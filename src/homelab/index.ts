/**
 * Homelab Module Router
 * 
 * Central entry point for all homelab operations.
 * Routes homelab actions to the appropriate module.
 * 
 * SAFETY:
 * - Platform guard: refuses to run on non-Linux unless HOMELAB_DEV_MODE
 * - Config guard: requires homelab.enabled = true
 * - Trust gating: actions require minimum trust levels
 */

import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { isHomelabAvailable, getAuditReport } from './shell.js';
import type { ParsedIntent, ExecutionResult } from '../types/index.js';

// ============================================================================
// Trust level requirements for homelab actions
// ============================================================================

const TRUST_REQUIREMENTS: Record<string, number> = {
  // Read-only operations: trust level 2+ (semi-autonomous)
  homelab_status: 2,
  homelab_containers: 2,
  homelab_resources: 2,
  homelab_temps: 2,
  homelab_logs: 2,
  homelab_stacks: 2,
  homelab_health: 2,
  homelab_self_test: 2,
  homelab_security_status: 2,

  // Service control: trust level 3+ (trusted)
  homelab_service_start: 3,
  homelab_service_stop: 3,
  homelab_service_restart: 3,
  homelab_update: 3,
  homelab_diagnose: 3,
  homelab_firewall: 3,

  // Destructive/install operations: trust level 4+ (autonomous)
  homelab_install: 2,
  homelab_uninstall: 3,
  homelab_update_all: 3,
};

// ============================================================================
// Module imports (lazy-loaded to avoid issues on Windows)
// ============================================================================

async function getResourceMonitor() {
  return await import('./system/resource-monitor.js');
}

async function getContainerMonitor() {
  return await import('./docker/container-monitor.js');
}

async function getComposeManager() {
  return await import('./docker/compose-manager.js');
}

async function getRegistry() {
  return await import('./services/registry.js');
}

async function getHealthChecker() {
  return await import('./services/health-checker.js');
}

async function getInstaller() {
  return await import('./services/installer.js');
}

async function getFirewall() {
  return await import('./security/firewall.js');
}

async function getSSHHardening() {
  return await import('./security/ssh-hardening.js');
}

async function getSecurityAudit() {
  return await import('./security/audit.js');
}

async function getSSL() {
  return await import('./security/ssl.js');
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Check if homelab mode is enabled and available
 */
export function isHomelabEnabled(): boolean {
  return isHomelabAvailable();
}

/**
 * Get the minimum trust level required for an action
 */
export function getRequiredTrustLevel(action: string): number {
  return TRUST_REQUIREMENTS[action] || 2;
}

/**
 * Execute a homelab action
 */
export async function executeHomelabAction(
  intent: ParsedIntent,
  trustLevel: number
): Promise<ExecutionResult> {
  const startTime = Date.now();

  // Platform/config guard
  if (!isHomelabAvailable()) {
    return {
      success: false,
      output: 'Homelab mode is not available. Requires Linux with homelab.enabled = true in config.',
      duration_ms: Date.now() - startTime
    };
  }

  // Trust level gate
  const requiredTrust = getRequiredTrustLevel(intent.action);
  if (trustLevel < requiredTrust) {
    return {
      success: false,
      output: `This action requires trust level ${requiredTrust} (${getTrustName(requiredTrust)}). Current level: ${trustLevel}.`,
      duration_ms: Date.now() - startTime
    };
  }

  const serviceName = intent.target || intent.data?.service as string || '';

  try {
    switch (intent.action) {
      case 'homelab_status':
        return await handleStatus();

      case 'homelab_containers':
        return await handleContainers();

      case 'homelab_resources':
        return await handleResources();

      case 'homelab_temps':
        return await handleTemps();

      case 'homelab_logs':
        return await handleLogs(serviceName, intent.data?.lines as number);

      case 'homelab_service_start':
        return await handleServiceControl('start', serviceName);

      case 'homelab_service_stop':
        return await handleServiceControl('stop', serviceName);

      case 'homelab_service_restart':
        return await handleServiceControl('restart', serviceName);

      case 'homelab_update':
        return await handleUpdate(serviceName);

      case 'homelab_update_all':
        return await handleUpdateAll();

      case 'homelab_stacks':
        return await handleStacks();

      case 'homelab_health':
        return await handleHealth();

      case 'homelab_self_test':
        return await handleSelfTest();

      case 'homelab_diagnose':
        return await handleDiagnose(serviceName);

      case 'homelab_install':
        return await handleInstall(serviceName);

      case 'homelab_uninstall':
        return await handleUninstall(serviceName);

      case 'homelab_security_status':
        return await handleSecurityStatus();

      case 'homelab_firewall':
        return await handleFirewall(intent.data?.subcommand as string, intent.data?.port as number, intent.data?.proto as string);

      default:
        return {
          success: false,
          output: `Unknown homelab action: ${intent.action}`,
          duration_ms: Date.now() - startTime
        };
    }
  } catch (error) {
    logger.error('Homelab action failed', { action: intent.action, error: String(error) });
    return {
      success: false,
      error: `Homelab error: ${error instanceof Error ? error.message : String(error)}`,
      duration_ms: Date.now() - startTime
    };
  }
}

// ============================================================================
// Action Handlers
// ============================================================================

async function handleStatus(): Promise<ExecutionResult> {
  const startTime = Date.now();
  const resourceMon = await getResourceMonitor();
  const containerMon = await getContainerMonitor();

  const [sysStatus, containers] = await Promise.all([
    resourceMon.getSystemStatus(),
    containerMon.listContainers()
  ]);

  const runningCount = containers.filter((c: { state: string }) => c.state === 'running').length;
  const totalCount = containers.length;

  let output = '## Daemon Status\n\n';
  output += `**CPU:** ${sysStatus.cpu.usagePercent.toFixed(0)}% | **Load:** ${sysStatus.cpu.loadAverage.join(', ')}\n`;
  output += `**RAM:** ${sysStatus.ram.usedMB}/${sysStatus.ram.totalMB}MB (${sysStatus.ram.usagePercent.toFixed(0)}%)\n`;

  // Disk may be { partitions: [...] } from resource-monitor
  const diskList = sysStatus.disk?.partitions || [];
  for (const d of diskList) {
    const mount = d.mountpoint || '/';
    const totalGB = (d.sizeMB / 1024).toFixed(1);
    const usedGB = (d.usedMB / 1024).toFixed(1);
    output += `**Disk (${mount}):** ${usedGB}/${totalGB}GB (${d.usagePercent.toFixed(0)}%)\n`;
  }

  if (sysStatus.temperature) {
    output += `**Temp:** ${sysStatus.temperature.celcius}°C\n`;
  }

  output += `**Containers:** ${runningCount}/${totalCount} running\n`;

  // Check thresholds
  const alerts = resourceMon.checkThresholds(sysStatus);
  if (alerts.length > 0) {
    output += '\n### Alerts\n';
    for (const alert of alerts) {
      const icon = alert.level === 'critical' ? '🚨' : '⚠️';
      output += `${icon} ${alert.message}\n`;
    }
  }

  return { success: true, output, duration_ms: Date.now() - startTime };
}

async function handleContainers(): Promise<ExecutionResult> {
  const startTime = Date.now();
  const containerMon = await getContainerMonitor();
  const containers = await containerMon.listContainers();

  if (containers.length === 0) {
    return { success: true, output: 'No containers found.', duration_ms: Date.now() - startTime };
  }

  let output = '## Containers\n\n';
  output += '| Name | State | Status | Ports |\n';
  output += '|------|-------|--------|-------|\n';
  for (const c of containers) {
    const stateIcon = c.state === 'running' ? '🟢' : c.state === 'exited' ? '🔴' : '🟡';
    const portsStr = c.ports || '-';
    output += `| ${stateIcon} ${c.name} | ${c.state} | ${c.status} | ${portsStr} |\n`;
  }

  return { success: true, output, duration_ms: Date.now() - startTime };
}

async function handleResources(): Promise<ExecutionResult> {
  const startTime = Date.now();
  const resourceMon = await getResourceMonitor();
  const status = await resourceMon.getSystemStatus();

  let output = '## System Resources\n\n';
  output += `**CPU:** ${status.cpu.usagePercent.toFixed(1)}% | Cores: ${status.cpu.cores} | Load: ${status.cpu.loadAverage.join(', ')}\n`;
  output += `**RAM:** ${status.ram.usedMB}MB / ${status.ram.totalMB}MB (${status.ram.usagePercent.toFixed(1)}%)\n`;
  output += `**Free:** ${status.ram.availableMB}MB available\n\n`;

  output += '### Disk Usage\n';
  for (const d of status.disk?.partitions || []) {
    const mount = d.mountpoint || '/';
    const totalGB = (d.sizeMB / 1024).toFixed(1);
    const usedGB = (d.usedMB / 1024).toFixed(1);
    const bar = makeBar(d.usagePercent);
    output += `${mount}: ${bar} ${d.usagePercent.toFixed(0)}% (${usedGB}/${totalGB}GB)\n`;
  }

  return { success: true, output, duration_ms: Date.now() - startTime };
}

async function handleTemps(): Promise<ExecutionResult> {
  const startTime = Date.now();
  const resourceMon = await getResourceMonitor();
  const temp = await resourceMon.getTemperature();

  if (!temp) {
    return { success: true, output: 'Temperature sensor not available.', duration_ms: Date.now() - startTime };
  }

  // Agent 3 uses 'celcius' (typo) not 'celsius'
  const tempC = temp.celcius;
  const thresholds = config.homelab.thresholds.temp;
  const status = tempC >= thresholds.critical ? 'critical' : tempC >= thresholds.warning ? 'warning' : 'normal';
  const icon = status === 'critical' ? '🔥' : status === 'warning' ? '⚠️' : '✅';
  return {
    success: true,
    output: `${icon} CPU Temperature: **${tempC}°C** (${status})`,
    duration_ms: Date.now() - startTime
  };
}

async function handleLogs(serviceName: string, lines?: number): Promise<ExecutionResult> {
  const startTime = Date.now();
  if (!serviceName) {
    return { success: false, output: 'Please specify a service name. Usage: `logs <service>`', duration_ms: Date.now() - startTime };
  }

  const containerMon = await getContainerMonitor();
  const logResult = await containerMon.getContainerLogs(serviceName, lines || 50);
  
  // getContainerLogs returns { name, lines[], lineCount, truncated }
  const logText = Array.isArray(logResult.lines) ? logResult.lines.join('\n') : String(logResult);

  return {
    success: true,
    output: `## Logs: ${serviceName}\n\n\`\`\`\n${logText}\n\`\`\``,
    duration_ms: Date.now() - startTime
  };
}

async function handleServiceControl(action: 'start' | 'stop' | 'restart', serviceName: string): Promise<ExecutionResult> {
  const startTime = Date.now();
  if (!serviceName) {
    return { success: false, output: `Please specify a service name. Usage: \`${action} <service>\``, duration_ms: Date.now() - startTime };
  }

  const containerMon = await getContainerMonitor();

  let result;
  switch (action) {
    case 'start':
      result = await containerMon.startContainer(serviceName);
      break;
    case 'stop':
      result = await containerMon.stopContainer(serviceName);
      break;
    case 'restart':
      result = await containerMon.restartContainer(serviceName);
      break;
  }

  return {
    success: result.success,
    output: result.success
      ? `✅ ${serviceName} ${action}ed successfully`
      : `❌ Failed to ${action} ${serviceName}: ${result.error || result.output || 'Unknown error'}`,
    duration_ms: Date.now() - startTime
  };
}

async function handleUpdate(serviceName: string): Promise<ExecutionResult> {
  const startTime = Date.now();
  if (!serviceName) {
    return { success: false, output: 'Please specify a service name. Usage: `update <service>`', duration_ms: Date.now() - startTime };
  }

  const { execHomelab } = await import('./shell.js');
  const containerMon = await getContainerMonitor();

  // Pull new image via docker pull
  const pullResult = await execHomelab('docker', ['pull', serviceName], { timeout: 120000 });
  if (!pullResult.success) {
    // Try docker compose pull for compose-managed services
    const composePull = await execHomelab('docker', ['compose', '-f', `${config.homelab.stacksDir}/${serviceName}/docker-compose.yml`, 'pull'], { timeout: 120000 });
    if (!composePull.success) {
      return { success: false, output: `Failed to pull image for ${serviceName}: ${pullResult.stderr}`, duration_ms: Date.now() - startTime };
    }
  }

  // Restart the container to use the new image
  const restartResult = await containerMon.restartContainer(serviceName);

  return {
    success: restartResult.success,
    output: restartResult.success
      ? `✅ ${serviceName} updated and restarted`
      : `⚠️ Image pulled but restart failed: ${restartResult.error || restartResult.output || 'Unknown error'}`,
    duration_ms: Date.now() - startTime
  };
}

async function handleUpdateAll(): Promise<ExecutionResult> {
  const startTime = Date.now();

  const installer = await getInstaller();
  const result = await installer.updateAllServices();

  let output = '## Bulk Update Results\n\n';
  if (result.updated.length > 0) {
    output += `**Updated (${result.updated.length}):** ${result.updated.join(', ')}\n`;
  }
  if (result.failed.length > 0) {
    output += `**Failed (${result.failed.length}):** ${result.failed.join(', ')}\n`;
  }
  if (result.skipped.length > 0) {
    output += `**Skipped (${result.skipped.length}):** ${result.skipped.join(', ')}\n`;
  }
  output += `\nCompleted in ${(result.duration_ms / 1000).toFixed(1)}s`;

  return { success: result.success, output, duration_ms: Date.now() - startTime };
}

async function handleStacks(): Promise<ExecutionResult> {
  const startTime = Date.now();
  const composeMgr = await getComposeManager();
  const stacks = await composeMgr.listStacks();

  if (stacks.length === 0) {
    return { success: true, output: 'No stacks found.', duration_ms: Date.now() - startTime };
  }

  let output = '## Docker Compose Stacks\n\n';
  for (const stack of stacks) {
    const icon = stack.running ? '🟢' : '🔴';
    const name = stack.stackName;
    const path = stack.composePath;
    const svcNames = (stack.services || []).map((s: { name: string }) => s.name);
    output += `${icon} **${name}** (${svcNames.length} services)\n`;
    output += `   Path: ${path}\n`;
    output += `   Services: ${svcNames.join(', ')}\n\n`;
  }

  return { success: true, output, duration_ms: Date.now() - startTime };
}

async function handleHealth(): Promise<ExecutionResult> {
  const startTime = Date.now();
  const healthChecker = await getHealthChecker();
  const report = await healthChecker.getHealthReport();

  // HealthReport is an object - format it, or use formatHealthReport if available
  let output: string;
  if (typeof report === 'string') {
    output = report;
  } else if (healthChecker.formatHealthReport) {
    output = healthChecker.formatHealthReport(report);
  } else {
    output = `## Health Report\n\n`;
    output += `**Overall:** ${report.overall} | ${report.healthy}/${report.totalServices} healthy\n`;
    if (report.alerts?.length > 0) {
      output += '\n### Alerts\n';
      for (const a of report.alerts) output += `⚠️ ${a}\n`;
    }
    output += '\n### Services\n';
    for (const svc of report.services || []) {
      const icon = svc.status === 'healthy' ? '✅' : svc.status === 'unhealthy' ? '❌' : '⚠️';
      output += `${icon} **${svc.service}**: ${svc.status}\n`;
    }
  }

  return { success: true, output, duration_ms: Date.now() - startTime };
}

async function handleSelfTest(): Promise<ExecutionResult> {
  const startTime = Date.now();
  const healthChecker = await getHealthChecker();
  const results = await healthChecker.runSelfTests();

  let output = '## Self-Test Results\n\n';
  let passed = 0;
  let failed = 0;

  // runSelfTests returns SelfTestResult[]
  for (const result of results) {
    if (result.passed) {
      passed++;
      output += `✅ **${result.name}**: ${(result.output || '').substring(0, 100)}\n`;
    } else {
      failed++;
      output += `❌ **${result.name}**: ${result.error || 'Failed'}\n`;
    }
  }

  output += `\n**${passed} passed, ${failed} failed**`;

  return { success: failed === 0, output, duration_ms: Date.now() - startTime };
}

async function handleDiagnose(serviceName: string): Promise<ExecutionResult> {
  const startTime = Date.now();
  if (!serviceName) {
    return { success: false, output: 'Please specify a service name. Usage: `diagnose <service>`', duration_ms: Date.now() - startTime };
  }

  const containerMon = await getContainerMonitor();
  const healthChecker = await getHealthChecker();

  let output = `## Diagnostics: ${serviceName}\n\n`;

  // Container state
  const containers = await containerMon.listContainers();
  const container = containers.find((c: { name: string }) => c.name === serviceName);

  if (!container) {
    output += '❌ Container not found\n';
    return { success: false, output, duration_ms: Date.now() - startTime };
  }

  output += `**State:** ${container.state}\n`;
  output += `**Status:** ${container.status}\n`;
  output += `**Image:** ${container.image}\n`;
  output += `**Uptime:** ${container.uptime || 'N/A'}\n\n`;

  // Resource usage
  const stats = await containerMon.getContainerStats();
  const statsList = Array.isArray(stats) ? stats : [];
  const stat = statsList.find((s: { name: string }) => s.name === serviceName);
  if (stat) {
    output += `**CPU:** ${stat.cpuPercent}\n`;
    output += `**Memory:** ${stat.memUsage} / ${stat.memLimit} (${stat.memPercent})\n\n`;
  }

  // Health check
  const health = await healthChecker.checkServiceHealth(serviceName);
  output += '### Health Checks\n';
  for (const check of health.checks || []) {
    const icon = check.passed ? '✅' : '❌';
    output += `${icon} ${check.type}: ${check.target}`;
    if (check.responseTimeMs) output += ` (${check.responseTimeMs}ms)`;
    if (check.error) output += ` - ${check.error}`;
    output += '\n';
  }

  // Recent logs
  output += '\n### Recent Logs (last 10 lines)\n```\n';
  const logResult = await containerMon.getContainerLogs(serviceName, 10);
  const logLines = Array.isArray(logResult.lines) ? logResult.lines.join('\n') : String(logResult);
  output += logLines;
  output += '\n```\n';

  return { success: true, output, duration_ms: Date.now() - startTime };
}

async function handleInstall(serviceName: string): Promise<ExecutionResult> {
  const startTime = Date.now();
  if (!serviceName) {
    return { success: false, output: 'Please specify a service name. Usage: `install <service>`', duration_ms: Date.now() - startTime };
  }

  const installer = await getInstaller();
  const result = await installer.installService(serviceName);

  let output = result.success
    ? `✅ ${serviceName} installed successfully.\n${result.message}`
    : `❌ Failed to install ${serviceName}: ${result.message}`;

  if (result.warnings.length > 0) {
    output += '\n\n**Warnings:**\n' + result.warnings.map(w => `⚠️ ${w}`).join('\n');
  }

  return { success: result.success, output, duration_ms: Date.now() - startTime };
}

async function handleUninstall(serviceName: string): Promise<ExecutionResult> {
  const startTime = Date.now();
  if (!serviceName) {
    return { success: false, output: 'Please specify a service name. Usage: `uninstall <service>`', duration_ms: Date.now() - startTime };
  }

  const installer = await getInstaller();
  const result = await installer.uninstallService(serviceName);

  let output = result.success
    ? `✅ ${serviceName} uninstalled. Data volumes preserved.`
    : `❌ Failed to uninstall ${serviceName}: ${result.message}`;

  if (result.warnings.length > 0) {
    output += '\n\n**Warnings:**\n' + result.warnings.map(w => `⚠️ ${w}`).join('\n');
  }

  return { success: result.success, output, duration_ms: Date.now() - startTime };
}

// ============================================================================
// Security Handlers
// ============================================================================

async function handleSecurityStatus(): Promise<ExecutionResult> {
  const startTime = Date.now();
  const [firewallMod, sshMod, auditMod, sslMod] = await Promise.all([
    getFirewall(),
    getSSHHardening(),
    getSecurityAudit(),
    getSSL()
  ]);

  const [fwReport, sshReport, auditReport, sslReport] = await Promise.all([
    firewallMod.getFirewallReport().catch(() => 'Firewall check unavailable'),
    sshMod.getSSHReport().catch(() => 'SSH check unavailable'),
    auditMod.getSecurityAuditReport().catch(() => 'Audit check unavailable'),
    sslMod.getSSLReport().catch(() => 'SSL check unavailable')
  ]);

  const output = `## Security Status\n\n${fwReport}\n\n---\n\n${sshReport}\n\n---\n\n${sslReport}\n\n---\n\n${auditReport}`;

  return { success: true, output, duration_ms: Date.now() - startTime };
}

async function handleFirewall(subcommand?: string, port?: number, proto?: string): Promise<ExecutionResult> {
  const startTime = Date.now();
  const firewallMod = await getFirewall();

  if (!subcommand || subcommand === 'status') {
    const report = await firewallMod.getFirewallReport();
    return { success: true, output: report, duration_ms: Date.now() - startTime };
  }

  if (subcommand === 'allow' && port) {
    const result = await firewallMod.allowPort(port, proto || 'tcp', `Allowed by Jeeves`);
    return { success: result.success, output: result.message, duration_ms: Date.now() - startTime };
  }

  if (subcommand === 'deny' && port) {
    const result = await firewallMod.denyPort(port);
    return { success: result.success, output: result.message, duration_ms: Date.now() - startTime };
  }

  return { success: false, output: 'Usage: `firewall status`, `firewall allow <port>`, `firewall deny <port>`', duration_ms: Date.now() - startTime };
}

// ============================================================================
// Dashboard Data Export
// ============================================================================

/**
 * Get aggregated dashboard status for the web UI
 */
export async function getDashboardStatus(): Promise<Record<string, unknown>> {
  if (!isHomelabAvailable()) {
    return { enabled: false, resources: null, services: [], health: { healthy: 0, unhealthy: 0, unknown: 0, total: 0 }, security: null, alerts: [], timestamp: new Date().toISOString() };
  }

  try {
    const resourceMon = await getResourceMonitor();
    const containerMon = await getContainerMonitor();
    const registry = await getRegistry();

    const [sysStatus, containers] = await Promise.all([
      resourceMon.getSystemStatus().catch(() => null),
      containerMon.listContainers().catch(() => [])
    ]);

    // Map containers to service statuses
    const allServices = registry.getAllServices();
    const services = allServices.map(svc => {
      const container = containers.find((c: { name: string }) =>
        c.name === svc.name || c.name === svc.name.replace(/_/g, '-')
      );
      return {
        name: svc.name,
        tier: svc.tier,
        priority: svc.priority,
        state: container ? (container.state === 'running' ? 'running' : container.state) : 'stopped',
        image: svc.image,
        ramMB: svc.ramMB,
        ports: svc.ports,
        purpose: svc.purpose,
        uptime: container?.status || undefined,
        memUsage: undefined as string | undefined,
      };
    });

    // Container stats (optional, might be slow)
    try {
      const stats = await containerMon.getContainerStats();
      const statsList = Array.isArray(stats) ? stats : [];
      for (const stat of statsList) {
        const svc = services.find(s => s.name === stat.name);
        if (svc) {
          svc.memUsage = stat.memUsage;
        }
      }
    } catch { /* skip stats on error */ }

    // Build resources
    let resources = null;
    if (sysStatus) {
      const diskList = sysStatus.disk?.partitions || [];
      resources = {
        cpu: { usagePercent: sysStatus.cpu.usagePercent, cores: sysStatus.cpu.cores, loadAverage: sysStatus.cpu.loadAverage },
        ram: { totalMB: sysStatus.ram.totalMB, usedMB: sysStatus.ram.usedMB, usagePercent: sysStatus.ram.usagePercent },
        disk: diskList.map((d: { mountpoint?: string; sizeMB: number; usedMB: number; usagePercent: number }) => ({
          mountPoint: d.mountpoint || '/',
          totalGB: +(d.sizeMB / 1024).toFixed(1),
          usedGB: +(d.usedMB / 1024).toFixed(1),
          usagePercent: d.usagePercent
        })),
        temperature: sysStatus.temperature ? {
          celsius: sysStatus.temperature.celcius,
          status: sysStatus.temperature.celcius >= config.homelab.thresholds.temp.critical ? 'critical' as const
            : sysStatus.temperature.celcius >= config.homelab.thresholds.temp.warning ? 'warning' as const
            : 'normal' as const
        } : null
      };
    }

    // Health counts
    const running = services.filter(s => s.state === 'running').length;
    const stopped = services.filter(s => s.state === 'stopped').length;
    const errored = services.filter(s => s.state === 'error').length;

    // Alerts
    const alerts: string[] = [];
    if (sysStatus) {
      const thresholdAlerts = resourceMon.checkThresholds(sysStatus);
      for (const a of thresholdAlerts) {
        alerts.push(`${a.level.toUpperCase()}: ${a.message}`);
      }
    }

    // Security summary (lightweight)
    let security = null;
    try {
      const firewallMod = await getFirewall();
      const fwStatus = await firewallMod.getFirewallStatus();
      security = {
        firewallActive: fwStatus.active,
        sshHardened: false,
        certsValid: 0,
        certsExpiring: 0,
        lastAuditCommand: null as string | null,
      };
    } catch { /* security info not critical */ }

    return {
      enabled: true,
      resources,
      services,
      health: { healthy: running, unhealthy: errored, unknown: stopped, total: allServices.length },
      security,
      alerts,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    logger.error('Failed to build dashboard status', { error: String(error) });
    return { enabled: true, resources: null, services: [], health: { healthy: 0, unhealthy: 0, unknown: 0, total: 0 }, security: null, alerts: ['Failed to fetch status'], timestamp: new Date().toISOString() };
  }
}

// ============================================================================
// Helpers
// ============================================================================

function getTrustName(level: number): string {
  const names = ['', 'supervised', 'semi-autonomous', 'trusted', 'autonomous', 'full-trust'];
  return names[level] || 'unknown';
}

function makeBar(percent: number, width = 20): string {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

/**
 * Get the audit report for display
 */
export { getAuditReport };
