/**
 * Novel Scenario Generator
 * Picks scenarios that have been run least recently or least often.
 * Used by jeeves-qa to prioritize under-tested scenarios.
 */

import { getDb } from './context/db.js';

export interface ScenarioWithRunCount {
  id: string;
  runCount: number;
  lastRunAt: number | null;
  passCount: number;
}

/**
 * Get run counts per scenario from growth_scenario_runs.
 */
export function getScenarioRunCounts(): ScenarioWithRunCount[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT scenario_id,
           COUNT(*) as run_count,
           MAX(run_at) as last_run_at,
           SUM(passed) as pass_count
    FROM growth_scenario_runs
    GROUP BY scenario_id
  `).all() as Array<{ scenario_id: string; run_count: number; last_run_at: number | null; pass_count: number }>;

  return rows.map((r) => ({
    id: r.scenario_id,
    runCount: r.run_count,
    lastRunAt: r.last_run_at,
    passCount: r.pass_count,
  }));
}

/**
 * Pick scenarios to run, prioritizing least-run and least-recent.
 * Returns scenario IDs in order of priority (novel first).
 */
export function pickNovelScenarios(
  allScenarioIds: string[],
  limit: number = 20
): string[] {
  const counts = getScenarioRunCounts();
  const byId = new Map(counts.map((c) => [c.id, c]));

  const scored = allScenarioIds.map((id) => {
    const c = byId.get(id) ?? { runCount: 0, lastRunAt: null, passCount: 0 };
    const noveltyScore = 1000 - c.runCount * 10 - (c.lastRunAt ? Math.floor(c.lastRunAt / 86400) : 0);
    return { id, score: noveltyScore };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.id);
}
