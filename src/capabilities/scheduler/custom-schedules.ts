/**
 * Custom Scheduled Tasks via Natural Language
 * "Every Friday at 5pm send me a homelab summary"
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { logger } from '../../utils/logger.js';

const SCHEDULES_PATH = '/home/jeeves/signal-cursor-controller/data/custom-schedules.json';

export interface CustomSchedule {
  id: string;
  description: string;
  cronExpression: string;
  action: string;
  enabled: boolean;
  createdAt: string;
  lastRun?: string;
}

function loadSchedules(): CustomSchedule[] {
  try {
    if (existsSync(SCHEDULES_PATH)) {
      return JSON.parse(readFileSync(SCHEDULES_PATH, 'utf-8'));
    }
  } catch { /* ignore */ }
  return [];
}

function saveSchedules(schedules: CustomSchedule[]): void {
  try {
    const dir = dirname(SCHEDULES_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(SCHEDULES_PATH, JSON.stringify(schedules, null, 2));
  } catch { /* ignore */ }
}

/**
 * Parse natural language schedule to cron expression.
 */
export function parseScheduleExpression(input: string): { cron: string; description: string } | null {
  const lower = input.toLowerCase();

  // "every hour"
  if (/every\s+hour/.test(lower)) {
    return { cron: '0 * * * *', description: 'Every hour' };
  }

  // "every N hours"
  const nHoursMatch = lower.match(/every\s+(\d+)\s+hours?/);
  if (nHoursMatch) {
    const n = parseInt(nHoursMatch[1], 10);
    return { cron: `0 */${n} * * *`, description: `Every ${n} hours` };
  }

  // "every day at Xam/pm" or "daily at X"
  const dailyMatch = lower.match(/(?:every\s+day|daily)\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (dailyMatch) {
    let hour = parseInt(dailyMatch[1], 10);
    const min = parseInt(dailyMatch[2] || '0', 10);
    if (dailyMatch[3] === 'pm' && hour < 12) hour += 12;
    if (dailyMatch[3] === 'am' && hour === 12) hour = 0;
    return { cron: `${min} ${hour} * * *`, description: `Daily at ${hour}:${min.toString().padStart(2, '0')}` };
  }

  // "every day" (no time = 8am)
  if (/every\s+day/.test(lower)) {
    return { cron: '0 8 * * *', description: 'Daily at 8:00' };
  }

  // "every monday/tuesday/..." with optional time
  const dayNames: Record<string, number> = {
    sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
    thursday: 4, friday: 5, saturday: 6,
    sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
  };

  const weekdayMatch = lower.match(/every\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|wed|thu|fri|sat)\s*(?:at\s+)?(?:(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?/);
  if (weekdayMatch) {
    const dow = dayNames[weekdayMatch[1]] ?? 1;
    let hour = parseInt(weekdayMatch[2] || '8', 10);
    const min = parseInt(weekdayMatch[3] || '0', 10);
    if (weekdayMatch[4] === 'pm' && hour < 12) hour += 12;
    if (weekdayMatch[4] === 'am' && hour === 12) hour = 0;
    const dayName = Object.keys(dayNames).find(k => dayNames[k] === dow && k.length > 3) || weekdayMatch[1];
    return { cron: `${min} ${hour} * * ${dow}`, description: `Every ${dayName} at ${hour}:${min.toString().padStart(2, '0')}` };
  }

  // "every week" (= every Monday 8am)
  if (/every\s+week/.test(lower)) {
    return { cron: '0 8 * * 1', description: 'Every Monday at 8:00' };
  }

  return null;
}

/**
 * Create a custom schedule.
 */
export function createCustomSchedule(timeExpr: string, action: string): CustomSchedule | null {
  const parsed = parseScheduleExpression(timeExpr);
  if (!parsed) return null;

  const schedule: CustomSchedule = {
    id: `sched-${Date.now()}`,
    description: `${parsed.description}: ${action}`,
    cronExpression: parsed.cron,
    action,
    enabled: true,
    createdAt: new Date().toISOString(),
  };

  const schedules = loadSchedules();
  schedules.push(schedule);
  saveSchedules(schedules);

  return schedule;
}

/**
 * List active custom schedules.
 */
export function listCustomSchedules(): CustomSchedule[] {
  return loadSchedules().filter(s => s.enabled);
}

/**
 * Delete a custom schedule.
 */
export function deleteCustomSchedule(id: string): boolean {
  const schedules = loadSchedules();
  const idx = schedules.findIndex(s => s.id === id || s.description.toLowerCase().includes(id.toLowerCase()));
  if (idx === -1) return false;
  schedules.splice(idx, 1);
  saveSchedules(schedules);
  return true;
}

/**
 * Get schedules that match the current cron tick.
 */
export function getSchedulesDueNow(): CustomSchedule[] {
  const now = new Date();
  const currentMin = now.getMinutes();
  const currentHour = now.getHours();
  const currentDow = now.getDay();

  return loadSchedules().filter(s => {
    if (!s.enabled) return false;
    const [min, hour, , , dow] = s.cronExpression.split(' ');

    const minMatch = min === '*' || min.includes('/') ?
      (parseInt(min.replace('*/', ''), 10) ? currentMin % parseInt(min.replace('*/', ''), 10) === 0 : true)
      : parseInt(min, 10) === currentMin;

    const hourMatch = hour === '*' || hour.includes('/') ?
      (parseInt(hour.replace('*/', ''), 10) ? currentHour % parseInt(hour.replace('*/', ''), 10) === 0 : true)
      : parseInt(hour, 10) === currentHour;

    const dowMatch = dow === '*' || parseInt(dow, 10) === currentDow;

    return minMatch && hourMatch && dowMatch;
  });
}

export function formatSchedules(schedules: CustomSchedule[]): string {
  if (schedules.length === 0) return 'No custom schedules. Try: "every friday at 5pm send me a homelab summary"';

  const lines = ['## Scheduled Tasks', ''];
  for (const s of schedules) {
    lines.push(`- ${s.description} (\`${s.cronExpression}\`)`);
  }
  return lines.join('\n');
}
