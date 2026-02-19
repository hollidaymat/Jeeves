/**
 * Layer 5: Learnings (Error Patterns & Fixes)
 * 
 * Every error Jeeves encounters + what fixed it.
 * Confidence reinforcement loop: fixes that work again get stronger,
 * fixes that fail get weaker.
 */

import { getDb, generateId } from '../db.js';
import { logger } from '../../../utils/logger.js';

// ==========================================
// TYPES
// ==========================================

export interface Learning {
  id: string;
  timestamp: number;
  category: string;
  trigger: string;
  rootCause: string | null;
  fix: string;
  lesson: string;
  appliesTo: string | null;
  confidence: number;
  timesApplied: number;
  timesFailed: number;
  supersededBy: string | null;
}

export interface RecordLearningInput {
  category: string;
  trigger: string;
  rootCause?: string;
  fix: string;
  lesson: string;
  appliesTo?: string;
}

// ==========================================
// DATABASE OPERATIONS
// ==========================================

/**
 * Record a new learning from an error + fix pair.
 */
export function recordLearning(input: RecordLearningInput): string {
  const db = getDb();
  const id = generateId('learn');

  db.prepare(`
    INSERT INTO learnings (id, category, trigger_text, root_cause, fix, lesson, applies_to)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.category,
    input.trigger,
    input.rootCause || null,
    input.fix,
    input.lesson,
    input.appliesTo || null
  );

  logger.info('Learning recorded', {
    id,
    category: input.category,
    trigger: input.trigger.substring(0, 60)
  });

  // Record for REASONING tab: one error occurrence linked to this learning (fixed by learning)
  import('../../reasoning-recorder.js').then(({ recordErrorOccurrence }) => {
    recordErrorOccurrence(input.category, id);
  }).catch(() => {});

  return id;
}

/**
 * Reinforce a learning (its fix worked again).
 * Increases confidence and times_applied.
 */
export function reinforceLearning(id: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE learnings
    SET times_applied = times_applied + 1,
        confidence = MIN(0.99, confidence + 0.05)
    WHERE id = ?
  `).run(id);

  logger.debug('Learning reinforced', { id });
}

/**
 * Weaken a learning (its fix didn't work).
 * Decreases confidence and increases times_failed.
 */
export function weakenLearning(id: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE learnings
    SET times_failed = times_failed + 1,
        confidence = MAX(0.1, confidence - 0.1)
    WHERE id = ?
  `).run(id);

  logger.debug('Learning weakened', { id });
}

/**
 * Mark a learning as superseded by a better fix.
 */
export function supersedeLearning(oldId: string, newId: string): void {
  const db = getDb();
  db.prepare('UPDATE learnings SET superseded_by = ? WHERE id = ?').run(newId, oldId);
}

/**
 * Find learnings relevant to a task description and/or service.
 * Returns up to 5 most relevant learnings with confidence > 0.3.
 */
export function findRelevantLearnings(
  description: string,
  service?: string
): Learning[] {
  const db = getDb();
  const results: Learning[] = [];

  // First: exact service match
  if (service) {
    const serviceRows = db.prepare(`
      SELECT * FROM learnings
      WHERE applies_to = ? AND confidence > 0.3 AND superseded_by IS NULL
      ORDER BY times_applied DESC, confidence DESC
      LIMIT 3
    `).all(service) as any[];

    for (const row of serviceRows) {
      results.push(rowToLearning(row));
    }
  }

  // Second: at most one self-test learning when message clearly matches a trigger (avoid flooding context)
  const descLower = description.toLowerCase().trim();
  if (descLower.length > 0) {
    const scenarioRows = db.prepare(`
      SELECT * FROM learnings
      WHERE applies_to = 'self-test' AND confidence > 0.3 AND superseded_by IS NULL
      ORDER BY times_applied DESC, confidence DESC
    `).all() as any[];
    let best: { row: any; score: number } | null = null;
    for (const row of scenarioRows) {
      const triggerLower = (row.trigger_text || '').toLowerCase();
      const descWords = new Set(descLower.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w: string) => w.length > 2));
      const triggerWords = new Set(triggerLower.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w: string) => w.length > 2));
      const overlap = [...descWords].filter((w: string) => triggerWords.has(w)).length;
      const triggerInDesc = triggerLower.length > 10 && descLower.includes(triggerLower.slice(0, 50));
      const score = triggerInDesc ? 100 + overlap : overlap;
      if ((overlap >= 4 || triggerInDesc) && (!best || score > best.score)) {
        best = { row, score };
      }
    }
    if (best) {
      results.push(rowToLearning(best.row));
    }
  }

  // Third: keyword match in trigger or lesson
  const keywords = description.toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 3);

  if (keywords.length > 0 && results.length < 5) {
    const topKeywords = keywords.slice(0, 3);
    for (const keyword of topKeywords) {
      const rows = db.prepare(`
        SELECT * FROM learnings
        WHERE (trigger_text LIKE ? OR lesson LIKE ? OR fix LIKE ?)
          AND confidence > 0.3
          AND superseded_by IS NULL
          AND id NOT IN (${results.map(() => '?').join(',') || "''"})
        ORDER BY confidence DESC, times_applied DESC
        LIMIT 2
      `).all(
        `%${keyword}%`, `%${keyword}%`, `%${keyword}%`,
        ...results.map(r => r.id)
      ) as any[];

      for (const row of rows) {
        results.push(rowToLearning(row));
      }
    }
  }

  // Deduplicate and limit
  const seen = new Set<string>();
  const unique = results.filter(r => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });

  return unique.slice(0, 5);
}

/**
 * Get all learnings, optionally filtered.
 */
export function getLearnings(opts?: {
  category?: string;
  appliesTo?: string;
  minConfidence?: number;
}): Learning[] {
  const db = getDb();
  let sql = 'SELECT * FROM learnings WHERE superseded_by IS NULL';
  const params: unknown[] = [];

  if (opts?.category) {
    sql += ' AND category = ?';
    params.push(opts.category);
  }
  if (opts?.appliesTo) {
    sql += ' AND applies_to = ?';
    params.push(opts.appliesTo);
  }
  if (opts?.minConfidence !== undefined) {
    sql += ' AND confidence >= ?';
    params.push(opts.minConfidence);
  }

  sql += ' ORDER BY confidence DESC, times_applied DESC';

  return (db.prepare(sql).all(...params) as any[]).map(rowToLearning);
}

const SCENARIO_CATEGORY_PREFIX = 'scenario:';

/**
 * Get the single most recent learning for a category (e.g. scenario:rememberpreference).
 */
export function getLearningByCategory(category: string): Learning | null {
  const list = getLearnings({ category });
  return list.length > 0 ? list[0]! : null;
}

/**
 * Apply self-test scenario failure: weaken existing scenario learning or create one.
 * Called when jeeves-qa reports a scenario run with passed=false.
 */
export function applyScenarioFailure(
  scenarioId: string,
  failureDetail: { trigger: string; check: string; detail: string }
): void {
  const category = SCENARIO_CATEGORY_PREFIX + scenarioId;
  const existing = getLearningByCategory(category);
  if (existing) {
    weakenLearning(existing.id);
    logger.debug('Scenario learning weakened (failure)', { scenarioId, learningId: existing.id });
    return;
  }
  recordLearning({
    category,
    trigger: failureDetail.trigger,
    rootCause: failureDetail.check,
    fix: failureDetail.detail,
    lesson: 'Self-test expectation: response should satisfy this check.',
    appliesTo: 'self-test',
  });
  logger.info('Scenario learning created from self-test failure', { scenarioId, check: failureDetail.check });
}

/**
 * Apply self-test scenario success: reinforce existing scenario learning.
 * Called when jeeves-qa reports a scenario run with passed=true.
 */
export function applyScenarioSuccess(scenarioId: string): void {
  const category = SCENARIO_CATEGORY_PREFIX + scenarioId;
  const existing = getLearningByCategory(category);
  if (existing) {
    reinforceLearning(existing.id);
    logger.debug('Scenario learning reinforced (success)', { scenarioId, learningId: existing.id });
  }
}

// ==========================================
// HELPERS
// ==========================================

function rowToLearning(row: any): Learning {
  return {
    id: row.id,
    timestamp: row.timestamp,
    category: row.category,
    trigger: row.trigger_text,
    rootCause: row.root_cause,
    fix: row.fix,
    lesson: row.lesson,
    appliesTo: row.applies_to,
    confidence: row.confidence,
    timesApplied: row.times_applied,
    timesFailed: row.times_failed,
    supersededBy: row.superseded_by
  };
}
