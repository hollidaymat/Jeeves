/**
 * Bandwidth Monitoring Per Service
 * Uses docker stats to track per-container network I/O.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { logger } from '../../utils/logger.js';

const execAsync = promisify(exec);

export interface ContainerBandwidth {
  container: string;
  netIn: string;
  netOut: string;
  netInBytes: number;
  netOutBytes: number;
}

export interface BandwidthReport {
  containers: ContainerBandwidth[];
  totalIn: string;
  totalOut: string;
  summary: string;
}

function parseSize(s: string): number {
  const match = s.match(/([\d.]+)\s*(B|KB|MB|GB|TB|kB)/i);
  if (!match) return 0;
  const val = parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  switch (unit) {
    case 'TB': return val * 1e12;
    case 'GB': return val * 1e9;
    case 'MB': return val * 1e6;
    case 'KB': case 'KB': return val * 1e3;
    default: return val;
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
  return `${bytes} B`;
}

/**
 * Get per-container network I/O from docker stats.
 */
export async function getBandwidthStats(): Promise<BandwidthReport> {
  const containers: ContainerBandwidth[] = [];

  try {
    const { stdout } = await execAsync(
      'docker stats --no-stream --format "{{.Name}}|{{.NetIO}}"',
      { timeout: 15000 }
    );

    for (const line of stdout.trim().split('\n').filter(Boolean)) {
      const [name, netIO] = line.split('|');
      if (!name || !netIO) continue;

      const parts = netIO.split('/').map(s => s.trim());
      const netIn = parts[0] || '0B';
      const netOut = parts[1] || '0B';

      containers.push({
        container: name,
        netIn,
        netOut,
        netInBytes: parseSize(netIn),
        netOutBytes: parseSize(netOut),
      });
    }
  } catch (error) {
    logger.debug('[bandwidth] docker stats failed', { error: String(error) });
  }

  // Sort by total I/O descending
  containers.sort((a, b) => (b.netInBytes + b.netOutBytes) - (a.netInBytes + a.netOutBytes));

  const totalInBytes = containers.reduce((s, c) => s + c.netInBytes, 0);
  const totalOutBytes = containers.reduce((s, c) => s + c.netOutBytes, 0);

  return {
    containers,
    totalIn: formatBytes(totalInBytes),
    totalOut: formatBytes(totalOutBytes),
    summary: `${containers.length} containers, total: ${formatBytes(totalInBytes)} in / ${formatBytes(totalOutBytes)} out`,
  };
}

export function formatBandwidthReport(report: BandwidthReport): string {
  if (report.containers.length === 0) {
    return 'No container bandwidth data available.';
  }

  const lines = [
    '## Network Usage',
    '',
    `Total: ${report.totalIn} in / ${report.totalOut} out`,
    '',
  ];

  // Show top 10 by usage
  for (const c of report.containers.slice(0, 10)) {
    lines.push(`  ${c.container}: ${c.netIn} / ${c.netOut}`);
  }

  if (report.containers.length > 10) {
    lines.push(`  ... and ${report.containers.length - 10} more`);
  }

  return lines.join('\n');
}
