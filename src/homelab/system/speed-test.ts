/**
 * Network Speed Test
 * Runs speedtest-cli and tracks results over time.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { logger } from '../../utils/logger.js';

const execAsync = promisify(exec);

export interface SpeedResult {
  download: number;  // Mbps
  upload: number;    // Mbps
  ping: number;      // ms
  server: string;
  timestamp: string;
}

const HISTORY_PATH = '/home/jeeves/signal-cursor-controller/data/speed-history.json';
const MAX_HISTORY = 30;

function loadHistory(): SpeedResult[] {
  try {
    if (existsSync(HISTORY_PATH)) {
      return JSON.parse(readFileSync(HISTORY_PATH, 'utf-8'));
    }
  } catch { /* ignore */ }
  return [];
}

function saveHistory(history: SpeedResult[]): void {
  try {
    const dir = dirname(HISTORY_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(HISTORY_PATH, JSON.stringify(history.slice(-MAX_HISTORY), null, 2));
  } catch { /* ignore */ }
}

/**
 * Run a speed test. Takes ~15-30 seconds.
 */
export async function runSpeedTest(): Promise<SpeedResult | null> {
  try {
    // Try speedtest-cli first, fall back to speedtest
    const cmd = 'speedtest-cli --json 2>/dev/null || speedtest --format=json 2>/dev/null';
    const { stdout } = await execAsync(cmd, { timeout: 60000 });
    const data = JSON.parse(stdout);

    const result: SpeedResult = {
      download: Math.round((data.download || 0) / 1_000_000 * 10) / 10,
      upload: Math.round((data.upload || 0) / 1_000_000 * 10) / 10,
      ping: Math.round((data.ping || data.latency || 0) * 10) / 10,
      server: data.server?.sponsor || data.server?.name || 'Unknown',
      timestamp: new Date().toISOString(),
    };

    // Save to history
    const history = loadHistory();
    history.push(result);
    saveHistory(history);

    return result;
  } catch (error) {
    logger.debug('[speed-test] Failed', { error: String(error) });
    return null;
  }
}

/**
 * Get speed test history.
 */
export function getSpeedHistory(): SpeedResult[] {
  return loadHistory();
}

export function formatSpeedResult(result: SpeedResult | null, history?: SpeedResult[]): string {
  if (!result) {
    return 'Speed test failed. Is speedtest-cli installed? (`sudo apt install speedtest-cli`)';
  }

  const lines = [
    '## Speed Test',
    '',
    `Download: ${result.download} Mbps`,
    `Upload: ${result.upload} Mbps`,
    `Ping: ${result.ping} ms`,
    `Server: ${result.server}`,
  ];

  if (history && history.length > 1) {
    const recent = history.slice(-7);
    const avgDown = recent.reduce((s, r) => s + r.download, 0) / recent.length;
    const avgUp = recent.reduce((s, r) => s + r.upload, 0) / recent.length;
    lines.push('', `7-day avg: ${avgDown.toFixed(1)} Mbps down / ${avgUp.toFixed(1)} Mbps up`);

    if (result.download < avgDown * 0.7) {
      lines.push('⚠️ Download speed is 30%+ below average');
    }
  }

  return lines.join('\n');
}
