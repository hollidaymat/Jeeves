/**
 * Container Log Scanner
 * Scans recent container logs for errors/warnings.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { logger } from '../../utils/logger.js';

const execAsync = promisify(exec);

export interface LogError {
  container: string;
  line: string;
  level: 'error' | 'fatal' | 'warning';
}

export interface LogScanResult {
  errors: LogError[];
  containersScanned: number;
  summary: string;
}

const ERROR_PATTERNS = [
  { pattern: /\b(FATAL|PANIC|OOM|OutOfMemory|Killed|segfault)\b/i, level: 'fatal' as const },
  { pattern: /\b(ERROR|ERR|CRIT|CRITICAL|EXCEPTION|FAILURE)\b/i, level: 'error' as const },
];

/**
 * Scan recent logs from all running containers for error patterns.
 */
export async function scanContainerLogs(sinceMinutes: number = 60): Promise<LogScanResult> {
  const errors: LogError[] = [];
  let containersScanned = 0;

  try {
    const { stdout: psOut } = await execAsync('docker ps --format "{{.Names}}"', { timeout: 5000 });
    const containers = psOut.trim().split('\n').filter(Boolean);

    for (const container of containers) {
      containersScanned++;
      try {
        const { stdout: logOut } = await execAsync(
          `docker logs --since ${sinceMinutes}m --tail 200 ${container} 2>&1`,
          { timeout: 10000 }
        );

        const lines = logOut.split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          for (const { pattern, level } of ERROR_PATTERNS) {
            if (pattern.test(line)) {
              // Deduplicate similar errors
              const truncated = line.substring(0, 200);
              if (!errors.some(e => e.container === container && e.line === truncated)) {
                errors.push({ container, line: truncated, level });
              }
              break;
            }
          }
        }
      } catch {
        // Skip containers we can't read logs from
      }
    }
  } catch (error) {
    logger.debug('[log-scanner] Failed to scan logs', { error: String(error) });
  }

  const fatalCount = errors.filter(e => e.level === 'fatal').length;
  const errorCount = errors.filter(e => e.level === 'error').length;

  let summary = `Scanned ${containersScanned} containers (last ${sinceMinutes}m): `;
  if (errors.length === 0) {
    summary += 'No errors found';
  } else {
    const parts: string[] = [];
    if (fatalCount > 0) parts.push(`${fatalCount} fatal`);
    if (errorCount > 0) parts.push(`${errorCount} errors`);
    summary += parts.join(', ');
  }

  return { errors, containersScanned, summary };
}

/**
 * Format log scan for display.
 */
export function formatLogScan(result: LogScanResult): string {
  if (result.errors.length === 0) {
    return `All clear across ${result.containersScanned} containers. No errors in recent logs.`;
  }

  const lines: string[] = [`## Log Errors (${result.errors.length} found)`, ''];

  // Group by container
  const byContainer = new Map<string, LogError[]>();
  for (const err of result.errors) {
    const list = byContainer.get(err.container) || [];
    list.push(err);
    byContainer.set(err.container, list);
  }

  for (const [container, errs] of byContainer) {
    const icon = errs.some(e => e.level === 'fatal') ? '🔴' : '🟡';
    lines.push(`${icon} **${container}** (${errs.length} error${errs.length > 1 ? 's' : ''})`);
    for (const err of errs.slice(0, 3)) {
      lines.push(`   ${err.line.substring(0, 120)}`);
    }
    if (errs.length > 3) lines.push(`   ... and ${errs.length - 3} more`);
    lines.push('');
  }

  return lines.join('\n');
}
