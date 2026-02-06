/**
 * Homelab Security - SSL Certificate Management
 * 
 * Checks SSL certificate expiry, monitors homelab services,
 * and generates certificate status reports.
 */

import { execHomelab } from '../shell.js';
import { logger } from '../../utils/logger.js';

// ============================================================================
// Types
// ============================================================================

export type CertStatus = 'valid' | 'expiring' | 'expired';

export interface CertInfo {
  domain: string;
  subject: string;
  expiresAt: string;
  daysRemaining: number;
  status: CertStatus;
}

// ============================================================================
// Default Homelab Ports
// ============================================================================

const DEFAULT_HOMELAB_CHECKS: { domain: string; port: number }[] = [
  { domain: 'localhost', port: 443 },
  { domain: 'localhost', port: 9443 },
  { domain: 'localhost', port: 8443 },
  { domain: 'localhost', port: 8843 },
];

// ============================================================================
// Certificate Checking
// ============================================================================

/**
 * Check SSL certificate expiry for a domain and port.
 * Uses openssl s_client to connect and extract certificate info.
 */
export async function checkCertExpiry(
  domain: string,
  port = 443
): Promise<CertInfo> {
  // Use openssl s_client piped to x509 — since we can't pipe with spawn,
  // we run s_client first to get the cert, then parse the output.
  const result = await execHomelab('openssl', [
    's_client',
    '-connect', `${domain}:${port}`,
    '-servername', domain,
    '-showcerts',
  ], { timeout: 10000 });

  // openssl s_client writes to stderr for connection info and stdout for the cert
  // It may return exit code 0 even if connection worked, or non-zero if not.
  // The cert PEM is in stdout; we need to extract dates from it.
  const certPEM = extractPEM(result.stdout || result.stderr);

  if (!certPEM) {
    logger.warn('No certificate found', { domain, port });
    return {
      domain: `${domain}:${port}`,
      subject: 'unknown',
      expiresAt: 'unknown',
      daysRemaining: -1,
      status: 'expired',
    };
  }

  // Now parse the certificate with openssl x509
  const x509Result = await execHomelab('openssl', [
    'x509',
    '-noout',
    '-enddate',
    '-subject',
  ], { timeout: 5000 });

  // Since we can't pipe stdin easily, use a different approach:
  // Write the PEM to openssl via echo — but execHomelab uses spawn without shell.
  // Alternative: parse the dates from the s_client output directly.
  const certInfo = parseCertFromSClientOutput(result.stdout + '\n' + result.stderr, domain, port);

  if (certInfo) {
    return certInfo;
  }

  // Fallback: try running openssl with the -in flag approach won't work without a file.
  // Parse what we can from the raw output.
  return parseFallback(result.stdout + '\n' + result.stderr, domain, port);
}

/**
 * Extract PEM certificate block from openssl output.
 */
function extractPEM(output: string): string | null {
  const match = output.match(
    /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/
  );
  return match ? match[0] : null;
}

/**
 * Parse certificate info from openssl s_client verbose output.
 */
function parseCertFromSClientOutput(
  output: string,
  domain: string,
  port: number
): CertInfo | null {
  // Look for "Not After" in the output (from -showcerts or verify output)
  const notAfterMatch = output.match(/Not After\s*:\s*(.+)/i);
  const subjectMatch = output.match(/subject\s*=\s*(.+)/i);

  if (!notAfterMatch) return null;

  const expiresAt = notAfterMatch[1].trim();
  const subject = subjectMatch ? subjectMatch[1].trim() : 'unknown';
  const expiryDate = new Date(expiresAt);
  const now = new Date();
  const diffMs = expiryDate.getTime() - now.getTime();
  const daysRemaining = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  let status: CertStatus;
  if (daysRemaining < 0) {
    status = 'expired';
  } else if (daysRemaining < 14) {
    status = 'expiring';
  } else {
    status = 'valid';
  }

  return {
    domain: `${domain}:${port}`,
    subject,
    expiresAt,
    daysRemaining,
    status,
  };
}

/**
 * Fallback parser when structured fields aren't found.
 */
function parseFallback(output: string, domain: string, port: number): CertInfo {
  // Try to find any date-like expiry string
  const dateMatch = output.match(
    /notAfter=(.+)|expire date:\s*(.+)/i
  );

  if (dateMatch) {
    const dateStr = (dateMatch[1] || dateMatch[2]).trim();
    const expiryDate = new Date(dateStr);
    const now = new Date();
    const diffMs = expiryDate.getTime() - now.getTime();
    const daysRemaining = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    let status: CertStatus;
    if (daysRemaining < 0) {
      status = 'expired';
    } else if (daysRemaining < 14) {
      status = 'expiring';
    } else {
      status = 'valid';
    }

    return {
      domain: `${domain}:${port}`,
      subject: 'unknown',
      expiresAt: dateStr,
      daysRemaining,
      status,
    };
  }

  logger.warn('Could not parse certificate info', { domain, port });
  return {
    domain: `${domain}:${port}`,
    subject: 'unknown',
    expiresAt: 'unknown',
    daysRemaining: -1,
    status: 'expired',
  };
}

// ============================================================================
// Multi-Domain Checking
// ============================================================================

/**
 * Check SSL certificates for a list of domains.
 * If no domains provided, checks common homelab service ports on localhost.
 */
export async function listCerts(domains?: string[]): Promise<CertInfo[]> {
  if (domains && domains.length > 0) {
    const results = await Promise.allSettled(
      domains.map(d => checkCertExpiry(d))
    );

    return results.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      logger.warn('Certificate check failed', { domain: domains[i], error: String(r.reason) });
      return {
        domain: domains[i],
        subject: 'unknown',
        expiresAt: 'unknown',
        daysRemaining: -1,
        status: 'expired' as CertStatus,
      };
    });
  }

  // Default: check common homelab ports on localhost
  const results = await Promise.allSettled(
    DEFAULT_HOMELAB_CHECKS.map(({ domain, port }) =>
      checkCertExpiry(domain, port)
    )
  );

  return results.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    const check = DEFAULT_HOMELAB_CHECKS[i];
    logger.warn('Certificate check failed', { domain: check.domain, port: check.port, error: String(r.reason) });
    return {
      domain: `${check.domain}:${check.port}`,
      subject: 'unknown',
      expiresAt: 'unknown',
      daysRemaining: -1,
      status: 'expired' as CertStatus,
    };
  });
}

// ============================================================================
// Reporting
// ============================================================================

/**
 * Generate a formatted markdown SSL certificate report.
 */
export async function getSSLReport(): Promise<string> {
  const certs = await listCerts();

  let report = '## SSL Certificate Status\n\n';

  if (certs.length === 0) {
    report += '_No certificates checked._\n';
    return report;
  }

  const valid = certs.filter(c => c.status === 'valid').length;
  const expiring = certs.filter(c => c.status === 'expiring').length;
  const expired = certs.filter(c => c.status === 'expired').length;

  report += `**Summary:** ${valid} valid, ${expiring} expiring, ${expired} expired/unreachable\n\n`;

  report += '| Domain | Subject | Expires | Days Left | Status |\n';
  report += '|--------|---------|---------|-----------|--------|\n';

  for (const cert of certs) {
    const statusLabel =
      cert.status === 'valid' ? 'Valid' :
      cert.status === 'expiring' ? 'EXPIRING' :
      'EXPIRED';
    report += `| ${cert.domain} | ${cert.subject} | ${cert.expiresAt} | ${cert.daysRemaining} | ${statusLabel} |\n`;
  }

  // Warnings
  const warnings = certs.filter(c => c.status !== 'valid');
  if (warnings.length > 0) {
    report += '\n### Action Required\n\n';
    for (const cert of warnings) {
      if (cert.status === 'expired') {
        report += `- **${cert.domain}**: Certificate expired or unreachable. Renew immediately.\n`;
      } else {
        report += `- **${cert.domain}**: Certificate expires in ${cert.daysRemaining} days. Renew soon.\n`;
      }
    }
  }

  return report;
}
