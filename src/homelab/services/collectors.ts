/**
 * Service Detail Collectors
 * 
 * Queries individual service APIs (Jellyfin, Radarr, Sonarr, Pi-hole, etc.)
 * for deep-dive dashboard data. Each collector is self-contained and gracefully
 * returns null if the service API is unavailable or unconfigured.
 * 
 * Results are cached for 30 seconds to avoid hammering service APIs.
 */

import { logger } from '../../utils/logger.js';

// ============================================================================
// Types
// ============================================================================

interface CacheEntry {
  data: Record<string, unknown>;
  timestamp: number;
}

interface CollectorConfig {
  endpoint: string;
  apiKey?: string;
  collect: () => Promise<Record<string, unknown> | null>;
}

// ============================================================================
// Cache
// ============================================================================

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 30000; // 30 seconds

function getCached(name: string): Record<string, unknown> | null {
  const entry = cache.get(name);
  if (entry && (Date.now() - entry.timestamp) < CACHE_TTL_MS) {
    return entry.data;
  }
  return null;
}

function setCache(name: string, data: Record<string, unknown>): void {
  cache.set(name, { data, timestamp: Date.now() });
}

// ============================================================================
// Service URL Helper — reads from env or falls back to default
// ============================================================================

function serviceUrl(name: string, defaultPort: number): string {
  // Check for SERVICE_URL override first (e.g. JELLYFIN_URL=http://192.168.1.50:8096)
  const envKey = `${name.toUpperCase()}_URL`;
  const override = process.env[envKey];
  if (override) return override.replace(/\/$/, '');
  return `http://localhost:${defaultPort}`;
}

// ============================================================================
// HTTP Helper
// ============================================================================

async function fetchJson(url: string, headers?: Record<string, string>): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

// ============================================================================
// Collectors
// ============================================================================

const collectors: Record<string, () => Promise<Record<string, unknown> | null>> = {

  // ---------- Jellyfin ----------
  async jellyfin() {
    const apiKey = process.env.JELLYFIN_API_KEY;
    if (!apiKey) return null;
    const base = serviceUrl('jellyfin', 8096);
    const headers = { 'X-Emby-Token': apiKey };

    try {
      const [sessions, library, recent] = await Promise.all([
        fetchJson(`${base}/Sessions`, headers) as Promise<Array<Record<string, unknown>>>,
        fetchJson(`${base}/Library/MediaFolders`, headers) as Promise<Record<string, unknown>>,
        fetchJson(`${base}/Items/Latest?limit=5`, headers) as Promise<Array<Record<string, unknown>>>,
      ]);

      const activeSessions = (sessions || []).filter((s: Record<string, unknown>) => s.NowPlayingItem);
      const transcoding = activeSessions.some((s: Record<string, unknown>) => s.TranscodingInfo);

      return {
        activeStreams: activeSessions.length,
        transcoding,
        recentlyAdded: (recent || []).slice(0, 5).map((item: Record<string, unknown>) => ({
          title: item.Name,
          type: item.Type,
        })),
        sessions: activeSessions.length,
      };
    } catch (e) {
      logger.debug('Jellyfin collector failed', { error: String(e) });
      return null;
    }
  },

  // ---------- Radarr ----------
  async radarr() {
    const apiKey = process.env.RADARR_API_KEY;
    if (!apiKey) return null;
    const base = serviceUrl('radarr', 7878);
    const headers = { 'X-Api-Key': apiKey };

    try {
      const [queue, movies, health, disk] = await Promise.all([
        fetchJson(`${base}/api/v3/queue?page=1&pageSize=10`, headers) as Promise<Record<string, unknown>>,
        fetchJson(`${base}/api/v3/movie`, headers) as Promise<Array<Record<string, unknown>>>,
        fetchJson(`${base}/api/v3/health`, headers) as Promise<Array<Record<string, unknown>>>,
        fetchJson(`${base}/api/v3/diskspace`, headers) as Promise<Array<Record<string, unknown>>>,
      ]);

      const records = ((queue as Record<string, unknown>)?.records as Array<Record<string, unknown>>) || [];
      const moviesArr = movies || [];
      const monitored = moviesArr.filter((m: Record<string, unknown>) => m.monitored).length;
      const missing = moviesArr.filter((m: Record<string, unknown>) => m.monitored && !m.hasFile).length;

      return {
        queue: records.slice(0, 5).map((r: Record<string, unknown>) => ({
          title: r.title,
          status: r.status,
          progress: r.size ? Math.round((1 - (r.sizeleft as number) / (r.size as number)) * 100) : 0,
        })),
        monitored,
        missing,
        diskSpace: (disk || []).map((d: Record<string, unknown>) => `${Math.round((d.freeSpace as number) / 1e9)}GB free`).join(', '),
        health: (health || []).slice(0, 3).map((h: Record<string, unknown>) => ({
          type: h.type,
          message: h.message,
        })),
        totalMovies: moviesArr.length,
      };
    } catch (e) {
      logger.debug('Radarr collector failed', { error: String(e) });
      return null;
    }
  },

  // ---------- Sonarr ----------
  async sonarr() {
    const apiKey = process.env.SONARR_API_KEY;
    if (!apiKey) return null;
    const base = serviceUrl('sonarr', 8989);
    const headers = { 'X-Api-Key': apiKey };

    try {
      const [queue, series, health] = await Promise.all([
        fetchJson(`${base}/api/v3/queue?page=1&pageSize=10`, headers) as Promise<Record<string, unknown>>,
        fetchJson(`${base}/api/v3/series`, headers) as Promise<Array<Record<string, unknown>>>,
        fetchJson(`${base}/api/v3/health`, headers) as Promise<Array<Record<string, unknown>>>,
      ]);

      const records = ((queue as Record<string, unknown>)?.records as Array<Record<string, unknown>>) || [];
      const seriesArr = series || [];
      const monitored = seriesArr.filter((s: Record<string, unknown>) => s.monitored).length;

      return {
        queue: records.slice(0, 5).map((r: Record<string, unknown>) => ({
          title: r.title,
          status: r.status,
          progress: r.size ? Math.round((1 - (r.sizeleft as number) / (r.size as number)) * 100) : 0,
        })),
        monitored,
        totalSeries: seriesArr.length,
        health: (health || []).slice(0, 3).map((h: Record<string, unknown>) => ({
          type: h.type,
          message: h.message,
        })),
      };
    } catch (e) {
      logger.debug('Sonarr collector failed', { error: String(e) });
      return null;
    }
  },

  // ---------- Prowlarr ----------
  async prowlarr() {
    const apiKey = process.env.PROWLARR_API_KEY;
    if (!apiKey) return null;
    const base = serviceUrl('prowlarr', 9696);
    const headers = { 'X-Api-Key': apiKey };

    try {
      const indexers = await fetchJson(`${base}/api/v1/indexer`, headers) as Array<Record<string, unknown>>;
      return {
        indexers: (indexers || []).map((idx: Record<string, unknown>) => ({
          name: idx.name,
          status: idx.enable ? 'healthy' : 'disabled',
        })),
        totalIndexers: (indexers || []).length,
      };
    } catch (e) {
      logger.debug('Prowlarr collector failed', { error: String(e) });
      return null;
    }
  },

  // ---------- Pi-hole ----------
  async pihole() {
    const apiKey = process.env.PIHOLE_API_KEY;
    const base = serviceUrl('pihole', 8053);

    try {
      const summary = await fetchJson(`${base}/admin/api.php?summaryRaw${apiKey ? '&auth=' + apiKey : ''}`) as Record<string, unknown>;
      return {
        queriesTotal: summary.dns_queries_today,
        queriesBlocked: summary.ads_blocked_today,
        blockPercent: parseFloat(String(summary.ads_percentage_today || 0)),
        status: summary.status,
        uniqueClients: summary.unique_clients,
      };
    } catch (e) {
      logger.debug('Pi-hole collector failed', { error: String(e) });
      return null;
    }
  },

  // ---------- Uptime Kuma ----------
  async uptimekuma() {
    // Uptime Kuma doesn't have a simple REST API -- it uses Socket.IO
    // We attempt the /api/status-page/default endpoint (if configured)
    const base = serviceUrl('uptime_kuma', 3001);
    try {
      const data = await fetchJson(`${base}/api/status-page/default`) as Record<string, unknown>;
      const monitors = (data?.publicGroupList as Array<Record<string, unknown>>) || [];
      const allMonitors: Array<Record<string, unknown>> = [];
      for (const group of monitors) {
        const list = (group.monitorList as Array<Record<string, unknown>>) || [];
        allMonitors.push(...list);
      }
      return {
        monitors: allMonitors.slice(0, 10).map((m: Record<string, unknown>) => ({
          name: m.name,
          status: m.active ? 'up' : 'down',
        })),
        totalMonitors: allMonitors.length,
      };
    } catch (e) {
      logger.debug('Uptime Kuma collector failed', { error: String(e) });
      return null;
    }
  },

  // ---------- Nextcloud ----------
  async nextcloud() {
    const user = process.env.NEXTCLOUD_USER;
    const pass = process.env.NEXTCLOUD_PASS;
    if (!user || !pass) return null;
    const base = serviceUrl('nextcloud', 8888);
    const auth = Buffer.from(`${user}:${pass}`).toString('base64');
    const headers = { 'Authorization': `Basic ${auth}`, 'OCS-APIREQUEST': 'true' };

    try {
      const data = await fetchJson(`${base}/ocs/v2.php/cloud/server?format=json`, headers) as Record<string, unknown>;
      return {
        serverInfo: data,
      };
    } catch (e) {
      logger.debug('Nextcloud collector failed', { error: String(e) });
      return null;
    }
  },

  // ---------- Paperless-ngx ----------
  async paperless() {
    const apiKey = process.env.PAPERLESS_API_KEY;
    if (!apiKey) return null;
    const base = serviceUrl('paperless', 8010);
    const headers = { 'Authorization': `Token ${apiKey}` };

    try {
      const docs = await fetchJson(`${base}/api/documents/?page_size=5&ordering=-created`, headers) as Record<string, unknown>;
      return {
        documentsTotal: (docs as Record<string, unknown>)?.count || 0,
        recentDocuments: (((docs as Record<string, unknown>)?.results as Array<Record<string, unknown>>) || []).slice(0, 5).map((d: Record<string, unknown>) => ({
          title: d.title,
        })),
      };
    } catch (e) {
      logger.debug('Paperless collector failed', { error: String(e) });
      return null;
    }
  },
};

// ============================================================================
// Public API
// ============================================================================

// ============================================================================
// Name Normalization — matches Docker container names to collector keys
// ============================================================================

const nameAliases: Record<string, string> = {
  uptime_kuma: 'uptimekuma',
  'uptime-kuma': 'uptimekuma',
  pihole: 'pihole',
  'pi-hole': 'pihole',
  'paperless-ngx': 'paperless',
  'paperless_ngx': 'paperless',
};

function normalizeServiceName(name: string): string {
  const lower = name.toLowerCase().trim();
  return nameAliases[lower] || lower.replace(/[-_]/g, '');
}

// Map of which env vars each collector needs (for helpful error messages)
const requiredEnvVars: Record<string, string[]> = {
  jellyfin: ['JELLYFIN_API_KEY'],
  radarr: ['RADARR_API_KEY'],
  sonarr: ['SONARR_API_KEY'],
  prowlarr: ['PROWLARR_API_KEY'],
  pihole: [],  // works without key (limited)
  uptimekuma: [],  // no key needed
  nextcloud: ['NEXTCLOUD_USER', 'NEXTCLOUD_PASS'],
  paperless: ['PAPERLESS_API_KEY'],
};

/**
 * Collect detailed data for a specific service.
 * Returns cached data if fresh, otherwise queries the service API.
 * Returns null if no collector exists or the API is unavailable.
 */
export async function collectServiceDetail(serviceName: string): Promise<Record<string, unknown> | null> {
  const normalized = normalizeServiceName(serviceName);
  const cached = getCached(normalized);
  if (cached) return cached;

  const collector = collectors[normalized];
  if (!collector) {
    // No dedicated collector -- return basic info from container
    return null;
  }

  try {
    const data = await collector();
    if (data) {
      setCache(normalized, data);
    }
    return data;
  } catch (error) {
    logger.debug(`Collector failed for ${serviceName}`, { error: String(error) });
    return null;
  }
}

/**
 * Get the required env vars for a service collector (for UI hints).
 */
export function getRequiredEnvVars(serviceName: string): string[] {
  const normalized = normalizeServiceName(serviceName);
  return requiredEnvVars[normalized] || [];
}

/**
 * Get list of services that have collectors available.
 */
export function getAvailableCollectors(): string[] {
  return Object.keys(collectors);
}
