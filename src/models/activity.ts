/**
 * Activity Model
 * 
 * Tracks Jeeves's current task, work queue, standing orders, and history.
 * Persists to data/activity.json.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_PATH = join(__dirname, '../../data/activity.json');

// ============================================================================
// Types
// ============================================================================

export interface CurrentTask {
  id: string;
  name: string;
  phaseName?: string;
  phase: number;
  totalPhases: number;
  progress: number;       // 0-100
  startedAt: string;
  estimatedComplete?: string;
  cost: number;
}

export interface QueueItem {
  id: string;
  name: string;
  status: 'pending' | 'scheduled';
  scheduledFor?: string;
  priority: number;
}

export interface StandingOrder {
  id: string;
  name: string;
  interval: string;       // human-readable interval
  lastRun?: string;
  nextRun?: string;
  status: 'active' | 'paused' | 'error';
  successRate?: number;
}

export interface HistoryItem {
  id: string;
  name: string;
  completedAt: string;
  status: 'success' | 'failed' | 'retried';
  cost: number;
  tokensUsed?: number;
  duration?: number;       // ms
  error?: string;
}

export interface ActivitySummary {
  tasks: number;
  cost: number;
  failures: number;
}

export interface ActivitySnapshot {
  currentTask: CurrentTask | null;
  queue: QueueItem[];
  standingOrders: StandingOrder[];
  history: HistoryItem[];
  summary: ActivitySummary;
}

// ============================================================================
// State
// ============================================================================

let currentTask: CurrentTask | null = null;
let queue: QueueItem[] = [];
let standingOrders: StandingOrder[] = [];
let history: HistoryItem[] = [];

// Initialize standing orders from known schedules
function initStandingOrders(): void {
  if (standingOrders.length > 0) return;
  standingOrders = [
    {
      id: 'monitor-health',
      name: 'Monitor container health',
      interval: 'every 5m',
      status: 'active',
    },
    {
      id: 'backup-daily',
      name: 'Backup configs',
      interval: 'daily 2am',
      status: 'active',
    },
  ];
}

// ============================================================================
// Persistence
// ============================================================================

function loadData(): void {
  try {
    if (existsSync(DATA_PATH)) {
      const raw = JSON.parse(readFileSync(DATA_PATH, 'utf-8'));
      queue = raw.queue || [];
      standingOrders = raw.standingOrders || [];
      history = raw.history || [];
      // currentTask is not persisted (session-only)
    }
  } catch (e) {
    logger.debug('Failed to load activity data', { error: String(e) });
  }
  initStandingOrders();
}

function saveData(): void {
  try {
    writeFileSync(DATA_PATH, JSON.stringify({
      queue,
      standingOrders,
      history: history.slice(-200), // Keep last 200 entries
    }, null, 2));
  } catch (e) {
    logger.debug('Failed to save activity data', { error: String(e) });
  }
}

// Load on module init
loadData();

// ============================================================================
// Public API
// ============================================================================

export function setCurrentTask(task: Omit<CurrentTask, 'id'>): string {
  const id = `task_${Date.now()}`;
  currentTask = { id, ...task };
  return id;
}

export function updateTaskProgress(progress: number, phaseName?: string, cost?: number): void {
  if (!currentTask) return;
  currentTask.progress = progress;
  if (phaseName) currentTask.phaseName = phaseName;
  if (cost != null) currentTask.cost = cost;
}

export function completeTask(result?: { cost?: number; tokensUsed?: number }): void {
  if (!currentTask) return;

  history.push({
    id: currentTask.id,
    name: currentTask.name,
    completedAt: new Date().toISOString(),
    status: 'success',
    cost: result?.cost ?? currentTask.cost,
    tokensUsed: result?.tokensUsed,
    duration: Date.now() - new Date(currentTask.startedAt).getTime(),
  });

  currentTask = null;
  saveData();
}

export function failTask(error: string, willRetry?: boolean): void {
  if (!currentTask) return;

  history.push({
    id: currentTask.id,
    name: currentTask.name,
    completedAt: new Date().toISOString(),
    status: willRetry ? 'retried' : 'failed',
    cost: currentTask.cost,
    duration: Date.now() - new Date(currentTask.startedAt).getTime(),
    error,
  });

  currentTask = null;
  saveData();
}

export function addToQueue(name: string, options?: { scheduledFor?: string; priority?: number }): string {
  const id = `q_${Date.now()}`;
  queue.push({
    id,
    name,
    status: options?.scheduledFor ? 'scheduled' : 'pending',
    scheduledFor: options?.scheduledFor,
    priority: options?.priority ?? 5,
  });
  saveData();
  return id;
}

export function removeFromQueue(id: string): void {
  queue = queue.filter(q => q.id !== id);
  saveData();
}

export function getActivitySnapshot(): ActivitySnapshot {
  // Compute summary for today
  const today = new Date().toISOString().split('T')[0];
  const todayItems = history.filter(h => h.completedAt.startsWith(today));

  return {
    currentTask,
    queue,
    standingOrders,
    history: history.slice(-50).reverse(), // Most recent first
    summary: {
      tasks: todayItems.length,
      cost: todayItems.reduce((s, h) => s + (h.cost || 0), 0),
      failures: todayItems.filter(h => h.status === 'failed').length,
    },
  };
}

export function getHistory(limit: number = 20): HistoryItem[] {
  return history.slice(-limit).reverse();
}
