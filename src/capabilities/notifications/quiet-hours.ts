/**
 * Quiet Hours / Notification Preferences
 * Queues non-critical notifications during quiet hours and delivers them as a batch.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { logger } from '../../utils/logger.js';

const CONFIG_PATH = '/home/jeeves/signal-cursor-controller/data/notification-prefs.json';
const QUEUE_PATH = '/home/jeeves/signal-cursor-controller/data/notification-queue.json';
/** Runtime state Jeeves can modify via simple node/jq commands (disable until EOD, re-enable, status). */
const NOTIFICATION_STATE_PATH = '/home/jeeves/config/notification-state.json';

export interface NotificationState {
  enabled: boolean;
  quiet_until: string | null;
  quiet_reason: string | null;
  channels?: { signal?: boolean; web?: boolean; logs?: boolean };
}

export interface NotificationPrefs {
  quietHoursEnabled: boolean;
  quietStart: string;  // "23:00"
  quietEnd: string;    // "07:00"
  criticalBypass: boolean;  // critical alerts bypass quiet hours
  muteUntil?: string | null;  // ISO timestamp - no proactive notifications until this time
}

export interface QueuedNotification {
  message: string;
  priority: 'critical' | 'normal' | 'low';
  timestamp: string;
  source: string;
}

const DEFAULT_PREFS: NotificationPrefs = {
  quietHoursEnabled: true,
  quietStart: '23:00',
  quietEnd: '07:00',
  criticalBypass: true,
};

function loadPrefs(): NotificationPrefs {
  try {
    if (existsSync(CONFIG_PATH)) {
      return { ...DEFAULT_PREFS, ...JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) };
    }
  } catch { /* ignore */ }
  return DEFAULT_PREFS;
}

function savePrefs(prefs: NotificationPrefs): void {
  try {
    const dir = dirname(CONFIG_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(prefs, null, 2));
  } catch { /* ignore */ }
}

const DEFAULT_NOTIFICATION_STATE: NotificationState = {
  enabled: true,
  quiet_until: null,
  quiet_reason: null,
  channels: { signal: true, web: true, logs: true },
};

function loadNotificationState(): NotificationState {
  try {
    if (existsSync(NOTIFICATION_STATE_PATH)) {
      return { ...DEFAULT_NOTIFICATION_STATE, ...JSON.parse(readFileSync(NOTIFICATION_STATE_PATH, 'utf-8')) };
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_NOTIFICATION_STATE };
}

function saveNotificationState(state: NotificationState): void {
  try {
    const dir = dirname(NOTIFICATION_STATE_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(NOTIFICATION_STATE_PATH, JSON.stringify(state, null, 2));
  } catch { /* ignore */ }
}

function loadQueue(): QueuedNotification[] {
  try {
    if (existsSync(QUEUE_PATH)) {
      return JSON.parse(readFileSync(QUEUE_PATH, 'utf-8'));
    }
  } catch { /* ignore */ }
  return [];
}

function saveQueue(queue: QueuedNotification[]): void {
  try {
    const dir = dirname(QUEUE_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(QUEUE_PATH, JSON.stringify(queue, null, 2));
  } catch { /* ignore */ }
}

/**
 * Check if current time is within quiet hours.
 */
export function isQuietHours(): boolean {
  const prefs = loadPrefs();
  if (!prefs.quietHoursEnabled) return false;

  const now = new Date();
  const [startH, startM] = prefs.quietStart.split(':').map(Number);
  const [endH, endM] = prefs.quietEnd.split(':').map(Number);
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  if (startMinutes > endMinutes) {
    // Spans midnight (e.g., 23:00 - 07:00)
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }
  return currentMinutes >= startMinutes && currentMinutes < endMinutes;
}

/**
 * Decide whether to send a notification now or queue it.
 * Returns true if the notification should be sent now, false if queued.
 */
export function shouldSendNow(priority: 'critical' | 'normal' | 'low'): boolean {
  if (!isQuietHours()) return true;
  const prefs = loadPrefs();
  if (priority === 'critical' && prefs.criticalBypass) return true;
  return false;
}

/**
 * Queue a notification for later delivery.
 */
export function queueNotification(message: string, priority: 'critical' | 'normal' | 'low', source: string): void {
  const queue = loadQueue();
  queue.push({ message, priority, source, timestamp: new Date().toISOString() });
  saveQueue(queue);
  logger.debug('[quiet-hours] Notification queued', { source, priority });
}

/**
 * Flush the notification queue, returning all queued messages.
 * Called when quiet hours end.
 */
export function flushQueue(): QueuedNotification[] {
  const queue = loadQueue();
  if (queue.length > 0) {
    saveQueue([]);
  }
  return queue;
}

/**
 * Get current preferences.
 */
export function getPrefs(): NotificationPrefs {
  return loadPrefs();
}

/**
 * Update quiet hours.
 */
export function setQuietHours(start: string, end: string): NotificationPrefs {
  const prefs = loadPrefs();
  prefs.quietHoursEnabled = true;
  prefs.quietStart = start;
  prefs.quietEnd = end;
  savePrefs(prefs);
  return prefs;
}

/**
 * Disable quiet hours.
 */
export function disableQuietHours(): void {
  const prefs = loadPrefs();
  prefs.quietHoursEnabled = false;
  savePrefs(prefs);
}

/**
 * Check if proactive notifications are muted.
 * Respects (1) notification-prefs.json muteUntil, (2) notification-state.json (quiet_until, enabled, channels.signal).
 * notification-state.json is the runtime file Jeeves can modify himself (e.g. disable until EOD, re-enable).
 */
export function isMuted(): boolean {
  const prefs = loadPrefs();
  const until = prefs.muteUntil;
  if (until) {
    const untilMs = new Date(until).getTime();
    if (Date.now() < untilMs) return true;
  }
  const state = loadNotificationState();
  if (state.enabled === false) {
    logger.debug('[quiet-hours] Notifications suppressed (enabled=false in notification-state.json)');
    return true;
  }
  if (state.channels?.signal === false) {
    logger.debug('[quiet-hours] Signal channel disabled in notification-state.json');
    return true;
  }
  if (state.quiet_until) {
    const quietUntilMs = new Date(state.quiet_until).getTime();
    if (Date.now() < quietUntilMs) {
      logger.debug('[quiet-hours] Notifications quiet until ' + state.quiet_until);
      return true;
    }
  }
  return false;
}

/**
 * Mute all proactive Signal notifications until the given ISO timestamp.
 * Use end of today for "no more notifications for today".
 * Updates both notification-prefs.json and notification-state.json so the state file
 * is the single source of truth Jeeves (and the user) can inspect with jq.
 */
export function setMuteUntil(iso: string | null): void {
  const prefs = loadPrefs();
  prefs.muteUntil = iso ?? undefined;
  savePrefs(prefs);
  const state = loadNotificationState();
  state.quiet_until = iso;
  state.quiet_reason = iso ? 'user_requested' : null;
  saveNotificationState(state);
  logger.info('[quiet-hours] Mute until set', { until: iso ?? 'cleared' });
}

/**
 * Return end-of-today as ISO string (midnight tomorrow, local timezone).
 */
export function getEndOfTodayISO(): string {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.toISOString();
}

export function formatNotificationPrefs(): string {
  const prefs = loadPrefs();
  const queue = loadQueue();
  const status = prefs.quietHoursEnabled
    ? `Quiet hours: ${prefs.quietStart} - ${prefs.quietEnd} (${isQuietHours() ? 'active now' : 'inactive'})`
    : 'Quiet hours: disabled';
  const queueInfo = queue.length > 0 ? `\n${queue.length} notification(s) queued` : '';
  const muteInfo = prefs.muteUntil && new Date(prefs.muteUntil).getTime() > Date.now()
    ? `\nNotifications muted until ${new Date(prefs.muteUntil).toLocaleString()}`
    : '';
  return `${status}${queueInfo}${muteInfo}`;
}
