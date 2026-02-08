/**
 * Uptime Kuma Integration
 * Reads monitor status from Uptime Kuma API.
 */

import { logger } from '../../utils/logger.js';

const KUMA_URL = process.env.UPTIME_KUMA_URL || 'http://localhost:3001';

export interface KumaMonitor {
  id: number;
  name: string;
  url: string;
  type: string;
  status: 'up' | 'down' | 'pending' | 'unknown';
  uptime24h: number;
  responseTime: number;
}

export interface KumaStatus {
  monitors: KumaMonitor[];
  allUp: boolean;
  summary: string;
}

/**
 * Get status from Uptime Kuma.
 * Uses the status page API (no auth required for public status pages).
 */
export async function getKumaStatus(): Promise<KumaStatus | null> {
  try {
    // Try the push-based metrics or status page API
    const res = await fetch(`${KUMA_URL}/api/status-page/homelab`, {
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      // Try alternate endpoint
      const res2 = await fetch(`${KUMA_URL}/api/status-page/default`, {
        signal: AbortSignal.timeout(5000),
      }).catch(() => null);

      if (!res2?.ok) {
        logger.debug('[uptime-kuma] No status page found');
        return await getKumaStatusViaMetrics();
      }
    }

    const data = await res.json() as Record<string, unknown>;
    const publicGroupList = data.publicGroupList as Array<{
      monitorList: Array<{
        id: number;
        name: string;
        url: string;
        type: string;
      }>;
    }> || [];

    const heartbeatList = data.heartbeatList as Record<string, Array<{
      status: number;
      ping: number;
    }>> || {};

    const monitors: KumaMonitor[] = [];

    for (const group of publicGroupList) {
      for (const mon of group.monitorList) {
        const beats = heartbeatList[String(mon.id)] || [];
        const lastBeat = beats[beats.length - 1];

        monitors.push({
          id: mon.id,
          name: mon.name,
          url: mon.url || '',
          type: mon.type || 'http',
          status: lastBeat?.status === 1 ? 'up' : lastBeat?.status === 0 ? 'down' : 'unknown',
          uptime24h: beats.length > 0
            ? Math.round(beats.filter(b => b.status === 1).length / beats.length * 100)
            : 0,
          responseTime: lastBeat?.ping || 0,
        });
      }
    }

    const down = monitors.filter(m => m.status === 'down');
    const allUp = down.length === 0;

    return {
      monitors,
      allUp,
      summary: allUp
        ? `All ${monitors.length} monitors are up`
        : `${down.length} of ${monitors.length} monitors are DOWN: ${down.map(m => m.name).join(', ')}`,
    };
  } catch (error) {
    logger.debug('[uptime-kuma] API failed', { error: String(error) });
    return null;
  }
}

async function getKumaStatusViaMetrics(): Promise<KumaStatus | null> {
  try {
    // Try metrics endpoint
    const res = await fetch(`${KUMA_URL}/metrics`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;

    const text = await res.text();
    const monitors: KumaMonitor[] = [];

    const statusMatches = text.matchAll(/monitor_status\{.*?monitor_name="([^"]+)".*?monitor_url="([^"]*)".*?\}\s+(\d+)/g);
    for (const match of statusMatches) {
      monitors.push({
        id: monitors.length + 1,
        name: match[1],
        url: match[2],
        type: 'http',
        status: match[3] === '1' ? 'up' : 'down',
        uptime24h: 0,
        responseTime: 0,
      });
    }

    if (monitors.length === 0) return null;

    const down = monitors.filter(m => m.status === 'down');
    return {
      monitors,
      allUp: down.length === 0,
      summary: down.length === 0
        ? `All ${monitors.length} monitors are up`
        : `${down.length} DOWN: ${down.map(m => m.name).join(', ')}`,
    };
  } catch {
    return null;
  }
}

export function formatKumaStatus(status: KumaStatus | null): string {
  if (!status) {
    return 'Uptime Kuma not reachable. Check that it\'s running on port 3001.';
  }

  const lines = ['## Uptime Kuma', '', status.summary, ''];

  for (const mon of status.monitors) {
    const icon = mon.status === 'up' ? '🟢' : mon.status === 'down' ? '🔴' : '⚫';
    const rt = mon.responseTime > 0 ? ` (${mon.responseTime}ms)` : '';
    const uptime = mon.uptime24h > 0 ? ` — ${mon.uptime24h}% 24h` : '';
    lines.push(`  ${icon} ${mon.name}${rt}${uptime}`);
  }

  return lines.join('\n');
}
