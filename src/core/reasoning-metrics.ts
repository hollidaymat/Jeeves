/**
 * Reasoning evaluation metrics for the REASONING tab.
 * Reads from reasoning_tasks and reasoning_error_occurrences.
 */

import { getDb } from './context/db.js';

function parseDays(queryDays: string | undefined): number | null {
  if (queryDays === undefined || queryDays === '') return null;
  const d = parseInt(String(queryDays), 10);
  if (Number.isNaN(d) || d < 1) return null;
  return d;
}

function sinceTimestamp(days: number | null): number | null {
  if (days == null) return null;
  return Math.floor(Date.now() / 1000) - days * 24 * 3600;
}

export interface ReasoningMetrics {
  successRate: number;
  testPassRate: number;
  avgConfidence: number;
  learningApplied: number;
  totalTasks: number;
  totalErrors: number;
}

export function getReasoningMetrics(days: number | null): ReasoningMetrics {
  const db = getDb();
  const since = sinceTimestamp(days);
  const where = since != null ? ' WHERE timestamp >= ?' : '';
  const args = since != null ? [since] : [];

  const rows = db.prepare(`SELECT success, test_passed, confidence FROM reasoning_tasks${where}`).all(...args) as Array<{ success: number; test_passed: number | null; confidence: number | null }>;
  const total = rows.length;
  const successCount = rows.filter((r) => r.success === 1).length;
  const withTest = rows.filter((r) => r.test_passed != null);
  const testPassCount = withTest.filter((r) => r.test_passed === 1).length;
  const confidences = rows.map((r) => r.confidence).filter((c): c is number => c != null && c > 0);
  const avgConf = confidences.length ? confidences.reduce((a, b) => a + b, 0) / confidences.length : 0;

  // Learning applied: error types that have at least one occurrence with learning_id
  const errorRows = db.prepare(`
    SELECT error_type, learning_id FROM reasoning_error_occurrences ${since != null ? 'WHERE timestamp >= ?' : ''}
  `).all(...(since != null ? [since] : [])) as Array<{ error_type: string; learning_id: string | null }>;
  const errorTypesWithLearning = new Set(
    errorRows.filter((r) => r.learning_id != null).map((r) => r.error_type)
  );
  const allErrorTypes = new Set(errorRows.map((r) => r.error_type));
  const learningApplied = errorTypesWithLearning.size;
  const totalErrors = allErrorTypes.size;

  return {
    successRate: total ? Math.round((successCount / total) * 100) : 0,
    testPassRate: withTest.length ? Math.round((testPassCount / withTest.length) * 100) : 0,
    avgConfidence: Math.round(avgConf * 10) / 10,
    learningApplied,
    totalTasks: total,
    totalErrors,
  };
}

export interface ReasoningTaskRow {
  taskType: string;
  total: number;
  successRate: number;
  avgIterations: number;
  testPassRate: number;
  avgConfidence: number;
}

export function getReasoningTasks(days: number | null): ReasoningTaskRow[] {
  const db = getDb();
  const since = sinceTimestamp(days);
  const where = since != null ? ' WHERE timestamp >= ?' : '';
  const args = since != null ? [since] : [];

  const rows = db.prepare(`
    SELECT task_type, success, iterations, test_passed, confidence
    FROM reasoning_tasks ${where}
  `).all(...args) as Array<{ task_type: string; success: number; iterations: number; test_passed: number | null; confidence: number | null }>;

  const byType: Record<string, { total: number; success: number; iterations: number[]; withTest: number; testPass: number; confidences: number[] }> = {};
  for (const r of rows) {
    if (!byType[r.task_type]) {
      byType[r.task_type] = { total: 0, success: 0, iterations: [], withTest: 0, testPass: 0, confidences: [] };
    }
    byType[r.task_type].total++;
    if (r.success === 1) byType[r.task_type].success++;
    byType[r.task_type].iterations.push(r.iterations);
    if (r.test_passed != null) {
      byType[r.task_type].withTest++;
      if (r.test_passed === 1) byType[r.task_type].testPass++;
    }
    if (r.confidence != null && r.confidence > 0) byType[r.task_type].confidences.push(r.confidence);
  }

  return Object.entries(byType).map(([taskType, data]) => ({
    taskType,
    total: data.total,
    successRate: data.total ? Math.round((data.success / data.total) * 100) : 0,
    avgIterations: data.iterations.length ? Math.round((data.iterations.reduce((a, b) => a + b, 0) / data.iterations.length) * 10) / 10 : 0,
    testPassRate: data.withTest ? Math.round((data.testPass / data.withTest) * 100) : 0,
    avgConfidence: data.confidences.length ? Math.round((data.confidences.reduce((a, b) => a + b, 0) / data.confidences.length) * 10) / 10 : 0,
  }));
}

export interface ReasoningConfidenceRow {
  confidenceLevel: number;
  tasksAtLevel: number;
  actualSuccessRate: number;
  deviation: number;
}

export function getReasoningConfidence(days: number | null): ReasoningConfidenceRow[] {
  const db = getDb();
  const since = sinceTimestamp(days);
  const where = since != null ? ' WHERE timestamp >= ?' : '';
  const args = since != null ? [since] : [];

  const rows = db.prepare(`
    SELECT confidence, success FROM reasoning_tasks ${where}
  `).all(...args) as Array<{ confidence: number | null; success: number }>;

  const buckets: Record<string, { total: number; success: number }> = { '1-3': { total: 0, success: 0 }, '4-6': { total: 0, success: 0 }, '7-10': { total: 0, success: 0 } };
  for (const r of rows) {
    const c = r.confidence;
    let bucket: string;
    if (c == null || c < 1) bucket = '1-3';
    else if (c <= 3) bucket = '1-3';
    else if (c <= 6) bucket = '4-6';
    else bucket = '7-10';
    buckets[bucket].total++;
    if (r.success === 1) buckets[bucket].success++;
  }

  const levelMid: Record<string, number> = { '1-3': 2, '4-6': 5, '7-10': 8.5 };
  return (['1-3', '4-6', '7-10'] as const).map((label) => {
    const b = buckets[label];
    const actual = b.total ? (b.success / b.total) * 100 : 0;
    const expected = levelMid[label] * 10; // rough: 1-10 scale -> expected success %
    const deviation = Math.round((actual / 100 - expected / 100) * 100) / 100;
    return {
      confidenceLevel: levelMid[label],
      tasksAtLevel: b.total,
      actualSuccessRate: Math.round(actual),
      deviation,
    };
  });
}

export interface ReasoningErrorRow {
  errorType: string;
  firstSeen: string;
  occurrences: number;
  fixedByLearning: boolean;
  lastSeen: string;
}

export function getReasoningErrors(days: number | null): ReasoningErrorRow[] {
  const db = getDb();
  const since = sinceTimestamp(days);
  const where = since != null ? ' WHERE timestamp >= ?' : '';
  const args = since != null ? [since] : [];

  const rows = db.prepare(`
    SELECT error_type, timestamp, learning_id FROM reasoning_error_occurrences ${where} ORDER BY timestamp
  `).all(...args) as Array<{ error_type: string; timestamp: number; learning_id: string | null }>;

  const byType: Record<string, { first: number; last: number; count: number; withLearning: number }> = {};
  for (const r of rows) {
    if (!byType[r.error_type]) {
      byType[r.error_type] = { first: r.timestamp, last: r.timestamp, count: 0, withLearning: 0 };
    }
    byType[r.error_type].first = Math.min(byType[r.error_type].first, r.timestamp);
    byType[r.error_type].last = Math.max(byType[r.error_type].last, r.timestamp);
    byType[r.error_type].count++;
    if (r.learning_id != null) byType[r.error_type].withLearning++;
  }

  return Object.entries(byType).map(([errorType, data]) => ({
    errorType,
    firstSeen: new Date(data.first * 1000).toISOString().slice(0, 10),
    occurrences: data.count,
    fixedByLearning: data.withLearning > 0,
    lastSeen: new Date(data.last * 1000).toISOString().slice(0, 10),
  }));
}

export interface ReasoningTimelineRow {
  date: string;
  successRate: number;
  tasksCompleted: number;
}

export function getReasoningTimeline(days: number | null): ReasoningTimelineRow[] {
  const db = getDb();
  const since = sinceTimestamp(days ?? 30);
  const rows = db.prepare(`
    SELECT date(timestamp, 'unixepoch') AS d, success FROM reasoning_tasks WHERE timestamp >= ? ORDER BY d
  `).all(since) as Array<{ d: string; success: number }>;

  const byDay: Record<string, { total: number; success: number }> = {};
  for (const r of rows) {
    if (!byDay[r.d]) byDay[r.d] = { total: 0, success: 0 };
    byDay[r.d].total++;
    if (r.success === 1) byDay[r.d].success++;
  }

  return Object.entries(byDay).map(([date, data]) => ({
    date,
    successRate: data.total ? Math.round((data.success / data.total) * 100) : 0,
    tasksCompleted: data.total,
  })).sort((a, b) => a.date.localeCompare(b.date));
}

export function getReasoningApi(daysParam: string | undefined) {
  const days = parseDays(daysParam);
  return {
    metrics: getReasoningMetrics(days),
    tasks: getReasoningTasks(days),
    confidence: getReasoningConfidence(days),
    errors: getReasoningErrors(days),
    timeline: getReasoningTimeline(days),
  };
}
