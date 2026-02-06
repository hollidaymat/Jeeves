/**
 * Jeeves Homelab - Service Installer
 *
 * Core deployment engine for homelab services. Each service gets its own
 * Docker Compose stack stored at /opt/stacks/{serviceName}/docker-compose.yml.
 *
 * Handles: install, uninstall, and batch-update of all running services.
 * Integrates with the service registry, health checker, Traefik proxy, and Pi-hole DNS.
 */

import {
  generateCompose,
  writeComposeToDisk,
  deployStack,
  teardownStack,
} from '../docker/compose-manager.js';
import {
  getService,
  getAllServices,
  getServiceDependencies,
  getDependents,
  updateServiceState,
} from './registry.js';
import { execHomelab } from '../shell.js';
import { checkServiceHealth } from './health-checker.js';
import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';
import { generateTraefikLabels, getDefaultDomain } from '../network/reverse-proxy.js';
import { addLocalDNS, removeLocalDNS } from '../network/dns.js';

// ============================================================================
// Types
// ============================================================================

export interface InstallResult {
  success: boolean;
  message: string;
  service?: string;
  warnings: string[];
  duration_ms: number;
}

export interface UpdateAllResult {
  success: boolean;
  updated: string[];
  failed: string[];
  skipped: string[];
  duration_ms: number;
}

// ============================================================================
// Constants
// ============================================================================

const RAM_BUDGET_MB = 14_336; // 14GB (16GB total, 2GB reserved for OS + Jeeves)
const DEFAULT_HOST_IP = '127.0.0.1';
const POST_DEPLOY_WAIT_MS = 5_000;

/**
 * Priority sort order — critical services update first.
 */
const PRIORITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

// ============================================================================
// Public API
// ============================================================================

/**
 * Install and deploy a single homelab service.
 *
 * Steps: registry lookup → RAM check → dependency check → create dirs →
 * generate Traefik labels → generate compose → write to disk → deploy →
 * health check → update registry state → add DNS entry.
 */
export async function installService(name: string): Promise<InstallResult> {
  const startTime = Date.now();
  const warnings: string[] = [];

  // ---- a. Look up service in registry ----
  const svc = getService(name);
  if (!svc) {
    return {
      success: false,
      message: `Service '${name}' not found in registry`,
      warnings,
      duration_ms: Date.now() - startTime,
    };
  }

  if (svc.type === 'system-service') {
    return {
      success: false,
      message: `Service '${name}' is a system-service and cannot be installed via Docker`,
      service: name,
      warnings,
      duration_ms: Date.now() - startTime,
    };
  }

  // ---- b. Check if already running ----
  const psResult = await execHomelab('docker', ['ps', '-q', '-f', `name=${name}`]);
  if (psResult.success && psResult.stdout.trim().length > 0) {
    warnings.push(`Container '${name}' is already running. It will be recreated.`);
  }

  // ---- c. Check RAM budget ----
  const runningServices = getAllServices().filter((s) => s.state === 'running');
  const currentRunningRAM = runningServices.reduce((sum, s) => sum + s.ramMB, 0);
  const projectedRAM = currentRunningRAM + svc.ramMB;

  if (projectedRAM > RAM_BUDGET_MB) {
    warnings.push(
      `RAM budget exceeded: ${projectedRAM}MB projected ` +
      `(${currentRunningRAM}MB running + ${svc.ramMB}MB new) vs ${RAM_BUDGET_MB}MB budget`,
    );
  }

  // ---- d. Check dependency chain ----
  const deps = getServiceDependencies(name);
  for (const dep of deps) {
    const depService = getService(dep);
    if (depService && depService.state !== 'running') {
      warnings.push(`Dependency '${dep}' is not currently running. Install it first.`);
    }
  }

  // ---- e. Create directories ----
  const stackDir = `${config.homelab.stacksDir}/${name}`;
  const configDir = `${config.homelab.configsDir}/${name}`;

  await execHomelab('mkdir', ['-p', stackDir]);
  await execHomelab('mkdir', ['-p', configDir]);

  // ---- f. Generate Traefik labels ----
  const primaryPort = svc.ports[0] ?? 80;
  const domain = getDefaultDomain(name);
  const traefikLabels = svc.networkMode === 'host'
    ? {}
    : generateTraefikLabels(name, primaryPort, domain);

  // ---- g. Generate compose YAML ----
  // Map registry service definition to compose-manager format
  const composeDef = {
    name: svc.name,
    image: svc.image,
    ports: svc.ports,
    ram: `${svc.ramMB}M`,
    devices: svc.devices,
    networkMode: svc.networkMode,
    dependsOn: svc.dependencies.length > 0 ? svc.dependencies : undefined,
    labels: Object.keys(traefikLabels).length > 0 ? traefikLabels : undefined,
    environment: svc.environment,
    volumes: svc.volumes,
  };

  const composeYaml = generateCompose(name, [composeDef]);

  // ---- h. Write compose to disk ----
  await writeComposeToDisk(name, composeYaml);

  // ---- i. Deploy stack ----
  const deployResult = await deployStack(name);
  if (!deployResult.success) {
    return {
      success: false,
      message: `Deployment failed: ${deployResult.error ?? 'Unknown error'}`,
      service: name,
      warnings,
      duration_ms: Date.now() - startTime,
    };
  }

  // ---- j. Wait, then health check ----
  await delay(POST_DEPLOY_WAIT_MS);
  const healthResult = await checkServiceHealth(name);
  const isHealthy = healthResult.status === 'healthy' || healthResult.status === 'degraded';

  if (!isHealthy) {
    warnings.push(`Health check returned '${healthResult.status}' after deployment`);
  }

  // ---- k. Update service state in registry ----
  updateServiceState(name, isHealthy ? 'running' : 'error');

  // ---- l. Add DNS entry ----
  const dnsResult = await addLocalDNS(domain, DEFAULT_HOST_IP);
  if (!dnsResult.success) {
    warnings.push(`DNS entry creation failed: ${dnsResult.message}`);
  }

  // ---- m. Return result ----
  return {
    success: true,
    message: `Service '${name}' installed and ${isHealthy ? 'healthy' : 'deployed with warnings'}`,
    service: name,
    warnings,
    duration_ms: Date.now() - startTime,
  };
}

/**
 * Uninstall a homelab service.
 *
 * Refuses if other running services depend on it.
 * Tears down the Docker stack but preserves data volumes and config directories.
 */
export async function uninstallService(name: string): Promise<InstallResult> {
  const startTime = Date.now();
  const warnings: string[] = [];

  // ---- a. Check reverse dependencies ----
  const dependents = getDependents(name);
  const runningDependents = dependents.filter((dep) => {
    const svc = getService(dep);
    return svc && svc.state === 'running';
  });

  if (runningDependents.length > 0) {
    return {
      success: false,
      message: `Cannot uninstall '${name}': running services depend on it: ${runningDependents.join(', ')}`,
      service: name,
      warnings,
      duration_ms: Date.now() - startTime,
    };
  }

  // ---- b. Teardown stack ----
  const teardownResult = await teardownStack(name);
  if (!teardownResult.success) {
    warnings.push(`Teardown issue: ${teardownResult.error ?? 'Partial teardown'}`);
  }

  // ---- c. Remove DNS entry ----
  const domain = getDefaultDomain(name);
  const dnsResult = await removeLocalDNS(domain);
  if (!dnsResult.success) {
    warnings.push(`DNS removal failed: ${dnsResult.message}`);
  }

  // ---- d. Update service state ----
  updateServiceState(name, 'stopped');

  // ---- e. DO NOT delete data volumes or config dirs (safety) ----

  // ---- f. Return result ----
  return {
    success: true,
    message: `Service '${name}' uninstalled. Data volumes and configs preserved.`,
    service: name,
    warnings,
    duration_ms: Date.now() - startTime,
  };
}

/**
 * Update all running services: pull new images, recreate containers, health check.
 *
 * Services are processed in priority order (critical first).
 * If a health check fails after update, a rollback restart is attempted.
 */
export async function updateAllServices(): Promise<UpdateAllResult> {
  const startTime = Date.now();
  const updated: string[] = [];
  const failed: string[] = [];
  const skipped: string[] = [];

  // ---- a. List running containers ----
  const psResult = await execHomelab('docker', ['ps', '--format', '{{.Names}}']);

  if (!psResult.success) {
    return {
      success: false,
      updated,
      failed,
      skipped,
      duration_ms: Date.now() - startTime,
    };
  }

  if (!psResult.stdout.trim()) {
    // No running containers — nothing to update
    return {
      success: true,
      updated,
      failed,
      skipped,
      duration_ms: Date.now() - startTime,
    };
  }

  const containerNames = psResult.stdout
    .trim()
    .split('\n')
    .map((n) => n.trim())
    .filter(Boolean);

  // ---- b. Sort by priority (critical first, then high, medium, low) ----
  const servicesToUpdate: Array<{ name: string; image: string; priority: string }> = [];

  for (const containerName of containerNames) {
    const svc = getService(containerName);
    if (!svc || !svc.image || svc.type === 'system-service') {
      skipped.push(containerName);
      continue;
    }
    servicesToUpdate.push({
      name: containerName,
      image: svc.image,
      priority: svc.priority,
    });
  }

  servicesToUpdate.sort((a, b) => {
    const pa = PRIORITY_ORDER[a.priority] ?? 99;
    const pb = PRIORITY_ORDER[b.priority] ?? 99;
    return pa - pb;
  });

  // ---- c. For each: pull new image, recreate, health check ----
  for (const { name, image } of servicesToUpdate) {
    logger.info(`Updating service: ${name}`, { image });

    // Pull new image
    const pullResult = await execHomelab('docker', ['pull', image], {
      timeout: 120_000, // Image pulls can be slow
    });

    if (!pullResult.success) {
      logger.warn(`Failed to pull image for ${name}`, { error: pullResult.stderr });
      failed.push(name);
      continue;
    }

    // Recreate container via docker compose up -d
    const composePath = `${config.homelab.stacksDir}/${name}/docker-compose.yml`;
    const upResult = await execHomelab('docker', [
      'compose', '-f', composePath, 'up', '-d',
    ], { timeout: 60_000 });

    if (!upResult.success) {
      logger.warn(`Failed to recreate ${name}`, { error: upResult.stderr });
      failed.push(name);
      continue;
    }

    // Wait for container to stabilize
    await delay(POST_DEPLOY_WAIT_MS);

    // Health check
    const healthResult = await checkServiceHealth(name);
    const isHealthy = healthResult.status === 'healthy' || healthResult.status === 'degraded';

    if (isHealthy) {
      updated.push(name);
      updateServiceState(name, 'running');
      logger.info(`Service ${name} updated successfully`);
      continue;
    }

    // ---- d. Health check failed — try rollback via restart ----
    logger.warn(`Health check failed for ${name} after update, attempting restart rollback`);

    await execHomelab('docker', [
      'compose', '-f', composePath, 'restart',
    ], { timeout: 60_000 });

    await delay(POST_DEPLOY_WAIT_MS);

    const retryHealth = await checkServiceHealth(name);
    const retryHealthy = retryHealth.status === 'healthy' || retryHealth.status === 'degraded';

    if (retryHealthy) {
      updated.push(name);
      updateServiceState(name, 'running');
      logger.info(`Service ${name} recovered after restart`);
    } else {
      failed.push(name);
      updateServiceState(name, 'error');
      logger.error(`Service ${name} failed to recover after update`);
    }
  }

  // ---- e. Return summary ----
  return {
    success: failed.length === 0,
    updated,
    failed,
    skipped,
    duration_ms: Date.now() - startTime,
  };
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Promise-based delay.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
