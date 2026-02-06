/**
 * Jeeves Homelab - Pi-hole Local DNS Management
 *
 * Manages custom DNS records via the Pi-hole admin API or direct
 * custom.list manipulation inside the Pi-hole container.
 *
 * Primary method: Pi-hole API at http://localhost:8053/admin/api.php
 * Fallback: docker exec into the pihole container to edit /etc/pihole/custom.list
 */

import { execHomelab } from '../shell.js';
import { logger } from '../../utils/logger.js';

// ============================================================================
// Types
// ============================================================================

export interface DNSEntry {
  hostname: string;
  ip: string;
}

// ============================================================================
// Constants
// ============================================================================

const PIHOLE_API_URL = 'http://localhost:8053/admin/api.php';
const CUSTOM_LIST_PATH = '/etc/pihole/custom.list';
const PIHOLE_CONTAINER = 'pihole';

// ============================================================================
// Public API
// ============================================================================

/**
 * Add a custom DNS record.
 * Tries the Pi-hole API first, falls back to appending to custom.list
 * inside the pihole container.
 */
export async function addLocalDNS(
  hostname: string,
  ip: string,
): Promise<{ success: boolean; message: string }> {
  logger.info('Adding local DNS entry', { hostname, ip });

  // ---- Primary: Pi-hole API ----
  const apiResult = await execHomelab('curl', [
    '-s',
    '-X', 'POST',
    PIHOLE_API_URL,
    '-d', `customdns=true&action=add&domain=${hostname}&ip=${ip}`,
  ]);

  if (apiResult.success && !apiResult.stdout.toLowerCase().includes('error')) {
    logger.info('DNS entry added via Pi-hole API', { hostname, ip });
    return { success: true, message: `DNS entry added: ${hostname} -> ${ip}` };
  }

  logger.warn('Pi-hole API failed, falling back to custom.list', {
    stderr: apiResult.stderr,
    stdout: apiResult.stdout,
  });

  // ---- Fallback: docker exec into pihole container ----
  const appendResult = await execHomelab('docker', [
    'exec', PIHOLE_CONTAINER, 'bash', '-c',
    `echo '${ip} ${hostname}' >> ${CUSTOM_LIST_PATH}`,
  ], { timeout: 10_000 });

  if (!appendResult.success) {
    return {
      success: false,
      message: `Failed to add DNS entry: ${appendResult.stderr || 'Unknown error'}`,
    };
  }

  // Restart Pi-hole DNS resolver to pick up the new entry
  await execHomelab('docker', [
    'exec', PIHOLE_CONTAINER, 'pihole', 'restartdns',
  ], { timeout: 15_000 });

  return {
    success: true,
    message: `DNS entry added to custom.list: ${hostname} -> ${ip}`,
  };
}

/**
 * Remove a custom DNS record.
 * Tries the Pi-hole API first (requires knowing the IP), falls back
 * to filtering custom.list inside the pihole container.
 */
export async function removeLocalDNS(
  hostname: string,
): Promise<{ success: boolean; message: string }> {
  logger.info('Removing local DNS entry', { hostname });

  // Look up the IP for this hostname (needed for API delete)
  const entries = await listLocalDNS();
  const entry = entries.find((e) => e.hostname === hostname);

  // ---- Primary: Pi-hole API (only if we know the IP) ----
  if (entry) {
    const apiResult = await execHomelab('curl', [
      '-s',
      '-X', 'POST',
      PIHOLE_API_URL,
      '-d', `customdns=true&action=delete&domain=${hostname}&ip=${entry.ip}`,
    ]);

    if (apiResult.success && !apiResult.stdout.toLowerCase().includes('error')) {
      logger.info('DNS entry removed via Pi-hole API', { hostname });
      return { success: true, message: `DNS entry removed: ${hostname}` };
    }

    logger.warn('Pi-hole API delete failed, falling back to custom.list', {
      stderr: apiResult.stderr,
    });
  }

  // ---- Fallback: docker exec to filter custom.list ----
  // Use grep -v to remove lines ending with the hostname
  const fallbackResult = await execHomelab('docker', [
    'exec', PIHOLE_CONTAINER, 'bash', '-c',
    `grep -v ' ${hostname}$' ${CUSTOM_LIST_PATH} > ${CUSTOM_LIST_PATH}.tmp && mv ${CUSTOM_LIST_PATH}.tmp ${CUSTOM_LIST_PATH}`,
  ], { timeout: 10_000 });

  if (!fallbackResult.success) {
    return {
      success: false,
      message: `Failed to remove DNS entry: ${fallbackResult.stderr || 'Unknown error'}`,
    };
  }

  // Restart Pi-hole DNS resolver to pick up changes
  await execHomelab('docker', [
    'exec', PIHOLE_CONTAINER, 'pihole', 'restartdns',
  ], { timeout: 15_000 });

  return {
    success: true,
    message: `DNS entry removed from custom.list: ${hostname}`,
  };
}

/**
 * List all custom DNS entries.
 * Reads /etc/pihole/custom.list from the pihole container, or queries the API.
 * custom.list format: "IP HOSTNAME" per line.
 */
export async function listLocalDNS(): Promise<DNSEntry[]> {
  // Try reading custom.list from pihole container
  const catResult = await execHomelab('docker', [
    'exec', PIHOLE_CONTAINER, 'cat', CUSTOM_LIST_PATH,
  ], { timeout: 10_000 });

  if (catResult.success && catResult.stdout.trim()) {
    return parseCustomList(catResult.stdout);
  }

  // Fallback: query Pi-hole API
  const apiResult = await execHomelab('curl', [
    '-s',
    `${PIHOLE_API_URL}?customdns&action=get`,
  ]);

  if (apiResult.success && apiResult.stdout.trim()) {
    try {
      const data = JSON.parse(apiResult.stdout) as { data?: string[][] };
      if (Array.isArray(data.data)) {
        return data.data.map(([domain, ip]) => ({
          hostname: domain ?? '',
          ip: ip ?? '',
        }));
      }
    } catch {
      logger.warn('Failed to parse Pi-hole API response for DNS list');
    }
  }

  return [];
}

/**
 * Generate a formatted markdown report of all local DNS entries.
 */
export async function getDNSReport(): Promise<string> {
  const entries = await listLocalDNS();

  if (entries.length === 0) {
    return '## Local DNS Entries\n\nNo custom DNS entries configured.\n';
  }

  let report = '## Local DNS Entries\n\n';
  report += '| Hostname | IP Address |\n';
  report += '|----------|------------|\n';

  for (const entry of entries) {
    report += `| ${entry.hostname} | ${entry.ip} |\n`;
  }

  report += `\n**Total entries:** ${entries.length}\n`;

  return report;
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Parse Pi-hole custom.list content into DNSEntry array.
 * Format: "IP HOSTNAME" per line, comments start with #.
 */
function parseCustomList(content: string): DNSEntry[] {
  const entries: DNSEntry[] = [];

  for (const line of content.trim().split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const parts = trimmed.split(/\s+/);
    if (parts.length >= 2) {
      entries.push({ ip: parts[0], hostname: parts[1] });
    }
  }

  return entries;
}
