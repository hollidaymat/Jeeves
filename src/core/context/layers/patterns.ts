/**
 * Layer 3: Patterns (Proven Solutions)
 * 
 * Known-good configurations, deployment scripts, command sequences
 * that have worked before. Auto-extracted after successful multi-step tasks.
 */

import { getDb, generateId } from '../db.js';
import { logger } from '../../../utils/logger.js';

// ==========================================
// TYPES
// ==========================================

export interface Pattern {
  id: string;
  description: string;
  steps: string[];
  rollback: string | null;
  successCount: number;
  lastUsed: number;
  category: string;
}

export interface MatchedPattern {
  id: string;
  description: string;
  steps: string[];
  rollback: string | null;
  successCount: number;
  category: string;
  matchScore: number;
}

// ==========================================
// PATTERN MATCHING
// ==========================================

/**
 * Extract keywords from a description for matching.
 */
function extractKeywords(text: string): string[] {
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
    'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
    'would', 'could', 'should', 'may', 'might', 'shall', 'can',
    'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
    'and', 'or', 'but', 'not', 'if', 'then', 'so', 'it', 'this',
    'that', 'my', 'your', 'their', 'our', 'all', 'each', 'every'
  ]);

  return text.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));
}

/**
 * Score how well a pattern matches a description.
 */
function matchScore(query: string, pattern: Pattern): number {
  const queryKeywords = extractKeywords(query);
  const patternKeywords = extractKeywords(pattern.description);

  if (queryKeywords.length === 0 || patternKeywords.length === 0) return 0;

  const matches = queryKeywords.filter(qk =>
    patternKeywords.some(pk => pk.includes(qk) || qk.includes(pk))
  );

  // Base score from keyword overlap
  const overlap = matches.length / Math.max(queryKeywords.length, 1);

  // Boost by success count (proven patterns are better)
  const successBoost = Math.min(pattern.successCount / 10, 0.2);

  return Math.min(1, overlap + successBoost);
}

// ==========================================
// DATABASE OPERATIONS
// ==========================================

/**
 * Find a pattern that matches the given task description.
 * Returns the best match if score >= 0.4, otherwise null.
 */
export function findMatchingPattern(
  description: string,
  action?: string
): MatchedPattern | null {
  const db = getDb();

  let rows: Pattern[];
  if (action) {
    // Try category match first
    const category = actionToCategory(action);
    rows = db.prepare(
      'SELECT * FROM patterns WHERE category = ? ORDER BY success_count DESC LIMIT 20'
    ).all(category) as Pattern[];

    // If nothing in category, search all
    if (rows.length === 0) {
      rows = db.prepare(
        'SELECT * FROM patterns ORDER BY success_count DESC LIMIT 50'
      ).all() as Pattern[];
    }
  } else {
    rows = db.prepare(
      'SELECT * FROM patterns ORDER BY success_count DESC LIMIT 50'
    ).all() as Pattern[];
  }

  let bestMatch: MatchedPattern | null = null;
  let bestScore = 0.4; // Minimum threshold

  for (const row of rows) {
    const pattern: Pattern = {
      ...row,
      steps: JSON.parse(row.steps as unknown as string),
      successCount: row.successCount ?? (row as any).success_count ?? 1,
      lastUsed: row.lastUsed ?? (row as any).last_used ?? 0
    };

    const score = matchScore(description, pattern);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = {
        id: pattern.id,
        description: pattern.description,
        steps: pattern.steps,
        rollback: pattern.rollback,
        successCount: pattern.successCount,
        category: pattern.category,
        matchScore: score
      };
    }
  }

  return bestMatch;
}

/**
 * Record or update a pattern after a successful task.
 * Only creates patterns for multi-step tasks (3+ steps).
 */
export function maybeRecordPattern(
  description: string,
  action: string,
  steps: string[],
  rollback?: string
): void {
  if (steps.length < 3) return;

  const db = getDb();
  const category = actionToCategory(action);

  // Check for existing similar pattern
  const existing = findMatchingPattern(description, action);

  if (existing && existing.matchScore >= 0.7) {
    // Update existing pattern
    db.prepare(`
      UPDATE patterns
      SET success_count = success_count + 1,
          last_used = strftime('%s', 'now')
      WHERE id = ?
    `).run(existing.id);

    logger.debug('Pattern reinforced', { id: existing.id, newCount: existing.successCount + 1 });
    return;
  }

  // Create new pattern
  const id = generateId('pat');
  db.prepare(`
    INSERT INTO patterns (id, description, steps, rollback, category, last_used)
    VALUES (?, ?, ?, ?, ?, strftime('%s', 'now'))
  `).run(id, description, JSON.stringify(steps), rollback || null, category);

  logger.debug('Pattern recorded', { id, description: description.substring(0, 60), steps: steps.length });
}

/**
 * Get all patterns, optionally filtered by category.
 */
export function getPatterns(category?: string): Pattern[] {
  const db = getDb();

  const rows = category
    ? db.prepare('SELECT * FROM patterns WHERE category = ? ORDER BY success_count DESC').all(category)
    : db.prepare('SELECT * FROM patterns ORDER BY success_count DESC').all();

  return (rows as any[]).map(row => ({
    ...row,
    steps: JSON.parse(row.steps),
    successCount: row.success_count ?? 1,
    lastUsed: row.last_used ?? 0
  }));
}

// ==========================================
// HELPERS
// ==========================================

function actionToCategory(action: string): string {
  if (action.startsWith('homelab_install')) return 'deploy';
  if (action.startsWith('homelab_uninstall')) return 'teardown';
  if (action.startsWith('homelab_update')) return 'upgrade';
  if (action.startsWith('homelab_health') || action.startsWith('homelab_status')) return 'diagnostics';
  if (action.startsWith('media_')) return 'media';
  if (action.includes('backup')) return 'backup';
  if (action.includes('firewall') || action.includes('security')) return 'security';
  return 'general';
}
