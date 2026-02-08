/**
 * Cursor Feedback Loop
 * Records Cursor task outcomes for learning and analytics.
 * Called when tasks complete (success, error, or stopped).
 */

import { getDb } from './context/db.js';
import type { CursorTask } from '../integrations/cursor-orchestrator.js';

/**
 * Record a Cursor task outcome for the feedback loop.
 */
export function recordCursorOutcome(task: CursorTask): void {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO growth_cursor_outcomes (task_id, status, summary, pr_url, completed_at)
      VALUES (?, ?, ?, ?, strftime('%s', 'now'))
    `).run(
      task.id,
      task.status,
      task.spec?.summary ?? null,
      task.prUrl ?? null
    );
  } catch (err) {
    import('../utils/logger.js').then(({ logger }) => logger.debug('CursorFeedbackLoop: record outcome failed', { error: String(err) })).catch(() => {});
  }
}
