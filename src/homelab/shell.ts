/**
 * Homelab Shell Executor
 * 
 * Safe system command executor for homelab management.
 * Separate from terminal.ts (which handles npm/git for projects).
 * This handles docker, systemctl, ufw, free, df, etc.
 * 
 * SECURITY:
 * - Whitelisted executables only (no arbitrary shell)
 * - Dangerous pattern blocking
 * - Uses spawn() (no shell injection)
 * - Platform guard (Linux only in production)
 * - Audit logging of every command
 * - Timeout enforcement
 */

import { spawn } from 'child_process';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import type { ShellCommandResult } from '../types/index.js';

// ============================================================================
// Whitelisted executables
// ============================================================================

const ALLOWED_EXECUTABLES = new Set([
  // Docker
  'docker',
  'docker-compose',

  // System info (read-only)
  'free',
  'df',
  'top',
  'uptime',
  'cat',
  'ls',
  'lsblk',
  'lscpu',
  'lsof',
  'ps',
  'who',
  'w',
  'id',
  'hostname',
  'uname',
  'arch',

  // Network (read-only)
  'ip',
  'ss',
  'ping',
  'dig',
  'nslookup',
  'traceroute',
  'curl',
  'wget',
  'nmap',
  'iperf3',

  // Service management
  'systemctl',
  'journalctl',

  // Firewall
  'ufw',

  // Package management
  'apt',
  'apt-get',
  'dpkg',

  // Backup
  'restic',

  // Storage
  'lvcreate',
  'lvs',
  'vgs',
  'pvs',
  'smartctl',

  // File utilities (read-only)
  'head',
  'tail',
  'wc',
  'du',
  'find',
  'grep',
  'sort',
  'uniq',

  // SSL / Certificates
  'openssl',
  'certbot',

  // Process management
  'kill',
  'killall',
  'nice',
  'renice',

  // Misc
  'date',
  'timedatectl',
  'fail2ban-client',
]);

// ============================================================================
// Dangerous patterns - block these regardless of executable
// ============================================================================

const DANGEROUS_PATTERNS: { pattern: RegExp; description: string; trustRequired: number }[] = [
  // Filesystem destruction
  { pattern: /rm\s+(-rf?|--recursive)\s+\/(?!\w)/, description: 'Recursive delete from root', trustRequired: 99 },
  { pattern: /rm\s+(-rf?|--recursive)\s+\/opt\/jeeves/, description: 'Delete Jeeves installation', trustRequired: 99 },
  { pattern: /mkfs/, description: 'Format filesystem', trustRequired: 99 },
  { pattern: /fdisk/, description: 'Partition manipulation', trustRequired: 99 },
  { pattern: /dd\s+if=/, description: 'Raw disk write', trustRequired: 99 },
  
  // System destruction
  { pattern: /shutdown/, description: 'System shutdown', trustRequired: 5 },
  { pattern: /reboot/, description: 'System reboot', trustRequired: 5 },
  { pattern: /init\s+[0-6]/, description: 'Change runlevel', trustRequired: 99 },
  
  // SSH suicide (could lock owner out)
  { pattern: /systemctl\s+(stop|disable)\s+ssh/, description: 'Stop SSH service', trustRequired: 5 },
  { pattern: /ufw\s+deny\s+22/, description: 'Block SSH port', trustRequired: 5 },
  { pattern: /ufw\s+reset/, description: 'Reset firewall', trustRequired: 5 },
  
  // Network destruction
  { pattern: /ip\s+link\s+set\s+\w+\s+down/, description: 'Disable network interface', trustRequired: 5 },
  { pattern: /ifdown/, description: 'Take interface down', trustRequired: 5 },
  
  // User manipulation
  { pattern: /userdel/, description: 'Delete user', trustRequired: 5 },
  { pattern: /passwd/, description: 'Change password', trustRequired: 5 },
  { pattern: /usermod.*-L/, description: 'Lock user account', trustRequired: 5 },

  // Docker nuclear options (allowed at lower trust but still flagged)
  { pattern: /docker\s+system\s+prune\s+(-a|--all)/, description: 'Prune ALL docker data', trustRequired: 4 },
  { pattern: /docker\s+volume\s+prune/, description: 'Prune docker volumes', trustRequired: 3 },
];

// ============================================================================
// Audit log
// ============================================================================

interface AuditEntry {
  timestamp: string;
  command: string;
  args: string[];
  exitCode: number | null;
  success: boolean;
  duration_ms: number;
  blocked?: boolean;
  blockReason?: string;
}

const auditLog: AuditEntry[] = [];
const MAX_AUDIT_ENTRIES = 500;

function addAuditEntry(entry: AuditEntry): void {
  auditLog.push(entry);
  if (auditLog.length > MAX_AUDIT_ENTRIES) {
    auditLog.splice(0, auditLog.length - MAX_AUDIT_ENTRIES);
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Execute a system command safely
 */
export async function execHomelab(
  executable: string,
  args: string[] = [],
  options: {
    timeout?: number;
    maxOutput?: number;
    trustLevel?: number;
  } = {}
): Promise<ShellCommandResult> {
  const startTime = Date.now();
  const timeout = options.timeout || 30000;     // 30s default
  const maxOutput = options.maxOutput || 50000;  // 50KB default
  const trustLevel = options.trustLevel || 2;

  // Platform guard - only allow on Linux (except for testing)
  if (process.platform !== 'linux' && !process.env.HOMELAB_DEV_MODE) {
    return {
      success: false,
      stdout: '',
      stderr: 'Homelab commands only available on Linux',
      exitCode: null,
      timedOut: false,
      duration_ms: Date.now() - startTime,
      command: `${executable} ${args.join(' ')}`
    };
  }

  // Check if homelab is enabled
  if (!config.homelab.enabled && !process.env.HOMELAB_DEV_MODE) {
    return {
      success: false,
      stdout: '',
      stderr: 'Homelab mode is not enabled. Set homelab.enabled = true in config.json',
      exitCode: null,
      timedOut: false,
      duration_ms: Date.now() - startTime,
      command: `${executable} ${args.join(' ')}`
    };
  }

  // Validate executable is whitelisted
  if (!ALLOWED_EXECUTABLES.has(executable)) {
    const blocked: AuditEntry = {
      timestamp: new Date().toISOString(),
      command: executable,
      args,
      exitCode: null,
      success: false,
      duration_ms: 0,
      blocked: true,
      blockReason: `Executable not whitelisted: ${executable}`
    };
    addAuditEntry(blocked);
    logger.warn('Blocked non-whitelisted executable', { executable, args });

    return {
      success: false,
      stdout: '',
      stderr: `Executable not allowed: ${executable}`,
      exitCode: null,
      timedOut: false,
      duration_ms: Date.now() - startTime,
      command: `${executable} ${args.join(' ')}`
    };
  }

  // Check for dangerous patterns
  const fullCommand = `${executable} ${args.join(' ')}`;
  for (const danger of DANGEROUS_PATTERNS) {
    if (danger.pattern.test(fullCommand)) {
      if (trustLevel < danger.trustRequired) {
        const blocked: AuditEntry = {
          timestamp: new Date().toISOString(),
          command: executable,
          args,
          exitCode: null,
          success: false,
          duration_ms: 0,
          blocked: true,
          blockReason: `Dangerous pattern: ${danger.description} (requires trust level ${danger.trustRequired})`
        };
        addAuditEntry(blocked);
        logger.warn('Blocked dangerous command', { command: fullCommand, pattern: danger.description, trustLevel, required: danger.trustRequired });

        return {
          success: false,
          stdout: '',
          stderr: `Blocked: ${danger.description}. Requires trust level ${danger.trustRequired}, current: ${trustLevel}`,
          exitCode: null,
          timedOut: false,
          duration_ms: Date.now() - startTime,
          command: fullCommand
        };
      }
      // Trust level sufficient but still log it
      logger.info('Dangerous command allowed by trust level', { command: fullCommand, pattern: danger.description, trustLevel });
    }
  }

  // Execute the command
  logger.debug('Executing homelab command', { executable, args: args.join(' ') });

  return new Promise<ShellCommandResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killed = false;

    const proc = spawn(executable, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
      timeout: 0  // We handle timeout ourselves
    });

    // Timeout handling
    const timer = setTimeout(() => {
      timedOut = true;
      killed = true;
      proc.kill('SIGTERM');
      // Force kill after 5 seconds
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL');
      }, 5000);
    }, timeout);

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
      // Truncate if too large
      if (stdout.length > maxOutput) {
        stdout = stdout.substring(0, maxOutput) + '\n... (output truncated)';
        if (!killed) {
          killed = true;
          proc.kill('SIGTERM');
        }
      }
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
      if (stderr.length > maxOutput) {
        stderr = stderr.substring(0, maxOutput) + '\n... (output truncated)';
      }
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      const duration_ms = Date.now() - startTime;
      const success = code === 0 && !timedOut;

      const entry: AuditEntry = {
        timestamp: new Date().toISOString(),
        command: executable,
        args,
        exitCode: code,
        success,
        duration_ms
      };
      addAuditEntry(entry);

      if (timedOut) {
        logger.warn('Homelab command timed out', { executable, args: args.join(' '), timeout });
      } else {
        logger.debug('Homelab command completed', { executable, exitCode: code, duration_ms });
      }

      resolve({
        success,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code,
        timedOut,
        duration_ms,
        command: fullCommand
      });
    });

    proc.on('error', (error) => {
      clearTimeout(timer);
      const duration_ms = Date.now() - startTime;

      const entry: AuditEntry = {
        timestamp: new Date().toISOString(),
        command: executable,
        args,
        exitCode: null,
        success: false,
        duration_ms
      };
      addAuditEntry(entry);

      logger.error('Homelab command failed to start', { executable, error: String(error) });

      resolve({
        success: false,
        stdout: '',
        stderr: `Failed to execute: ${error.message}`,
        exitCode: null,
        timedOut: false,
        duration_ms,
        command: fullCommand
      });
    });
  });
}

/**
 * Convenience: execute and return just stdout on success
 */
export async function execHomelabQuick(
  executable: string,
  args: string[] = [],
  timeout?: number
): Promise<string> {
  const result = await execHomelab(executable, args, { timeout });
  if (!result.success) {
    throw new Error(result.stderr || `Command failed: ${result.command}`);
  }
  return result.stdout;
}

/**
 * Get the audit log
 */
export function getAuditLog(limit = 50): AuditEntry[] {
  return auditLog.slice(-limit);
}

/**
 * Get audit log formatted for display
 */
export function getAuditReport(): string {
  const recent = auditLog.slice(-20);
  if (recent.length === 0) return 'No homelab commands executed yet.';

  let report = '## Homelab Command Audit\n\n';
  for (const entry of recent) {
    const status = entry.blocked ? '🚫 BLOCKED' : entry.success ? '✅' : '❌';
    report += `${status} \`${entry.command} ${entry.args.join(' ')}\``;
    if (entry.blocked) {
      report += ` - ${entry.blockReason}`;
    }
    report += ` (${entry.duration_ms}ms)\n`;
  }
  return report;
}

/**
 * Check if homelab mode is available on this system
 */
export function isHomelabAvailable(): boolean {
  if (process.env.HOMELAB_DEV_MODE) return true;
  return process.platform === 'linux' && config.homelab.enabled;
}
