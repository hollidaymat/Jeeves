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

      return {
        activeStreams: activeSessions.length,
        transcoding,
        libraries: folders.map((f: Record<string, unknown>) => f.Name),
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

      return {
        queue: records.slice(0, 5).map((r: Record<string, unknown>) => ({
          title: r.title,
          status: r.status,
          progress: r.size ? Math.round((1 - (r.sizeleft as number) / (r.size as number)) * 100) : 0,
        })),
        monitored,
        totalArtists: artistsArr.length,
        health: (health || []).slice(0, 3).map((h: Record<string, unknown>) => ({
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

      return {
        version: (systemStatus as Record<string, unknown>)?.data || 'unknown',
        wantedMovies: wantedMoviesList.length,
        wantedEpisodes: wantedSeriesList.length,
        recentWanted: [...wantedMoviesList, ...wantedSeriesList].slice(0, 5).map((w: Record<string, unknown>) => ({
          title: w.title || w.seriesTitle,
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

      return {
        version: (status as Record<string, unknown>)?.version || 'unknown',
        totalRequests: ((requests as Record<string, unknown>)?.pageInfo as Record<string, unknown>)?.results || 0,
        recentRequests: requestList.slice(0, 5).map((r: Record<string, unknown>) => ({
          title: ((r.media as Record<string, unknown>)?.title as string) || 'Unknown',
          type: r.type,
          status: r.status === 2 ? 'approved' : r.status === 3 ? 'declined' : 'pending',
        })),
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
        streams: sessions.map((s: Record<string, unknown>) => ({
          user: s.friendly_name,
          title: s.full_title,
          player: s.player,
          quality: s.quality_profile,
        })),
        recentHistory: historyList.slice(0, 5).map((h: Record<string, unknown>) => ({
          title: h.full_title,
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

      return {
        status: (health as Record<string, unknown>)?.database || 'unknown',
        version: (health as Record<string, unknown>)?.version,
        dashboards: (dashboards || []).slice(0, 10).map((d: Record<string, unknown>) => ({
          title: d.title,
          url: d.url,
        })),
        activeAlerts: (alerts || []).length,
        alerts: (alerts || []).slice(0, 5).map((a: Record<string, unknown>) => ({
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
      return {
        torrents: status.torrents.length,
        downloading: status.torrents.filter((t: { state: string }) => t.state === 'downloading').length,
        dlSpeed: transfer ? Math.round(transfer.dl_info_speed / 1024) : 0,
        upSpeed: transfer ? Math.round(transfer.up_info_speed / 1024) : 0,
        dlTotal: transfer ? Math.round(transfer.dl_info_data / 1e9) : 0,
        upTotal: transfer ? Math.round(transfer.up_info_data / 1e9) : 0,
        queue: status.torrents.slice(0, 5).map((t: { name: string; progress: number; state: string }) => ({
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
      return {
        entities: (states || []).length,
        lights: lights.length,
        sensors: sensors.length,
        onLights: lights.filter((s: Record<string, unknown>) => s.state === 'on').length,
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
      const [routers, services] = await Promise.all([
        fetchJson(`${base}/api/http/routers`) as Promise<Record<string, unknown>>,
        fetchJson(`${base}/api/http/services`) as Promise<Record<string, unknown>>,
      ]);
      const routerList = (routers && typeof routers === 'object' && !Array.isArray(routers)) ? Object.keys(routers) : [];
      const serviceList = (services && typeof services === 'object' && !Array.isArray(services)) ? Object.keys(services) : [];
      return { routers: routerList.length, services: serviceList.length, routerNames: routerList.slice(0, 10) };
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
    try {
      const [endpoints, stacks] = await Promise.all([
        fetchJson(`${base}/api/endpoints`, { 'X-API-Key': apiKey }) as Promise<Array<Record<string, unknown>>>,
        fetchJson(`${base}/api/stacks`, { 'X-API-Key': apiKey }) as Promise<Array<Record<string, unknown>>>,
      ]);
      return {
        endpoints: (endpoints || []).length,
        stacks: (stacks || []).length,
        stackNames: (stacks || []).slice(0, 10).map((s: Record<string, unknown>) => s.Name),
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
      return {
        downloadRate: result.DownloadRate,
        downloadLimit: result.DownloadLimit,
        queue: result.QueueFiles ?? 0,
        postQueue: result.PostQueueBytes ?? 0,
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
      const res = await fetch(`${base}/admin/stats`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as Record<string, unknown>;
      return {
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
      const data = (await res.json()) as { data?: { result?: Array<{ value?: [string, string] }> } };
      const result = data?.data?.result ?? [];
      const targets = result.length;
      const up = result.filter((r) => r.value?.[1] === '1').length;
      return { targets, up, status: targets > 0 && up === targets ? 'ok' : 'degraded' };
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
      const nodeBootTime = text.match(/node_boot_time_seconds (\d+)/);
      return { up: true, metrics: 'available', nodeBootTime: nodeBootTime ? Number(nodeBootTime[1]) : undefined };
    } catch (e) {
      logger.debug('Node exporter collector failed', { error: String(e) });
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
  nextcloud: ['NEXTCLOUD_USER', 'NEXTCLOUD_PASS'],
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
