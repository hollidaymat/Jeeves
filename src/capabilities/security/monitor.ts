/**
 * Vercel Security Guardian — Monitor
 *
 * A 60-second interval loop that checks every Vercel project against a set of
 * configurable thresholds.  When a threshold is breached the automated
 * response playbook is invoked.
 *
 * Design principles:
 *   • Pure math / threshold comparison — NO LLM calls in the hot path.
 *   • Events persisted to data/security-events.json (max 500, FIFO).
 *   • Broadcast function wired in at startup (same pattern as cursor-orchestrator).
 */

import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { logger } from '../../utils/logger.js';
import { getVercelStatus } from '../../api/vercel.js';
import { getDeployments, getProjectAnalytics, isSecurityEnabled } from './vercel-security.js';
import { executePlaybook } from './response.js';

import type {
  SecurityEvent,
  ProjectSecurityStatus,
  SecurityDashboardData,
  SecurityEventsFile,
  SecurityThresholds,
  SecurityStatus,
  EventSeverity,
  ResponseAction,
} from './types.js';
import { DEFAULT_THRESHOLDS } from './types.js';

// ============================================================================
// Paths
// ============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EVENTS_PATH = join(__dirname, '../../../data/security-events.json');
const MONITOR_CONFIG_PATH = join(__dirname, '../../../data/security-monitor.json');
const MAX_PERSISTED_EVENTS = 500;

/** Per-project alert overrides: ignore (no Signal) or cap severity (e.g. high -> medium). */
interface SecurityMonitorConfig {
  /** Project names to never send Signal alerts for (dashboard/events still updated). */
  alertIgnoreProjects?: string[];
  /** Project name -> max severity to send. E.g. "medium" = high is sent as medium; "low"/"info" = no Signal. */
  alertDowngradeProjects?: Record<string, EventSeverity>;
}

// ============================================================================
// State
// ============================================================================

let monitorInterval: ReturnType<typeof setInterval> | null = null;
let projectStatuses: Map<string, ProjectSecurityStatus> = new Map();
let events: SecurityEvent[] = [];
let thresholds: SecurityThresholds = { ...DEFAULT_THRESHOLDS };

// Broadcast hook — same pattern as cursor-orchestrator
let broadcastFn: ((type: string, payload: unknown) => void) | null = null;

// ============================================================================
// Alert Cooldowns — prevent spam for ongoing conditions
// ============================================================================

// Map<"projectId:eventType", timestamp>
const alertCooldowns = new Map<string, number>();
const ALERT_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes between repeated alerts for same condition

function isOnCooldown(projectId: string, eventType: string): boolean {
  const key = `${projectId}:${eventType}`;
  const lastAlert = alertCooldowns.get(key);
  if (!lastAlert) return false;
  return Date.now() - lastAlert < ALERT_COOLDOWN_MS;
}

function setCooldown(projectId: string, eventType: string): void {
  alertCooldowns.set(`${projectId}:${eventType}`, Date.now());
}

// Content dedup: don't send identical messages within 5 min
const recentSentContent = new Map<string, number>();
const DEDUP_WINDOW_MS = 5 * 60 * 1000;

const SEVERITY_ORDER: EventSeverity[] = ['info', 'low', 'medium', 'high'];

function loadMonitorConfig(): SecurityMonitorConfig {
  try {
    if (existsSync(MONITOR_CONFIG_PATH)) {
      return JSON.parse(readFileSync(MONITOR_CONFIG_PATH, 'utf-8')) as SecurityMonitorConfig;
    }
  } catch { /* ignore */ }
  return {};
}

/** Apply ignore/downgrade from data/security-monitor.json. Returns null if alert should not be sent. */
function applyAlertOverrides(projectName: string, severity: EventSeverity): EventSeverity | null {
  const cfg = loadMonitorConfig();
  const ignore = cfg.alertIgnoreProjects ?? [];
  if (ignore.some((p) => p === projectName || projectName.toLowerCase() === p.toLowerCase())) {
    logger.debug('[security-monitor] Skipping Signal alert (project in alertIgnoreProjects)', { project: projectName });
    return null;
  }
  const downgrade = cfg.alertDowngradeProjects ?? {};
  const maxSev = downgrade[projectName] ?? downgrade[projectName.toLowerCase()];
  if (maxSev) {
    const maxIdx = SEVERITY_ORDER.indexOf(maxSev);
    const curIdx = SEVERITY_ORDER.indexOf(severity);
    if (curIdx > maxIdx) {
      const newSev = SEVERITY_ORDER[maxIdx];
      logger.debug('[security-monitor] Downgrading alert severity', { project: projectName, from: severity, to: newSev });
      severity = newSev;
    }
  }
  return severity;
}

/** Send security alert to owner via Signal (proactive messaging) */
async function sendSecurityAlertToSignal(
  projectName: string,
  message: string,
  summary: string,
  severity: EventSeverity
): Promise<void> {
  const effective = applyAlertOverrides(projectName, severity);
  if (effective === null) return;
  severity = effective;
  if (severity !== 'high' && severity !== 'medium') return;
  try {
    const { isMuted } = await import('../notifications/quiet-hours.js');
    if (isMuted()) {
      logger.debug('[security-monitor] Skipping Signal alert (notifications muted)');
      return;
    }
    const content = `🚨 ${projectName}: ${message}\n\n${summary}`;
    const contentKey = content.slice(0, 200);
    const lastSent = recentSentContent.get(contentKey);
    if (lastSent && Date.now() - lastSent < DEDUP_WINDOW_MS) {
      logger.debug('[security-monitor] Skipping duplicate alert (same content recently sent)');
      return;
    }
    const { getOwnerNumber } = await import('../../config.js');
    const { signalInterface } = await import('../../interfaces/signal.js');
    if (signalInterface.isAvailable()) {
      await signalInterface.send({
        recipient: getOwnerNumber(),
        content,
      });
      recentSentContent.set(contentKey, Date.now());
      logger.info('[security-monitor] Sent Signal alert', { project: projectName, severity });
    }
  } catch (err) {
    logger.debug('[security-monitor] Could not send Signal alert', { error: String(err) });
  }
}

export function setSecurityBroadcast(fn: (type: string, payload: unknown) => void): void {
  broadcastFn = fn;
}

// ============================================================================
// Persistence
// ============================================================================

function loadEvents(): void {
  try {
    if (existsSync(EVENTS_PATH)) {
      const raw = readFileSync(EVENTS_PATH, 'utf-8');
      const data = JSON.parse(raw) as SecurityEventsFile;
      events = Array.isArray(data.events) ? data.events : [];
      logger.debug(`[security-monitor] Loaded ${events.length} persisted events`);
    }
  } catch (error) {
    logger.warn('[security-monitor] Failed to load persisted events', { error: String(error) });
    events = [];
  }
}

function persistEvents(): void {
  try {
    // Ensure directory exists
    const dir = dirname(EVENTS_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    // Trim to max
    if (events.length > MAX_PERSISTED_EVENTS) {
      events = events.slice(events.length - MAX_PERSISTED_EVENTS);
    }

    const data: SecurityEventsFile = {
      events,
      lastUpdated: new Date().toISOString(),
    };
    writeFileSync(EVENTS_PATH, JSON.stringify(data, null, 2));
  } catch (error) {
    logger.error('[security-monitor] Failed to persist events', { error: String(error) });
  }
}

// ============================================================================
// Event Creation
// ============================================================================

function createEvent(
  projectId: string,
  projectName: string,
  type: ResponseAction,
  severity: EventSeverity,
  message: string,
): SecurityEvent {
  const event: SecurityEvent = {
    id: randomUUID(),
    projectId,
    projectName,
    type,
    severity,
    message,
    timestamp: new Date().toISOString(),
    autoActionsTaken: [],
    resolved: false,
  };

  events.push(event);
  persistEvents();

  // Broadcast to connected clients
  if (broadcastFn) {
    broadcastFn('security_event', event);
  }

  return event;
}

// ============================================================================
// Threshold Checks
// ============================================================================

/**
 * Analyse recent deployments for a project and return security-relevant metrics.
 */
async function checkProject(projectId: string, projectName: string): Promise<void> {
  const now = new Date().toISOString();
  let hasData = false;
  let newEventsCreated = false;

  // ── Deployments ──────────────────────────────────────────────────────
  let errorRate = 0;
  let consecutiveFailures = 0;
  let domain = '';

  try {
    const deploys = await getDeployments(projectId, 10);
    if (deploys && deploys.length > 0) {
      hasData = true;
      const deployRecords = deploys as Array<Record<string, unknown>>;

      // Domain from the latest deployment
      domain = (deployRecords[0]?.url as string) || '';

      // Error rate = failed / total
      const failed = deployRecords.filter(d => d.readyState === 'ERROR').length;
      errorRate = (failed / deployRecords.length) * 100;

      // Consecutive failures (from most recent)
      for (const d of deployRecords) {
        if (d.readyState === 'ERROR') {
          consecutiveFailures++;
        } else {
          break;
        }
      }
    }
  } catch (error) {
    logger.debug(`[security-monitor] Failed to fetch deploys for ${projectName}`, { error: String(error) });
  }

  // ── Analytics (best-effort) ──────────────────────────────────────────
  let responseTime = 0;
  try {
    const analytics = await getProjectAnalytics(projectId);
    if (analytics) {
      hasData = true;
      const data = analytics as Record<string, unknown>;
      responseTime = (data.p95ResponseTime as number) || 0;
    }
  } catch {
    // Analytics unavailable — acceptable
  }

  // ── Skip if no data available ────────────────────────────────────────
  if (!hasData) {
    // No data from Vercel API — skip status update to avoid false signals
    logger.debug(`[security-monitor] ${projectName}: no data available — skipping`);
    return;
  }

  // ── Determine status ────────────────────────────────────────────────
  let status: SecurityStatus = 'secure';
  const threats: string[] = [];

  // Check error-rate threshold
  if (errorRate >= thresholds.errorRate) {
    status = errorRate >= thresholds.errorRate * 2 ? 'critical' : 'warning';
    threats.push(`error_rate:${errorRate.toFixed(1)}%`);

    // Only create event + fire playbook if not on cooldown and user hasn't acknowledged
    if (!isOnCooldown(projectId, 'error_spike') && !hasResolvedEventFor(projectId, 'error_spike')) {
      const severity: EventSeverity = errorRate >= thresholds.errorRate * 2 ? 'high' : 'medium';
      const event = createEvent(
        projectId,
        projectName,
        'error_spike',
        severity,
        `Error rate at ${errorRate.toFixed(1)}% (threshold: ${thresholds.errorRate}%)`,
      );
      executePlaybook(event)
        .then((summary) => sendSecurityAlertToSignal(projectName, event.message, summary, severity))
        .catch(err => logger.error('[security-monitor] Playbook failed', { error: String(err) }));
      setCooldown(projectId, 'error_spike');
      newEventsCreated = true;
    }
  }

  // Check consecutive deploy failures
  if (consecutiveFailures >= thresholds.failedDeploys) {
    status = 'critical';
    threats.push(`consecutive_failures:${consecutiveFailures}`);

    if (!isOnCooldown(projectId, 'deploy_failed') && !hasResolvedEventFor(projectId, 'deploy_failed')) {
      const event = createEvent(
        projectId,
        projectName,
        'deploy_failed',
        'high',
        `${consecutiveFailures} consecutive deploy failures (threshold: ${thresholds.failedDeploys})`,
      );
      executePlaybook(event)
        .then((summary) => sendSecurityAlertToSignal(projectName, event.message, summary, 'high'))
        .catch(err => logger.error('[security-monitor] Playbook failed', { error: String(err) }));
      setCooldown(projectId, 'deploy_failed');
      newEventsCreated = true;
    }
  }

  // Check response time threshold
  if (responseTime > 0 && responseTime >= thresholds.responseTime) {
    if (status === 'secure') status = 'warning';
    threats.push(`p95_response:${responseTime}ms`);

    if (!isOnCooldown(projectId, 'traffic_spike') && !hasResolvedEventFor(projectId, 'traffic_spike')) {
      const event = createEvent(
        projectId,
        projectName,
        'traffic_spike',
        'medium',
        `p95 response time ${responseTime}ms exceeds threshold ${thresholds.responseTime}ms`,
      );
      executePlaybook(event)
        .then((summary) => sendSecurityAlertToSignal(projectName, event.message, summary, 'medium'))
        .catch(err => logger.error('[security-monitor] Playbook failed', { error: String(err) }));
      setCooldown(projectId, 'traffic_spike');
      newEventsCreated = true;
    }
  }

  // ── Update project status map ───────────────────────────────────────
  const projectStatus: ProjectSecurityStatus = {
    projectId,
    projectName,
    domain,
    status,
    errorRate,
    responseTime,
    blockedToday: 0, // Populated when WAF data is available
    activeThreats: threats.length,
    attackMode: false,
    lastChecked: now,
  };

  projectStatuses.set(projectId, projectStatus);

  // Log: only warn on first alert (not on cooldown), otherwise debug
  if (threats.length > 0 && newEventsCreated) {
    logger.warn(`[security-monitor] ${projectName}: ${status.toUpperCase()} — ${threats.join(', ')}`);
  } else if (threats.length > 0) {
    logger.debug(`[security-monitor] ${projectName}: ${status.toUpperCase()} — ${threats.join(', ')} (cooldown)`);
  } else {
    logger.debug(`[security-monitor] ${projectName}: secure`);
  }
}

// ============================================================================
// Monitor Loop
// ============================================================================

async function tick(): Promise<void> {
  if (!isSecurityEnabled()) {
    logger.debug('[security-monitor] Vercel API token not set — skipping tick');
    return;
  }

  try {
    const vercelStatus = await getVercelStatus();
    if (!vercelStatus.enabled || vercelStatus.projects.length === 0) {
      logger.debug('[security-monitor] No Vercel projects to monitor');
      return;
    }

    // Check each project against thresholds
    for (const project of vercelStatus.projects) {
      // Use project name as a proxy for ID when ID is not directly available
      // The Vercel status collector stores the project config name
      const projectId = project.name;
      await checkProject(projectId, project.name);
    }

    // Broadcast updated dashboard
    if (broadcastFn) {
      broadcastFn('security_dashboard', getSecurityDashboard());
    }
  } catch (error) {
    logger.error('[security-monitor] Monitor tick failed', { error: String(error) });
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Start the security monitoring loop (60-second interval).
 */
export function startSecurityMonitor(): void {
  if (monitorInterval) {
    logger.warn('[security-monitor] Monitor already running');
    return;
  }

  // Load persisted events from disk
  loadEvents();

  logger.info('[security-monitor] Starting security monitor (60s interval)');
  monitorInterval = setInterval(() => {
    tick().catch(err =>
      logger.error('[security-monitor] Unhandled tick error', { error: String(err) }),
    );
  }, 60_000);

  // Run first tick immediately
  tick().catch(err =>
    logger.error('[security-monitor] Initial tick error', { error: String(err) }),
  );
}

/**
 * Stop the security monitoring loop.
 */
export function stopSecurityMonitor(): void {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
    logger.info('[security-monitor] Monitor stopped');
  }
}

/**
 * Return a full security dashboard snapshot.
 */
export function getSecurityDashboard(): SecurityDashboardData {
  const projects = Array.from(projectStatuses.values());
  const now = Date.now();
  const oneDayAgo = now - 86_400_000;

  const incidents24h = events.filter(
    e => new Date(e.timestamp).getTime() >= oneDayAgo && !e.resolved,
  ).length;

  const totalBlocked = projects.reduce((sum, p) => sum + p.blockedToday, 0);
  const allHealthy = projects.length > 0 && projects.every(p => p.status === 'secure');

  return {
    portfolio: {
      totalProjects: projects.length,
      allHealthy,
      totalBlocked,
      incidents24h,
    },
    projects,
    recentEvents: events.slice(-20).reverse(),
  };
}

/**
 * Return recent security events.
 */
export function getSecurityEvents(limit: number = 50): SecurityEvent[] {
  return events.slice(-limit).reverse();
}

/**
 * Return current alert overrides (ignore/downgrade) from data/security-monitor.json.
 * Used by dashboard to show which projects have Signal alerts suppressed or downgraded.
 */
export function getSecurityMonitorConfig(): SecurityMonitorConfig {
  return loadMonitorConfig();
}

/**
 * Mark the most recent unresolved security events as resolved (user acknowledged).
 * Prevents re-alerting for the same ongoing condition.
 */
export function resolveLatestSecurityEvents(): number {
  const oneDayAgo = Date.now() - 86_400_000;
  let count = 0;
  for (let i = events.length - 1; i >= 0 && count < 10; i--) {
    const e = events[i];
    if (!e.resolved && new Date(e.timestamp).getTime() >= oneDayAgo) {
      e.resolved = true;
      count++;
    }
  }
  if (count > 0) {
    persistEvents();
    logger.info('[security-monitor] Marked security events as resolved', { count });
  }
  return count;
}

function hasResolvedEventFor(projectId: string, eventType: string): boolean {
  const oneDayAgo = Date.now() - 86_400_000;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.projectId !== projectId || e.type !== eventType) continue;
    if (new Date(e.timestamp).getTime() < oneDayAgo) break;
    return e.resolved;
  }
  return false;
}

/**
 * Update monitoring thresholds at runtime.
 */
export function setThresholds(newThresholds: Partial<SecurityThresholds>): void {
  thresholds = { ...thresholds, ...newThresholds };
  logger.info('[security-monitor] Thresholds updated', { thresholds });
}
