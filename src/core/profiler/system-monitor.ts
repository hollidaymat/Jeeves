/**
 * System monitor: collect CPU, memory, disk, load, Docker stats every 60s.
 * Only runs when homelab is enabled (Linux). Does not start interval itself;
 * call startSystemMonitor() from app boot.
 */

import { recordSnapshot } from './performance-collector.js';
import { logger } from '../../utils/logger.js';

let intervalId: ReturnType<typeof setInterval> | null = null;

async function collectSnapshot(): Promise<void> {
  const now = Date.now();
  const snapshot: Parameters<typeof recordSnapshot>[0] = {
    timestamp: now,
    cpu_percent: null,
    memory_used_mb: null,
    memory_total_mb: null,
    disk_used_gb: null,
    disk_total_gb: null,
    docker_containers_running: null,
    docker_containers_total: null,
    uptime_seconds: null,
    load_average_1m: null,
    load_average_5m: null,
    load_average_15m: null,
  };

  try {
    const { execHomelab } = await import('../../homelab/shell.js');
    const { config } = await import('../../config.js');

    if (!config.homelab?.enabled && !process.env.HOMELAB_DEV_MODE) return;
    if (process.platform !== 'linux') return;

    // free -m: Mem line is "Mem: total used free ..."
    const freeResult = await execHomelab('free', ['-m'], { timeout: 5000 });
    if (freeResult.success && freeResult.stdout) {
      const memLine = freeResult.stdout.split('\n').find((l) => l.startsWith('Mem:'));
      if (memLine) {
        const parts = memLine.split(/\s+/).filter(Boolean);
        if (parts.length >= 3) {
          snapshot.memory_total_mb = parseInt(parts[1], 10) || null;
          snapshot.memory_used_mb = parseInt(parts[2], 10) || null;
        }
      }
    }

    // df -h / : last line is root fs; col1=size (e.g. 98G), col2=used (e.g. 49G)
    const dfResult = await execHomelab('df', ['-h', '/'], { timeout: 5000 });
    if (dfResult.success && dfResult.stdout) {
      const lines = dfResult.stdout.trim().split('\n');
      const lastLine = lines[lines.length - 1];
      if (lastLine) {
        const parts = lastLine.split(/\s+/).filter(Boolean);
        if (parts.length >= 3) {
          const toGb = (s: string): number => {
            const num = parseFloat(s.replace(/[^0-9.]/g, ''));
            const unit = (s.toLowerCase().match(/[gmtk]/) || [])[0];
            if (unit === 't') return num * 1024;
            if (unit === 'g') return num;
            if (unit === 'm') return num / 1024;
            return num / (1024 * 1024);
          };
          snapshot.disk_total_gb = toGb(parts[1]);
          snapshot.disk_used_gb = toGb(parts[2]);
        }
      }
    }

    // /proc/loadavg: "1.2 0.8 0.5 ..."
    const loadResult = await execHomelab('cat', ['/proc/loadavg'], { timeout: 2000 });
    if (loadResult.success && loadResult.stdout) {
      const parts = loadResult.stdout.trim().split(/\s+/);
      if (parts.length >= 3) {
        snapshot.load_average_1m = parseFloat(parts[0]) || null;
        snapshot.load_average_5m = parseFloat(parts[1]) || null;
        snapshot.load_average_15m = parseFloat(parts[2]) || null;
      }
    }

    // /proc/uptime: first value is seconds
    const uptimeResult = await execHomelab('cat', ['/proc/uptime'], { timeout: 2000 });
    if (uptimeResult.success && uptimeResult.stdout) {
      const seconds = parseFloat(uptimeResult.stdout.trim().split(/\s+/)[0] || '0');
      snapshot.uptime_seconds = Number.isFinite(seconds) ? Math.floor(seconds) : null;
    }

    // Docker: count running containers (docker ps -q)
    try {
      const dockerResult = await execHomelab('docker', ['ps', '-q'], { timeout: 5000 });
      if (dockerResult.success && dockerResult.stdout) {
        const count = dockerResult.stdout.trim().split('\n').filter(Boolean).length;
        snapshot.docker_containers_running = count;
        snapshot.docker_containers_total = count;
      }
    } catch {
      // docker not available or not running
    }

    // CPU %: optional, from /proc/stat delta; skip for now (store null)
  } catch (err) {
    logger.debug('System monitor collection error', { error: String(err) });
  }

  recordSnapshot(snapshot);
}

export function startSystemMonitor(): void {
  if (intervalId) return;
  intervalId = setInterval(() => {
    collectSnapshot().catch((err) => logger.debug('System monitor tick failed', { error: String(err) }));
  }, 60_000);
  // Run once immediately after a short delay so DB is ready
  setTimeout(() => collectSnapshot().catch(() => {}), 2000);
  logger.info('Performance system monitor started (60s interval)');
}

export function stopSystemMonitor(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    logger.info('Performance system monitor stopped');
  }
}
