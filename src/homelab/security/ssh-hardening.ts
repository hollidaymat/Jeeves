/**
 * Homelab Security - SSH Configuration Audit
 * 
 * READ-ONLY audit of sshd_config. Never modifies the SSH configuration.
 * Checks best-practice hardening settings and produces a security score.
 */

import { execHomelab } from '../shell.js';
import { logger } from '../../utils/logger.js';

// ============================================================================
// Types
// ============================================================================

export type SSHFindingSeverity = 'info' | 'warning' | 'critical';

export interface SSHFinding {
  setting: string;
  current: string;
  recommended: string;
  severity: SSHFindingSeverity;
}

export interface SSHAuditResult {
  findings: SSHFinding[];
  score: number;
  recommendations: string[];
}

// ============================================================================
// Audit Configuration
// ============================================================================

interface AuditCheck {
  setting: string;
  recommended: string;
  severity: SSHFindingSeverity;
  scoreImpact: number;
  check: (value: string) => boolean;
  recommendation: string;
}

const AUDIT_CHECKS: AuditCheck[] = [
  {
    setting: 'PasswordAuthentication',
    recommended: 'no',
    severity: 'critical',
    scoreImpact: 30,
    check: (value: string) => value.toLowerCase() === 'no',
    recommendation: 'Disable password authentication. Use SSH keys only: PasswordAuthentication no',
  },
  {
    setting: 'PermitRootLogin',
    recommended: 'no',
    severity: 'critical',
    scoreImpact: 25,
    check: (value: string) => value.toLowerCase() === 'no',
    recommendation: 'Disable root login via SSH: PermitRootLogin no',
  },
  {
    setting: 'PubkeyAuthentication',
    recommended: 'yes',
    severity: 'critical',
    scoreImpact: 20,
    check: (value: string) => value.toLowerCase() === 'yes',
    recommendation: 'Enable public key authentication: PubkeyAuthentication yes',
  },
  {
    setting: 'MaxAuthTries',
    recommended: '3-5',
    severity: 'warning',
    scoreImpact: 10,
    check: (value: string) => {
      const n = parseInt(value, 10);
      return !isNaN(n) && n <= 5;
    },
    recommendation: 'Limit authentication attempts to 5 or fewer: MaxAuthTries 5',
  },
  {
    setting: 'Port',
    recommended: 'non-standard or 22',
    severity: 'info',
    scoreImpact: 15,
    check: (_value: string) => {
      // Any valid port is acceptable; non-standard is just a bonus
      return true;
    },
    recommendation: 'Consider using a non-standard port to reduce automated scan noise',
  },
];

// ============================================================================
// SSH Config Parsing
// ============================================================================

function parseSshdConfig(raw: string): Map<string, string> {
  const settings = new Map<string, string>();

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();

    // Skip comments and empty lines
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    // sshd_config format: Setting Value
    const spaceIdx = trimmed.indexOf(' ');
    const tabIdx = trimmed.indexOf('\t');
    let sepIdx: number;

    if (spaceIdx === -1 && tabIdx === -1) continue;
    if (spaceIdx === -1) sepIdx = tabIdx;
    else if (tabIdx === -1) sepIdx = spaceIdx;
    else sepIdx = Math.min(spaceIdx, tabIdx);

    const key = trimmed.substring(0, sepIdx);
    const value = trimmed.substring(sepIdx + 1).trim();

    // First occurrence wins (sshd behavior)
    if (!settings.has(key)) {
      settings.set(key, value);
    }
  }

  return settings;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Audit the SSH daemon configuration (read-only).
 * Reads /etc/ssh/sshd_config and checks hardening best practices.
 */
export async function auditSSHConfig(): Promise<SSHAuditResult> {
  const result = await execHomelab('cat', ['/etc/ssh/sshd_config']);

  if (!result.success) {
    logger.error('Failed to read sshd_config', { stderr: result.stderr });
    return {
      findings: [{
        setting: 'sshd_config',
        current: 'unreadable',
        recommended: 'readable',
        severity: 'critical',
      }],
      score: 0,
      recommendations: ['Unable to read /etc/ssh/sshd_config. Check permissions.'],
    };
  }

  const config = parseSshdConfig(result.stdout);
  const findings: SSHFinding[] = [];
  const recommendations: string[] = [];
  let score = 100;

  for (const check of AUDIT_CHECKS) {
    const current = config.get(check.setting);

    if (current === undefined) {
      // Setting not explicitly configured — use SSH defaults
      const defaultValues: Record<string, string> = {
        PasswordAuthentication: 'yes',
        PermitRootLogin: 'prohibit-password',
        PubkeyAuthentication: 'yes',
        MaxAuthTries: '6',
        Port: '22',
      };

      const defaultValue = defaultValues[check.setting] ?? 'not set';
      const passes = check.check(defaultValue);

      findings.push({
        setting: check.setting,
        current: `${defaultValue} (default)`,
        recommended: check.recommended,
        severity: passes ? 'info' : check.severity,
      });

      if (!passes) {
        score -= check.scoreImpact;
        recommendations.push(check.recommendation);
      }
    } else {
      const passes = check.check(current);

      findings.push({
        setting: check.setting,
        current,
        recommended: check.recommended,
        severity: passes ? 'info' : check.severity,
      });

      if (!passes) {
        score -= check.scoreImpact;
        recommendations.push(check.recommendation);
      }
    }
  }

  // Clamp score
  score = Math.max(0, Math.min(100, score));

  logger.info('SSH config audit completed', { score, findingsCount: findings.length });

  return { findings, score, recommendations };
}

/**
 * Generate a formatted markdown SSH hardening report.
 */
export async function getSSHReport(): Promise<string> {
  const audit = await auditSSHConfig();

  let report = '## SSH Hardening Audit\n\n';
  report += `**Security Score:** ${audit.score}/100\n\n`;

  // Findings table
  report += '| Setting | Current | Recommended | Severity |\n';
  report += '|---------|---------|-------------|----------|\n';

  for (const finding of audit.findings) {
    const severityIcon =
      finding.severity === 'critical' ? 'CRITICAL' :
      finding.severity === 'warning' ? 'WARNING' :
      'OK';
    report += `| ${finding.setting} | ${finding.current} | ${finding.recommended} | ${severityIcon} |\n`;
  }

  // Recommendations
  if (audit.recommendations.length > 0) {
    report += '\n### Recommendations\n\n';
    for (const rec of audit.recommendations) {
      report += `- ${rec}\n`;
    }
  } else {
    report += '\n_All checks passed. SSH configuration is well-hardened._\n';
  }

  return report;
}
