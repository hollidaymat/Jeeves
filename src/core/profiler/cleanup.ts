/**
 * Performance profiler cleanup: retain 30d metrics, 90d snapshots.
 * Run daily via scheduler.
 */

import { getDb } from '../context/db.js';
import { logger } from '../../utils/logger.js';

const METRICS_RETENTION_DAYS = 30;
const SNAPSHOTS_RETENTION_DAYS = 90;

export function runPerformanceCleanup(): void {
  try {
    const db = getDb();
    const now = Date.now();
    const metricsCutoff = now - METRICS_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const snapshotsCutoff = now - SNAPSHOTS_RETENTION_DAYS * 24 * 60 * 60 * 1000;

    const metricsResult = db.prepare('DELETE FROM performance_metrics WHERE timestamp < ?').run(metricsCutoff);
    const snapshotsResult = db.prepare('DELETE FROM performance_snapshots WHERE timestamp < ?').run(snapshotsCutoff);

    if (metricsResult.changes > 0 || snapshotsResult.changes > 0) {
      logger.info('Performance cleanup completed', { metricsDeleted: metricsResult.changes, snapshotsDeleted: snapshotsResult.changes });
    }
  } catch (err) {
    logger.debug('Performance cleanup failed', { error: String(err) });
  }
}
