/**
 * Container Monitor - Docker container lifecycle and health management
 * 
 * Provides container listing, inspection, log retrieval, restart loop detection,
 * start/stop/restart control, and per-container resource stats.
 * 
 * All Docker commands use child_process.spawn() (never exec()) for safety.
 * Hard rule: never exceed 14GB RAM. Reserve 2GB for OS + Jeeves.
 */

import { spawn } from 'child_process';
import { logger } from '../../utils/logger.js';

// ============================================================================
// Local Interfaces (Agent 1 will reconcile into types/index.ts)
// ============================================================================

export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  status: string;
  state: 'running' | 'exited' | 'paused' | 'restarting' | 'dead' | 'created' | 'removing';
  ports: string;
  createdAt: string;
  uptime: string;
  networks: string;
}

export interface ContainerDetails {
  id: string;
  name: string;
  image: string;
  state: {
    status: string;
    running: boolean;
    paused: boolean;
    restarting: boolean;
    pid: number;
    exitCode: number;
    startedAt: string;
    finishedAt: string;
    restartCount: number;
  };
  config: {
    hostname: string;
    env: string[];
    cmd: string[];
    image: string;
    volumes: Record<string, unknown>;
    labels: Record<string, string>;
  };
  networkSettings: {
    ports: Record<string, Array<{ hostIp: string; hostPort: string }> | null>;
    networks: Record<string, { ipAddress: string; gateway: string }>;
  };
  mounts: Array<{
    type: string;
    source: string;
    destination: string;
    mode: string;
    rw: boolean;
  }>;
  hostConfig: {
    memory: number;
    memoryReservation: number;
    cpuShares: number;
    restartPolicy: { name: string; maximumRetryCount: number };
  };
}

export interface ContainerStats {
  name: string;
  cpuPercent: number;
  memUsage: string;
  memLimit: string;
  memPercent: number;
  netIO: string;
  blockIO: string;
  pids: number;
}

export interface ContainerLog {
  name: string;
  lines: string[];
  lineCount: number;
  truncated: boolean;
}

export interface RestartLoopInfo {
  containerName: string;
  restartCount: number;
  windowMinutes: number;
  events: Array<{ timestamp: string; action: string }>;
  isLooping: boolean;
}

export interface ContainerActionResult {
  success: boolean;
  container: string;
  action: 'start' | 'stop' | 'restart';
  output: string;
  error?: string;
  duration_ms: number;
}

// ============================================================================
// Spawn Helper
// ============================================================================

const COMMAND_TIMEOUT_MS = 30_000; // 30s default timeout

/**
 * Run a command via spawn and collect output. Returns { stdout, stderr, exitCode }.
 * Rejects on timeout or spawn error.
 */
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
// Container Listing
// ============================================================================

/**
 * List all containers (running and stopped) via `docker ps -a --format json`.
 * Returns typed ContainerInfo array.
 */
export async function listContainers(): Promise<ContainerInfo[]> {
  try {
    const { stdout, stderr, exitCode } = await runCommand('docker', [
      'ps', '-a', '--format',
      '{{json .}}',
    ]);

    if (exitCode !== 0) {
      logger.error('docker ps failed', { stderr, exitCode });
      return [];
    }

    // docker ps --format json outputs one JSON object per line
    const containers: ContainerInfo[] = stdout
      .trim()
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try {
          const raw = JSON.parse(line);
          return {
            id: raw.ID || raw.Id || '',
            name: raw.Names || raw.Name || '',
            image: raw.Image || '',
            status: raw.Status || '',
            state: parseContainerState(raw.State || raw.Status || ''),
            ports: raw.Ports || '',
            createdAt: raw.CreatedAt || '',
            uptime: raw.RunningFor || raw.Status || '',
            networks: raw.Networks || '',
          };
        } catch {
          logger.warn('Failed to parse container JSON line', { line });
          return null;
        }
      })
      .filter((c): c is ContainerInfo => c !== null);

    logger.debug(`Listed ${containers.length} containers`);
    return containers;
  } catch (err) {
    logger.error('Failed to list containers', { error: String(err) });
    return [];
  }
}

/**
 * Normalize Docker state string to typed state value.
 */
function parseContainerState(state: string): ContainerInfo['state'] {
  const lower = state.toLowerCase();
  if (lower.includes('running') || lower === 'running') return 'running';
  if (lower.includes('exited') || lower === 'exited') return 'exited';
  if (lower.includes('paused') || lower === 'paused') return 'paused';
  if (lower.includes('restarting') || lower === 'restarting') return 'restarting';
  if (lower.includes('dead') || lower === 'dead') return 'dead';
  if (lower.includes('created') || lower === 'created') return 'created';
  if (lower.includes('removing') || lower === 'removing') return 'removing';
  return 'exited';
}

// ============================================================================
// Container Details (Inspect)
// ============================================================================

/**
 * Get detailed information about a container via `docker inspect`.
 */
export async function getContainerDetails(name: string): Promise<ContainerDetails | null> {
  try {
    const sanitized = sanitizeContainerName(name);
    const { stdout, stderr, exitCode } = await runCommand('docker', ['inspect', sanitized]);

    if (exitCode !== 0) {
      logger.error(`docker inspect failed for ${sanitized}`, { stderr, exitCode });
      return null;
    }

    const inspectData = JSON.parse(stdout);
    if (!Array.isArray(inspectData) || inspectData.length === 0) {
      logger.warn(`No inspect data returned for ${sanitized}`);
      return null;
    }

    const raw = inspectData[0];
    return {
      id: raw.Id || '',
      name: (raw.Name || '').replace(/^\//, ''),
      image: raw.Config?.Image || '',
      state: {
        status: raw.State?.Status || '',
        running: raw.State?.Running ?? false,
        paused: raw.State?.Paused ?? false,
        restarting: raw.State?.Restarting ?? false,
        pid: raw.State?.Pid ?? 0,
        exitCode: raw.State?.ExitCode ?? -1,
        startedAt: raw.State?.StartedAt || '',
        finishedAt: raw.State?.FinishedAt || '',
        restartCount: raw.RestartCount ?? 0,
      },
      config: {
        hostname: raw.Config?.Hostname || '',
        env: raw.Config?.Env || [],
        cmd: raw.Config?.Cmd || [],
        image: raw.Config?.Image || '',
        volumes: raw.Config?.Volumes || {},
        labels: raw.Config?.Labels || {},
      },
      networkSettings: {
        ports: raw.NetworkSettings?.Ports || {},
        networks: Object.fromEntries(
          Object.entries(raw.NetworkSettings?.Networks || {}).map(
            ([netName, netData]: [string, any]) => [
              netName,
              {
                ipAddress: netData?.IPAddress || '',
                gateway: netData?.Gateway || '',
              },
            ]
          )
        ),
      },
      mounts: (raw.Mounts || []).map((m: any) => ({
        type: m.Type || '',
        source: m.Source || '',
        destination: m.Destination || '',
        mode: m.Mode || '',
        rw: m.RW ?? true,
      })),
      hostConfig: {
        memory: raw.HostConfig?.Memory ?? 0,
        memoryReservation: raw.HostConfig?.MemoryReservation ?? 0,
        cpuShares: raw.HostConfig?.CpuShares ?? 0,
        restartPolicy: {
          name: raw.HostConfig?.RestartPolicy?.Name || '',
          maximumRetryCount: raw.HostConfig?.RestartPolicy?.MaximumRetryCount ?? 0,
        },
      },
    };
  } catch (err) {
    logger.error(`Failed to inspect container ${name}`, { error: String(err) });
    return null;
  }
}

// ============================================================================
// Container Logs
// ============================================================================

/**
 * Get the last N lines of a container's logs via `docker logs --tail N`.
 */
export async function getContainerLogs(name: string, lines: number = 50): Promise<ContainerLog> {
  const sanitized = sanitizeContainerName(name);
  const clampedLines = Math.max(1, Math.min(lines, 5000));

  try {
    // docker logs writes to both stdout and stderr; combine them
    const { stdout, stderr, exitCode } = await runCommand('docker', [
      'logs', '--tail', String(clampedLines), '--timestamps', sanitized,
    ]);

    if (exitCode !== 0 && !stdout && !stderr) {
      return {
        name: sanitized,
        lines: [`Error fetching logs (exit ${exitCode})`],
        lineCount: 0,
        truncated: false,
      };
    }

    // Docker may send app output to stderr (e.g., Python apps). Combine both streams.
    const combined = (stdout + '\n' + stderr).trim();
    const logLines = combined.split('\n').filter((l) => l.length > 0);

    return {
      name: sanitized,
      lines: logLines,
      lineCount: logLines.length,
      truncated: logLines.length >= clampedLines,
    };
  } catch (err) {
    logger.error(`Failed to get logs for ${sanitized}`, { error: String(err) });
    return {
      name: sanitized,
      lines: [`Error: ${String(err)}`],
      lineCount: 0,
      truncated: false,
    };
  }
}

// ============================================================================
// Container Lifecycle (Start / Stop / Restart)
// ============================================================================

/**
 * Start a stopped container.
 */
export async function startContainer(name: string): Promise<ContainerActionResult> {
  return containerAction(name, 'start');
}

/**
 * Stop a running container (10s grace period).
 */
export async function stopContainer(name: string): Promise<ContainerActionResult> {
  return containerAction(name, 'stop');
}

/**
 * Restart a container (10s grace period for stop phase).
 */
export async function restartContainer(name: string): Promise<ContainerActionResult> {
  return containerAction(name, 'restart');
}

/**
 * Internal: perform a start/stop/restart action on a container.
 */
async function containerAction(
  name: string,
  action: 'start' | 'stop' | 'restart'
): Promise<ContainerActionResult> {
  const sanitized = sanitizeContainerName(name);
  const startTime = Date.now();

  try {
    logger.info(`Container ${action}: ${sanitized}`);

    const { stdout, stderr, exitCode } = await runCommand(
      'docker',
      [action, sanitized],
      60_000 // 60s timeout for stop/restart which waits for graceful shutdown
    );

    const duration_ms = Date.now() - startTime;

    if (exitCode !== 0) {
      logger.error(`docker ${action} failed for ${sanitized}`, { stderr, exitCode });
      return {
        success: false,
        container: sanitized,
        action,
        output: stderr.trim() || stdout.trim(),
        error: `Exit code ${exitCode}: ${stderr.trim()}`,
        duration_ms,
      };
    }

    logger.info(`Container ${action} succeeded: ${sanitized}`, { duration_ms });
    return {
      success: true,
      container: sanitized,
      action,
      output: stdout.trim() || sanitized,
      duration_ms,
    };
  } catch (err) {
    const duration_ms = Date.now() - startTime;
    logger.error(`Container ${action} error for ${sanitized}`, { error: String(err) });
    return {
      success: false,
      container: sanitized,
      action,
      output: '',
      error: String(err),
      duration_ms,
    };
  }
}

// ============================================================================
// Container Stats
// ============================================================================

/**
 * Get per-container resource stats via `docker stats --no-stream --format json`.
 * Returns CPU %, memory usage/limit/%, network I/O, block I/O, and PID count.
 */
export async function getContainerStats(): Promise<ContainerStats[]> {
  try {
    const { stdout, stderr, exitCode } = await runCommand('docker', [
      'stats', '--no-stream', '--format', '{{json .}}',
    ]);

    if (exitCode !== 0) {
      logger.error('docker stats failed', { stderr, exitCode });
      return [];
    }

    const stats: ContainerStats[] = stdout
      .trim()
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try {
          const raw = JSON.parse(line);
          return {
            name: (raw.Name || '').replace(/^\//, ''),
            cpuPercent: parsePercent(raw.CPUPerc),
            memUsage: raw.MemUsage?.split('/')[0]?.trim() || '0B',
            memLimit: raw.MemUsage?.split('/')[1]?.trim() || '0B',
            memPercent: parsePercent(raw.MemPerc),
            netIO: raw.NetIO || '0B / 0B',
            blockIO: raw.BlockIO || '0B / 0B',
            pids: parseInt(raw.PIDs, 10) || 0,
          };
        } catch {
          logger.warn('Failed to parse stats JSON line', { line });
          return null;
        }
      })
      .filter((s): s is ContainerStats => s !== null);

    logger.debug(`Got stats for ${stats.length} containers`);
    return stats;
  } catch (err) {
    logger.error('Failed to get container stats', { error: String(err) });
    return [];
  }
}

// ============================================================================
// Restart Loop Detection
// ============================================================================

// In-memory restart event tracking for real-time detection
const restartEvents: Map<string, number[]> = new Map();

const RESTART_LOOP_THRESHOLD = 3;
const RESTART_LOOP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Detect containers stuck in restart loops (>3 restarts in 5 minutes).
 * Uses `docker events` with a time window to check for recent restart actions,
 * and also checks the in-memory event tracker.
 */
export async function detectRestartLoops(): Promise<RestartLoopInfo[]> {
  const results: RestartLoopInfo[] = [];

  try {
    // Query recent docker events for restart actions in the last 5 minutes
    const sinceSeconds = Math.floor(RESTART_LOOP_WINDOW_MS / 1000);
    const { stdout, exitCode } = await runCommand(
      'docker',
      [
        'events',
        '--since', `${sinceSeconds}s`,
        '--until', '0s',
        '--filter', 'event=restart',
        '--filter', 'type=container',
        '--format', '{{json .}}',
      ],
      15_000 // 15s timeout — events query should complete quickly with --until
    );

    if (exitCode !== 0 && !stdout.trim()) {
      // No events or error — fall back to inspect-based detection
      return await detectRestartLoopsViaInspect();
    }

    // Group restart events by container
    const eventsByContainer: Map<string, Array<{ timestamp: string; action: string }>> = new Map();

    stdout
      .trim()
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .forEach((line) => {
        try {
          const raw = JSON.parse(line);
          const containerName =
            raw.Actor?.Attributes?.name || raw.Actor?.Attributes?.container || raw.id || 'unknown';
          const timestamp = raw.time
            ? new Date(parseInt(raw.time, 10) * 1000).toISOString()
            : raw.timeNano
              ? new Date(parseInt(raw.timeNano, 10) / 1_000_000).toISOString()
              : new Date().toISOString();

          if (!eventsByContainer.has(containerName)) {
            eventsByContainer.set(containerName, []);
          }
          eventsByContainer.get(containerName)!.push({
            timestamp,
            action: raw.Action || 'restart',
          });
        } catch {
          // Skip unparseable lines
        }
      });

    // Merge with in-memory tracking
    const now = Date.now();
    for (const [containerName, timestamps] of restartEvents.entries()) {
      // Clean old entries
      const recent = timestamps.filter((t) => now - t < RESTART_LOOP_WINDOW_MS);
      if (recent.length > 0) {
        if (!eventsByContainer.has(containerName)) {
          eventsByContainer.set(containerName, []);
        }
        for (const ts of recent) {
          eventsByContainer.get(containerName)!.push({
            timestamp: new Date(ts).toISOString(),
            action: 'restart (tracked)',
          });
        }
      }
    }

    // Evaluate each container
    for (const [containerName, events] of eventsByContainer.entries()) {
      const isLooping = events.length >= RESTART_LOOP_THRESHOLD;
      results.push({
        containerName,
        restartCount: events.length,
        windowMinutes: sinceSeconds / 60,
        events,
        isLooping,
      });

      if (isLooping) {
        logger.warn(`Restart loop detected: ${containerName}`, {
          restartCount: events.length,
          windowMinutes: sinceSeconds / 60,
        });
      }
    }
  } catch (err) {
    logger.error('Failed to detect restart loops via events', { error: String(err) });
    // Fall back to inspect-based detection
    return await detectRestartLoopsViaInspect();
  }

  return results;
}

/**
 * Fallback: detect restart loops by inspecting each container's RestartCount
 * and comparing start time vs creation time. Less precise but always works.
 */
async function detectRestartLoopsViaInspect(): Promise<RestartLoopInfo[]> {
  const results: RestartLoopInfo[] = [];

  try {
    const containers = await listContainers();
    const restartingContainers = containers.filter(
      (c) => c.state === 'restarting' || c.status.toLowerCase().includes('restarting')
    );

    for (const container of restartingContainers) {
      const details = await getContainerDetails(container.name);
      if (details && details.state.restartCount >= RESTART_LOOP_THRESHOLD) {
        results.push({
          containerName: container.name,
          restartCount: details.state.restartCount,
          windowMinutes: 5,
          events: [{ timestamp: details.state.startedAt, action: 'restart (from inspect)' }],
          isLooping: true,
        });
      }
    }
  } catch (err) {
    logger.error('Failed to detect restart loops via inspect', { error: String(err) });
  }

  return results;
}

/**
 * Record a restart event for a container (called externally when a restart is observed).
 * Used to supplement docker events-based detection.
 */
export function recordRestartEvent(containerName: string): void {
  const now = Date.now();
  if (!restartEvents.has(containerName)) {
    restartEvents.set(containerName, []);
  }
  const events = restartEvents.get(containerName)!;
  events.push(now);

  // Prune old events outside the window
  const cutoff = now - RESTART_LOOP_WINDOW_MS;
  const pruned = events.filter((t) => t >= cutoff);
  restartEvents.set(containerName, pruned);

  if (pruned.length >= RESTART_LOOP_THRESHOLD) {
    logger.warn(`Restart loop threshold reached for ${containerName}`, {
      restartCount: pruned.length,
      windowMinutes: RESTART_LOOP_WINDOW_MS / 60_000,
    });
  }
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Sanitize container name to prevent command injection.
 * Only allows alphanumeric, hyphens, underscores, dots, and forward slashes.
 */
function sanitizeContainerName(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9._\-\/]/g, '');
  if (sanitized.length === 0) {
    throw new Error(`Invalid container name: "${name}"`);
  }
  return sanitized;
}

/**
 * Parse a percent string like "12.34%" into a number.
 */
function parsePercent(value: string | undefined): number {
  if (!value) return 0;
  const match = value.replace('%', '').trim();
  const num = parseFloat(match);
  return isNaN(num) ? 0 : num;
}
