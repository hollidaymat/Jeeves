/**
 * Service Detail Collectors
 * 
 * Queries individual service APIs (Jellyfin, Radarr, Sonarr, Pi-hole, etc.)
 * for deep-dive dashboard data. Each collector is self-contained and gracefully
 * returns null if the service API is unavailable or unconfigured.
 * 
 * Results are cached for 30 seconds to avoid hammering service APIs.
 */

import http from 'node:http';
import https from 'node:https';
import { logger } from '../../utils/logger.js';
import { formatBytes, formatSpeed, formatTimestampAgo } from '../utils/format.js';

const insecureHttpsAgent = new https.Agent({ rejectUnauthorized: false });

async function fetchInsecure(url: string, opts: { method?: string; body?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; headers: Map<string, string>; json: () => Promise<unknown> }> {
  const u = new URL(url);
  const isHttps = u.protocol === 'https:';
  const agent = isHttps ? insecureHttpsAgent : undefined;
  return new Promise((resolve, reject) => {
    const req = (isHttps ? https : http).request(url, { method: opts.method || 'GET', headers: opts.headers, agent }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        const headers = new Map<string, string>();
        for (const [k, v] of Object.entries(res.headers)) {
          const val = Array.isArray(v) ? v[0] : v;
          if (val && typeof val === 'string') headers.set(k.toLowerCase(), val);
        }
        resolve({
          status: res.statusCode ?? 0,
          headers,
          json: () => Promise.resolve(JSON.parse(raw || '{}')),
        });
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

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
    let apiKey = process.env.JELLYFIN_API_KEY;
    const base = serviceUrl('jellyfin', 8096);

    // Fallback: authenticate with user/pass if no API key
    if (!apiKey) {
      const user = process.env.JELLYFIN_USER;
      const pass = process.env.JELLYFIN_PASS;
      if (!user || !pass) return null;

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const authRes = await fetch(`${base}/Users/AuthenticateByName`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Emby-Authorization': 'MediaBrowser Client="Jeeves", Device="Homelab", DeviceId="jeeves-collector", Version="1.0"',
          },
          body: JSON.stringify({ Username: user, Pw: pass }),
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (!authRes.ok) return null;
        const authData = await authRes.json() as Record<string, unknown>;
        apiKey = authData.AccessToken as string;
      } catch (e) {
        logger.debug('Jellyfin auth failed', { error: String(e) });
        return null;
      }
    }

    const headers = { 'X-Emby-Token': apiKey };

    try {
      const [sessions, library, recent] = await Promise.all([
        fetchJson(`${base}/Sessions`, headers) as Promise<Array<Record<string, unknown>>>,
        fetchJson(`${base}/Library/MediaFolders`, headers) as Promise<Record<string, unknown>>,
        fetchJson(`${base}/Items/Latest?limit=5`, headers) as Promise<Array<Record<string, unknown>>>,
      ]);

      const activeSessions = (sessions || []).filter((s: Record<string, unknown>) => s.NowPlayingItem);
      const transcoding = activeSessions.some((s: Record<string, unknown>) => s.TranscodingInfo);
      const folders = ((library as Record<string, unknown>)?.Items as Array<Record<string, unknown>>) || [];
      const librarySummary = folders.length
        ? folders.map((f: Record<string, unknown>) => `${f.Name as string}${f.CollectionType ? ` (${f.CollectionType})` : ''}`).join(', ')
        : 'No libraries';
      const activeStreamsList = activeSessions.slice(0, 10).map((s: Record<string, unknown>) => {
        const user = (s.UserName as string) || '?';
        const item = s.NowPlayingItem as Record<string, unknown> | undefined;
        const name = item?.Name as string | undefined;
        const device = (s.DeviceName as string) || '?';
        return { title: `${user} · ${name || 'Playing'} · ${device}` };
      });

      return {
        summary: `${activeSessions.length} active stream(s)${transcoding ? ', 1 transcoding' : ''}`,
        activeStreams: activeSessions.length,
        transcoding,
        activeStreamsList,
        libraries: folders.map((f: Record<string, unknown>) => f.Name),
        librarySummary,
        recentlyAdded: (recent || []).slice(0, 5).map((item: Record<string, unknown>) => ({
          title: `${item.Name as string} (${item.Type as string})`,
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
        summary: `${moviesArr.length} movies, ${monitored} monitored, ${missing} missing`,
        queue: records.slice(0, 5).map((r: Record<string, unknown>) => ({
          title: r.title,
          status: r.status,
          progress: r.size ? Math.round((1 - (r.sizeleft as number) / (r.size as number)) * 100) : 0,
        })),
        monitored,
        missing,
        diskSpace: (disk || []).map((d: Record<string, unknown>) => `${Math.round((d.freeSpace as number) / 1e9)}GB free`).join(', '),
        health: (health || []).slice(0, 3).map((h: Record<string, unknown>) => ({
          title: `${h.type as string}: ${h.message as string}`,
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
      const missing = seriesArr.filter((s: Record<string, unknown>) => s.monitored && !(s as Record<string, boolean>).hasFile).length;

      return {
        summary: `${seriesArr.length} series, ${monitored} monitored${missing > 0 ? `, ${missing} missing` : ''}`,
        missing,
        queue: records.slice(0, 5).map((r: Record<string, unknown>) => ({
          title: r.title,
          status: r.status,
          progress: r.size ? Math.round((1 - (r.sizeleft as number) / (r.size as number)) * 100) : 0,
        })),
        monitored,
        totalSeries: seriesArr.length,
        health: (health || []).slice(0, 3).map((h: Record<string, unknown>) => ({
          title: `${h.type as string}: ${h.message as string}`,
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
      const indexers = (await fetchJson(`${base}/api/v1/indexer`, headers)) as Array<Record<string, unknown>>;
      const list = indexers || [];
      const enabled = list.filter((idx: Record<string, unknown>) => idx.enable).length;
      return {
        summary: `${list.length} indexers, ${enabled} enabled`,
        indexers: list.map((idx: Record<string, unknown>) => {
          const name = (idx.name as string) || '?';
          const status = idx.enable ? 'healthy' : 'disabled';
          return { name, title: `${name} · ${status}`, status };
        }),
        totalIndexers: list.length,
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
      const authSuffix = apiKey ? '&auth=' + apiKey : '';
      const [summary, topBlockedData, topClientsData] = await Promise.all([
        fetchJson(`${base}/admin/api.php?summaryRaw${authSuffix}`) as Promise<Record<string, unknown>>,
        apiKey ? fetchJson(`${base}/admin/api.php?topItems=3${authSuffix}`).catch(() => null) as Promise<Record<string, unknown> | null> : Promise.resolve(null),
        apiKey ? fetchJson(`${base}/admin/api.php?getQuerySources=3${authSuffix}`).catch(() => null) as Promise<Record<string, unknown> | null> : Promise.resolve(null),
      ]);
      const blockPct = parseFloat(String(summary.ads_percentage_today || 0));
      const topAds = topBlockedData && typeof topBlockedData.top_ads === 'object' ? (topBlockedData.top_ads as Record<string, number>) : {};
      const topSources = topClientsData && typeof topClientsData.top_sources === 'object' ? (topClientsData.top_sources as Record<string, number>) : {};
      const topBlockedEntry = Object.entries(topAds)[0];
      const topClientEntry = Object.entries(topSources)[0];
      return {
        queriesTotal: summary.dns_queries_today,
        queriesBlocked: summary.ads_blocked_today,
        blockPercent: blockPct,
        blockPercentFormatted: `${blockPct.toFixed(1)}%`,
        status: summary.status,
        uniqueClients: summary.unique_clients,
        topBlockedDomain: topBlockedEntry ? `${topBlockedEntry[0]} (${topBlockedEntry[1]})` : undefined,
        topClient: topClientEntry ? `${topClientEntry[0]} (${topClientEntry[1]} queries)` : undefined,
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
      const statusStr = (active: boolean) => active ? 'up' : 'down';
      return {
        monitors: allMonitors.slice(0, 10).map((m: Record<string, unknown>) => {
          const name = (m.name as string) || '?';
          const status = statusStr(m.active as boolean);
          return { name, title: `${name} · ${status}`, status };
        }),
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
    const base = process.env.NEXTCLOUD_URL?.replace(/\/$/, '') || '';
    if (!user || !pass || !base) return null;
    const auth = Buffer.from(`${user}:${pass}`).toString('base64');
    const headers = { 'Authorization': `Basic ${auth}`, 'OCS-APIRequest': 'true', 'Accept': 'application/json' };

    try {
      const data = await fetchJson(`${base}/ocs/v1.php/cloud/users/${user}?format=json`, headers) as Record<string, unknown>;
      const quota = (data as Record<string, Record<string, Record<string, Record<string, number>>>>).ocs?.data?.quota;
      if (!quota) return null;
      const used = quota.used ?? 0;
      const total = quota.total ?? 0;
      const usedFormatted = formatBytes(used);
      const totalFormatted = total > 0 ? formatBytes(total) : 'unlimited';
      const quotaPercent = total > 0 ? Math.round((used / total) * 100) : 0;
      const storageSummary = total > 0
        ? `${usedFormatted} / ${totalFormatted} (${quotaPercent}%)`
        : `${usedFormatted} used`;
      return {
        serverInfo: { quota },
        used,
        total,
        usedFormatted,
        totalFormatted,
        quotaPercent: total > 0 ? quotaPercent : undefined,
        storageSummary,
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
      const total = (docs as Record<string, unknown>)?.count as number || 0;
      const results = ((docs as Record<string, unknown>)?.results as Array<Record<string, unknown>>) || [];
      return {
        summary: `${total} documents`,
        documentsTotal: total,
        recentDocuments: results.slice(0, 5).map((d: Record<string, unknown>) => ({
          title: (d.title as string) || 'Untitled',
        })),
      };
    } catch (e) {
      logger.debug('Paperless collector failed', { error: String(e) });
      return null;
    }
  },

  // ---------- Lidarr ----------
  async lidarr() {
    const apiKey = process.env.LIDARR_API_KEY;
    if (!apiKey) return null;
    const base = serviceUrl('lidarr', 8686);
    const headers = { 'X-Api-Key': apiKey };

    try {
      const [queue, artists, health] = await Promise.all([
        fetchJson(`${base}/api/v1/queue?page=1&pageSize=10`, headers) as Promise<Record<string, unknown>>,
        fetchJson(`${base}/api/v1/artist`, headers) as Promise<Array<Record<string, unknown>>>,
        fetchJson(`${base}/api/v1/health`, headers) as Promise<Array<Record<string, unknown>>>,
      ]);

      const records = ((queue as Record<string, unknown>)?.records as Array<Record<string, unknown>>) || [];
      const artistsArr = artists || [];
      const monitored = artistsArr.filter((a: Record<string, unknown>) => a.monitored).length;
      const missing = artistsArr.filter((a: Record<string, unknown>) => a.monitored && !(a as Record<string, boolean>).hasFile).length;

      return {
        summary: `${artistsArr.length} artists, ${monitored} monitored${missing > 0 ? `, ${missing} missing` : ''}`,
        missing,
        queue: records.slice(0, 5).map((r: Record<string, unknown>) => ({
          title: r.title,
          status: r.status,
          progress: r.size ? Math.round((1 - (r.sizeleft as number) / (r.size as number)) * 100) : 0,
        })),
        monitored,
        totalArtists: artistsArr.length,
        health: (health || []).slice(0, 3).map((h: Record<string, unknown>) => ({
          title: `${h.type as string}: ${h.message as string}`,
          type: h.type,
          message: h.message,
        })),
      };
    } catch (e) {
      logger.debug('Lidarr collector failed', { error: String(e) });
      return null;
    }
  },

  // ---------- Bazarr ----------
  async bazarr() {
    const apiKey = process.env.BAZARR_API_KEY;
    if (!apiKey) return null;
    const base = serviceUrl('bazarr', 6767);
    const headers = { 'X-API-KEY': apiKey };

    try {
      const [systemStatus, wantedMovies, wantedSeries] = await Promise.all([
        fetchJson(`${base}/api/system/status`, headers) as Promise<Record<string, unknown>>,
        fetchJson(`${base}/api/movies/wanted?length=5`, headers) as Promise<Record<string, unknown>>,
        fetchJson(`${base}/api/episodes/wanted?length=5`, headers) as Promise<Record<string, unknown>>,
      ]);

      const wantedMoviesList = ((wantedMovies as Record<string, unknown>)?.data as Array<Record<string, unknown>>) || [];
      const wantedSeriesList = ((wantedSeries as Record<string, unknown>)?.data as Array<Record<string, unknown>>) || [];

      const wantedMoviesCount = wantedMoviesList.length;
      const wantedEpisodesCount = wantedSeriesList.length;
      return {
        summary: `${wantedMoviesCount} movie subs, ${wantedEpisodesCount} episode subs wanted`,
        version: (systemStatus as Record<string, unknown>)?.data || 'unknown',
        wantedMovies: wantedMoviesCount,
        wantedEpisodes: wantedEpisodesCount,
        recentWanted: [...wantedMoviesList, ...wantedSeriesList].slice(0, 5).map((w: Record<string, unknown>) => ({
          title: (w.title as string) || (w.seriesTitle as string) || '?',
          missing: w.missing_subtitles,
        })),
      };
    } catch (e) {
      logger.debug('Bazarr collector failed', { error: String(e) });
      return null;
    }
  },

  // ---------- Overseerr / Jellyseerr ----------
  async overseerr() {
    const apiKey = process.env.OVERSEERR_API_KEY;
    if (!apiKey) return null;
    const base = serviceUrl('overseerr', 5055);
    const headers = { 'X-Api-Key': apiKey };

    try {
      const [status, requests] = await Promise.all([
        fetchJson(`${base}/api/v1/status`, headers) as Promise<Record<string, unknown>>,
        fetchJson(`${base}/api/v1/request?take=5&sort=added&order=desc`, headers) as Promise<Record<string, unknown>>,
      ]);

      const requestList = ((requests as Record<string, unknown>)?.results as Array<Record<string, unknown>>) || [];
      const totalRequests = ((requests as Record<string, unknown>)?.pageInfo as Record<string, unknown>)?.results as number || 0;
      const statusLabel = (s: number) => s === 2 ? 'approved' : s === 3 ? 'declined' : 'pending';

      return {
        summary: `${totalRequests} total requests`,
        version: (status as Record<string, unknown>)?.version || 'unknown',
        totalRequests,
        recentRequests: requestList.slice(0, 5).map((r: Record<string, unknown>) => {
          const title = ((r.media as Record<string, unknown>)?.title as string) || 'Unknown';
          const type = (r.type as string) || '?';
          const status = statusLabel((r.status as number) ?? 0);
          return { title: `${title} · ${type} · ${status}`, type, status };
        }),
      };
    } catch (e) {
      logger.debug('Overseerr collector failed', { error: String(e) });
      return null;
    }
  },

  // ---------- Tautulli ----------
  async tautulli() {
    const apiKey = process.env.TAUTULLI_API_KEY;
    if (!apiKey) return null;
    const base = serviceUrl('tautulli', 8181);

    try {
      const [activity, history] = await Promise.all([
        fetchJson(`${base}/api/v2?apikey=${apiKey}&cmd=get_activity`) as Promise<Record<string, unknown>>,
        fetchJson(`${base}/api/v2?apikey=${apiKey}&cmd=get_history&length=5`) as Promise<Record<string, unknown>>,
      ]);

      const activityData = (activity as Record<string, unknown>)?.response as Record<string, unknown>;
      const historyData = (history as Record<string, unknown>)?.response as Record<string, unknown>;
      const sessions = ((activityData as Record<string, unknown>)?.data as Record<string, unknown>)?.sessions as Array<Record<string, unknown>> || [];
      const historyList = ((historyData as Record<string, unknown>)?.data as Record<string, unknown>)?.data as Array<Record<string, unknown>> || [];

      return {
        activeStreams: sessions.length,
        streams: sessions.map((s: Record<string, unknown>) => {
          const user = (s.friendly_name as string) || '?';
          const fullTitle = (s.full_title as string) || '?';
          const quality = (s.quality_profile as string) || '';
          return {
            title: `${user} — ${fullTitle}${quality ? ` (${quality})` : ''}`,
            user: s.friendly_name,
            fullTitle: s.full_title,
            player: s.player,
            quality: s.quality_profile,
          };
        }),
        recentHistory: historyList.slice(0, 5).map((h: Record<string, unknown>) => ({
          title: `${h.full_title as string} · ${h.friendly_name as string} · ${h.date as string}`,
          user: h.friendly_name,
          watchedAt: h.date,
        })),
      };
    } catch (e) {
      logger.debug('Tautulli collector failed', { error: String(e) });
      return null;
    }
  },

  // ---------- Grafana ----------
  async grafana() {
    const apiKey = process.env.GRAFANA_API_KEY;
    const user = process.env.GRAFANA_USER;
    const pass = process.env.GRAFANA_PASS;
    const base = serviceUrl('grafana', 3000);

    let headers: Record<string, string> = {};
    if (apiKey) {
      headers = { 'Authorization': `Bearer ${apiKey}` };
    } else if (user && pass) {
      headers = { 'Authorization': `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` };
    } else {
      return null;
    }

    try {
      const [health, dashboards, alerts] = await Promise.all([
        fetchJson(`${base}/api/health`, headers) as Promise<Record<string, unknown>>,
        fetchJson(`${base}/api/search?type=dash-db&limit=10`, headers) as Promise<Array<Record<string, unknown>>>,
        fetchJson(`${base}/api/alerts?state=alerting`, headers) as Promise<Array<Record<string, unknown>>>,
      ]);

      const dashCount = (dashboards || []).length;
      const alertingCount = (alerts || []).length;
      return {
        summary: `${dashCount} dashboards, ${alertingCount} alerting`,
        status: (health as Record<string, unknown>)?.database || 'unknown',
        version: (health as Record<string, unknown>)?.version,
        dashboards: (dashboards || []).slice(0, 10).map((d: Record<string, unknown>) => ({
          title: d.title,
          url: d.url,
        })),
        activeAlerts: alertingCount,
        alerts: (alerts || []).slice(0, 5).map((a: Record<string, unknown>) => ({
          title: (a.name as string) || 'Alert',
          name: a.name,
          state: a.state,
        })),
      };
    } catch (e) {
      logger.debug('Grafana collector failed', { error: String(e) });
      return null;
    }
  },

  // ---------- qBittorrent ----------
  async qbittorrent() {
    try {
      const { getQbittorrentStatus } = await import('../integrations/qbittorrent.js');
      const status = await getQbittorrentStatus();
      if (!status.success || !status.torrents) return null;
      const transfer = status.transfer;
      const torrents = status.torrents.length;
      const downloading = status.torrents.filter((t: { state: string }) => t.state === 'downloading').length;
      const dlSpeedFormatted = transfer ? formatSpeed(transfer.dl_info_speed) : '0 B/s';
      const upSpeedFormatted = transfer ? formatSpeed(transfer.up_info_speed) : '0 B/s';
      const dlTotalFormatted = transfer ? formatBytes(transfer.dl_info_data) : '0 B';
      const upTotalFormatted = transfer ? formatBytes(transfer.up_info_data) : '0 B';
      return {
        summary: `${torrents} torrents, ${downloading} downloading`,
        torrents,
        downloading,
        dlSpeedFormatted,
        upSpeedFormatted,
        dlTotalFormatted,
        upTotalFormatted,
        queue: status.torrents.slice(0, 5).map((t: { name: string; progress: number; state: string }) => ({
          title: t.name,
          name: t.name,
          progress: Math.round((t.progress || 0) * 100),
          state: t.state,
        })),
      };
    } catch (e) {
      logger.debug('qBittorrent collector failed', { error: String(e) });
      return null;
    }
  },

  // ---------- Home Assistant ----------
  async homeassistant() {
    const token = process.env.HA_TOKEN || process.env.HOME_ASSISTANT_TOKEN;
    if (!token) return null;
    const base = serviceUrl('homeassistant', 8123).replace(/^http/, 'http');
    const url = process.env.HA_URL || `http://localhost:8123`;
    try {
      const res = await fetch(`${url}/api/states`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return null;
      const states = (await res.json()) as Array<Record<string, unknown>>;
      const lights = (states || []).filter((s: Record<string, unknown>) => String(s.entity_id).startsWith('light.'));
      const sensors = (states || []).filter((s: Record<string, unknown>) => String(s.entity_id).startsWith('sensor.'));
      const onLights = lights.filter((s: Record<string, unknown>) => s.state === 'on').length;
      const entities = (states || []).length;
      return {
        summary: `${entities} entities, ${lights.length} lights (${onLights} on)`,
        entities,
        lights: lights.length,
        sensors: sensors.length,
        onLights,
      };
    } catch (e) {
      logger.debug('Home Assistant collector failed', { error: String(e) });
      return null;
    }
  },

  // ---------- Gluetun (VPN) — no API, minimal status ----------
  async gluetun() {
    return { status: 'running', note: 'VPN tunnel; use dashboard or docker exec for exit IP' };
  },

  // ---------- Traefik ----------
  async traefik() {
    const base = process.env.TRAEFIK_URL || serviceUrl('traefik', 8080);
    try {
      const [routersResp, services] = await Promise.all([
        fetchJson(`${base}/api/http/routers`) as Promise<Record<string, unknown>>,
        fetchJson(`${base}/api/http/services`) as Promise<Record<string, unknown>>,
      ]);
      const serviceList = (services && typeof services === 'object' && !Array.isArray(services)) ? Object.keys(services) : [];
      const routerEntries = (routersResp && typeof routersResp === 'object' && !Array.isArray(routersResp))
        ? Object.entries(routersResp as Record<string, Record<string, unknown>>)
        : [];
      const routerList = routerEntries.map(([name, config]) => {
        const rule = (config?.rule as string) || '';
        const service = (config?.service as string) || '?';
        const title = rule ? `${rule} → ${service}` : `${name} → ${service}`;
        return { title, rule, service, name };
      });
      return {
        routers: routerList.length,
        services: serviceList.length,
        routerList: routerList.slice(0, 30),
      };
    } catch (e) {
      logger.debug('Traefik collector failed', { error: String(e) });
      return null;
    }
  },

  // ---------- Portainer ----------
  async portainer() {
    const apiKey = process.env.PORTAINER_API_KEY;
    if (!apiKey) return null;
    const base = (process.env.PORTAINER_URL || serviceUrl('portainer', 9000)).replace(/\/$/, '');
    const headers = { 'X-API-Key': apiKey };
    try {
      const [endpoints, stacks] = await Promise.all([
        fetchJson(`${base}/api/endpoints`, headers) as Promise<Array<Record<string, unknown>>>,
        fetchJson(`${base}/api/stacks`, headers) as Promise<Array<Record<string, unknown>>>,
      ]);
      const endpointList = endpoints || [];
      const stackList = stacks || [];
      const firstEndpointId = (endpointList[0] as Record<string, unknown>)?.Id as number | undefined;
      let containers: Array<{ name: string; state: string; status: string; image: string; title: string }> = [];
      if (firstEndpointId != null) {
        try {
          const raw = await fetchJson(
            `${base}/api/endpoints/${firstEndpointId}/docker/containers/json?all=true`,
            headers
          ) as Array<Record<string, unknown>>;
          containers = (raw || []).map((c: Record<string, unknown>) => {
            const names = c.Names as string[] | undefined;
            const name = String(names?.[0] || c.Id || '').replace(/^\//, '');
            const state = String(c.State || 'unknown');
            const status = String(c.Status || '-');
            const image = String(c.Image || (c as Record<string, string>).ImageID?.slice(0, 12) || '-');
            return {
              name,
              state,
              status,
              image,
              title: `${name} · ${state}`,
            };
          }).sort((a, b) => a.name.localeCompare(b.name));
        } catch (inner) {
          logger.debug('Portainer containers fetch failed', { error: String(inner) });
        }
      }
      const running = containers.filter((c) => c.state === 'running').length;
      return {
        summary: `${containers.length} containers, ${running} running`,
        endpoints: endpointList.length,
        stacks: stackList.length,
        stackNames: stackList.slice(0, 20).map((s: Record<string, unknown>) => s.Name),
        containers,
      };
    } catch (e) {
      logger.debug('Portainer collector failed', { error: String(e) });
      return null;
    }
  },

  // ---------- NZBGet ----------
  async nzbget() {
    const user = process.env.NZBGET_USER || 'nzbget';
    const pass = process.env.NZBGET_PASS || 'tegbzn6789';
    const base = (process.env.NZBGET_URL || serviceUrl('nzbget', 6789)).replace(/\/$/, '');
    try {
      const body = JSON.stringify({ method: 'status', params: [] });
      const res = await fetch(`${base}/jsonrpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as Record<string, unknown>;
      const result = data?.result as Record<string, unknown> | undefined;
      if (!result) return null;
      const queueFiles = Number(result.QueueFiles ?? 0);
      const postQueueBytes = Number(result.PostQueueBytes ?? 0);
      const downloadRate = Number(result.DownloadRate ?? 0);
      return {
        summary: `Queue: ${queueFiles} items, Speed: ${formatSpeed(downloadRate)}`,
        downloadRate,
        downloadLimit: result.DownloadLimit,
        queue: queueFiles,
        postQueue: postQueueBytes,
        downloadRateFormatted: formatSpeed(downloadRate),
        queueFormatted: `${queueFiles} items`,
        postQueueFormatted: formatBytes(postQueueBytes),
      };
    } catch (e) {
      logger.debug('NZBGet collector failed', { error: String(e) });
      return null;
    }
  },

  // ---------- Vaultwarden ----------
  async vaultwarden() {
    const token = process.env.VAULTWARDEN_ADMIN_TOKEN;
    if (!token) return null;
    const base = (process.env.VAULTWARDEN_URL || serviceUrl('vaultwarden', 80)).replace(/\/$/, '');
    try {
      const loginRes = await fetchInsecure(`${base}/admin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `token=${encodeURIComponent(token)}`,
      });
      if (loginRes.status !== 302 && loginRes.status !== 200) return null;
      const setCookie = loginRes.headers.get('set-cookie');
      if (!setCookie) return null;
      const cookie = setCookie.split(';')[0];
      const statsRes = await fetchInsecure(`${base}/admin/stats`, { headers: { Cookie: cookie } });
      if (statsRes.status < 200 || statsRes.status >= 300) return null;
      const data = (await statsRes.json()) as Record<string, unknown>;
      const users = Number(data?.users ?? 0);
      const activeUsers = Number(data?.active_users ?? 0);
      const items = Number(data?.items ?? 0);
      return {
        summary: `${users} users, ${activeUsers} active, ${items} items`,
        users: data?.users,
        activeUsers: data?.active_users,
        items: data?.items,
      };
    } catch (e) {
      logger.debug('Vaultwarden collector failed', { error: String(e) });
      return null;
    }
  },

  // ---------- Prometheus ----------
  async prometheus() {
    const base = (process.env.PROMETHEUS_URL || serviceUrl('prometheus', 9090)).replace(/\/$/, '');
    try {
      const res = await fetch(`${base}/api/v1/query?query=up`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;
      const data = (await res.json()) as { data?: { result?: Array<{ metric?: Record<string, string>; value?: [string, string] }> } };
      const result = data?.data?.result ?? [];
      const targets = result.length;
      const up = result.filter((r) => r.value?.[1] === '1').length;
      const downTargets = result
        .filter((r) => r.value?.[1] !== '1')
        .map((r) => {
          const m = r.metric || {};
          const job = m.job || '?';
          const instance = m.instance || '?';
          return { title: `${job}/${instance}`, ...m };
        })
        .slice(0, 20);
      return {
        targets,
        up,
        status: targets > 0 && up === targets ? 'ok' : 'degraded',
        downTargets: downTargets.length > 0 ? downTargets : undefined,
      };
    } catch (e) {
      logger.debug('Prometheus collector failed', { error: String(e) });
      return null;
    }
  },

  // ---------- Node Exporter ----------
  async nodeexporter() {
    const base = process.env.NODE_EXPORTER_URL || serviceUrl('nodeexporter', 9100);
    try {
      const res = await fetch(`${base}/metrics`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return null;
      const text = await res.text();
      const nodeBootTimeMatch = text.match(/node_boot_time_seconds (\d+)/);
      const nodeBootTime = nodeBootTimeMatch ? Number(nodeBootTimeMatch[1]) : undefined;
      return {
        up: true,
        metrics: 'available',
        nodeBootTime,
        bootTimeFormatted: nodeBootTime != null ? formatTimestampAgo(nodeBootTime) : undefined,
      };
    } catch (e) {
      logger.debug('Node exporter collector failed', { error: String(e) });
      return null;
    }
  },

  // ---------- Tailscale (system service, no API key) ----------
  async tailscale() {
    try {
      const { getTailscaleStatus } = await import('../integrations/tailscale.js');
      const status = await getTailscaleStatus();
      if (!status) return null;
      const onlineCount = status.devices.filter(d => d.online).length;
      const total = status.devices.length;
      return {
        summary: `${onlineCount}/${total} devices online`,
        connected: status.connected,
        selfIP: status.selfIP,
        networkName: status.networkName,
        devicesTotal: total,
        devicesOnline: onlineCount,
        devices: status.devices.map(d => ({
          title: `${d.name}${d.isSelf ? ' (self)' : ''} · ${d.ip ?? '?'} · ${d.online ? 'online' : 'offline'}`,
          name: d.name,
          ip: d.ip,
          online: d.online,
          os: d.os,
          isSelf: d.isSelf,
        })),
      };
    } catch (e) {
      logger.debug('Tailscale collector failed', { error: String(e) });
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
  jellyseerr: 'overseerr',
  'node_exporter': 'nodeexporter',
  'qbittorrent': 'qbittorrent',
  'home-assistant': 'homeassistant',
  homeassistant: 'homeassistant',
};

function normalizeServiceName(name: string): string {
  const lower = name.toLowerCase().trim();
  return nameAliases[lower] || lower.replace(/[-_]/g, '');
}

// Map of which env vars each collector needs (for helpful error messages)
const requiredEnvVars: Record<string, string[]> = {
  jellyfin: ['JELLYFIN_API_KEY or JELLYFIN_USER + JELLYFIN_PASS'],
  radarr: ['RADARR_API_KEY'],
  sonarr: ['SONARR_API_KEY'],
  prowlarr: ['PROWLARR_API_KEY'],
  lidarr: ['LIDARR_API_KEY'],
  bazarr: ['BAZARR_API_KEY'],
  overseerr: ['OVERSEERR_API_KEY'],
  tautulli: ['TAUTULLI_API_KEY'],
  grafana: ['GRAFANA_API_KEY or GRAFANA_USER + GRAFANA_PASS'],
  pihole: [],  // works without key (limited)
  uptimekuma: [],  // no key needed
  nextcloud: ['NEXTCLOUD_URL + NEXTCLOUD_USER + NEXTCLOUD_PASS'],
  paperless: ['PAPERLESS_API_KEY'],
  qbittorrent: ['QBITTORRENT_USER + QBITTORRENT_PASS'],  // URL has default
  homeassistant: ['HA_TOKEN or HOME_ASSISTANT_TOKEN'],
  gluetun: [],  // no API, minimal status only
  traefik: [],  // dashboard API often unauthenticated
  portainer: ['PORTAINER_API_KEY'],
  nzbget: [],   // defaults for user/pass/url
  vaultwarden: ['VAULTWARDEN_ADMIN_TOKEN'],
  prometheus: [],  // query API no auth
  nodeexporter: [],  // metrics endpoint
  tailscale: [],  // system service, no API key
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
    // No dedicated collector -- return basic info from container if we can find it
    try {
      const containerMon = await import('../docker/container-monitor.js');
      const list = await containerMon.listContainers();
      const norm = (s: string) => s.toLowerCase().replace(/[-_]/g, '');
      const match = list.find(
        (c) =>
          c.name === serviceName ||
          norm(c.name) === norm(serviceName) ||
          c.name === serviceName.replace(/_/g, '-')
      );
      if (match) {
        return {
          note: 'No Jeeves integration for this service',
          image: match.image,
          state: match.state,
          status: match.status,
        };
      }
    } catch {
      // ignore
    }
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

/** Whether a service has a collector and if so, whether API/env is configured */
export type CollectorConfigStatus = 'no_collector' | 'missing_api' | 'configured';

/** Check if env vars for a collector are set (for report: "needs API added"). */
export function getCollectorConfigStatus(serviceName: string): CollectorConfigStatus {
  const normalized = normalizeServiceName(serviceName);
  if (!collectors[normalized]) return 'no_collector';

  const hints = requiredEnvVars[normalized];
  if (!hints || hints.length === 0) return 'configured'; // pihole, uptimekuma

  // Single key e.g. RADARR_API_KEY
  for (const hint of hints) {
    if (hint.includes(' or ')) {
      const parts = hint.split(' or ');
      const ok = parts.some(p => {
        if (p.includes(' + ')) {
          const keys = p.split('+').map(k => k.trim());
          return keys.every(k => process.env[k]?.trim());
        }
        const key = p.trim();
        return !!process.env[key]?.trim();
      });
      if (ok) return 'configured';
    } else if (hint.includes(' + ')) {
      const keys = hint.split('+').map(k => k.trim());
      if (keys.every(k => process.env[k]?.trim())) return 'configured';
    } else if (process.env[hint]?.trim()) {
      return 'configured';
    }
  }
  return 'missing_api';
}

export function normalizeServiceNameForCollector(name: string): string {
  return normalizeServiceName(name);
}
