/**
 * Grafana Dashboard Snapshots
 * Renders dashboard panels as PNG images.
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { logger } from '../../utils/logger.js';

const GRAFANA_URL = process.env.GRAFANA_URL || 'http://localhost:3000';
const GRAFANA_USER = process.env.GRAFANA_USER || 'admin';
const GRAFANA_PASS = process.env.GRAFANA_PASS || '';

function authHeaders(): Record<string, string> {
  return {
    'Authorization': 'Basic ' + Buffer.from(`${GRAFANA_USER}:${GRAFANA_PASS}`).toString('base64'),
  };
}

export interface GrafanaDashboard {
  uid: string;
  title: string;
  url: string;
}

/**
 * List available dashboards.
 */
export async function listDashboards(): Promise<GrafanaDashboard[]> {
  try {
    const res = await fetch(`${GRAFANA_URL}/api/search?type=dash-db`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json() as Array<{ uid: string; title: string; url: string }>;
    return data.map(d => ({
      uid: d.uid,
      title: d.title,
      url: d.url,
    }));
  } catch (error) {
    logger.debug('[grafana] List dashboards failed', { error: String(error) });
    return [];
  }
}

/**
 * Render a dashboard panel to PNG.
 * Requires Grafana image renderer plugin.
 */
export async function renderPanel(
  dashboardUid: string,
  panelId: number = 1,
  width: number = 800,
  height: number = 400,
  from: string = 'now-24h',
  to: string = 'now'
): Promise<string | null> {
  try {
    const url = `${GRAFANA_URL}/render/d-solo/${dashboardUid}?orgId=1&panelId=${panelId}&width=${width}&height=${height}&from=${from}&to=${to}`;

    const res = await fetch(url, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      logger.debug('[grafana] Render failed', { status: res.status });
      return null;
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    const outDir = '/tmp/jeeves-grafana';
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    const outPath = `${outDir}/panel-${dashboardUid}-${panelId}-${Date.now()}.png`;
    writeFileSync(outPath, buffer);

    return outPath;
  } catch (error) {
    logger.debug('[grafana] Render error', { error: String(error) });
    return null;
  }
}

export function formatDashboardList(dashboards: GrafanaDashboard[]): string {
  if (dashboards.length === 0) {
    return 'No Grafana dashboards found. Check that Grafana is running and credentials are configured.';
  }
  const lines = ['## Grafana Dashboards', ''];
  for (const d of dashboards) {
    lines.push(`- **${d.title}** (${d.uid})`);
  }
  lines.push('', 'Use `grafana snapshot <dashboard-name>` to get a graph image.');
  return lines.join('\n');
}
