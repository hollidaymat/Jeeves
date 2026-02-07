/**
 * Decision Recorder
 * 
 * Records decisions to SQLite for the future Digital Twin prediction engine.
 * Stores category, context, decision, reasoning, and confidence for
 * pattern analysis once enough data is accumulated.
 */

import { getDb } from '../../core/context/db.js';
import { logger } from '../../utils/logger.js';

// ============================================================================
// Table Initialization
// ============================================================================

let tableInitialized = false;

/**
 * Create the decisions table if it doesn't exist.
 */
export function initDecisionTable(): void {
  if (tableInitialized) return;

  try {
    const db = getDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        context_summary TEXT NOT NULL,
        decision TEXT NOT NULL,
        reasoning TEXT,
        confidence REAL DEFAULT 0.5,
        timestamp INTEGER NOT NULL,
        auto_approved INTEGER DEFAULT 0
      )
    `);

    tableInitialized = true;
    logger.debug('Decisions table initialized');
  } catch (error) {
    logger.error('Failed to initialize decisions table', { error: String(error) });
  }
}

// ============================================================================
// Recording
// ============================================================================

/**
 * Record a decision for future prediction analysis.
 */
export function recordDecision(
  category: string,
  contextSummary: string,
  decision: string,
  reasoning?: string,
  confidence?: number,
): void {
  try {
    initDecisionTable();
    const db = getDb();

    const stmt = db.prepare(`
      INSERT INTO decisions (category, context_summary, decision, reasoning, confidence, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      category,
      contextSummary,
      decision,
      reasoning ?? null,
      confidence ?? 0.5,
      Date.now(),
    );

    logger.debug('Decision recorded', { category, decision: decision.substring(0, 50) });
  } catch (error) {
    logger.error('Failed to record decision', { error: String(error) });
  }
}

// ============================================================================
// Queries
// ============================================================================

/**
 * Get the total number of recorded decisions.
 */
export function getDecisionCount(): number {
  try {
    initDecisionTable();
    const db = getDb();
    const row = db.prepare('SELECT COUNT(*) as count FROM decisions').get() as { count: number };
    return row.count;
  } catch (error) {
    logger.error('Failed to get decision count', { error: String(error) });
    return 0;
  }
}

/**
 * Get recent decisions, ordered by most recent first.
 */
export function getRecentDecisions(limit: number = 10): Array<{
  category: string;
  decision: string;
  reasoning: string;
  timestamp: number;
}> {
  try {
    initDecisionTable();
    const db = getDb();

    const rows = db.prepare(`
      SELECT category, decision, reasoning, timestamp
      FROM decisions
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(limit) as Array<{
      category: string;
      decision: string;
      reasoning: string | null;
      timestamp: number;
    }>;

    return rows.map(row => ({
      category: row.category,
      decision: row.decision,
      reasoning: row.reasoning ?? '',
      timestamp: row.timestamp,
    }));
  } catch (error) {
    logger.error('Failed to get recent decisions', { error: String(error) });
    return [];
  }
}

/**
 * Get decision statistics including category breakdown and prediction readiness.
 */
export function getDecisionStats(): {
  total: number;
  byCategory: Record<string, number>;
  readyForPrediction: boolean;
} {
  try {
    initDecisionTable();
    const db = getDb();

    const total = getDecisionCount();

    const categoryRows = db.prepare(`
      SELECT category, COUNT(*) as count
      FROM decisions
      GROUP BY category
    `).all() as Array<{ category: string; count: number }>;

    const byCategory: Record<string, number> = {};
    for (const row of categoryRows) {
      byCategory[row.category] = row.count;
    }

    return {
      total,
      byCategory,
      readyForPrediction: total >= 50,
    };
  } catch (error) {
    logger.error('Failed to get decision stats', { error: String(error) });
    return {
      total: 0,
      byCategory: {},
      readyForPrediction: false,
    };
  }
}
