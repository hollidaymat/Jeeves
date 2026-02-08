/**
 * Quiet Hours / Notification Preferences
 * Queues non-critical notifications during quiet hours and delivers them as a batch.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { logger } from '../../utils/logger.js';

const CONFIG_PATH = '/home/jeeves/signal-cursor-controller/data/notification-prefs.json';
const QUEUE_PATH = '/home/jeeves/signal-cursor-controller/data/notification-queue.json';

export interface NotificationPrefs {
  quietHoursEnabled: boolean;
  quietStart: string;  // "23:00"
  quietEnd: string;    // "07:00"
  criticalBypass: boolean;  // critical alerts bypass quiet hours
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

export function formatNotificationPrefs(): string {
  const prefs = loadPrefs();
  const queue = loadQueue();
  const status = prefs.quietHoursEnabled
    ? `Quiet hours: ${prefs.quietStart} - ${prefs.quietEnd} (${isQuietHours() ? 'active now' : 'inactive'})`
    : 'Quiet hours: disabled';
  const queueInfo = queue.length > 0 ? `\n${queue.length} notification(s) queued` : '';
  return `${status}${queueInfo}`;
}
