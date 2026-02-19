/**
 * Execution Logger
 * Persistent log of plan and dev_task runs so we can tell if Jeeves succeeded.
 * Used by: executePendingPlan, dev_task executor, and GET /api/debug/last-execution-outcome.
 */

import { resolve } from 'path';
import { getDb } from './context/db.js';
import { generateId } from './context/db.js';
import { logger } from '../utils/logger.js';

/** Canonical project root for plan execution when no session is active. Prefer JEEVES_PROJECT_ROOT, else cwd. */
export function getCanonicalProjectRoot(): string {
  if (process.env.JEEVES_PROJECT_ROOT) {
    return resolve(process.env.JEEVES_PROJECT_ROOT);
  }
  return process.cwd();
}

/** Normalize a plan command: replace /opt/jeeves and /home/jeeves/src with actual project root so commands run in the right place. */
export function normalizePlanCommand(command: string, projectRoot: string): string {
  let out = command.replace(/\/opt\/jeeves/g, projectRoot).replace(/\/opt\/jeeves\/src/g, projectRoot + '/src');
  // /home/jeeves/src (missing signal-cursor-controller) -> projectRoot/src
  out = out.replace(/\/home\/jeeves\/src\b/g, projectRoot + '/src');
  return out;
}

export type ExecutionType = 'plan' | 'dev_task';
export type ExecutionOutcome = 'success' | 'partial' | 'failed';

export interface ExecutionStep {
  command: string;
  cwd?: string;
  success: boolean;
  exitCode?: number | null;
  outputSnippet?: string;
  error?: string;
}

export interface ExecutionRecord {
  id: string;
  type: ExecutionType;
  description: string;
  triggerMessage?: string;
  projectRoot: string;
  outcome: ExecutionOutcome;
  steps: ExecutionStep[];
  summary?: string;
  createdAt: number;
}

export interface LastExecutionOutcome {
  succeeded: boolean;
  outcome: ExecutionOutcome;
  description: string;
  projectRoot: string;
  summary?: string;
  stepsSummary: string;
  createdAt: number;
  full?: ExecutionRecord;
}

/**
 * Record a plan execution (after executePendingPlan completes).
 */
export function recordPlanExecution(
  description: string,
  projectRoot: string,
  steps: ExecutionStep[],
  outcome: ExecutionOutcome,
  summary?: string,
  triggerMessage?: string
): string {
  const id = generateId('exec');
  const db = getDb();
  db.prepare(`
    INSERT INTO execution_log (id, type, description, trigger_message, project_root, outcome, steps_json, summary, created_at)
    VALUES (?, 'plan', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    description,
    triggerMessage ?? null,
    projectRoot,
    outcome,
    JSON.stringify(steps),
    summary ?? null,
    Date.now()
  );
  logger.debug('Execution log: plan recorded', { id, outcome, projectRoot, stepsCount: steps.length });
  return id;
}

/**
 * Record a dev_task execution (after executeDevTask returns).
 */
export function recordDevTaskExecution(
  description: string,
  projectRoot: string,
  outcome: ExecutionOutcome,
  steps: ExecutionStep[],
  summary?: string
): string {
  const id = generateId('exec');
  const db = getDb();
  db.prepare(`
    INSERT INTO execution_log (id, type, description, trigger_message, project_root, outcome, steps_json, summary, created_at)
    VALUES (?, 'dev_task', ?, NULL, ?, ?, ?, ?, ?)
  `).run(id, description, projectRoot, outcome, JSON.stringify(steps), summary ?? null, Date.now());
  logger.debug('Execution log: dev_task recorded', { id, outcome, projectRoot });
  return id;
}

/**
 * Get the last execution record (for "did Jeeves succeed?").
 */
export function getLastExecutionOutcome(includeFull?: boolean): LastExecutionOutcome | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT id, type, description, trigger_message, project_root, outcome, steps_json, summary, created_at
    FROM execution_log
    ORDER BY created_at DESC
    LIMIT 1
  `).get() as {
    id: string;
    type: string;
    description: string;
    trigger_message: string | null;
    project_root: string;
    outcome: string;
    steps_json: string;
    summary: string | null;
    created_at: number;
  } | undefined;

  if (!row) return null;

  const steps: ExecutionStep[] = [];
  try {
    const parsed = JSON.parse(row.steps_json);
    if (Array.isArray(parsed)) steps.push(...parsed);
  } catch {
    /* ignore */
  }

  const stepsSummary = steps.length === 0
    ? 'No steps recorded.'
    : steps.map((s) => `${s.success ? '✓' : '✗'} ${s.command}${s.cwd ? ` (cwd: ${s.cwd})` : ''}${s.error ? ` — ${s.error}` : ''}`).join('\n');

  const record: ExecutionRecord = {
    id: row.id,
    type: row.type as ExecutionType,
    description: row.description,
    triggerMessage: row.trigger_message ?? undefined,
    projectRoot: row.project_root,
    outcome: row.outcome as ExecutionOutcome,
    steps,
    summary: row.summary ?? undefined,
    createdAt: row.created_at,
  };

  return {
    succeeded: row.outcome === 'success',
    outcome: row.outcome as ExecutionOutcome,
    description: row.description,
    projectRoot: row.project_root,
    summary: row.summary ?? undefined,
    stepsSummary,
    createdAt: row.created_at,
    full: includeFull ? record : undefined,
  };
}

/**
 * Get last N execution records (for debug / audit).
 */
export function getExecutionLog(limit: number = 50): ExecutionRecord[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, type, description, trigger_message, project_root, outcome, steps_json, summary, created_at
    FROM execution_log
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit) as Array<{
    id: string;
    type: string;
    description: string;
    trigger_message: string | null;
    project_root: string;
    outcome: string;
    steps_json: string;
    summary: string | null;
    created_at: number;
  }>;

  return rows.map((row) => {
    let steps: ExecutionStep[] = [];
    try {
      const parsed = JSON.parse(row.steps_json);
      if (Array.isArray(parsed)) steps = parsed;
    } catch {
      /* ignore */
    }
    return {
      id: row.id,
      type: row.type as ExecutionType,
      description: row.description,
      triggerMessage: row.trigger_message ?? undefined,
      projectRoot: row.project_root,
      outcome: row.outcome as ExecutionOutcome,
      steps,
      summary: row.summary ?? undefined,
      createdAt: row.created_at,
    };
  });
}
