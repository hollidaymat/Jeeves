/**
 * Performance optimizer: analyze metrics over 24h/7d and generate recommendations.
 * Run daily via scheduler.
 */

import { getDb, generateId } from '../context/db.js';
import { logger } from '../../utils/logger.js';

export interface Recommendation {
  id: string;
  created_at: number;
  priority: 'low' | 'medium' | 'high';
  category: string;
  title: string;
  description: string;
  action: string;
  auto_action?: string;
  impact: string;
  status: string;
}

const REC_KEY_PREFIX = 'rec:';

function hasPendingRecommendation(db: ReturnType<typeof getDb>, key: string): boolean {
  const row = db.prepare(
    "SELECT 1 FROM performance_recommendations WHERE category = ? AND status = 'pending' LIMIT 1"
  ).get(REC_KEY_PREFIX + key) as { '1'?: number } | undefined;
  return !!row;
}

function insertRecommendation(
  db: ReturnType<typeof getDb>,
  key: string,
  priority: 'low' | 'medium' | 'high',
  title: string,
  description: string,
  action: string,
  impact: string,
  autoAction?: string
): void {
  const id = generateId('rec');
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO performance_recommendations (id, created_at, priority, category, title, description, action, auto_action, impact, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  `).run(id, now, priority, REC_KEY_PREFIX + key, title, description, action, autoAction ?? null, impact);
  logger.info('Performance recommendation created', { key, title });
}

export async function runOptimizer(): Promise<void> {
  try {
    const db = getDb();
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const sevenDaysAgo = now - 7 * dayMs;

    // Model selection: if most LLM calls are from one model and are fast, suggest Haiku for simple tasks
    const llmBySource = db.prepare(`
      SELECT source, AVG(value) as avg_ms, COUNT(*) as cnt
      FROM performance_metrics
      WHERE category = 'response_time' AND source = 'llm_call' AND timestamp >= ?
      GROUP BY source
    `).all(sevenDaysAgo) as Array<{ source: string; avg_ms: number; cnt: number }>;
    const totalLlm = llmBySource.reduce((s, r) => s + r.cnt, 0);
    if (totalLlm >= 20 && !hasPendingRecommendation(db, 'haiku_routing')) {
      insertRecommendation(
        db, 'haiku_routing', 'high',
        'Route simple commands through Haiku',
        'LLM metrics show many calls; Haiku is faster and cheaper for simple tasks.',
        'Use Haiku for conversational and low-complexity cognitive paths.',
        'Save cost and improve latency for simple requests.'
      );
    }

    // Signal response trend: if avg is high, suggest context trimming
    const signalAvg = db.prepare(`
      SELECT AVG(value) as avg_ms FROM performance_metrics
      WHERE category = 'response_time' AND source = 'signal_handler' AND timestamp >= ?
    `).get(sevenDaysAgo) as { avg_ms: number } | undefined;
    if (signalAvg && signalAvg.avg_ms > 8000 && !hasPendingRecommendation(db, 'context_trim')) {
      insertRecommendation(
        db, 'context_trim', 'medium',
        'Reduce context window for faster responses',
        'Average message response time is high. Large context assembly may be slowing replies.',
        'Review context layers and token budget; consider trimming to 3000 chars for non-critical paths.',
        'Faster response times for message handling.'
      );
    }
  } catch (err) {
    logger.debug('Optimizer failed', { error: String(err) });
  }
}
