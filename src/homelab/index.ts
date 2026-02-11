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
  homelab_system_review: 2,
  homelab_containers: 2,
  homelab_resources: 2,
  homelab_temps: 2,
  homelab_logs: 2,
  homelab_stacks: 2,
  homelab_health: 2,
  homelab_self_test: 2,
  homelab_security_status: 2,
  homelab_report: 2,

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

  // Backup commands
  homelab_backup: 3,          // Running backups: trusted
  homelab_backup_status: 2,   // Viewing status: semi-autonomous
  homelab_backup_list: 2,     // Listing backups: semi-autonomous
  homelab_backup_restore: 4,  // Restoring data: autonomous (destructive)
  homelab_backup_schedule: 3, // Installing timer: trusted

  // Media commands: trust level 2+ (semi-autonomous)
  media_search: 2,
  media_download: 2,
  media_select: 2,
  media_more: 2,
  media_status: 2,
  music_indexer_status: 2,

  // System monitoring: trust level 2+ (read-only)
  disk_health: 2,
  docker_cleanup: 3,   // Actually modifies system
  log_errors: 2,
  pihole_stats: 2,
  speed_test: 2,
  image_updates: 2,
  ssl_check: 2,
  service_deps: 2,

  // Integrations: trust level 2+
  home_assistant: 2,
  tailscale_status: 2,
  nextcloud_status: 2,
  nextcloud_upload: 3,
  grafana_dashboards: 2,
  grafana_snapshot: 2,
  uptime_kuma: 2,
  bandwidth: 2,
  qbittorrent_status: 2,
  qbittorrent_add: 2,
  deploy_gluetun_stack: 3,

  // Productivity: trust level 2+
  note_add: 2,
  note_search: 2,
  note_list: 2,
  reminder_set: 2,
  reminder_list: 2,
  schedule_create: 2,
  schedule_list: 2,
  schedule_delete: 2,
  timeline: 2,
  quiet_hours: 2,
  quiet_hours_set: 2,
  file_share: 3,
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

async function getMediaSearch() {
  return await import('./media/search.js');
}

async function getBackupManager() {
  return await import('./backup/backup-manager.js');
}

async function getBackupSchedule() {
  return await import('./backup/setup-schedule.js');
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

      case 'homelab_system_review':
        return await handleSystemReview();

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

      case 'homelab_report':
        return await handleHomelabReport();

      case 'homelab_firewall':
        return await handleFirewall(intent.data?.subcommand as string, intent.data?.port as number, intent.data?.proto as string);

      case 'homelab_backup':
        return await handleBackup(intent.data?.mode as string);

      case 'homelab_backup_status':
        return await handleBackupStatus();

      case 'homelab_backup_list':
        return await handleBackupList();

      case 'homelab_backup_restore':
        return await handleBackupRestore(serviceName);

      case 'homelab_backup_schedule':
        return await handleBackupSchedule();

      case 'media_search':
        return await handleMediaSearch(serviceName);

      case 'media_download':
        return await handleMediaDownload(serviceName);

      case 'media_download_from_image':
        return await handleMediaDownloadFromImage(intent);

      case 'media_select':
        return await handleMediaSelect(serviceName);

      case 'media_more':
        return await handleMediaMore();

      case 'media_status':
        return await handleMediaStatus();

      // ===== SYSTEM MONITORING =====

      case 'disk_health': {
        const { getSmartHealth, formatSmartReport } = await import('./system/smart-monitor.js');
        const report = await getSmartHealth();
        return { success: true, output: formatSmartReport(report), duration_ms: Date.now() - startTime };
      }

      case 'docker_cleanup': {
        const { runCleanup } = await import('./system/docker-cleanup.js');
        const result = await runCleanup();
        return { success: result.success, output: result.message, duration_ms: Date.now() - startTime };
      }

      case 'log_errors': {
        const { scanContainerLogs, formatLogScan } = await import('./system/log-scanner.js');
        const result = await scanContainerLogs(60);
        return { success: true, output: formatLogScan(result), duration_ms: Date.now() - startTime };
      }

      case 'pihole_stats': {
        const { getPiholeStats, formatPiholeStats } = await import('./system/pihole-stats.js');
        const stats = await getPiholeStats();
        if (!stats) return { success: false, error: 'Pi-hole not configured. Set PIHOLE_API_KEY in .env.', duration_ms: Date.now() - startTime };
        return { success: true, output: formatPiholeStats(stats), duration_ms: Date.now() - startTime };
      }

      case 'speed_test': {
        const { runSpeedTest, getSpeedHistory, formatSpeedResult } = await import('./system/speed-test.js');
        const result = await runSpeedTest();
        const history = getSpeedHistory();
        return { success: !!result, output: formatSpeedResult(result, history), duration_ms: Date.now() - startTime };
      }

      case 'image_updates': {
        const { checkImageUpdates, formatUpdateCheck } = await import('./system/image-updates.js');
        const result = await checkImageUpdates();
        return { success: true, output: formatUpdateCheck(result), duration_ms: Date.now() - startTime };
      }

      case 'ssl_check': {
        const { checkCertificates, formatCertReport } = await import('./system/ssl-monitor.js');
        const report = await checkCertificates();
        return { success: true, output: formatCertReport(report), duration_ms: Date.now() - startTime };
      }

      case 'service_deps': {
        const { formatDependencies } = await import('./system/dependency-map.js');
        const target = intent.target || '';
        if (!target) return { success: false, error: 'Which service? E.g., "deps for sonarr" or "what depends on postgres"', duration_ms: Date.now() - startTime };
        return { success: true, output: formatDependencies(target), duration_ms: Date.now() - startTime };
      }

      // ===== INTEGRATIONS =====

      case 'home_assistant': {
        const { handleHACommand } = await import('./integrations/home-assistant.js');
        const result = await handleHACommand(intent.target || '');
        return { success: true, output: result, duration_ms: Date.now() - startTime };
      }

      case 'tailscale_status': {
        const { getTailscaleStatus, formatTailscaleStatus } = await import('./integrations/tailscale.js');
        const status = await getTailscaleStatus();
        return { success: true, output: formatTailscaleStatus(status), duration_ms: Date.now() - startTime };
      }

      case 'nextcloud_status': {
        const { getStorageInfo, formatStorageInfo } = await import('./integrations/nextcloud.js');
        const info = await getStorageInfo();
        return { success: true, output: formatStorageInfo(info), duration_ms: Date.now() - startTime };
      }

      case 'nextcloud_upload': {
        const { uploadFile } = await import('./integrations/nextcloud.js');
        const parts = (intent.target || '').split(' to ');
        const localPath = parts[0]?.trim() || '';
        const remotePath = parts[1]?.trim() || localPath.split('/').pop() || 'upload';
        const ok = await uploadFile(localPath, remotePath);
        return { success: ok, output: ok ? `Uploaded to Nextcloud: ${remotePath}` : 'Upload failed', duration_ms: Date.now() - startTime };
      }

      case 'grafana_dashboards': {
        const { listDashboards, formatDashboardList } = await import('./integrations/grafana.js');
        const dashboards = await listDashboards();
        return { success: true, output: formatDashboardList(dashboards), duration_ms: Date.now() - startTime };
      }

      case 'grafana_snapshot': {
        const { listDashboards, renderPanel } = await import('./integrations/grafana.js');
        const dashboards = await listDashboards();
        const target = intent.target || '';
        const match = dashboards.find(d => d.title.toLowerCase().includes(target.toLowerCase()) || d.uid === target);
        if (!match) return { success: false, error: `Dashboard not found: ${target}. Use 'grafana' to list.`, duration_ms: Date.now() - startTime };
        const path = await renderPanel(match.uid);
        if (!path) return { success: false, error: 'Grafana render failed. Is the image renderer plugin installed?', duration_ms: Date.now() - startTime };
        return { success: true, output: `Grafana snapshot: ${match.title}`, duration_ms: Date.now() - startTime, attachments: [path] };
      }

      case 'uptime_kuma': {
        const { getKumaStatus, formatKumaStatus } = await import('./integrations/uptime-kuma.js');
        const status = await getKumaStatus();
        return { success: true, output: formatKumaStatus(status), duration_ms: Date.now() - startTime };
      }

      case 'bandwidth': {
        const { getBandwidthStats, formatBandwidthReport } = await import('./integrations/bandwidth-monitor.js');
        const report = await getBandwidthStats();
        return { success: true, output: formatBandwidthReport(report), duration_ms: Date.now() - startTime };
      }

      case 'qbittorrent_status': {
        const { getQbittorrentStatus, formatQbittorrentStatus } = await import('./integrations/qbittorrent.js');
        const status = await getQbittorrentStatus();
        return { success: status.success, output: formatQbittorrentStatus(status), duration_ms: Date.now() - startTime };
      }

      case 'qbittorrent_add': {
        const { addTorrent } = await import('./integrations/qbittorrent.js');
        const target = (intent.target || '').trim();
        if (!target) return { success: false, error: 'Provide a magnet link or .torrent URL.', duration_ms: Date.now() - startTime };
        const result = await addTorrent(target);
        return { success: result.success, output: result.message, duration_ms: Date.now() - startTime };
      }

      case 'deploy_gluetun_stack': {
        const { deployGluetunStack } = await import('./gluetun-deploy.js');
        const result = await deployGluetunStack();
        return { success: result.success, output: result.message, duration_ms: Date.now() - startTime };
      }

      case 'music_indexer_status': {
        const { getMusicIndexerCategoryStatus } = await import('./media/search.js');
        const report = await getMusicIndexerCategoryStatus();
        return { success: true, output: report, duration_ms: Date.now() - startTime };
      }

      // ===== PRODUCTIVITY =====

      case 'note_add': {
        const { addNote } = await import('../capabilities/notes/scratchpad.js');
        const note = addNote(intent.target || '');
        return { success: true, output: `Saved: "${note.content}"`, duration_ms: Date.now() - startTime };
      }

      case 'note_search': {
        const { searchNotes, formatNotes } = await import('../capabilities/notes/scratchpad.js');
        const results = searchNotes(intent.target || '');
        return { success: true, output: formatNotes(results), duration_ms: Date.now() - startTime };
      }

      case 'note_list': {
        const { listNotes, formatNotes } = await import('../capabilities/notes/scratchpad.js');
        const notes = listNotes();
        return { success: true, output: formatNotes(notes), duration_ms: Date.now() - startTime };
      }

      case 'reminder_set': {
        const { createReminder } = await import('../capabilities/reminders/reminders.js');
        // Parse "remind me in 2h to check the backup"
        const input = intent.target || '';
        const toMatch = input.match(/(.+?)\s+to\s+(.+)/i);
        if (!toMatch) return { success: false, error: 'Try: "remind me in 2h to check the backup"', duration_ms: Date.now() - startTime };
        const reminder = createReminder(toMatch[1], toMatch[2]);
        if (!reminder) return { success: false, error: 'Could not parse time. Try: "in 30m", "in 2 hours", "tomorrow at 9am"', duration_ms: Date.now() - startTime };
        const when = new Date(reminder.triggerAt);
        return { success: true, output: `Reminder set for ${when.toLocaleString()}: ${reminder.message}`, duration_ms: Date.now() - startTime };
      }

      case 'reminder_list': {
        const { listReminders, formatReminders } = await import('../capabilities/reminders/reminders.js');
        const reminders = listReminders();
        return { success: true, output: formatReminders(reminders), duration_ms: Date.now() - startTime };
      }

      case 'schedule_create': {
        const { createCustomSchedule } = await import('../capabilities/scheduler/custom-schedules.js');
        const input = intent.target || '';
        // Extract time pattern and action: "every friday at 5pm send me a homelab summary"
        const actionMatch = input.match(/(every\s+.+?)\s+(send|check|run|do|show|notify|test)\s+(.+)/i);
        if (!actionMatch) return { success: false, error: 'Try: "every friday at 5pm send me a homelab summary"', duration_ms: Date.now() - startTime };
        const schedule = createCustomSchedule(actionMatch[1], `${actionMatch[2]} ${actionMatch[3]}`);
        if (!schedule) return { success: false, error: 'Could not parse schedule. Try: "every day at 8am", "every friday at 5pm"', duration_ms: Date.now() - startTime };
        return { success: true, output: `Scheduled: ${schedule.description}`, duration_ms: Date.now() - startTime };
      }

      case 'schedule_list': {
        const { listCustomSchedules, formatSchedules } = await import('../capabilities/scheduler/custom-schedules.js');
        const schedules = listCustomSchedules();
        return { success: true, output: formatSchedules(schedules), duration_ms: Date.now() - startTime };
      }

      case 'schedule_delete': {
        const { deleteCustomSchedule } = await import('../capabilities/scheduler/custom-schedules.js');
        const ok = deleteCustomSchedule(intent.target || '');
        return { success: ok, output: ok ? 'Schedule deleted.' : 'Schedule not found.', duration_ms: Date.now() - startTime };
      }

      case 'timeline': {
        const { formatTimeline } = await import('../capabilities/timeline/timeline.js');
        return { success: true, output: formatTimeline(24), duration_ms: Date.now() - startTime };
      }

      case 'quiet_hours': {
        const { formatNotificationPrefs } = await import('../capabilities/notifications/quiet-hours.js');
        return { success: true, output: formatNotificationPrefs(), duration_ms: Date.now() - startTime };
      }

      case 'mute_notifications': {
        const { setMuteUntil, getEndOfTodayISO } = await import('../capabilities/notifications/quiet-hours.js');
        const until = getEndOfTodayISO();
        setMuteUntil(until);
        const untilStr = new Date(until).toLocaleString();
        return { success: true, output: `Notifications muted until ${untilStr}. Say "notifications on" or "resume notifications" to re-enable.`, duration_ms: Date.now() - startTime };
      }

      case 'security_acknowledge': {
        const { resolveLatestSecurityEvents } = await import('../capabilities/security/monitor.js');
        const count = resolveLatestSecurityEvents();
        return { success: true, output: count > 0 ? `Acknowledged ${count} security event(s). No more re-alerts for those conditions until they clear.` : 'No recent security events to acknowledge.', duration_ms: Date.now() - startTime };
      }

      case 'quiet_hours_set': {
        const target = intent.target || '';
        if (target === 'off') {
          const { disableQuietHours, setMuteUntil } = await import('../capabilities/notifications/quiet-hours.js');
          disableQuietHours();
          setMuteUntil(null);
          return { success: true, output: 'Quiet hours disabled and notification mute cleared. Notifications will come through anytime.', duration_ms: Date.now() - startTime };
        }
        const parts = target.split('-');
        if (parts.length === 2) {
          const { setQuietHours, formatNotificationPrefs } = await import('../capabilities/notifications/quiet-hours.js');
          setQuietHours(parts[0].trim(), parts[1].trim());
          return { success: true, output: `Quiet hours updated. ${formatNotificationPrefs()}`, duration_ms: Date.now() - startTime };
        }
        return { success: false, error: 'Specify start-end times, e.g., "quiet hours 23:00-07:00"', duration_ms: Date.now() - startTime };
      }

      case 'file_share': {
        const { validateFileForSharing } = await import('../capabilities/file-share/file-share.js');
        const result = validateFileForSharing(intent.target || '');
        if (!result.valid) {
          // Delegate to agent to resolve from context (e.g. "the config", "that file")
          return {
            success: false,
            delegateToAgent: `The user wants to receive a file. They said: "${intent.message || intent.target}". I couldn't resolve "${intent.target || ''}" to a file path. From our conversation context, which file do they mean? Reply with ONLY the absolute file path (e.g. /opt/stacks/jellyfin/docker-compose.yml) if you can determine it. Otherwise briefly explain what you need.`,
            duration_ms: Date.now() - startTime
          };
        }
        return { success: true, output: `Sending file: ${result.path}`, duration_ms: Date.now() - startTime, attachments: [result.path!] };
      }

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

/**
 * Build a text report: what's connected, what needs setup, what needs API added.
 * Uses same data as the web dashboard (registry + getDashboardStatus).
 */
async function handleHomelabReport(): Promise<ExecutionResult> {
  const startTime = Date.now();
  const { getCollectorConfigStatus, getRequiredEnvVars } = await import('./services/collectors.js');
  const status = await getDashboardStatus();
  if (!status.enabled) {
    return { success: false, output: 'Homelab is not enabled (config or platform).', duration_ms: Date.now() - startTime };
  }
  if (!status.services || !Array.isArray(status.services)) {
    return { success: false, output: 'Could not load service list. Check homelab config and registry.', duration_ms: Date.now() - startTime };
  }

  const services = status.services as Array<{ name: string; state: string; memUsage?: string; tier?: string }>;
  const connected: string[] = [];
  const needsSetup: string[] = [];
  const needsApi: Array<{ name: string; hint: string }> = [];
  const noIntegration: string[] = [];

  for (const svc of services) {
    const configStatus = getCollectorConfigStatus(svc.name);
    if (svc.state !== 'running') {
      needsSetup.push(svc.name);
      continue;
    }
    connected.push(svc.memUsage ? `${svc.name} (${svc.memUsage})` : svc.name);
    if (configStatus === 'missing_api') {
      const hints = getRequiredEnvVars(svc.name);
      needsApi.push({ name: svc.name, hint: hints[0] || 'Set API key in .env' });
    } else if (configStatus === 'no_collector') {
      noIntegration.push(svc.name);
    }
  }

  const lines: string[] = ['## Homelab Report', ''];
  lines.push(`**Connected (${connected.length} running):**`);
  if (connected.length > 0) {
    lines.push(connected.join(', '));
  } else if (services.length > 0) {
    lines.push('None — all services stopped.');
  } else {
    lines.push('No services in registry (registry may be empty).');
  }
  lines.push('');
  if (needsSetup.length > 0) {
    lines.push(`**Needs setup (${needsSetup.length} stopped/not running):**`);
    lines.push(needsSetup.join(', '));
    lines.push('');
  }
  if (needsApi.length > 0) {
    lines.push(`**Needs API added (${needsApi.length}):**`);
    for (const { name, hint } of needsApi) {
      lines.push(`- ${name}: ${hint}`);
    }
    lines.push('');
  }
  if (noIntegration.length > 0) {
    lines.push(`**Running, no Jeeves collector (${noIntegration.length}):**`);
    lines.push(noIntegration.join(', '));
  }

  const resources = status.resources as Record<string, unknown> | null;
  if (resources) {
    const cpu = resources.cpu as { usagePercent?: number } | undefined;
    const ram = resources.ram as { usedMB?: number; totalMB?: number; usagePercent?: number } | undefined;
    if (cpu || ram) {
      lines.push('');
      lines.push('**System:**');
      if (cpu?.usagePercent != null) lines.push(`CPU ${cpu.usagePercent.toFixed(0)}%`);
      if (ram != null) lines.push(`RAM ${ram.usagePercent?.toFixed(0) ?? 0}% (${ram.usedMB ?? 0}MB / ${ram.totalMB ?? 0}MB)`);
    }
  }

  return { success: true, output: lines.join('\n'), duration_ms: Date.now() - startTime };
}

async function handleSystemReview(): Promise<ExecutionResult> {
  const startTime = Date.now();
  const containerMon = await getContainerMonitor();
  const composeMgr = await getComposeManager();

  const [containers, stacks] = await Promise.all([
    containerMon.listContainers(),
    composeMgr.listStacks()
  ]);

  const running = containers.filter((c: { state: string }) => c.state === 'running');
  const date = new Date().toISOString().slice(0, 10);
  const parts: string[] = [
    `System (as of ${date}): This host runs Docker. ${running.length}/${containers.length} containers running.`
  ];
  const names = running.map((c: { name: string }) => c.name);
  if (names.length > 0 && names.length <= 15) {
    parts.push(`Containers: ${names.join(', ')}.`);
  } else if (names.length > 15) {
    parts.push(`Containers (sample): ${names.slice(0, 10).join(', ')}... and ${names.length - 10} more.`);
  }
  if (stacks.length > 0) {
    const stackDesc = stacks.map((s: { stackName: string; running: boolean }) =>
      `${s.stackName} (${s.running ? 'running' : 'stopped'})`
    );
    parts.push(`Stacks: ${stackDesc.join('; ')}.`);
    const hasGluetun = stacks.some((s: { stackName: string }) => s.stackName === 'gluetun-qbittorrent');
    if (hasGluetun) {
      parts.push('VPN stack gluetun-qbittorrent uses env from signal-cursor-controller/.env.');
    }
  }
  const systemContext = parts.join(' ');
  const { rememberPersonality } = await import('../core/trust.js');
  const rememberResult = rememberPersonality(systemContext);

  return {
    success: true,
    output: `System review done. ${rememberResult}\n\nStored: "${systemContext.substring(0, 200)}${systemContext.length > 200 ? '...' : ''}"`,
    duration_ms: Date.now() - startTime
  };
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
// Media Handlers
// ============================================================================

async function handleMediaSearch(query: string): Promise<ExecutionResult> {
  const startTime = Date.now();
  if (!query) {
    return { success: false, output: 'Please specify what to search for. Usage: `search Breaking Bad`', duration_ms: Date.now() - startTime };
  }

  const media = await getMediaSearch();
  const parsed = media.parseMediaQuery(query);
  const result = await media.searchMedia(parsed.query, parsed.context);

  if (!result.success || result.results.length === 0) {
    return { success: true, output: result.message, duration_ms: Date.now() - startTime };
  }

  let output = `## Media Search: "${parsed.query}"\n\n`;
  for (const r of result.results) {
    const icon = r.type === 'movie' ? '🎬' : '📺';
    const inLib = r.inLibrary ? ' ✅ (in library)' : '';
    const seasonInfo = r.seasonCount ? ` (${r.seasonCount} seasons)` : '';
    const runtime = r.runtime ? ` (${r.runtime} min)` : '';
    output += `${icon} **${r.title}** (${r.year})${seasonInfo}${runtime}${inLib}\n`;
    output += `   ${r.overview}\n\n`;
  }

  output += `\nSay \`download ${parsed.query}${parsed.season !== undefined ? ` season ${parsed.season}` : ''}\` to add to library and start downloading.`;

  return { success: true, output, duration_ms: Date.now() - startTime };
}

async function handleMediaDownload(query: string): Promise<ExecutionResult> {
  const startTime = Date.now();
  if (!query) {
    return { success: false, output: 'Please specify what to download. Usage: `download Breaking Bad season 3` or `download Inception 2010, Dune 2021`', duration_ms: Date.now() - startTime };
  }

  const media = await getMediaSearch();
  const { parseMediaQuery, addMedia, parseBatchDownloadInput } = media;

  const items = parseBatchDownloadInput(query);
  const singleItem = items.length <= 1;
  const toAdd = singleItem ? [query.trim()] : items;

  const added: string[] = [];
  const failed: string[] = [];
  let lastMessage = '';

  for (const raw of toAdd) {
    const parsed = parseMediaQuery(raw);
    const result = await addMedia(parsed.query, {
      season: parsed.season,
      type: parsed.type,
      context: parsed.context ? { ...parsed.context } : undefined,
      autoSelectBest: true,
    });

    lastMessage = result.message;
    if (result.success && result.title) {
      added.push(result.title);
      if (parsed.type === 'movie' || parsed.type === 'series') {
        try {
          const { trackDownload } = await import('./media/download-watcher.js');
          const source = parsed.type === 'movie' ? 'radarr' : 'sonarr';
          trackDownload(result.title, parsed.type === 'movie' ? 'movie' : 'episode', source as 'sonarr' | 'radarr');
        } catch {
          // Watcher is optional
        }
      }
    } else {
      failed.push(`${raw}: ${result.message}`);
    }
  }

  if (singleItem) {
    const success = added.length > 0;
    const icon = success ? '✅' : '❌';
    return { success, output: `${icon} ${lastMessage}`, duration_ms: Date.now() - startTime };
  }

  const icon = added.length > 0 ? '✅' : '❌';
  let output = added.length > 0
    ? `Added ${added.length}: ${added.join(', ')}`
    : 'No items added.';
  if (failed.length > 0) {
    output += '\n\nFailed: ' + failed.join('; ');
  }
  return {
    success: added.length > 0,
    output: `${icon} ${output}`,
    duration_ms: Date.now() - startTime,
  };
}

async function handleMediaSelect(indexStr: string): Promise<ExecutionResult> {
  const startTime = Date.now();
  const media = await getMediaSearch();

  if (!media.hasPendingMedia()) {
    return { success: false, output: 'No pending media selection. Search or download something first.', duration_ms: Date.now() - startTime };
  }

  const index = parseInt(indexStr, 10);
  const result = await media.selectMedia(index);

  // Start watching this download if it was successfully added
  if (result.success && result.title) {
    try {
      const { trackDownload } = await import('./media/download-watcher.js');
      trackDownload(result.title, 'episode', 'sonarr');
    } catch {
      // Watcher is optional
    }
  }

  const icon = result.success ? '✅' : '❌';
  return {
    success: result.success,
    output: `${icon} ${result.message}`,
    duration_ms: Date.now() - startTime,
  };
}

async function handleMediaMore(): Promise<ExecutionResult> {
  const startTime = Date.now();
  const media = await getMediaSearch();
  const result = media.showNextResults();

  return {
    success: result.success,
    output: result.success ? `✅ ${result.message}` : `${result.message}`,
    duration_ms: Date.now() - startTime,
  };
}

async function handleMediaDownloadFromImage(intent: { attachments?: Array<{ path?: string; data?: string }> }): Promise<ExecutionResult> {
  const startTime = Date.now();
  const attachments = intent.attachments;
  if (!attachments?.length) {
    return { success: false, output: 'No image attached. Send a screenshot or photo of a list and say "download these".', duration_ms: Date.now() - startTime };
  }
  const first = attachments[0];
  // 1. Try music playlist flow (vision → JSON tracks → Lidarr)
  const { handlePlaylistImage } = await import('../capabilities/music/playlist-image.js');
  const playlistResult = await handlePlaylistImage({ path: first.path, data: first.data });
  const total = playlistResult.added.length + playlistResult.notFound.length + playlistResult.existing.length;
  if (total > 0) {
    return {
      success: true,
      output: playlistResult.summary,
      duration_ms: Date.now() - startTime,
    };
  }
  // 2. Fall back to generic list (movies/TV)
  const { extractMediaListFromImage } = await import('./media/extract-list-from-image.js');
  const extracted = await extractMediaListFromImage({ path: first.path, data: first.data });
  if (!extracted.success) {
    return { success: false, output: `Could not read the image: ${extracted.message}`, duration_ms: Date.now() - startTime };
  }
  if (!extracted.list.trim()) {
    return { success: true, output: extracted.message, duration_ms: Date.now() - startTime };
  }
  const listForBatch = extracted.list.replace(/\n+/g, '\n').trim();
  return handleMediaDownload(listForBatch);
}

async function handleMediaStatus(): Promise<ExecutionResult> {
  const startTime = Date.now();
  const media = await getMediaSearch();
  const result = await media.getDownloadQueue();

  let output = '';

  if (!result.success) {
    return { success: false, output: result.message, duration_ms: Date.now() - startTime };
  }

  if (result.queue.length > 0) {
    output += '## Download Queue\n\n';
    output += '| Title | Status | Progress | Size | ETA |\n';
    output += '|-------|--------|----------|------|-----|\n';

    for (const item of result.queue) {
      const bar = makeBar(item.progress, 10);
      output += `| ${item.title} | ${item.status} | ${bar} ${item.progress}% | ${item.size} | ${item.timeLeft} |\n`;
    }
  } else {
    output = 'No active downloads';
  }

  // Append recently completed info from the watcher
  try {
    const { getWatcherStatus, isWatching } = await import('./media/download-watcher.js');
    const watcherStatus = getWatcherStatus();

    if (isWatching()) {
      output += '\n\n🔍 Download watcher: active';
    }

    if (watcherStatus.recentlyCompleted.length > 0) {
      output += '\n\n## Recently Completed\n';
      for (const d of watcherStatus.recentlyCompleted.slice(0, 5)) {
        const icon = d.type === 'movie' ? '🎬' : '📺';
        const size = d.size ? ` (${d.size})` : '';
        output += `${icon} ${d.title}${size}\n`;
      }
    }
  } catch {
    // Watcher not available
  }

  return { success: true, output, duration_ms: Date.now() - startTime };
}

// ============================================================================
// Backup Handlers
// ============================================================================

async function handleBackup(mode?: string): Promise<ExecutionResult> {
  const startTime = Date.now();
  const backupMgr = await getBackupManager();
  const backupMode = (mode === 'postgres' || mode === 'volumes' || mode === 'cleanup') ? mode : 'full';
  const result = await backupMgr.runBackup(backupMode);

  return {
    success: result.success,
    output: result.success
      ? `✅ ${result.message}`
      : `❌ ${result.message}`,
    duration_ms: Date.now() - startTime
  };
}

async function handleBackupStatus(): Promise<ExecutionResult> {
  const startTime = Date.now();
  const backupMgr = await getBackupManager();
  const output = backupMgr.formatBackupStatus();

  return { success: true, output, duration_ms: Date.now() - startTime };
}

async function handleBackupList(): Promise<ExecutionResult> {
  const startTime = Date.now();
  const backupMgr = await getBackupManager();
  const output = backupMgr.formatBackupList();

  return { success: true, output, duration_ms: Date.now() - startTime };
}

async function handleBackupRestore(target: string): Promise<ExecutionResult> {
  const startTime = Date.now();
  if (!target) {
    return {
      success: false,
      output: 'Please specify what to restore. Usage: `restore postgres` or `restore vaultwarden_data`',
      duration_ms: Date.now() - startTime
    };
  }

  const backupMgr = await getBackupManager();

  let result;
  if (target === 'postgres' || target === 'pg' || target === 'database') {
    result = await backupMgr.restorePostgres();
  } else {
    result = await backupMgr.restoreVolume(target);
  }

  return {
    success: result.success,
    output: result.success
      ? `✅ ${result.message}`
      : `❌ ${result.message}`,
    duration_ms: Date.now() - startTime
  };
}

async function handleBackupSchedule(): Promise<ExecutionResult> {
  const startTime = Date.now();
  const scheduler = await getBackupSchedule();

  // Check if already active
  const status = await scheduler.getScheduleStatus();

  if (status.active) {
    let output = '## Backup Schedule\n\n';
    output += '✅ **Active** (daily at 2:00 AM)\n';
    if (status.nextRun) output += `**Next run:** ${status.nextRun}\n`;
    if (status.lastRun) output += `**Last run:** ${status.lastRun}\n`;
    return { success: true, output, duration_ms: Date.now() - startTime };
  }

  // Install it
  const result = await scheduler.installBackupSchedule();

  return {
    success: result.success,
    output: result.success ? `✅ ${result.message}` : `❌ ${result.message}`,
    duration_ms: Date.now() - startTime
  };
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
