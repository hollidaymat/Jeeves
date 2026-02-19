/**
 * Performance profiler: record metrics from instrumented code.
 * Fire-and-forget, non-blocking; does not throw into callers.
 */

import { getDb, generateId } from '../context/db.js';
import { logger } from '../../utils/logger.js';

export interface PerformanceMetric {
  id: string;
  timestamp: number;
  category: string;
  source: string;
  metric_name: string;
  value: number;
  metadata?: Record<string, unknown>;
}

export interface PerformanceSnapshot {
  id?: number;
  timestamp: number;
  cpu_percent: number | null;
  memory_used_mb: number | null;
  memory_total_mb: number | null;
  disk_used_gb: number | null;
  disk_total_gb: number | null;
  docker_containers_running: number | null;
  docker_containers_total: number | null;
  uptime_seconds: number | null;
  load_average_1m: number | null;
  load_average_5m: number | null;
  load_average_15m: number | null;
}

export interface Bottleneck {
  id: string;
  detected_at: number;
  category: string;
  source: string;
  severity: string;
  description: string;
  recommendation: string;
  auto_fixable: boolean;
  resolved: boolean;
  resolved_at?: number;
}

export interface RecordMetricInput {
  category: string;
  source: string;
  metric_name: string;
  value: number;
  metadata?: Record<string, unknown>;
}

/**
 * Record a single performance metric. Sync insert; does not throw.
 */
export function recordMetric(input: RecordMetricInput): void {
  try {
    const db = getDb();
    const id = generateId('perf');
    const now = Date.now();
    const metadataJson = input.metadata ? JSON.stringify(input.metadata) : null;
    db.prepare(`
      INSERT INTO performance_metrics (id, timestamp, category, source, metric_name, value, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      now,
      input.category,
      input.source,
      input.metric_name,
      input.value,
      metadataJson
    );
  } catch (err) {
    logger.debug('Performance metric record failed', { error: String(err) });
  }
}

/**
 * Record a system snapshot. Call from system monitor.
 */
export function recordSnapshot(snapshot: Omit<PerformanceSnapshot, 'id'>): void {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO performance_snapshots (
        timestamp, cpu_percent, memory_used_mb, memory_total_mb,
        disk_used_gb, disk_total_gb, docker_containers_running, docker_containers_total,
        uptime_seconds, load_average_1m, load_average_5m, load_average_15m
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      snapshot.timestamp,
      snapshot.cpu_percent ?? null,
      snapshot.memory_used_mb ?? null,
      snapshot.memory_total_mb ?? null,
      snapshot.disk_used_gb ?? null,
      snapshot.disk_total_gb ?? null,
      snapshot.docker_containers_running ?? null,
      snapshot.docker_containers_total ?? null,
      snapshot.uptime_seconds ?? null,
      snapshot.load_average_1m ?? null,
      snapshot.load_average_5m ?? null,
      snapshot.load_average_15m ?? null
    );
  } catch (err) {
    logger.debug('Performance snapshot record failed', { error: String(err) });
  }
}
