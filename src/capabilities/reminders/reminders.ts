/**
 * Reminders and Timers
 * "Remind me in 2 hours to check the backup"
 * Uses simple file persistence and setTimeout for active reminders.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { logger } from '../../utils/logger.js';

const REMINDERS_PATH = '/home/jeeves/signal-cursor-controller/data/reminders.json';

export interface Reminder {
  id: string;
  message: string;
  triggerAt: string;  // ISO timestamp
  createdAt: string;
  delivered: boolean;
}

// Callback for delivering reminders
let deliverCallback: ((message: string) => void) | null = null;
const activeTimers = new Map<string, NodeJS.Timeout>();

function loadReminders(): Reminder[] {
  try {
    if (existsSync(REMINDERS_PATH)) {
      return JSON.parse(readFileSync(REMINDERS_PATH, 'utf-8'));
    }
  } catch { /* ignore */ }
  return [];
}

function saveReminders(reminders: Reminder[]): void {
  try {
    const dir = dirname(REMINDERS_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(REMINDERS_PATH, JSON.stringify(reminders, null, 2));
  } catch { /* ignore */ }
}

/**
 * Set the callback for delivering reminders (usually sends a Signal message).
 */
export function setReminderCallback(cb: (message: string) => void): void {
  deliverCallback = cb;
}

/**
 * Parse a natural-language time expression into a Date.
 * Supports: "in 30m", "in 2 hours", "in 1h30m", "tomorrow", "tomorrow at 9am"
 */
export function parseTimeExpression(expr: string): Date | null {
  const now = new Date();

  // "in Xm", "in Xh", "in X minutes", "in X hours"
  const relMatch = expr.match(/in\s+(\d+)\s*(m(?:in(?:ute)?s?)?|h(?:(?:ou)?rs?)?|s(?:ec(?:ond)?s?)?|d(?:ays?)?)/i);
  if (relMatch) {
    const amount = parseInt(relMatch[1], 10);
    const unit = relMatch[2][0].toLowerCase();
    const ms = unit === 's' ? amount * 1000
      : unit === 'm' ? amount * 60000
      : unit === 'h' ? amount * 3600000
      : amount * 86400000;
    return new Date(now.getTime() + ms);
  }

  // "in Xh Ym" format
  const compoundMatch = expr.match(/in\s+(\d+)\s*h(?:ours?)?\s*(\d+)\s*m(?:in(?:ute)?s?)?/i);
  if (compoundMatch) {
    const hours = parseInt(compoundMatch[1], 10);
    const mins = parseInt(compoundMatch[2], 10);
    return new Date(now.getTime() + hours * 3600000 + mins * 60000);
  }

  // "tomorrow"
  if (/tomorrow/i.test(expr)) {
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const timeMatch = expr.match(/at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
    if (timeMatch) {
      let hour = parseInt(timeMatch[1], 10);
      const min = parseInt(timeMatch[2] || '0', 10);
      if (timeMatch[3]?.toLowerCase() === 'pm' && hour < 12) hour += 12;
      if (timeMatch[3]?.toLowerCase() === 'am' && hour === 12) hour = 0;
      tomorrow.setHours(hour, min, 0, 0);
    } else {
      tomorrow.setHours(9, 0, 0, 0); // Default to 9am
    }
    return tomorrow;
  }

  return null;
}

/**
 * Create a reminder.
 */
export function createReminder(timeExpr: string, message: string): Reminder | null {
  const triggerAt = parseTimeExpression(timeExpr);
  if (!triggerAt) return null;

  const reminder: Reminder = {
    id: `rem-${Date.now()}`,
    message,
    triggerAt: triggerAt.toISOString(),
    createdAt: new Date().toISOString(),
    delivered: false,
  };

  const reminders = loadReminders();
  reminders.push(reminder);
  saveReminders(reminders);

  scheduleReminder(reminder);

  return reminder;
}

/**
 * Schedule a timer for a reminder.
 */
function scheduleReminder(reminder: Reminder): void {
  const ms = new Date(reminder.triggerAt).getTime() - Date.now();
  if (ms <= 0) {
    deliverReminder(reminder);
    return;
  }

  // Cap at 24h to avoid overflow, re-check on startup
  const delay = Math.min(ms, 86400000);
  const timer = setTimeout(() => {
    if (ms > 86400000) {
      // Reschedule
      scheduleReminder(reminder);
    } else {
      deliverReminder(reminder);
    }
  }, delay);

  activeTimers.set(reminder.id, timer);
}

function deliverReminder(reminder: Reminder): void {
  activeTimers.delete(reminder.id);

  if (deliverCallback) {
    deliverCallback(`⏰ Reminder: ${reminder.message}`);
  }

  // Mark as delivered
  const reminders = loadReminders();
  const r = reminders.find(r => r.id === reminder.id);
  if (r) {
    r.delivered = true;
    saveReminders(reminders);
  }

  logger.info('[reminders] Delivered', { id: reminder.id, message: reminder.message });
}

/**
 * Initialize — re-schedule any pending reminders from disk.
 */
export function initReminders(): void {
  const reminders = loadReminders();
  for (const r of reminders) {
    if (!r.delivered) {
      scheduleReminder(r);
    }
  }
  logger.info('[reminders] Initialized', { pending: reminders.filter(r => !r.delivered).length });
}

/**
 * List pending reminders.
 */
export function listReminders(): Reminder[] {
  return loadReminders().filter(r => !r.delivered);
}

export function formatReminders(reminders: Reminder[]): string {
  if (reminders.length === 0) return 'No pending reminders.';

  const lines = ['## Reminders', ''];
  for (const r of reminders) {
    const when = new Date(r.triggerAt);
    const diff = when.getTime() - Date.now();
    const relative = diff > 0
      ? diff > 86400000
        ? `in ${Math.round(diff / 86400000)}d`
        : diff > 3600000
          ? `in ${Math.round(diff / 3600000)}h`
          : `in ${Math.round(diff / 60000)}m`
      : 'overdue';
    lines.push(`- ${r.message} (${relative})`);
  }
  return lines.join('\n');
}
