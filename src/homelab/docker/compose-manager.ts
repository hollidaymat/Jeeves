/**
 * Compose Manager - Docker Compose generation, validation, and deployment
 * 
 * Generates modular docker-compose YAML files from service definitions,
 * validates them against port conflicts and the 14GB RAM budget,
 * and deploys/tears down stacks via docker compose CLI.
 * 
 * Stack directory pattern: /opt/stacks/{stackName}/docker-compose.yml
 * All Docker commands use child_process.spawn() (never exec()) for safety.
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { readdir, readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { stringify as yamlStringify, parse as yamlParse } from 'yaml';
import { logger } from '../../utils/logger.js';

// ============================================================================
// Constants
// ============================================================================

const STACKS_BASE_DIR = '/opt/stacks';
const COMPOSE_FILENAME = 'docker-compose.yml';
const MAX_RAM_MB = 14_336; // 14GB in MB — hard limit from JEEVES_HOMELAB_BUILD
const COMMAND_TIMEOUT_MS = 60_000; // 60s for compose operations

// ============================================================================
// Local Interfaces (Agent 1 will reconcile into types/index.ts)
// ============================================================================

export interface ServiceDefinition {
  name: string;
  image: string;
  ports: (number | string)[];  // number = same host:container, string = "host:container"
  ram: string;                // e.g. "256MB", "1GB"
  environment?: Record<string, string>;
  volumes?: string[];         // e.g. ["/opt/configs/sonarr:/config", "/data/media:/data"]
  labels?: Record<string, string>;
  devices?: string[];         // e.g. ["/dev/dri:/dev/dri"]
  networkMode?: string;       // e.g. "host"
  dependsOn?: string[];
  restart?: string;           // default: "unless-stopped"
  healthcheck?: {
    test: string[];
    interval?: string;
    timeout?: string;
    retries?: number;
  };
  command?: string[];
}

export interface ComposeFile {
  version?: string;
  services: Record<string, ComposeService>;
  networks?: Record<string, ComposeNetwork>;
  volumes?: Record<string, ComposeVolume | null>;
}

export interface ComposeService {
  image: string;
  container_name: string;
  restart: string;
  ports?: string[];
  volumes?: string[];
  environment?: string[] | Record<string, string>;
  labels?: string[] | Record<string, string>;
  devices?: string[];
  network_mode?: string;
  depends_on?: string[];
  deploy?: {
    resources: {
      limits: {
        memory: string;
      };
    };
  };
  healthcheck?: {
    test: string[];
    interval?: string;
    timeout?: string;
    retries?: number;
  };
  command?: string[];
  networks?: string[];
}

export interface ComposeNetwork {
  external?: boolean;
  driver?: string;
}

export interface ComposeVolume {
  driver?: string;
  external?: boolean;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  totalRamMB: number;
  portsUsed: number[];
}

export interface StackStatus {
  stackName: string;
  exists: boolean;
  composePath: string;
  services: Array<{
    name: string;
    status: string;
    state: string;
  }>;
  running: boolean;
}

export interface DeployResult {
  success: boolean;
  stackName: string;
  output: string;
  error?: string;
  duration_ms: number;
}

// ============================================================================
// Spawn Helper
// ============================================================================

function runCommand(
  command: string,
  args: string[],
  timeoutMs: number = COMMAND_TIMEOUT_MS
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const proc = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${command} ${args.join(' ')}`));
    }, timeoutMs);

    proc.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    proc.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Spawn error for "${command} ${args.join(' ')}": ${err.message}`));
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        exitCode: code ?? 1,
      });
    });
  });
}

// ============================================================================
// Compose Generation
// ============================================================================

/**
 * Generate a docker-compose YAML string from a stack name and service definitions.
 * Returns the YAML string ready to write to disk.
 */
export function generateCompose(stackName: string, services: ServiceDefinition[]): string {
  const compose: ComposeFile = {
    services: {},
    networks: {
      proxy: { external: true },
    },
    volumes: {},
  };

  for (const svc of services) {
    const composeService: ComposeService = {
      image: svc.image,
      container_name: svc.name,
      restart: svc.restart || 'unless-stopped',
    };

    // Ports — skip if networkMode is host
    if (svc.ports.length > 0 && svc.networkMode !== 'host') {
      composeService.ports = svc.ports.map((p) =>
        typeof p === 'string' ? p : `${p}:${p}`
      );
    }

    // Volumes
    if (svc.volumes && svc.volumes.length > 0) {
      composeService.volumes = svc.volumes;

      // Register named volumes (those without a / prefix on the source side)
      for (const vol of svc.volumes) {
        const source = vol.split(':')[0];
        if (source && !source.startsWith('/') && !source.startsWith('.')) {
          compose.volumes![source] = null;
        }
      }
    }

    // Environment
    if (svc.environment && Object.keys(svc.environment).length > 0) {
      composeService.environment = Object.entries(svc.environment).map(
        ([k, v]) => `${k}=${v}`
      );
    }

    // Labels (including Traefik labels)
    if (svc.labels && Object.keys(svc.labels).length > 0) {
      composeService.labels = Object.entries(svc.labels).map(
        ([k, v]) => `${k}=${v}`
      );
    }

    // GPU / device passthrough
    if (svc.devices && svc.devices.length > 0) {
      composeService.devices = svc.devices;
    }

    // Network mode (e.g., host for Home Assistant)
    if (svc.networkMode) {
      composeService.network_mode = svc.networkMode;
    } else {
      composeService.networks = ['proxy'];
    }

    // Dependencies - only include if the dependency is in THIS compose stack
    // (cross-stack depends_on doesn't work with one-stack-per-service model)
    if (svc.dependsOn && svc.dependsOn.length > 0) {
      const localDeps = svc.dependsOn.filter(dep => 
        services.some(s => s.name === dep)
      );
      if (localDeps.length > 0) {
        composeService.depends_on = localDeps;
      }
    }

    // Resource limits (RAM)
    if (svc.ram) {
      composeService.deploy = {
        resources: {
          limits: {
            memory: normalizeRamString(svc.ram),
          },
        },
      };
    }

    // Health check
    if (svc.healthcheck) {
      composeService.healthcheck = {
        test: svc.healthcheck.test,
        interval: svc.healthcheck.interval || '30s',
        timeout: svc.healthcheck.timeout || '10s',
        retries: svc.healthcheck.retries ?? 3,
      };
    }

    // Custom command
    if (svc.command && svc.command.length > 0) {
      composeService.command = svc.command;
    }

    compose.services[svc.name] = composeService;
  }

  // Clean up empty volumes section
  if (compose.volumes && Object.keys(compose.volumes).length === 0) {
    delete compose.volumes;
  }

  const yamlOutput = yamlStringify(compose, {
    lineWidth: 120,
    defaultKeyType: 'PLAIN',
    defaultStringType: 'QUOTE_DOUBLE',
    nullStr: '',
  });

  logger.info(`Generated compose for stack "${stackName}" with ${services.length} services`);
  return yamlOutput;
}

// ============================================================================
// Compose Validation
// ============================================================================

/**
 * Validate a compose YAML string before deployment.
 * Checks:
 *  - Port conflicts (within the compose and against running containers)
 *  - RAM budget (total must not push system past 14GB)
 *  - Dependency order (all depends_on targets must exist in the compose)
 *  - Image references are non-empty
 */
export async function validateCompose(composeYaml: string): Promise<ValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  let totalRamMB = 0;
  const portsUsed: number[] = [];

  let compose: ComposeFile;
  try {
    compose = yamlParse(composeYaml) as ComposeFile;
  } catch (err) {
    return {
      valid: false,
      errors: [`Invalid YAML: ${String(err)}`],
      warnings: [],
      totalRamMB: 0,
      portsUsed: [],
    };
  }

  if (!compose.services || Object.keys(compose.services).length === 0) {
    return {
      valid: false,
      errors: ['No services defined in compose file'],
      warnings: [],
      totalRamMB: 0,
      portsUsed: [],
    };
  }

  const serviceNames = Object.keys(compose.services);

  for (const [svcName, svc] of Object.entries(compose.services)) {
    // Validate image
    if (!svc.image || svc.image.trim().length === 0) {
      errors.push(`Service "${svcName}": no image specified`);
    }

    // Collect ports and check for internal conflicts
    if (svc.ports) {
      for (const portMapping of svc.ports) {
        const hostPort = parseHostPort(portMapping);
        if (hostPort !== null) {
          if (portsUsed.includes(hostPort)) {
            errors.push(
              `Port conflict: port ${hostPort} is used by multiple services in this compose`
            );
          }
          portsUsed.push(hostPort);
        }
      }
    }

    // Accumulate RAM
    const ramMB = parseRamToMB(svc.deploy?.resources?.limits?.memory);
    totalRamMB += ramMB;
    if (ramMB === 0 && !svc.network_mode) {
      warnings.push(`Service "${svcName}": no memory limit set — risky on a 16GB system`);
    }

    // Validate depends_on targets exist
    if (svc.depends_on) {
      for (const dep of svc.depends_on) {
        if (!serviceNames.includes(dep)) {
          // Dependencies might be in other stacks — warn, don't error
          warnings.push(
            `Service "${svcName}" depends on "${dep}" which is not in this compose file (may be in another stack)`
          );
        }
      }
    }
  }

  // Check total RAM against budget
  if (totalRamMB > MAX_RAM_MB) {
    errors.push(
      `Total RAM ${totalRamMB}MB exceeds the 14GB budget (${MAX_RAM_MB}MB). ` +
      `Reduce services or their memory limits.`
    );
  } else if (totalRamMB > MAX_RAM_MB * 0.85) {
    warnings.push(
      `Total RAM ${totalRamMB}MB is above 85% of the 14GB budget. ` +
      `Consider reducing allocations for headroom.`
    );
  }

  // Check for port conflicts against currently running containers
  if (portsUsed.length > 0) {
    const runningPorts = await getRunningContainerPorts();
    for (const port of portsUsed) {
      if (runningPorts.has(port)) {
        const occupant = runningPorts.get(port);
        warnings.push(
          `Port ${port} is currently in use by container "${occupant}". ` +
          `Deployment may fail or replace the existing binding.`
        );
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    totalRamMB,
    portsUsed,
  };
}

/**
 * Get a map of host ports → container names currently in use.
 */
async function getRunningContainerPorts(): Promise<Map<number, string>> {
  const portMap = new Map<number, string>();

  try {
    const { stdout, exitCode } = await runCommand('docker', [
      'ps', '--format', '{{.Names}}\t{{.Ports}}',
    ]);

    if (exitCode !== 0) return portMap;

    for (const line of stdout.trim().split('\n')) {
      if (!line.trim()) continue;
      const [name, portsStr] = line.split('\t');
      if (!portsStr) continue;

      // Parse port strings like "0.0.0.0:8080->8080/tcp, :::8080->8080/tcp"
      const portMatches = portsStr.matchAll(/(?:\d+\.\d+\.\d+\.\d+|:::?):(\d+)->/g);
      for (const match of portMatches) {
        const port = parseInt(match[1], 10);
        if (!isNaN(port)) {
          portMap.set(port, name || 'unknown');
        }
      }
    }
  } catch {
    // Non-critical — validation will still work without this check
  }

  return portMap;
}

// ============================================================================
// Stack Deployment
// ============================================================================

/**
 * Deploy a stack via `docker compose -f /opt/stacks/{stackName}/docker-compose.yml up -d`.
 * The compose file must already exist on disk.
 */
export async function deployStack(stackName: string): Promise<DeployResult> {
  const sanitized = sanitizeStackName(stackName);
  const composePath = getComposePath(sanitized);
  const startTime = Date.now();

  if (!existsSync(composePath)) {
    return {
      success: false,
      stackName: sanitized,
      output: '',
      error: `Compose file not found: ${composePath}`,
      duration_ms: Date.now() - startTime,
    };
  }

  try {
    logger.info(`Deploying stack "${sanitized}" from ${composePath}`);

    const { stdout, stderr, exitCode } = await runCommand(
      'docker',
      ['compose', '-f', composePath, 'up', '-d'],
      120_000 // 2 min timeout — image pulls can be slow
    );

    const duration_ms = Date.now() - startTime;
    const combinedOutput = (stdout + '\n' + stderr).trim();

    if (exitCode !== 0) {
      logger.error(`Stack deploy failed: ${sanitized}`, { stderr, exitCode });
      return {
        success: false,
        stackName: sanitized,
        output: combinedOutput,
        error: `docker compose up failed (exit ${exitCode}): ${stderr.trim()}`,
        duration_ms,
      };
    }

    logger.info(`Stack "${sanitized}" deployed successfully`, { duration_ms });
    return {
      success: true,
      stackName: sanitized,
      output: combinedOutput,
      duration_ms,
    };
  } catch (err) {
    const duration_ms = Date.now() - startTime;
    logger.error(`Stack deploy error: ${sanitized}`, { error: String(err) });
    return {
      success: false,
      stackName: sanitized,
      output: '',
      error: String(err),
      duration_ms,
    };
  }
}

// ============================================================================
// Stack Teardown
// ============================================================================

/**
 * Tear down a stack via `docker compose -f ... down`.
 * Stops and removes containers, networks. Does NOT remove volumes.
 */
export async function teardownStack(stackName: string): Promise<DeployResult> {
  const sanitized = sanitizeStackName(stackName);
  const composePath = getComposePath(sanitized);
  const startTime = Date.now();

  if (!existsSync(composePath)) {
    return {
      success: false,
      stackName: sanitized,
      output: '',
      error: `Compose file not found: ${composePath}`,
      duration_ms: Date.now() - startTime,
    };
  }

  try {
    logger.info(`Tearing down stack "${sanitized}"`);

    const { stdout, stderr, exitCode } = await runCommand(
      'docker',
      ['compose', '-f', composePath, 'down'],
      120_000
    );

    const duration_ms = Date.now() - startTime;
    const combinedOutput = (stdout + '\n' + stderr).trim();

    if (exitCode !== 0) {
      logger.error(`Stack teardown failed: ${sanitized}`, { stderr, exitCode });
      return {
        success: false,
        stackName: sanitized,
        output: combinedOutput,
        error: `docker compose down failed (exit ${exitCode}): ${stderr.trim()}`,
        duration_ms,
      };
    }

    logger.info(`Stack "${sanitized}" torn down successfully`, { duration_ms });
    return {
      success: true,
      stackName: sanitized,
      output: combinedOutput,
      duration_ms,
    };
  } catch (err) {
    const duration_ms = Date.now() - startTime;
    logger.error(`Stack teardown error: ${sanitized}`, { error: String(err) });
    return {
      success: false,
      stackName: sanitized,
      output: '',
      error: String(err),
      duration_ms,
    };
  }
}

// ============================================================================
// Stack Status
// ============================================================================

/**
 * Get the status of a specific stack: whether it exists, which services are defined,
 * and which are currently running.
 */
export async function getStackStatus(stackName: string): Promise<StackStatus> {
  const sanitized = sanitizeStackName(stackName);
  const composePath = getComposePath(sanitized);

  const status: StackStatus = {
    stackName: sanitized,
    exists: false,
    composePath,
    services: [],
    running: false,
  };

  if (!existsSync(composePath)) {
    return status;
  }

  status.exists = true;

  try {
    // Use docker compose ps to get service status
    const { stdout, exitCode } = await runCommand(
      'docker',
      ['compose', '-f', composePath, 'ps', '--format', '{{json .}}'],
      15_000
    );

    if (exitCode === 0 && stdout.trim()) {
      const services = stdout
        .trim()
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => {
          try {
            const raw = JSON.parse(line);
            return {
              name: raw.Name || raw.Service || '',
              status: raw.Status || '',
              state: raw.State || '',
            };
          } catch {
            return null;
          }
        })
        .filter((s): s is { name: string; status: string; state: string } => s !== null);

      status.services = services;
      status.running = services.some(
        (s) => s.state.toLowerCase().includes('running') || s.status.toLowerCase().includes('up')
      );
    } else {
      // Fallback: parse the compose file to get service names, then check docker ps
      await populateStatusFromComposeFile(status, composePath);
    }
  } catch (err) {
    logger.warn(`Failed to get stack status for ${sanitized}`, { error: String(err) });
    // Still try to parse the compose file
    await populateStatusFromComposeFile(status, composePath);
  }

  return status;
}

/**
 * Fallback: read the compose file and check container states individually.
 */
async function populateStatusFromComposeFile(
  status: StackStatus,
  composePath: string
): Promise<void> {
  try {
    const content = await readFile(composePath, 'utf8');
    const compose = yamlParse(content) as ComposeFile;

    if (compose.services) {
      for (const [svcName, svc] of Object.entries(compose.services)) {
        const containerName = svc.container_name || svcName;

        // Check if the container is running
        const { stdout, exitCode } = await runCommand(
          'docker',
          ['inspect', '--format', '{{.State.Status}}', containerName],
          5_000
        );

        const state = exitCode === 0 ? stdout.trim() : 'not found';
        status.services.push({
          name: containerName,
          status: state === 'running' ? 'Up' : state,
          state,
        });

        if (state === 'running') {
          status.running = true;
        }
      }
    }
  } catch (err) {
    logger.warn('Failed to parse compose file for status', { composePath, error: String(err) });
  }
}

// ============================================================================
// List All Stacks
// ============================================================================

/**
 * List all stacks in /opt/stacks/. A stack is a directory containing a docker-compose.yml.
 */
export async function listStacks(): Promise<StackStatus[]> {
  const stacks: StackStatus[] = [];

  try {
    if (!existsSync(STACKS_BASE_DIR)) {
      logger.warn(`Stacks directory does not exist: ${STACKS_BASE_DIR}`);
      return [];
    }

    const entries = await readdir(STACKS_BASE_DIR, { withFileTypes: true });
    const stackDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

    // Fetch status for each stack — do them in parallel for speed
    const statusPromises = stackDirs.map((dir) => getStackStatus(dir));
    const results = await Promise.allSettled(statusPromises);

    for (const result of results) {
      if (result.status === 'fulfilled') {
        stacks.push(result.value);
      }
    }

    logger.debug(`Found ${stacks.length} stacks in ${STACKS_BASE_DIR}`);
  } catch (err) {
    logger.error('Failed to list stacks', { error: String(err) });
  }

  return stacks;
}

// ============================================================================
// Write Compose to Disk
// ============================================================================

/**
 * Write a generated compose YAML to the appropriate stack directory.
 * Creates the directory if it doesn't exist.
 */
export async function writeComposeToDisk(stackName: string, composeYaml: string): Promise<void> {
  const sanitized = sanitizeStackName(stackName);
  const stackDir = join(STACKS_BASE_DIR, sanitized);
  const composePath = join(stackDir, COMPOSE_FILENAME);

  try {
    if (!existsSync(stackDir)) {
      await mkdir(stackDir, { recursive: true });
      logger.info(`Created stack directory: ${stackDir}`);
    }

    await writeFile(composePath, composeYaml, 'utf8');
    logger.info(`Wrote compose file: ${composePath}`);
  } catch (err) {
    logger.error(`Failed to write compose file for ${sanitized}`, { error: String(err) });
    throw new Error(`Failed to write compose file: ${String(err)}`);
  }
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Get the compose file path for a stack.
 */
function getComposePath(stackName: string): string {
  return join(STACKS_BASE_DIR, stackName, COMPOSE_FILENAME);
}

/**
 * Sanitize stack name — only allows alphanumeric, hyphens, underscores.
 */
function sanitizeStackName(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9_\-]/g, '');
  if (sanitized.length === 0) {
    throw new Error(`Invalid stack name: "${name}"`);
  }
  return sanitized;
}

/**
 * Normalize a RAM string to Docker-compatible format.
 * "256MB" → "256M", "1GB" → "1G", "64mb" → "64M"
 */
function normalizeRamString(ram: string): string {
  const match = ram.trim().match(/^(\d+(?:\.\d+)?)\s*(MB|GB|M|G|KB|K|B)?$/i);
  if (!match) return ram;

  const value = match[1];
  const unit = (match[2] || 'M').toUpperCase();

  // Docker uses single-letter suffixes
  if (unit === 'MB') return `${value}M`;
  if (unit === 'GB') return `${value}G`;
  if (unit === 'KB') return `${value}K`;
  return `${value}${unit.charAt(0)}`;
}

/**
 * Parse a RAM string into megabytes for budget calculation.
 * "256M" → 256, "1G" → 1024, "512MB" → 512, "64mb" → 64
 */
function parseRamToMB(ram: string | undefined): number {
  if (!ram) return 0;

  const match = ram.trim().match(/^(\d+(?:\.\d+)?)\s*(MB|GB|M|G|KB|K|B)?$/i);
  if (!match) return 0;

  const value = parseFloat(match[1]);
  const unit = (match[2] || 'M').toUpperCase();

  switch (unit) {
    case 'G':
    case 'GB':
      return value * 1024;
    case 'M':
    case 'MB':
      return value;
    case 'K':
    case 'KB':
      return value / 1024;
    case 'B':
      return value / (1024 * 1024);
    default:
      return value;
  }
}

/**
 * Parse the host port from a Docker port mapping string.
 * "8080:8080" → 8080, "0.0.0.0:9090:9090/tcp" → 9090, "53:53/udp" → 53
 */
function parseHostPort(portMapping: string): number | null {
  // Handle formats: "8080:8080", "0.0.0.0:8080:8080/tcp", "8080:8080/udp"
  const parts = portMapping.split('/')[0]; // strip protocol
  const segments = parts.split(':');

  let hostPort: string;
  if (segments.length === 3) {
    // "0.0.0.0:8080:8080" — host port is second segment
    hostPort = segments[1];
  } else if (segments.length === 2) {
    // "8080:8080" — host port is first segment
    hostPort = segments[0];
  } else {
    return null;
  }

  const port = parseInt(hostPort, 10);
  return isNaN(port) ? null : port;
}
