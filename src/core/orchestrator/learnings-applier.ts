/**
 * Learnings applier: fetch relevant playbooks for a PRD and inject into spec context.
 */

import { getDb } from '../context/db.js';
import type { PRDRequest, Playbook } from './types.js';

/**
 * Get playbooks relevant to this PRD (keyword match on title + description).
 */
export function getRelevantPlaybooks(prd: PRDRequest, limit = 5): Playbook[] {
  const db = getDb();
  const rows = db
    .prepare(
      'SELECT pattern, success_rate, avg_iterations, common_errors, winning_spec_template, last_updated FROM orchestrator_playbooks ORDER BY success_rate DESC, last_updated DESC'
    )
    .all() as Array<{
    pattern: string;
    success_rate: number;
    avg_iterations: number;
    common_errors: string;
    winning_spec_template: string | null;
    last_updated: number;
  }>;
  const text = `${prd.title} ${prd.description}`.toLowerCase();
  const relevant = rows.filter((r) => text.includes(r.pattern) || r.pattern === 'general');
  return relevant.slice(0, limit).map((r) => ({
    pattern: r.pattern,
    success_rate: r.success_rate,
    avg_iterations: r.avg_iterations,
    common_errors: (() => {
      try {
        return JSON.parse(r.common_errors || '[]') as string[];
      } catch {
        return [];
      }
    })(),
    winning_spec_template: r.winning_spec_template ?? '',
    last_updated: r.last_updated,
  }));
}
