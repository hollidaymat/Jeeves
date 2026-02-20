/**
 * Observer: record Antigravity orchestration runs to DB for playbooks.
 */

import { getDb } from '../context/db.js';
import type { AntigravitySpec, InteractionRecord } from '../orchestrator/types.js';
import { logger } from '../../utils/logger.js';

export interface RecordExecutionInput {
  task_id: string;
  iteration: number;
  spec: AntigravitySpec;
  antigravity_output: string;
  test_result: 'pass' | 'fail';
  error?: string;
  jeeves_action?: string;
  duration_ms: number;
}

/**
 * Record one iteration (call after each Antigravity run).
 */
export function recordIteration(input: RecordExecutionInput): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO orchestrator_task_iterations
    (task_id, iteration, spec, antigravity_output, test_result, error, jeeves_action, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    input.task_id,
    input.iteration,
    JSON.stringify(input.spec),
    input.antigravity_output,
    input.test_result,
    input.error ?? null,
    input.jeeves_action ?? null,
    input.duration_ms
  );
}

/**
 * Upsert task row (created_at set on first call; completed_at and final_code on completion).
 */
export function recordTask(
  task_id: string,
  prd: string,
  status: string,
  options?: { completed_at?: number; final_code?: string }
): void {
  const db = getDb();
  const existing = db.prepare('SELECT task_id FROM orchestrator_tasks WHERE task_id = ?').get(task_id);
  if (existing) {
    db.prepare(
      'UPDATE orchestrator_tasks SET status = ?, completed_at = ?, final_code = ? WHERE task_id = ?'
    ).run(status, options?.completed_at ?? null, options?.final_code ?? null, task_id);
  } else {
    db.prepare(
      'INSERT INTO orchestrator_tasks (task_id, prd, status, completed_at, final_code) VALUES (?, ?, ?, ?, ?)'
    ).run(task_id, prd, status, options?.completed_at ?? null, options?.final_code ?? null);
  }
}

/**
 * Load full interaction record for a task (for playbook generator or UI).
 */
export function getInteractionRecord(task_id: string): InteractionRecord | null {
  const db = getDb();
  const task = db.prepare('SELECT * FROM orchestrator_tasks WHERE task_id = ?').get(task_id) as {
    task_id: string;
    prd: string;
    status: string;
    final_code?: string;
  } | undefined;
  if (!task) return null;
  const rows = db
    .prepare(
      'SELECT iteration, spec, antigravity_output, test_result, error, jeeves_action, duration_ms FROM orchestrator_task_iterations WHERE task_id = ? ORDER BY iteration'
    )
    .all(task_id) as Array<{
    iteration: number;
    spec: string;
    antigravity_output: string;
    test_result: string;
    error: string | null;
    jeeves_action: string | null;
    duration_ms: number;
  }>;
  const spec = rows[0] ? (JSON.parse(rows[0].spec) as AntigravitySpec) : ({} as AntigravitySpec);
  const total_duration_ms = rows.reduce((s, r) => s + (r.duration_ms || 0), 0);
  return {
    task_id,
    prd: task.prd,
    spec_generated: spec,
    executions: rows.map((r) => ({
      iteration: r.iteration,
      antigravity_input: r.spec,
      antigravity_output: r.antigravity_output ?? '',
      test_result: (r.test_result === 'pass' ? 'pass' : 'fail') as 'pass' | 'fail',
      error: r.error ?? undefined,
      jeeves_action: r.jeeves_action ?? undefined,
    })),
    final_status: task.status === 'success' ? 'success' : task.status === 'escalated' ? 'escalated' : 'user_helped',
    total_iterations: rows.length,
    total_duration_ms,
    generated_code: task.final_code,
  };
}

/**
 * List recent tasks for UI.
 */
export function listRecentTasks(limit = 20): Array<{ task_id: string; prd: string; status: string; created_at: number }> {
  const db = getDb();
  const rows = db
    .prepare(
      'SELECT task_id, prd, status, created_at FROM orchestrator_tasks ORDER BY created_at DESC LIMIT ?'
    )
    .all(limit) as Array<{ task_id: string; prd: string; status: string; created_at: number }>;
  return rows;
}
