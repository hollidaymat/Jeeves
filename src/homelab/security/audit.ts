/**
 * Homelab Security - Command Audit Log & Security Events
 * 
 * Provides audit trail of executed homelab commands and
 * security event monitoring (failed SSH logins, etc).
 */

import { getAuditLog, execHomelab } from '../shell.js';
import { logger } from '../../utils/logger.js';

// ============================================================================
// Types
// ============================================================================

export interface AuditEntry {
  timestamp: string;
  command: string;
  args: string[];
  exitCode: number | null;
  success: boolean;
  duration_ms: number;
  blocked?: boolean;
  blockReason?: string;
}

export type SecurityEventType = 'failed_login' | 'accepted_login' | 'other';

export interface SecurityEvent {
  timestamp: string;
  type: SecurityEventType;
  source?: string;
  user?: string;
  message: string;
}

// ============================================================================
// Command Audit
// ============================================================================

/**
 * Get the command audit log from the shell executor.
 */
export function getCommandAuditLog(limit?: number): AuditEntry[] {
  return getAuditLog(limit);
}

// ============================================================================
// Security Events
// ============================================================================

/**
 * Parse journalctl SSH logs for security events (failed logins, etc).
 */
export async function getSecurityEvents(limit = 50): Promise<SecurityEvent[]> {
  const result = await execHomelab('journalctl', [
    '-u', 'ssh',
    '--since', '24 hours ago',
    '-n', String(limit),
    '--no-pager',
  ]);

  if (!result.success) {
    logger.warn('Failed to read SSH journal logs', { stderr: result.stderr });
    return [];
  }

  const events: SecurityEvent[] = [];

  for (const line of result.stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('--')) continue;

    const event = parseJournalLine(trimmed);
    if (event) {
      events.push(event);
    }
  }

  return events;
}

/**
 * Parse a single journalctl line into a SecurityEvent.
 */
function parseJournalLine(line: string): SecurityEvent | null {
  // Extract timestamp — journalctl default format: "Feb 06 14:23:01 hostname sshd[1234]: ..."
  const timestampMatch = line.match(/^(\w+\s+\d+\s+\d+:\d+:\d+)\s+/);
  const timestamp = timestampMatch ? timestampMatch[1] : new Date().toISOString();

  // Failed password
  const failedMatch = line.match(/Failed password for (?:invalid user )?(\S+) from (\S+)/);
  if (failedMatch) {
    return {
      timestamp,
      type: 'failed_login',
      user: failedMatch[1],
      source: failedMatch[2],
      message: line,
    };
  }

  // Accepted publickey / password
  const acceptedMatch = line.match(/Accepted (?:publickey|password) for (\S+) from (\S+)/);
  if (acceptedMatch) {
    return {
      timestamp,
      type: 'accepted_login',
      user: acceptedMatch[1],
      source: acceptedMatch[2],
      message: line,
    };
  }

  // Other SSH-related log lines
  if (line.includes('sshd')) {
    return {
      timestamp,
      type: 'other',
      message: line,
    };
  }

  return null;
}

// ============================================================================
// Reporting
// ============================================================================

/**
 * Generate a combined security audit report (command audit + security events).
 */
export async function getSecurityAuditReport(): Promise<string> {
  const [auditEntries, securityEvents] = await Promise.all([
    Promise.resolve(getCommandAuditLog(20)),
    getSecurityEvents(30),
  ]);

  let report = '## Security Audit Report\n\n';

  // Command audit section
  report += '### Recent Commands\n\n';
  if (auditEntries.length === 0) {
    report += '_No commands executed._\n\n';
  } else {
    report += '| Time | Command | Status | Duration |\n';
    report += '|------|---------|--------|----------|\n';
    for (const entry of auditEntries) {
      const status = entry.blocked
        ? 'BLOCKED'
        : entry.success
          ? 'OK'
          : 'FAILED';
      const time = entry.timestamp.substring(11, 19); // HH:MM:SS
      const cmd = `${entry.command} ${entry.args.join(' ')}`.substring(0, 60);
      report += `| ${time} | \`${cmd}\` | ${status} | ${entry.duration_ms}ms |\n`;
    }
    report += '\n';
  }

  // Security events section
  report += '### Security Events (24h)\n\n';

  const failedLogins = securityEvents.filter(e => e.type === 'failed_login');
  const acceptedLogins = securityEvents.filter(e => e.type === 'accepted_login');

  report += `- **Failed logins:** ${failedLogins.length}\n`;
  report += `- **Accepted logins:** ${acceptedLogins.length}\n\n`;

  if (failedLogins.length > 0) {
    report += '#### Failed Login Attempts\n\n';
    report += '| Time | User | Source |\n';
    report += '|------|------|--------|\n';
    for (const event of failedLogins.slice(0, 20)) {
      report += `| ${event.timestamp} | ${event.user ?? 'unknown'} | ${event.source ?? 'unknown'} |\n`;
    }
    if (failedLogins.length > 20) {
      report += `\n_...and ${failedLogins.length - 20} more._\n`;
    }
    report += '\n';
  }

  // Blocked commands
  const blockedCommands = auditEntries.filter(e => e.blocked);
  if (blockedCommands.length > 0) {
    report += '### Blocked Commands\n\n';
    for (const entry of blockedCommands) {
      report += `- \`${entry.command} ${entry.args.join(' ')}\` — ${entry.blockReason ?? 'no reason'}\n`;
    }
    report += '\n';
  }

  return report;
}
