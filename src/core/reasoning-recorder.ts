/**
 * Reasoning recorder
 * Writes to reasoning_tasks and reasoning_error_occurrences for the REASONING tab.
 */

import { getDb, generateId } from './context/db.js';
import type { OODATrace } from './ooda-logger.js';

const TASK_TYPES = ['develop', 'review', 'fix', 'refactor'] as const;
export type TaskType = (typeof TASK_TYPES)[number];

/**
 * Infer task type from classification, action, and optional user message.
 * Exported for reclassification of existing reasoning_tasks.
 */
export function inferTaskType(classification: string | undefined, action: string, rawInput?: string): TaskType {
  const c = (classification ?? '').toLowerCase();
  const a = action.toLowerCase();
  const raw = (rawInput ?? '').toLowerCase();
  // Check action/classification first, then user's words so "fix the bug" + execute_plan → fix
  if (/refactor|reformat|reorganize/.test(a) || /refactor/.test(c) || /\b(refactor|reformat|reorganize)\b/.test(raw)) return 'refactor';
  if (/review|inspect|check|audit/.test(a) || /review/.test(c) || /\b(review|inspect|audit|check\s+(this|the|it)|code\s+review)\b/.test(raw)) return 'review';
  if (/fix|patch|repair|debug/.test(a) || /fix/.test(c) || /\b(fix|patch|repair|debug|broken|bug)\b/.test(raw)) return 'fix';
  return 'develop';
}

/**
 * Record a completed task from an OODA trace (called when trace is persisted).
 */
export async function recordReasoningTaskFromTrace(trace: OODATrace): Promise<void> {
  try {
    const db = getDb();
    const id = generateId('task');
    const taskType = inferTaskType(
      trace.orient?.classification,
      trace.decide?.action ?? '',
      trace.observe?.rawInput
    );
    const confidence = trace.orient?.confidenceScore != null ? Math.round(trace.orient.confidenceScore * 10) / 10 : null;
    const confidenceScaled = confidence != null ? Math.min(10, Math.max(1, confidence * 10)) : null; // 0-1 -> 1-10
    db.prepare(`
      INSERT INTO reasoning_tasks (id, timestamp, task_type, success, confidence, iterations, test_passed, trace_id, classification)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      Math.floor(trace.timestamp / 1000),
      taskType,
      trace.act?.success ? 1 : 0,
      confidenceScaled,
      trace.loop?.loopCount ?? 1,
      null, // test_passed: filled later by updateReasoningTaskTestResult when jeeves-qa reports
      trace.requestId,
      trace.orient?.classification ?? trace.decide?.action ?? null
    );
    // Record error occurrence for failed handler so it shows in Common Errors (with action for breakdown).
    // Ensure a learning exists for this failure type and link the occurrence so "Fixed by Learning?" can be Yes.
    if (!trace.act?.success) {
      const action = trace.decide?.action ?? 'unknown';
      if (action !== 'refuse') {
        const errorType = `handler_failure:${action}`;
        let learningId: string | null = null;
        try {
          const { getLearnings, recordLearning } = await import('./context/layers/learnings.js');
          const existing = getLearnings({ category: errorType });
          if (existing.length > 0) {
            learningId = existing[0].id;
          } else {
            learningId = recordLearning({
              category: errorType,
              trigger: `Handler failed for action: ${action}`,
              fix: 'Retry or use alternative command; check logs for root cause.',
              lesson: `Handler failure for ${action} is tracked; context or user follow-up may resolve.`,
            });
          }
        } catch {
          // learnings unavailable; record occurrence without link
        }
        recordErrorOccurrence(errorType, learningId);
      }
    }
  } catch (err) {
    import('../utils/logger.js').then(({ logger }) => logger.debug('ReasoningRecorder: record task failed', { error: String(err) })).catch(() => {});
  }
}

/**
 * Update test_passed for a reasoning task by trace_id (called when jeeves-qa reports a scenario run).
 */
export function updateReasoningTaskTestResult(traceId: string, passed: boolean): void {
  try {
    const db = getDb();
    db.prepare(`UPDATE reasoning_tasks SET test_passed = ? WHERE trace_id = ?`).run(passed ? 1 : 0, traceId);
  } catch (err) {
    import('../utils/logger.js').then(({ logger }) => logger.debug('ReasoningRecorder: update test result failed', { error: String(err) })).catch(() => {});
  }
}

/**
 * Record an error occurrence (call when an error path is taken).
 * learning_id can be set when a learning is applied to fix this error type.
 */
export function recordErrorOccurrence(errorType: string, learningId?: string | null): void {
  try {
    const db = getDb();
    const id = generateId('err');
    db.prepare(`
      INSERT INTO reasoning_error_occurrences (id, timestamp, error_type, learning_id)
      VALUES (?, strftime('%s', 'now'), ?, ?)
    `).run(id, errorType, learningId ?? null);
  } catch (err) {
    import('../utils/logger.js').then(({ logger }) => logger.debug('ReasoningRecorder: record error failed', { error: String(err) })).catch(() => {});
  }
}

/**
 * Reclassify existing reasoning_tasks using current inferTaskType logic.
 * Joins with growth_ooda_traces when trace_id is set to use raw_input for better classification.
 */
export function reclassifyReasoningTasks(): { updated: number; total: number } {
  try {
    const db = getDb();
    const tasks = db.prepare(`
      SELECT id, task_type, trace_id, classification FROM reasoning_tasks
    `).all() as Array<{ id: string; task_type: string; trace_id: string | null; classification: string | null }>;

    let updated = 0;
    const updateStmt = db.prepare('UPDATE reasoning_tasks SET task_type = ? WHERE id = ?');

    for (const row of tasks) {
      let action = row.classification ?? '';
      let rawInput: string | undefined;
      if (row.trace_id) {
        const growth = db.prepare(`
          SELECT raw_input, action FROM growth_ooda_traces WHERE request_id = ?
        `).get(row.trace_id) as { raw_input: string; action: string } | undefined;
        if (growth) {
          action = growth.action;
          rawInput = growth.raw_input;
        }
      }
      const newType = inferTaskType(row.classification ?? undefined, action, rawInput);
      if (newType !== row.task_type) {
        updateStmt.run(newType, row.id);
        updated++;
      }
    }

    if (updated > 0) {
      import('../utils/logger.js').then(({ logger }) =>
        logger.info('Reclassified reasoning tasks', { updated, total: tasks.length })
      ).catch(() => {});
    }
    return { updated, total: tasks.length };
  } catch (err) {
    import('../utils/logger.js').then(({ logger }) =>
      logger.debug('Reclassify reasoning tasks failed', { error: String(err) })
    ).catch(() => {});
    return { updated: 0, total: 0 };
  }
}
