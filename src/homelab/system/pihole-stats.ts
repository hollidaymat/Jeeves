/**
 * Pi-hole Stats Integration
 * Fetches DNS blocking stats from Pi-hole API.
 */

import { logger } from '../../utils/logger.js';

export interface PiholeStats {
  queriesTotal: number;
  queriesBlocked: number;
  percentBlocked: number;
  domainsOnBlocklist: number;
  topBlocked: Array<{ domain: string; count: number }>;
  topClients: Array<{ client: string; count: number }>;
  status: string;
}

const PIHOLE_URL = process.env.PIHOLE_URL || 'http://192.168.7.50:8053';

export async function getPiholeStats(): Promise<PiholeStats | null> {
  const apiKey = process.env.PIHOLE_API_KEY;
  if (!apiKey) {
    logger.debug('[pihole] No PIHOLE_API_KEY set');
    return null;
  }

  try {
    const [summaryRes, topBlockedRes, topClientsRes] = await Promise.all([
      fetch(`${PIHOLE_URL}/admin/api.php?summaryRaw&auth=${apiKey}`, { signal: AbortSignal.timeout(5000) }),
      fetch(`${PIHOLE_URL}/admin/api.php?topItems=5&auth=${apiKey}`, { signal: AbortSignal.timeout(5000) }),
      fetch(`${PIHOLE_URL}/admin/api.php?getQuerySources=5&auth=${apiKey}`, { signal: AbortSignal.timeout(5000) }),
    ]);

    const summary = await summaryRes.json() as Record<string, unknown>;
    const topBlockedData = await topBlockedRes.json() as Record<string, unknown>;
    const topClientsData = await topClientsRes.json() as Record<string, unknown>;

    const topAds = (topBlockedData.top_ads || {}) as Record<string, number>;
    const topSources = (topClientsData.top_sources || {}) as Record<string, number>;

    return {
      queriesTotal: Number(summary.dns_queries_today) || 0,
      queriesBlocked: Number(summary.ads_blocked_today) || 0,
      percentBlocked: Number(summary.ads_percentage_today) || 0,
      domainsOnBlocklist: Number(summary.domains_being_blocked) || 0,
      topBlocked: Object.entries(topAds).map(([domain, count]) => ({ domain, count })),
      topClients: Object.entries(topSources).map(([client, count]) => ({ client, count })),
      status: String(summary.status || 'unknown'),
    };
  } catch (error) {
    logger.debug('[pihole] API call failed', { error: String(error) });
    return null;
  }
}

export function formatPiholeStats(stats: PiholeStats): string {
  const lines: string[] = [
    '## Pi-hole DNS Stats',
    '',
    `Status: ${stats.status === 'enabled' ? '🟢 Active' : '🔴 ' + stats.status}`,
    `Queries today: ${stats.queriesTotal.toLocaleString()}`,
    `Blocked: ${stats.queriesBlocked.toLocaleString()} (${stats.percentBlocked.toFixed(1)}%)`,
    `Domains on blocklist: ${stats.domainsOnBlocklist.toLocaleString()}`,
  ];

  if (stats.topBlocked.length > 0) {
    lines.push('', 'Top blocked:');
    for (const { domain, count } of stats.topBlocked) {
      lines.push(`  ${domain}: ${count}`);
    }
  }

  return lines.join('\n');
}
