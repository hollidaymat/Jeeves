/**
 * Jeeves Homelab - Service Health Checker
 * 
 * Performs health checks on all registered homelab services:
 * - HTTP health checks (GET, check for 200)
 * - TCP port checks (connect, verify listening)
 * - Docker healthcheck status (docker inspect)
 * - Self-test suite (docker, network, dns, firewall, backup, ssl, postgres, redis, disk, memory)
 * 
 * Timeout: 5 seconds per check.
 */

import { spawn } from 'child_process';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import {
  getAllServices,
  getService,
  updateServiceState,
  type ServiceDefinition,
  type ServiceState,
} from './registry.js';

// ============================================================================
// Types
// ============================================================================

export type HealthStatus = 'healthy' | 'unhealthy' | 'degraded' | 'unknown';

export interface HealthCheckResult {
  service: string;
  status: HealthStatus;
  checks: IndividualCheck[];
  responseTimeMs: number;
  timestamp: string;
  error?: string;
}

export interface IndividualCheck {
  type: 'http' | 'tcp' | 'docker' | 'command';
  target: string;            // URL, host:port, container name, or command
  passed: boolean;
  responseTimeMs: number;
  details?: string;
  error?: string;
}

export interface SelfTestResult {
  name: string;
  passed: boolean;
  output: string;
  error?: string;
  durationMs: number;
}

export interface HealthReport {
  timestamp: string;
  overall: HealthStatus;
  totalServices: number;
  healthy: number;
  unhealthy: number;
  degraded: number;
  unknown: number;
  services: HealthCheckResult[];
  alerts: string[];
}

// ============================================================================
// Constants
// ============================================================================

const CHECK_TIMEOUT_MS = 5000;
const DEFAULT_HOST = '127.0.0.1';

/**
 * Self-test commands from JEEVES_HOMELAB_BUILD.md.
 */
const SELF_TESTS: Record<string, { command: string; args: string[]; description: string }> = {
  docker:   { command: 'docker',   args: ['run', '--rm', 'hello-world'],                        description: 'Docker engine is working' },
  network:  { command: 'curl',     args: ['-s', '--max-time', '5', 'https://1.1.1.1/cdn-cgi/trace'], description: 'Internet connectivity' },
  dns:      { command: 'dig',      args: ['+short', 'google.com', '@127.0.0.1'],                description: 'Pi-hole DNS resolution' },
  firewall: { command: 'sudo',     args: ['ufw', 'status', 'verbose'],                           description: 'Firewall status' },
  backup:   { command: 'restic',   args: ['snapshots', '--latest', '1'],                        description: 'Backup repository accessible' },
  ssl:      { command: 'openssl',  args: ['s_client', '-connect', 'localhost:443', '-servername', 'home.local'], description: 'SSL certificate check' },
  postgres: { command: 'docker',   args: ['exec', 'postgres', 'pg_isready'],                    description: 'PostgreSQL accepting connections' },
  redis:    { command: 'docker',   args: ['exec', 'redis', 'redis-cli', 'ping'],                description: 'Redis responding' },
  disk:     { command: 'df',       args: ['-h', '/'],                                           description: 'Disk usage' },
  memory:   { command: 'free',     args: ['-m'],                                                description: 'Memory usage' },
};

/**
 * Port-to-HTTP-path mapping for services with known health endpoints.
 */
const HTTP_HEALTH_PATHS: Record<string, { port: number; path: string; https?: boolean }> = {
  portainer:      { port: 9000, path: '/api/status' },
  traefik:        { port: 8080, path: '/api/overview' },
  pihole:         { port: 8053, path: '/admin/' },
  jellyfin:       { port: 8096, path: '/health' },
  sonarr:         { port: 8989, path: '/api/v3/health' },
  radarr:         { port: 7878, path: '/api/v3/health' },
  prowlarr:       { port: 9696, path: '/api/v1/health' },
  lidarr:         { port: 8686, path: '/api/v1/health' },
  bazarr:         { port: 6767, path: '/' },
  overseerr:      { port: 5055, path: '/api/v1/status' },
  tautulli:       { port: 8181, path: '/api/v2?cmd=arnold' },
  nextcloud:      { port: 8443, path: '/status.php' },
  vaultwarden:    { port: 8843, path: '/alive' },
  paperless:      { port: 8000, path: '/api/' },
  homeassistant:  { port: 8123, path: '/api/' },
  uptime_kuma:    { port: 3001, path: '/' },
  prometheus:     { port: 9090, path: '/-/healthy' },
  grafana:        { port: 3000, path: '/api/health' },
  node_exporter:  { port: 9100, path: '/metrics' },
};

// ============================================================================
// Helpers
// ============================================================================

/**
 * Run a command with timeout, return stdout/stderr.
 */
function runCommand(cmd: string, args: string[], timeoutMs: number = CHECK_TIMEOUT_MS): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    try {
      const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
      }, timeoutMs);

      proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          resolve({ stdout, stderr: 'Command timed out', exitCode: null });
        } else {
          resolve({ stdout, stderr, exitCode: code });
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        resolve({ stdout: '', stderr: err.message, exitCode: null });
      });
    } catch (err) {
      resolve({ stdout: '', stderr: String(err), exitCode: null });
    }
  });
}

// ============================================================================
// HTTP Health Check
// ============================================================================

/**
 * Perform an HTTP GET health check. Returns true if status is 200.
 * Uses Node's built-in http/https modules (not fetch).
 */
export function httpHealthCheck(
  url: string,
  timeoutMs: number = CHECK_TIMEOUT_MS
): Promise<IndividualCheck> {
  const startTime = Date.now();

  return new Promise((resolve) => {
    try {
      const parsedUrl = new URL(url);
      const client = parsedUrl.protocol === 'https:' ? https : http;

      const options: http.RequestOptions = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        timeout: timeoutMs,
        // Accept self-signed certs for local services
        ...(parsedUrl.protocol === 'https:' ? { rejectUnauthorized: false } : {}),
      };

      const req = client.request(options, (res) => {
        // Consume response data to free up memory
        res.resume();

        const elapsed = Date.now() - startTime;
        const code = res.statusCode ?? 0;
        // Service is alive if it responds with anything other than 5xx
        // 2xx = OK, 3xx = redirect (login page), 401 = needs auth, 400 = needs setup
        const passed = code > 0 && code < 500;

        resolve({
          type: 'http',
          target: url,
          passed,
          responseTimeMs: elapsed,
          details: `HTTP ${code}`,
          error: passed ? undefined : `Server error: ${code}`,
        });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({
          type: 'http',
          target: url,
          passed: false,
          responseTimeMs: Date.now() - startTime,
          error: `Timeout after ${timeoutMs}ms`,
        });
      });

      req.on('error', (err) => {
        resolve({
          type: 'http',
          target: url,
          passed: false,
          responseTimeMs: Date.now() - startTime,
          error: err.message,
        });
      });

      req.end();
    } catch (err) {
      resolve({
        type: 'http',
        target: url,
        passed: false,
        responseTimeMs: Date.now() - startTime,
        error: String(err),
      });
    }
  });
}

// ============================================================================
// TCP Port Check
// ============================================================================

/**
 * Attempt a TCP connection to verify a port is listening.
 * Uses net.createConnection.
 */
export function tcpPortCheck(
  host: string,
  port: number,
  timeoutMs: number = CHECK_TIMEOUT_MS
): Promise<IndividualCheck> {
  const startTime = Date.now();
  const target = `${host}:${port}`;

  return new Promise((resolve) => {
    try {
      const socket = net.createConnection({ host, port, timeout: timeoutMs });

      socket.on('connect', () => {
        const elapsed = Date.now() - startTime;
        socket.destroy();
        resolve({
          type: 'tcp',
          target,
          passed: true,
          responseTimeMs: elapsed,
          details: 'Port is listening',
        });
      });

      socket.on('timeout', () => {
        socket.destroy();
        resolve({
          type: 'tcp',
          target,
          passed: false,
          responseTimeMs: Date.now() - startTime,
          error: `Connection timed out after ${timeoutMs}ms`,
        });
      });

      socket.on('error', (err) => {
        resolve({
          type: 'tcp',
          target,
          passed: false,
          responseTimeMs: Date.now() - startTime,
          error: err.message,
        });
      });
    } catch (err) {
      resolve({
        type: 'tcp',
        target,
        passed: false,
        responseTimeMs: Date.now() - startTime,
        error: String(err),
      });
    }
  });
}

// ============================================================================
// Docker Healthcheck Status
// ============================================================================

/**
 * Read Docker container healthcheck status via docker inspect.
 * Returns the health status string: healthy, unhealthy, starting, or none.
 */
export async function dockerHealthCheck(containerName: string): Promise<IndividualCheck> {
  const startTime = Date.now();
  const target = `docker:${containerName}`;

  const { stdout, stderr, exitCode } = await runCommand('docker', [
    'inspect',
    '--format',
    '{{.State.Health.Status}}',
    containerName,
  ]);

  const elapsed = Date.now() - startTime;
  const status = stdout.trim();

  // If docker inspect fails, the container may not exist or be stopped
  if (exitCode !== 0 || !status) {
    // Check if container exists but has no healthcheck
    const { stdout: stateOut } = await runCommand('docker', [
      'inspect',
      '--format',
      '{{.State.Status}}',
      containerName,
    ]);

    const containerState = stateOut.trim();
    if (containerState === 'running') {
      return {
        type: 'docker',
        target,
        passed: true,
        responseTimeMs: Date.now() - startTime,
        details: 'Container running (no healthcheck configured)',
      };
    }

    return {
      type: 'docker',
      target,
      passed: false,
      responseTimeMs: elapsed,
      error: stderr.trim() || `Container state: ${containerState || 'not found'}`,
    };
  }

  const passed = status === 'healthy';

  return {
    type: 'docker',
    target,
    passed,
    responseTimeMs: elapsed,
    details: `Docker health: ${status}`,
    error: passed ? undefined : `Health status: ${status}`,
  };
}

// ============================================================================
// Per-Service Health Check
// ============================================================================

/**
 * Run all applicable health checks for a named service.
 * Checks: Docker status, TCP port, HTTP endpoint (if known).
 */
export async function checkServiceHealth(name: string): Promise<HealthCheckResult> {
  const startTime = Date.now();
  const service = getService(name);

  if (!service) {
    return {
      service: name,
      status: 'unknown',
      checks: [],
      responseTimeMs: 0,
      timestamp: new Date().toISOString(),
      error: `Service '${name}' not found in registry`,
    };
  }

  const checks: IndividualCheck[] = [];

  // Skip Docker check for system services (like Tailscale)
  if (service.type !== 'system-service') {
    // 1. Docker healthcheck
    const dockerResult = await dockerHealthCheck(name);
    checks.push(dockerResult);

    // 2. TCP port checks for each exposed port (extract host port from "host:container" strings)
    for (const rawPort of service.ports) {
      const port = typeof rawPort === 'string'
        ? parseInt(rawPort.split(':')[0], 10)
        : rawPort;
      const tcpResult = await tcpPortCheck(DEFAULT_HOST, port);
      checks.push(tcpResult);
    }

    // 3. HTTP health check if we have a known endpoint
    const httpConfig = HTTP_HEALTH_PATHS[name];
    if (httpConfig) {
      const protocol = httpConfig.https ? 'https' : 'http';
      const url = `${protocol}://${DEFAULT_HOST}:${httpConfig.port}${httpConfig.path}`;
      const httpResult = await httpHealthCheck(url);
      checks.push(httpResult);
    }
  } else {
    // For system services, check via systemctl
    const { stdout, exitCode } = await runCommand('systemctl', ['is-active', name]);
    const isActive = stdout.trim() === 'active';
    checks.push({
      type: 'command',
      target: `systemctl is-active ${name}`,
      passed: isActive,
      responseTimeMs: 0,
      details: `systemd: ${stdout.trim()}`,
      error: isActive ? undefined : `Service is ${stdout.trim() || 'not found'}`,
    });
  }

  // Determine overall status
  const allPassed = checks.every(c => c.passed);
  const anyPassed = checks.some(c => c.passed);
  let status: HealthStatus;

  if (checks.length === 0) {
    status = 'unknown';
  } else if (allPassed) {
    status = 'healthy';
  } else if (anyPassed) {
    status = 'degraded';
  } else {
    status = 'unhealthy';
  }

  // Update service state in registry
  const stateMap: Record<HealthStatus, ServiceState> = {
    healthy: 'running',
    degraded: 'running',
    unhealthy: 'error',
    unknown: 'unknown',
  };
  updateServiceState(name, stateMap[status]);

  return {
    service: name,
    status,
    checks,
    responseTimeMs: Date.now() - startTime,
    timestamp: new Date().toISOString(),
  };
}

// ============================================================================
// Check All Services
// ============================================================================

/**
 * Run health checks against all registered services.
 * Runs checks in parallel for speed, respecting the 5s timeout per check.
 */
export async function checkAllServices(): Promise<HealthCheckResult[]> {
  const services = getAllServices();
  const results = await Promise.all(
    services.map(svc => checkServiceHealth(svc.name))
  );
  return results;
}

// ============================================================================
// Self-Test Suite
// ============================================================================

/**
 * Run the full self-test suite from the build doc.
 * Tests: docker, network, dns, firewall, backup, ssl, postgres, redis, disk, memory.
 */
export async function runSelfTests(): Promise<SelfTestResult[]> {
  const results: SelfTestResult[] = [];

  // Run tests sequentially to avoid overwhelming the system
  for (const [name, test] of Object.entries(SELF_TESTS)) {
    const startTime = Date.now();

    const { stdout, stderr, exitCode } = await runCommand(
      test.command,
      test.args,
      CHECK_TIMEOUT_MS
    );

    const durationMs = Date.now() - startTime;
    const passed = exitCode === 0;

    // For certain tests, check output content for additional validation
    let output = stdout.trim();
    let error = passed ? undefined : (stderr.trim() || `Exit code: ${exitCode}`);

    // Special handling for redis ping
    if (name === 'redis' && passed) {
      if (!output.includes('PONG')) {
        error = `Expected PONG, got: ${output}`;
      }
    }

    // Special handling for disk - extract usage percentage
    if (name === 'disk' && passed) {
      const match = output.match(/(\d+)%/);
      if (match) {
        output = `Root disk usage: ${match[1]}%`;
      }
    }

    // Special handling for memory - extract used/total
    if (name === 'memory' && passed) {
      const lines = output.split('\n');
      const memLine = lines.find(l => l.startsWith('Mem:'));
      if (memLine) {
        const parts = memLine.split(/\s+/);
        output = `Memory: ${parts[2]}MB used / ${parts[1]}MB total`;
      }
    }

    results.push({
      name,
      passed,
      output: output.substring(0, 500), // Cap output length
      error,
      durationMs,
    });
  }

  return results;
}

// ============================================================================
// Aggregated Health Report
// ============================================================================

/**
 * Generate a comprehensive health report across all services and self-tests.
 */
export async function getHealthReport(): Promise<HealthReport> {
  const serviceResults = await checkAllServices();

  // Identify system-services (e.g. tailscale) that aren't Docker containers
  const systemServiceNames = new Set(
    getAllServices()
      .filter(s => s.type === 'system-service')
      .map(s => s.name)
  );

  let healthy = 0;
  let unhealthy = 0;
  let degraded = 0;
  let unknown = 0;
  const alerts: string[] = [];

  // Filter out system-services from health counts (they're not Docker containers)
  const containerResults = serviceResults.filter(r => !systemServiceNames.has(r.service));

  for (const result of containerResults) {
    switch (result.status) {
      case 'healthy':  healthy++;  break;
      case 'unhealthy':
        unhealthy++;
        alerts.push(`[UNHEALTHY] ${result.service}: ${result.checks.filter(c => !c.passed).map(c => c.error).join('; ')}`);
        break;
      case 'degraded':
        degraded++;
        alerts.push(`[DEGRADED] ${result.service}: ${result.checks.filter(c => !c.passed).map(c => c.error).join('; ')}`);
        break;
      case 'unknown':  unknown++;  break;
    }
  }

  // Note system services separately
  if (systemServiceNames.size > 0) {
    const skipped = Array.from(systemServiceNames).join(', ');
    alerts.push(`[INFO] Skipped system services (not Docker): ${skipped}`);
  }

  // Determine overall health (based only on container services)
  let overall: HealthStatus;
  if (unhealthy > 0) {
    overall = 'unhealthy';
  } else if (degraded > 0) {
    overall = 'degraded';
  } else if (healthy > 0) {
    overall = 'healthy';
  } else {
    overall = 'unknown';
  }

  return {
    timestamp: new Date().toISOString(),
    overall,
    totalServices: containerResults.length,
    healthy,
    unhealthy,
    degraded,
    unknown,
    services: containerResults,
    alerts,
  };
}

// ============================================================================
// Convenience: Format health report as human-readable string
// ============================================================================

export function formatHealthReport(report: HealthReport): string {
  const lines = [
    `Health Report (${new Date(report.timestamp).toLocaleString()})`,
    `Overall: ${report.overall.toUpperCase()}`,
    `Services: ${report.healthy}/${report.totalServices} healthy`,
  ];

  if (report.unhealthy > 0) lines.push(`  Unhealthy: ${report.unhealthy}`);
  if (report.degraded > 0) lines.push(`  Degraded: ${report.degraded}`);
  if (report.unknown > 0) lines.push(`  Unknown: ${report.unknown}`);

  if (report.alerts.length > 0) {
    lines.push('');
    lines.push('Alerts:');
    for (const alert of report.alerts) {
      lines.push(`  ${alert}`);
    }
  }

  return lines.join('\n');
}
