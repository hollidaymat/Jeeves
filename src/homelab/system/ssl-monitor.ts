/**
 * SSL/TLS Certificate Monitoring
 * Checks cert expiry for Traefik-managed domains.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { readFileSync, existsSync } from 'fs';
import { logger } from '../../utils/logger.js';

const execAsync = promisify(exec);

export interface CertInfo {
  domain: string;
  issuer: string;
  expiresAt: string;
  daysLeft: number;
  status: 'ok' | 'expiring' | 'expired';
}

export interface CertReport {
  certs: CertInfo[];
  summary: string;
}

/**
 * Check SSL certificate expiry for domains.
 * Tries reading Traefik's acme.json first, falls back to openssl probes.
 */
export async function checkCertificates(): Promise<CertReport> {
  const certs: CertInfo[] = [];

  // Try Traefik acme.json first
  const acmePaths = [
    '/opt/stacks/traefik/acme.json',
    '/opt/stacks/traefik/letsencrypt/acme.json',
    '/etc/traefik/acme.json',
  ];

  for (const acmePath of acmePaths) {
    if (existsSync(acmePath)) {
      try {
        const raw = readFileSync(acmePath, 'utf-8');
        const acme = JSON.parse(raw);
        // Handle both v1 and v2 format
        const resolvers = acme.letsencrypt || acme.myresolver || acme;
        const certificates = resolvers?.Certificates || resolvers?.certificates || [];

        for (const cert of certificates) {
          const domain = cert.domain?.main || cert.Domain?.Main || 'unknown';
          try {
            // Decode cert to get expiry
            const certPem = Buffer.from(cert.certificate || cert.Certificate || '', 'base64').toString();
            if (certPem.includes('BEGIN CERTIFICATE')) {
              const info = await parseCertExpiry(domain, certPem);
              if (info) certs.push(info);
            }
          } catch { /* skip individual cert */ }
        }
        if (certs.length > 0) break;
      } catch { /* try next path */ }
    }
  }

  // If no acme.json, try known local domains via openssl
  if (certs.length === 0) {
    const domains = ['localhost'];
    try {
      // Check Traefik routes for configured domains
      const { stdout } = await execAsync('docker exec traefik traefik version 2>/dev/null', { timeout: 5000 }).catch(() => ({ stdout: '' }));
      if (!stdout) {
        // Check openssl on common ports
        for (const domain of domains) {
          const info = await probeSSL(domain, 443);
          if (info) certs.push(info);
        }
      }
    } catch { /* skip */ }
  }

  const expiring = certs.filter(c => c.status !== 'ok');
  const summary = certs.length === 0
    ? 'No SSL certificates found to monitor'
    : expiring.length === 0
      ? `${certs.length} certificate(s) healthy`
      : `${expiring.length} certificate(s) need attention`;

  return { certs, summary };
}

async function parseCertExpiry(domain: string, pem: string): Promise<CertInfo | null> {
  try {
    const { stdout } = await execAsync(
      `echo "${pem}" | openssl x509 -noout -enddate -issuer 2>/dev/null`,
      { timeout: 5000 }
    );
    const dateMatch = stdout.match(/notAfter=(.+)/);
    const issuerMatch = stdout.match(/issuer=(.+)/);

    if (dateMatch) {
      const expiresAt = new Date(dateMatch[1]).toISOString();
      const daysLeft = Math.floor((new Date(dateMatch[1]).getTime() - Date.now()) / 86400000);
      return {
        domain,
        issuer: issuerMatch?.[1]?.trim() || 'Unknown',
        expiresAt,
        daysLeft,
        status: daysLeft < 0 ? 'expired' : daysLeft < 14 ? 'expiring' : 'ok',
      };
    }
  } catch { /* skip */ }
  return null;
}

async function probeSSL(host: string, port: number): Promise<CertInfo | null> {
  try {
    const { stdout } = await execAsync(
      `echo | openssl s_client -servername ${host} -connect ${host}:${port} 2>/dev/null | openssl x509 -noout -enddate -issuer -subject 2>/dev/null`,
      { timeout: 10000 }
    );
    const dateMatch = stdout.match(/notAfter=(.+)/);
    const issuerMatch = stdout.match(/issuer=(.+)/);

    if (dateMatch) {
      const expiresAt = new Date(dateMatch[1]).toISOString();
      const daysLeft = Math.floor((new Date(dateMatch[1]).getTime() - Date.now()) / 86400000);
      return {
        domain: host,
        issuer: issuerMatch?.[1]?.trim() || 'Unknown',
        expiresAt,
        daysLeft,
        status: daysLeft < 0 ? 'expired' : daysLeft < 14 ? 'expiring' : 'ok',
      };
    }
  } catch { /* skip */ }
  return null;
}

export function formatCertReport(report: CertReport): string {
  if (report.certs.length === 0) {
    return 'No SSL certificates detected. Traefik acme.json not found.';
  }
  const lines = ['## SSL Certificates', ''];
  for (const cert of report.certs) {
    const icon = cert.status === 'ok' ? '🟢' : cert.status === 'expiring' ? '🟡' : '🔴';
    lines.push(`${icon} **${cert.domain}** — ${cert.daysLeft} days left`);
  }
  return lines.join('\n');
}
