/**
 * Playbook generator: analyze completed tasks, cluster by pattern, upsert playbooks.
 */

import { getDb } from '../context/db.js';
import type { Playbook } from '../orchestrator/types.js';
import { logger } from '../../utils/logger.js';

const PATTERN_KEYWORDS = ['auth', 'api', 'jwt', 'login', 'endpoint', 'test', 'middleware', 'db', 'migration'];

function inferPattern(title: string, prd: string): string {
  const text = `${title} ${prd}`.toLowerCase();
  for (const kw of PATTERN_KEYWORDS) {
    if (text.includes(kw)) return kw;
  }
  return 'general';
}

/**
 * Run playbook generation: load completed tasks, cluster, compute metrics, upsert playbooks table.
 */
export function runPlaybookGenerator(): void {
  const db = getDb();
  const tasks = db
    .prepare(
      `SELECT task_id, prd, status, created_at FROM orchestrator_tasks WHERE status IN ('success', 'escalated') ORDER BY created_at DESC`
    )
    .all() as Array<{ task_id: string; prd: string; status: string; created_at: number }>;
  if (tasks.length === 0) return;

  const byPattern = new Map<
    string,
    Array<{ task_id: string; prd: string; status: string; iterations: number; spec_template?: string }>
  >();
  for (const t of tasks) {
    const pattern = inferPattern(t.prd.slice(0, 80), t.prd);
    const itRows = db.prepare('SELECT iteration, spec FROM orchestrator_task_iterations WHERE task_id = ? ORDER BY iteration DESC LIMIT 1').get(t.task_id) as { iteration: number; spec: string } | undefined;
    const iterations = itRows?.iteration ?? 0;
    const spec_template = itRows?.spec?.slice(0, 500);
    if (!byPattern.has(pattern)) byPattern.set(pattern, []);
    byPattern.get(pattern)!.push({ task_id: t.task_id, prd: t.prd, status: t.status, iterations, spec_template });
  }

  const now = Math.floor(Date.now() / 1000);
  const upsert = db.prepare(`
    INSERT OR REPLACE INTO orchestrator_playbooks (pattern, success_rate, avg_iterations, common_errors, winning_spec_template, last_updated)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  for (const [pattern, list] of byPattern) {
    const successCount = list.filter((x) => x.status === 'success').length;
    const success_rate = list.length ? successCount / list.length : 0;
    const avg_iterations = list.length ? list.reduce((s, x) => s + x.iterations, 0) / list.length : 0;
    const errors = list.filter((x) => x.status === 'escalated').map((x) => x.prd.slice(0, 100));
    const best = list.filter((x) => x.status === 'success').sort((a, b) => a.iterations - b.iterations)[0];
    const winning_spec_template = best?.spec_template ?? '';
    upsert.run(pattern, success_rate, avg_iterations, JSON.stringify(errors.slice(0, 10)), winning_spec_template, now);
  }
  logger.debug('[orchestrator] Playbook generator ran', { patterns: byPattern.size, tasks: tasks.length });
}
