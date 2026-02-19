/**
 * Bottleneck detector: analyze recent metrics and snapshots, flag issues.
 * Run every 5 minutes via scheduler.
 */

import { getDb, generateId } from '../context/db.js';
import { logger } from '../../utils/logger.js';

function hasUnresolved(db: ReturnType<typeof getDb>, category: string, source: string): boolean {
  const row = db.prepare('SELECT 1 FROM bottlenecks WHERE category = ? AND source = ? AND resolved = 0 LIMIT 1').get(category, source) as { '1'?: number } | undefined;
  return !!row;
}

function insertBottleneck(
  db: ReturnType<typeof getDb>,
  category: string,
  source: string,
  severity: string,
  description: string,
  recommendation: string,
  autoFixable: boolean
): void {
  const id = generateId('bottleneck');
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO bottlenecks (id, detected_at, category, source, severity, description, recommendation, auto_fixable, resolved)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).run(id, now, category, source, severity, description, recommendation, autoFixable ? 1 : 0);
  logger.info('Bottleneck detected', { category, source, severity });
}

export async function runBottleneckDetection(): Promise<void> {
  try {
    const db = getDb();
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    const oneHourAgoSec = Math.floor(oneHourAgo / 1000);

    // Slow LLM Response: avg llm_call response_time_ms > 30000 over last 10
    const llmRows = db.prepare(`
      SELECT value FROM performance_metrics
      WHERE category = 'response_time' AND source = 'llm_call' AND metric_name = 'response_time_ms'
      AND timestamp >= ?
      ORDER BY timestamp DESC LIMIT 10
    `).all(oneHourAgo) as { value: number }[];
    if (llmRows.length >= 10) {
      const avg = llmRows.reduce((s, r) => s + r.value, 0) / llmRows.length;
      if (avg > 30000 && !hasUnresolved(db, 'slow_llm_response', 'llm')) {
        insertBottleneck(db, 'slow_llm_response', 'llm', 'medium', `Avg LLM response ${Math.round(avg / 1000)}s (last 10 calls)`, 'Consider switching to faster model (Haiku) for non-critical tasks', false);
      }
    }

    // High Memory / Disk / Load: from snapshots (last 3)
    const snapRows = db.prepare(`
      SELECT * FROM performance_snapshots ORDER BY timestamp DESC LIMIT 3
    `).all() as Array<{ memory_used_mb: number | null; memory_total_mb: number | null; disk_used_gb: number | null; disk_total_gb: number | null; load_average_5m: number | null; docker_containers_running: number | null }>;
    if (snapRows.length >= 3) {
      const memPct = snapRows.every(s => s.memory_total_mb && s.memory_used_mb)
        ? (snapRows[0]!.memory_used_mb! / snapRows[0]!.memory_total_mb!) * 100
        : 0;
      if (memPct > 80 && !hasUnresolved(db, 'high_memory_usage', 'memory')) {
        insertBottleneck(db, 'high_memory_usage', 'memory', 'high', `Memory usage ${Math.round(memPct)}%`, 'Identify memory-heavy containers. Run `docker stats` to find top consumers', false);
      }
      const diskPct = snapRows[0]?.disk_total_gb && snapRows[0]?.disk_used_gb
        ? (snapRows[0].disk_used_gb / snapRows[0].disk_total_gb) * 100
        : 0;
      if (diskPct > 85 && !hasUnresolved(db, 'disk_space_low', 'disk')) {
        insertBottleneck(db, 'disk_space_low', 'disk', 'critical', `Disk usage ${Math.round(diskPct)}%`, 'Run docker system prune. Check /data/downloads for stale files', false);
      }
      const load5 = snapRows[0]?.load_average_5m ?? 0;
      if (load5 > 4.0 && !hasUnresolved(db, 'high_cpu_load', 'cpu')) {
        insertBottleneck(db, 'high_cpu_load', 'cpu', 'high', `Load average 5m: ${load5.toFixed(2)}`, 'Check for runaway processes. Consider scheduling heavy tasks during off-hours', false);
      }
    }

    // Slow Shell: any shell_exec > 30s in last hour
    const shellRows = db.prepare(`
      SELECT value FROM performance_metrics
      WHERE category = 'response_time' AND source = 'shell_exec' AND timestamp >= ?
    `).all(oneHourAgo) as { value: number }[];
    const slowShell = shellRows.find(r => r.value > 30000);
    if (slowShell && !hasUnresolved(db, 'slow_shell_execution', 'shell')) {
      insertBottleneck(db, 'slow_shell_execution', 'shell', 'medium', 'A shell command exceeded 30s', 'Command may be hanging. Check network connectivity or command arguments', false);
    }

    // Signal Response Slow: avg signal_handler > 10s over last 20
    const signalRows = db.prepare(`
      SELECT value FROM performance_metrics
      WHERE category = 'response_time' AND source = 'signal_handler' AND timestamp >= ?
      ORDER BY timestamp DESC LIMIT 20
    `).all(oneHourAgo) as { value: number }[];
    if (signalRows.length >= 20) {
      const avg = signalRows.reduce((s, r) => s + r.value, 0) / signalRows.length;
      if (avg > 10000 && !hasUnresolved(db, 'signal_response_slow', 'signal_handler')) {
        insertBottleneck(db, 'signal_response_slow', 'signal_handler', 'medium', `Avg message response ${Math.round(avg / 1000)}s (last 20)`, 'Check LLM latency and context assembly time. Reduce context window if bloated', false);
      }
    }

    // DB Query Slow / High Error Rate / Repeated Failures: require metrics we may not have yet; skip or stub
    // Docker Container Down: would need expected count config; skip for now
  } catch (err) {
    logger.debug('Bottleneck detection failed', { error: String(err) });
  }
}
