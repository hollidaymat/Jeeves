/**
 * Scheduled Task Engine
 * Generalized cron-like scheduler with handler registry,
 * persistence, and broadcast support.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { logger } from '../../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_PATH = join(__dirname, '../../../data/schedules.json');

// --- Types ---

export interface ScheduleEntry {
  name: string;
  /** Simple cron: "HH:MM" for daily, "HH:MM:D" where D=0-6 for weekly (0=Sunday), or interval in ms */
  schedule: string | number;
  handlerKey: string;
  args?: Record<string, unknown>;
  enabled: boolean;
  lastRun: string;
  nextRun?: string;
}

interface ScheduleData {
  schedules: ScheduleEntry[];
  lastUpdated: string;
}

// --- State ---

const handlers = new Map<string, (args?: Record<string, unknown>) => Promise<void>>();
let schedules: ScheduleEntry[] = [];
let loaded = false;
let tickInterval: ReturnType<typeof setInterval> | null = null;
let broadcastFn: ((type: string, payload: unknown) => void) | null = null;

// --- Persistence ---

function loadSchedules(): void {
  if (loaded) return;
  try {
    if (existsSync(DATA_PATH)) {
      const raw = readFileSync(DATA_PATH, 'utf-8');
      const data: ScheduleData = JSON.parse(raw);
      schedules = data.schedules ?? [];
    }
  } catch (err) {
    logger.warn('Failed to load schedules, starting fresh', { error: String(err) });
    schedules = [];
  }
  loaded = true;
}

function saveSchedules(): void {
  try {
    const dir = dirname(DATA_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const data: ScheduleData = {
      schedules,
      lastUpdated: new Date().toISOString(),
    };
    writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    logger.error('Failed to save schedules', { error: String(err) });
  }
}

function ensureLoaded(): void { if (!loaded) loadSchedules(); }

// --- Handler Registry ---

export function registerHandler(key: string, handler: (args?: Record<string, unknown>) => Promise<void>): void {
  handlers.set(key, handler);
}

export function getRegisteredHandlers(): string[] { return Array.from(handlers.keys()); }

// --- Schedule Management ---

export function addSchedule(name: string, schedule: string | number, handlerKey: string, args?: Record<string, unknown>): void {
  ensureLoaded();
  if (schedules.find((s) => s.name === name)) return;
  schedules.push({ name, schedule, handlerKey, args, enabled: true, lastRun: '' });
  saveSchedules();
}

export function removeSchedule(name: string): void {
  ensureLoaded();
  schedules = schedules.filter((s) => s.name !== name);
  saveSchedules();
}

export function enableSchedule(name: string, enabled: boolean): void {
  ensureLoaded();
  const entry = schedules.find((s) => s.name === name);
  if (entry) { entry.enabled = enabled; saveSchedules(); }
}

export function getSchedules(): ScheduleEntry[] { ensureLoaded(); return [...schedules]; }

export function getSchedule(name: string): ScheduleEntry | null {
  ensureLoaded();
  return schedules.find((s) => s.name === name) ?? null;
}

// --- Broadcast ---

export function setSchedulerBroadcast(fn: (type: string, payload: unknown) => void): void {
  broadcastFn = fn;
}

// --- isDue Logic ---

function isDue(entry: ScheduleEntry): boolean {
  if (!entry.enabled) return false;

  const now = new Date();
  const lastRunMs = entry.lastRun ? new Date(entry.lastRun).getTime() : 0;

  // Interval-based schedule (number of milliseconds)
  if (typeof entry.schedule === 'number') {
    return Date.now() - lastRunMs >= entry.schedule;
  }

  // Cron-like string schedule
  const parts = entry.schedule.split(':');
  if (parts.length < 2) return false;

  const targetHour = parseInt(parts[0], 10);
  const targetMinute = parseInt(parts[1], 10);

  if (now.getHours() !== targetHour || now.getMinutes() !== targetMinute) {
    return false;
  }

  // Weekly: "HH:MM:D"
  if (parts.length === 3) {
    const targetDay = parseInt(parts[2], 10);
    if (now.getDay() !== targetDay) return false;
  }

  // Check hasn't run today (or this specific minute window)
  if (lastRunMs > 0) {
    const lastRun = new Date(lastRunMs);
    if (
      lastRun.getFullYear() === now.getFullYear() &&
      lastRun.getMonth() === now.getMonth() &&
      lastRun.getDate() === now.getDate()
    ) {
      return false;
    }
  }

  return true;
}

// --- Tick ---

async function tick(): Promise<void> {
  ensureLoaded();
  let didRun = false;

  for (const entry of schedules) {
    if (!isDue(entry)) continue;

    const handler = handlers.get(entry.handlerKey);
    if (!handler) {
      logger.warn('No handler registered for scheduled task', {
        name: entry.name,
        handlerKey: entry.handlerKey,
      });
      continue;
    }

    try {
      await handler(entry.args);
      entry.lastRun = new Date().toISOString();
      didRun = true;
      logger.info('Scheduler ran task', {
        name: entry.name,
        handlerKey: entry.handlerKey,
      });
      if (broadcastFn) {
        broadcastFn('scheduler:task:ran', {
          name: entry.name,
          handlerKey: entry.handlerKey,
          ranAt: entry.lastRun,
        });
      }
    } catch (err) {
      logger.error('Scheduled task failed', {
        name: entry.name,
        handlerKey: entry.handlerKey,
        error: String(err),
      });
    }
  }

  if (didRun) saveSchedules();
}

// --- Lifecycle ---

export function startScheduler(): void {
  if (tickInterval) return;
  ensureLoaded();
  initDefaultSchedules();
  tickInterval = setInterval(() => void tick(), 60_000);
  logger.info('Scheduler started', { scheduleCount: schedules.length });
}

export function stopScheduler(): void {
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
    logger.info('Scheduler stopped');
  }
}

export function isSchedulerRunning(): boolean {
  return tickInterval !== null;
}

// --- Default Schedules ---

function initDefaultSchedules(): void {
  ensureLoaded();

  const defaults: Omit<ScheduleEntry, 'enabled' | 'lastRun'>[] = [
    { name: 'morning_briefing', schedule: '07:00', handlerKey: 'morning_briefing' },
    { name: 'uptime_check', schedule: 300_000, handlerKey: 'uptime_check' },
    { name: 'changelog_scan', schedule: '09:00:1', handlerKey: 'changelog_scan' },
    { name: 'cost_review', schedule: '20:00:0', handlerKey: 'cost_review' },
  ];

  let added = false;
  for (const def of defaults) {
    if (!schedules.find((s) => s.name === def.name)) {
      schedules.push({ ...def, enabled: true, lastRun: '' });
      added = true;
    }
  }

  if (added) saveSchedules();
}
