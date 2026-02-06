/**
 * Homelab Security - UFW Firewall Management
 * 
 * Manages UFW firewall rules, status, and reporting.
 * Safety: Refuses to deny port 22 (SSH lockout prevention).
 */

import { execHomelab } from '../shell.js';
import { logger } from '../../utils/logger.js';

// ============================================================================
// Types
// ============================================================================

export interface FirewallRule {
  port: number;
  proto: string;
  action: string;
  from: string;
  comment?: string;
}

export interface FirewallStatus {
  active: boolean;
  defaultIncoming: string;
  defaultOutgoing: string;
  rules: FirewallRule[];
}

// ============================================================================
// Firewall Status
// ============================================================================

/**
 * Get current UFW firewall status and rules.
 * Parses `ufw status verbose` output into structured data.
 */
export async function getFirewallStatus(): Promise<FirewallStatus> {
  const result = await execHomelab('sudo', ['ufw', 'status', 'verbose']);

  if (!result.success) {
    logger.error('Failed to get firewall status', { stderr: result.stderr });
    return {
      active: false,
      defaultIncoming: 'unknown',
      defaultOutgoing: 'unknown',
      rules: [],
    };
  }

  const output = result.stdout;
  const lines = output.split('\n');

  // Parse active status
  const statusLine = lines.find(l => l.startsWith('Status:'));
  const active = statusLine ? statusLine.includes('active') : false;

  // Parse defaults
  let defaultIncoming = 'unknown';
  let defaultOutgoing = 'unknown';

  const defaultLine = lines.find(l => l.startsWith('Default:'));
  if (defaultLine) {
    const inMatch = defaultLine.match(/(\w+)\s+\(incoming\)/);
    const outMatch = defaultLine.match(/(\w+)\s+\(outgoing\)/);
    if (inMatch) defaultIncoming = inMatch[1];
    if (outMatch) defaultOutgoing = outMatch[1];
  }

  // Parse rules - they appear after the header line "-- ------ ----"
  const rules: FirewallRule[] = [];
  let inRulesSection = false;

  for (const line of lines) {
    if (line.includes('---') && line.includes('---')) {
      inRulesSection = true;
      continue;
    }

    if (!inRulesSection || line.trim() === '') continue;

    // UFW rule lines look like:
    //   22/tcp                     ALLOW IN    Anywhere                   # SSH
    //   80/tcp                     ALLOW IN    192.168.1.0/24             # Web
    const ruleMatch = line.match(
      /^\s*(\d+)\/(tcp|udp)\s+(ALLOW|DENY|REJECT|LIMIT)\s+(?:IN\s+)?(.*?)(?:\s+#\s*(.*))?$/
    );

    if (ruleMatch) {
      rules.push({
        port: parseInt(ruleMatch[1], 10),
        proto: ruleMatch[2],
        action: ruleMatch[3],
        from: ruleMatch[4].trim() || 'Anywhere',
        comment: ruleMatch[5]?.trim() || undefined,
      });
    }
  }

  return { active, defaultIncoming, defaultOutgoing, rules };
}

// ============================================================================
// Port Management
// ============================================================================

/**
 * Allow a port through the firewall.
 * Safety: Refuses port 0 or negative numbers.
 */
export async function allowPort(
  port: number,
  proto: string,
  comment: string
): Promise<{ success: boolean; message: string }> {
  if (port <= 0) {
    return { success: false, message: `Invalid port number: ${port}. Port must be positive.` };
  }

  if (port > 65535) {
    return { success: false, message: `Invalid port number: ${port}. Port must be <= 65535.` };
  }

  const result = await execHomelab('sudo', [
    'ufw', 'allow',
    `${port}/${proto}`,
    'comment',
    comment,
  ]);

  if (result.success) {
    logger.info('Firewall: allowed port', { port, proto, comment });
    return { success: true, message: `Port ${port}/${proto} allowed: ${comment}` };
  }

  logger.error('Failed to allow port', { port, proto, stderr: result.stderr });
  return { success: false, message: result.stderr || 'Failed to allow port' };
}

/**
 * Deny a port through the firewall.
 * Safety: NEVER allows denying port 22 (SSH lockout prevention).
 */
export async function denyPort(
  port: number
): Promise<{ success: boolean; message: string }> {
  if (port === 22) {
    logger.warn('Refused to deny port 22 (SSH lockout prevention)');
    return {
      success: false,
      message: 'SAFETY: Refusing to deny port 22 (SSH). This would lock you out of the server.',
    };
  }

  if (port <= 0) {
    return { success: false, message: `Invalid port number: ${port}. Port must be positive.` };
  }

  if (port > 65535) {
    return { success: false, message: `Invalid port number: ${port}. Port must be <= 65535.` };
  }

  const result = await execHomelab('sudo', ['ufw', 'deny', String(port)]);

  if (result.success) {
    logger.info('Firewall: denied port', { port });
    return { success: true, message: `Port ${port} denied` };
  }

  logger.error('Failed to deny port', { port, stderr: result.stderr });
  return { success: false, message: result.stderr || 'Failed to deny port' };
}

// ============================================================================
// Reporting
// ============================================================================

/**
 * Generate a formatted markdown firewall report for dashboard display.
 */
export async function getFirewallReport(): Promise<string> {
  const status = await getFirewallStatus();

  let report = '## Firewall Status\n\n';
  report += `**Status:** ${status.active ? 'Active' : 'Inactive'}\n`;
  report += `**Default Incoming:** ${status.defaultIncoming}\n`;
  report += `**Default Outgoing:** ${status.defaultOutgoing}\n\n`;

  if (status.rules.length === 0) {
    report += '_No rules configured._\n';
  } else {
    report += '| Port | Proto | Action | From | Comment |\n';
    report += '|------|-------|--------|------|--------|\n';
    for (const rule of status.rules) {
      report += `| ${rule.port} | ${rule.proto} | ${rule.action} | ${rule.from} | ${rule.comment ?? ''} |\n`;
    }
  }

  return report;
}

// ============================================================================
// Service Rule Generator
// ============================================================================

/**
 * Generate UFW rule suggestions from a service port list.
 * Pure function, no side effects.
 */
export function generateServiceRules(
  services: { name: string; ports: number[] }[]
): { port: number; proto: string; comment: string }[] {
  const rules: { port: number; proto: string; comment: string }[] = [];

  for (const service of services) {
    for (const port of service.ports) {
      rules.push({
        port,
        proto: 'tcp',
        comment: `${service.name} service`,
      });
    }
  }

  return rules;
}
