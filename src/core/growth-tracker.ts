/**
 * Growth Tracker
 * Persists OODA traces and scenario runs for learning and anti-gaming.
 * Used by jeeves-qa and NovelScenarioGenerator.
 */

import { getDb } from './context/db.js';
import type { OODATrace } from './ooda-logger.js';

export interface RunSummaryInput {
  total_pass: number;
  total_fail: number;
  novel_pass: number;
  novel_fail: number;
  context_loaded_rate: number;
  avg_confidence_score?: number;
}

export interface RunSummary {
  id: number;
  run_at: number;
  total_pass: number;
  total_fail: number;
  novel_pass: number;
  novel_fail: number;
  context_loaded_rate: number;
  avg_confidence_score: number | null;
}

/**
 * Persist an OODA trace to growth_ooda_traces (beyond in-memory window).
 */
export function persistTrace(trace: OODATrace): void {
  try {
    const db = getDb();
    db.prepare(`
      INSERT OR REPLACE INTO growth_ooda_traces (
        request_id, timestamp, routing_path, raw_input, context_loaded,
        classification, confidence_score, action, success, total_time_ms,
        model_used, loop_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      trace.requestId,
      trace.timestamp,
      trace.routingPath,
      trace.observe.rawInput,
      JSON.stringify(trace.observe.contextLoaded),
      trace.orient.classification ?? null,
      trace.orient.confidenceScore ?? null,
      trace.decide.action,
      trace.act.success ? 1 : 0,
      trace.loop.totalTime ?? 0,
      trace.decide.modelUsed ?? null,
      trace.loop.loopCount ?? 1
    );
    // Also record for REASONING tab metrics (reasoning_tasks)
    import('./reasoning-recorder.js').then(({ recordReasoningTaskFromTrace }) => recordReasoningTaskFromTrace(trace)).catch(() => {});
  } catch (err) {
    // Growth persistence is non-critical; log and continue
    import('../utils/logger.js').then(({ logger }) => logger.debug('GrowthTracker: persist trace failed', { error: String(err) })).catch(() => {});
  }
}

/**
 * Record a scenario run for NovelScenarioGenerator and AntiGaming.
 */
export function recordScenarioRun(
  scenarioId: string,
  passed: boolean,
  options?: { responseMs?: number; oodaRequestId?: string }
): void {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO growth_scenario_runs (scenario_id, run_at, passed, response_ms, ooda_request_id)
      VALUES (?, strftime('%s', 'now'), ?, ?, ?)
    `).run(
      scenarioId,
      passed ? 1 : 0,
      options?.responseMs ?? null,
      options?.oodaRequestId ?? null
    );
    // Wire test result into REASONING tab (reasoning_tasks.test_passed)
    if (options?.oodaRequestId) {
      import('./reasoning-recorder.js').then(({ updateReasoningTaskTestResult }) => {
        updateReasoningTaskTestResult(options.oodaRequestId!, passed);
      }).catch(() => {});
    }
  } catch (err) {
    import('../utils/logger.js').then(({ logger }) => logger.debug('GrowthTracker: record scenario run failed', { error: String(err) })).catch(() => {});
  }
}

export interface GrowthStats {
  totalTraces: number;
  totalScenarioRuns: number;
  byPath: Record<string, number>;
  scenarioPassRate: number;
  recentScenarioRuns: Array<{ scenario_id: string; run_at: number; passed: number }>;
}

/**
 * Get recent OODA journal entries (for "check his journal" / debug).
 * Returns last N persisted traces with human-readable fields.
 */
export function getRecentOodaJournal(limit: number = 50): Array<{
  requestId: string;
  timestamp: number;
  time: string;
  routingPath: string;
  rawInput: string;
  action: string;
  success: boolean;
  totalTimeMs: number;
  loopCount: number;
}> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT request_id, timestamp, routing_path, raw_input, action, success, total_time_ms, loop_count
    FROM growth_ooda_traces
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(limit) as Array<{
    request_id: string;
    timestamp: number;
    routing_path: string;
    raw_input: string;
    action: string;
    success: number;
    total_time_ms: number;
    loop_count: number;
  }>;
  return rows.map((r) => ({
    requestId: r.request_id,
    timestamp: r.timestamp,
    time: new Date(r.timestamp).toISOString(),
    routingPath: r.routing_path,
    rawInput: r.raw_input,
    action: r.action,
    success: r.success === 1,
    totalTimeMs: r.total_time_ms ?? 0,
    loopCount: r.loop_count ?? 1,
  }));
}

/**
 * Get aggregate growth stats.
 */
export function getGrowthStats(): GrowthStats {
  const db = getDb();
  const traces = db.prepare(
    'SELECT routing_path FROM growth_ooda_traces'
  ).all() as Array<{ routing_path: string }>;
  const runs = db.prepare(
    'SELECT scenario_id, run_at, passed FROM growth_scenario_runs ORDER BY run_at DESC LIMIT 100'
  ).all() as Array<{ scenario_id: string; run_at: number; passed: number }>;

  const byPath: Record<string, number> = {};
  for (const t of traces) {
    byPath[t.routing_path] = (byPath[t.routing_path] ?? 0) + 1;
  }

  const totalRuns = runs.length;
  const passedRuns = runs.filter((r) => r.passed === 1).length;
  const passRate = totalRuns > 0 ? passedRuns / totalRuns : 0;
  const countRow = db.prepare('SELECT COUNT(*) as c FROM growth_scenario_runs').get() as { c: number };

  return {
    totalTraces: traces.length,
    totalScenarioRuns: countRow.c,
    byPath,
    scenarioPassRate: passRate,
    recentScenarioRuns: runs,
  };
}

/**
 * Record a test run summary (Phase 6). Call after jeeves-qa completes a full run.
 */
export function recordRunSummary(input: RunSummaryInput): number {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO growth_run_summaries (total_pass, total_fail, novel_pass, novel_fail, context_loaded_rate, avg_confidence_score)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    input.total_pass,
    input.total_fail,
    input.novel_pass,
    input.novel_fail,
    input.context_loaded_rate,
    input.avg_confidence_score ?? null
  );
  return result.lastInsertRowid as number;
}

/**
 * Get last N run summaries for trend comparison.
 */
export function getRunSummaries(limit: number = 10): RunSummary[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, run_at, total_pass, total_fail, novel_pass, novel_fail, context_loaded_rate, avg_confidence_score
    FROM growth_run_summaries
    ORDER BY run_at DESC
    LIMIT ?
  `).all(limit) as Array<{
    id: number;
    run_at: number;
    total_pass: number;
    total_fail: number;
    novel_pass: number;
    novel_fail: number;
    context_loaded_rate: number;
    avg_confidence_score: number | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    run_at: r.run_at,
    total_pass: r.total_pass,
    total_fail: r.total_fail,
    novel_pass: r.novel_pass,
    novel_fail: r.novel_fail,
    context_loaded_rate: r.context_loaded_rate,
    avg_confidence_score: r.avg_confidence_score,
  }));
}

export type GrowthTrendStatus = 'GROWING' | 'PATCHING' | 'ASSEMBLER_NOT_WIRED' | 'UNKNOWN';

export interface GrowthTrend {
  runs: RunSummary[];
  status: GrowthTrendStatus;
  /** Human-readable interpretation */
  interpretation: string;
  novel_pass_rate_trend: 'up' | 'down' | 'flat';
  known_pass_rate_trend: 'up' | 'down' | 'flat';
}

/**
 * Get growth trend: last 10 runs compared.
 * - novel_pass_rate increases = GROWING
 * - only known_pass_rate increases = PATCHING
 * - context_loaded_rate stays 0 = ASSEMBLER_NOT_WIRED
 */
export function getGrowthTrend(limit: number = 10): GrowthTrend {
  const runs = getRunSummaries(limit);
  if (runs.length === 0) {
    return {
      runs: [],
      status: 'UNKNOWN',
      interpretation: 'No run summaries yet. Run jeeves-qa and post run summaries.',
      novel_pass_rate_trend: 'flat',
      known_pass_rate_trend: 'flat',
    };
  }

  const totalNovel = (r: RunSummary) => r.novel_pass + r.novel_fail;
  const totalKnown = (r: RunSummary) => (r.total_pass + r.total_fail) - totalNovel(r);
  const novelPassRate = (r: RunSummary) => (totalNovel(r) > 0 ? r.novel_pass / totalNovel(r) : 0);
  const knownPassRate = (r: RunSummary) => (totalKnown(r) > 0 ? (r.total_pass - r.novel_pass) / totalKnown(r) : 0);

  const latest = runs[0];
  const oldest = runs[runs.length - 1];

  const latestNovelRate = novelPassRate(latest);
  const oldestNovelRate = novelPassRate(oldest);
  const latestKnownRate = knownPassRate(latest);
  const oldestKnownRate = knownPassRate(oldest);

  const novelTrend: GrowthTrend['novel_pass_rate_trend'] =
    latestNovelRate > oldestNovelRate ? 'up' : latestNovelRate < oldestNovelRate ? 'down' : 'flat';
  const knownTrend: GrowthTrend['known_pass_rate_trend'] =
    latestKnownRate > oldestKnownRate ? 'up' : latestKnownRate < oldestKnownRate ? 'down' : 'flat';

  const avgContextLoaded = runs.reduce((s, r) => s + r.context_loaded_rate, 0) / runs.length;

  let status: GrowthTrendStatus = 'UNKNOWN';
  let interpretation: string;

  if (avgContextLoaded === 0) {
    status = 'ASSEMBLER_NOT_WIRED';
    interpretation = 'context_loaded_rate is 0 across runs — assembler not wired for complex requests.';
  } else if (novelTrend === 'up') {
    status = 'GROWING';
    interpretation = 'novel_pass_rate increased across runs — Jeeves is generalizing to new scenarios.';
  } else if (knownTrend === 'up' && (novelTrend === 'flat' || novelTrend === 'down')) {
    status = 'PATCHING';
    interpretation = 'Only known_pass_rate increased — improvements to existing scenarios, no novel growth.';
  } else {
    interpretation = `Novel trend: ${novelTrend}, known trend: ${knownTrend}. Context loaded rate: ${(avgContextLoaded * 100).toFixed(0)}%.`;
  }

  return {
    runs,
    status,
    interpretation,
    novel_pass_rate_trend: novelTrend,
    known_pass_rate_trend: knownTrend,
  };
}
