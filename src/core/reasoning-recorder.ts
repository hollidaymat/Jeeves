/**
 * Reasoning recorder
 * Writes to reasoning_tasks and reasoning_error_occurrences for the REASONING tab.
 */

import { getDb, generateId } from './context/db.js';
import type { OODATrace } from './ooda-logger.js';

const TASK_TYPES = ['develop', 'review', 'fix', 'refactor'] as const;
type TaskType = (typeof TASK_TYPES)[number];

function inferTaskType(classification: string | undefined, action: string): TaskType {
  const c = (classification ?? '').toLowerCase();
  const a = action.toLowerCase();
  if (/refactor|reformat|reorganize/.test(a) || /refactor/.test(c)) return 'refactor';
  if (/review|inspect|check|audit/.test(a) || /review/.test(c)) return 'review';
  if (/fix|patch|repair|debug/.test(a) || /fix/.test(c)) return 'fix';
  return 'develop';
}

/**
 * Record a completed task from an OODA trace (called when trace is persisted).
 */
export function recordReasoningTaskFromTrace(trace: OODATrace): void {
  try {
    const db = getDb();
    const id = generateId('task');
    const taskType = inferTaskType(trace.orient?.classification, trace.decide?.action ?? '');
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
    // Record error occurrence for failed handler so it shows in Common Errors (with action for breakdown)
    if (!trace.act?.success) {
      const action = trace.decide?.action ?? 'unknown';
      if (action !== 'refuse') {
        recordErrorOccurrence(`handler_failure:${action}`);
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
