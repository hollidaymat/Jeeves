/**
 * Performance profiler API: query helpers for summary, bottlenecks, response times, snapshots, recommendations.
 */

import { getDb } from '../context/db.js';

function daysToMs(days: number): number {
  return days * 24 * 60 * 60 * 1000;
}

export function getPerformanceSummary(days: number): {
  avgResponseMs: number;
  systemLoad: number;
  totalCores: number;
  memoryUsedMb: number;
  memoryTotalMb: number;
  containersRunning: number;
  containersUnhealthy: number;
  responseTimeTrend: number;
} {
  const db = getDb();
  const now = Date.now();
  const cutoff = now - daysToMs(days);
  const prevCutoff = now - daysToMs(days * 2);

  const signalRows = db.prepare(`
    SELECT value FROM performance_metrics
    WHERE category = 'response_time' AND source = 'signal_handler' AND timestamp >= ?
  `).all(cutoff) as { value: number }[];
  const avgResponseMs = signalRows.length > 0
    ? signalRows.reduce((s, r) => s + r.value, 0) / signalRows.length
    : 0;

  const prevSignalRows = db.prepare(`
    SELECT value FROM performance_metrics
    WHERE category = 'response_time' AND source = 'signal_handler' AND timestamp >= ? AND timestamp < ?
  `).all(prevCutoff, cutoff) as { value: number }[];
  const prevAvg = prevSignalRows.length > 0
    ? prevSignalRows.reduce((s, r) => s + r.value, 0) / prevSignalRows.length
    : avgResponseMs;
  const responseTimeTrend = prevAvg > 0 ? (prevAvg - avgResponseMs) / 1000 : 0;

  const latest = db.prepare('SELECT * FROM performance_snapshots ORDER BY timestamp DESC LIMIT 1').get() as {
    load_average_5m: number | null;
    memory_used_mb: number | null;
    memory_total_mb: number | null;
    docker_containers_running: number | null;
  } | undefined;

  return {
    avgResponseMs: Math.round(avgResponseMs),
    systemLoad: latest?.load_average_5m ?? 0,
    totalCores: 4,
    memoryUsedMb: latest?.memory_used_mb ?? 0,
    memoryTotalMb: latest?.memory_total_mb ?? 0,
    containersRunning: latest?.docker_containers_running ?? 0,
    containersUnhealthy: 0,
    responseTimeTrend: Math.round(responseTimeTrend * 10) / 10,
  };
}

export function getBottlenecks(days: number): Array<{
  id: string;
  severity: string;
  source: string;
  description: string;
  recommendation: string;
  resolved: boolean;
  detected_at: number;
}> {
  const db = getDb();
  const cutoff = Math.floor((Date.now() - daysToMs(days)) / 1000);
  const rows = db.prepare(`
    SELECT id, detected_at, category, source, severity, description, recommendation, resolved
    FROM bottlenecks WHERE detected_at >= ? ORDER BY detected_at DESC
  `).all(cutoff) as Array<{ id: string; detected_at: number; category: string; source: string; severity: string; description: string; recommendation: string; resolved: number }>;
  return rows.map(r => ({
    id: r.id,
    severity: r.severity,
    source: r.source,
    description: r.description,
    recommendation: r.recommendation,
    resolved: r.resolved === 1,
    detected_at: r.detected_at,
  }));
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, i)] ?? 0;
}

export function getResponseTimes(days: number): Array<{
  source: string;
  avg_ms: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  count: number;
}> {
  const db = getDb();
  const cutoff = Date.now() - daysToMs(days);
  const rows = db.prepare(`
    SELECT source, value FROM performance_metrics
    WHERE category = 'response_time' AND metric_name = 'response_time_ms' AND timestamp >= ?
  `).all(cutoff) as Array<{ source: string; value: number }>;

  const bySource = new Map<string, number[]>();
  for (const r of rows) {
    if (!bySource.has(r.source)) bySource.set(r.source, []);
    bySource.get(r.source)!.push(r.value);
  }

  return Array.from(bySource.entries()).map(([source, values]) => {
    const sorted = values.slice().sort((a, b) => a - b);
    const sum = values.reduce((s, v) => s + v, 0);
    return {
      source,
      avg_ms: Math.round(sum / values.length),
      p50_ms: Math.round(percentile(sorted, 50)),
      p95_ms: Math.round(percentile(sorted, 95)),
      p99_ms: Math.round(percentile(sorted, 99)),
      count: values.length,
    };
  });
}

export function getSnapshots(days: number): Array<{
  timestamp: number;
  cpu_percent: number | null;
  memory_used_mb: number | null;
  disk_used_gb: number | null;
}> {
  const db = getDb();
  const cutoff = Date.now() - daysToMs(days);
  const rows = db.prepare(`
    SELECT timestamp, cpu_percent, memory_used_mb, disk_used_gb
    FROM performance_snapshots WHERE timestamp >= ? ORDER BY timestamp ASC
  `).all(cutoff) as Array<{ timestamp: number; cpu_percent: number | null; memory_used_mb: number | null; disk_used_gb: number | null }>;
  return rows;
}

export function getRecommendations(): Array<{
  id: string;
  priority: string;
  title: string;
  impact: string;
  status: string;
}> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, priority, title, impact, status
    FROM performance_recommendations
    WHERE status IN ('pending', 'applied') ORDER BY created_at DESC
  `).all() as Array<{ id: string; priority: string; title: string; impact: string; status: string }>;
  return rows;
}

export function dismissRecommendation(id: string): void {
  const db = getDb();
  db.prepare("UPDATE performance_recommendations SET status = 'dismissed' WHERE id = ?").run(id);
}

export function applyRecommendation(id: string): void {
  const db = getDb();
  db.prepare("UPDATE performance_recommendations SET status = 'applied' WHERE id = ?").run(id);
}
