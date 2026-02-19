/**
 * qBittorrent Integration
 *
 * Connects to qBittorrent Web UI API for torrent management.
 * - List torrents and transfer stats
 * - Add torrents via magnet link or .torrent URL
 * - Pause/resume torrents
 *
 * Config via env: QBITTORRENT_URL, QBITTORRENT_USER, QBITTORRENT_PASS
 */

import { logger } from '../../utils/logger.js';

const DEFAULT_HOST = '192.168.7.50';
const DEFAULT_PORT = 8085;  // gluetun stack uses 8085 (Traefik uses 8080)
const BASE_URL = process.env.QBITTORRENT_URL || `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;
const USER = process.env.QBITTORRENT_USER || 'admin';
const PASS = process.env.QBITTORRENT_PASS || '';

let authCookie: string | null = null;

// ============================================================================
// Types
// ============================================================================

export interface QbittorrentTorrent {
  hash: string;
  name: string;
  size: number;
  progress: number;
  state: string;
  dlspeed: number;
  upspeed: number;
  eta: number;
  category?: string;
  num_seeds: number;
  num_leechs: number;
}

export interface QbittorrentTransferInfo {
  dl_info_speed: number;
  dl_info_data: number;
  up_info_speed: number;
  up_info_data: number;
  dl_rate_limit: number;
  up_rate_limit: number;
}

export interface QbittorrentStatus {
  success: boolean;
  message?: string;
  torrents?: QbittorrentTorrent[];
  transfer?: QbittorrentTransferInfo;
}

export interface QbittorrentAddResult {
  success: boolean;
  message: string;
}

// ============================================================================
// Auth
// ============================================================================

async function ensureLogin(): Promise<boolean> {
  if (authCookie) return true;

  try {
    const res = await fetch(`${BASE_URL}/api/v2/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: BASE_URL,
      },
      body: new URLSearchParams({ username: USER, password: PASS }),
      signal: AbortSignal.timeout(10_000),
    });

    const body = await res.text();

    if (res.status === 403) {
      logger.warn('[qbittorrent] Login failed: IP may be banned');
      return false;
    }

    if (body.trim() === 'Fails.') {
      logger.warn(
        '[qbittorrent] Invalid username or password. Set QBITTORRENT_USER/QBITTORRENT_PASS in .env to match Web UI (Tools → Options → Web UI). After a container restart, use the temp password from container logs and set a permanent password in the UI.'
      );
      return false;
    }

    // getSetCookie() returns all Set-Cookie headers; get('set-cookie') only the first
    const setCookies = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie')].filter(Boolean) as string[];
    for (const setCookie of setCookies) {
      if (setCookie && setCookie.includes('SID=')) {
        const match = setCookie.match(/SID=([^;]+)/);
        if (match) {
          authCookie = match[1];
          break;
        }
      }
    }

    if (!authCookie) {
      logger.warn('[qbittorrent] Login response had no SID cookie', { body: body.trim() || String(res.status) });
      return false;
    }

    logger.debug('[qbittorrent] Logged in');
    return true;
  } catch (error) {
    logger.debug('[qbittorrent] Login failed', { error: String(error) });
    return false;
  }
}

function getAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Referer: BASE_URL,
    Accept: 'application/json',
  };
  if (authCookie) {
    headers['Cookie'] = `SID=${authCookie}`;
  }
  return headers;
}

async function apiGet<T>(endpoint: string): Promise<T | null> {
  if (!(await ensureLogin())) return null;
  try {
    const res = await fetch(`${BASE_URL}/api/v2${endpoint}`, {
      headers: getAuthHeaders(),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401 || res.status === 403) {
      authCookie = null;
      return null;
    }
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function apiPost(endpoint: string, body?: URLSearchParams | FormData): Promise<boolean> {
  if (!(await ensureLogin())) return false;
  try {
    const res = await fetch(`${BASE_URL}/api/v2${endpoint}`, {
      method: 'POST',
      headers: body instanceof FormData
        ? { ...getAuthHeaders(), 'Content-Type': 'multipart/form-data' }
        : { ...getAuthHeaders(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body || undefined,
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 401 || res.status === 403) {
      authCookie = null;
      return false;
    }
    return res.ok;
  } catch {
    return false;
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Get torrent list and transfer info.
 */
export async function getQbittorrentStatus(): Promise<QbittorrentStatus> {
  const [torrents, transfer] = await Promise.all([
    apiGet<QbittorrentTorrent[]>('/torrents/info'),
    apiGet<QbittorrentTransferInfo>('/transfer/info'),
  ]);

  if (torrents === null && transfer === null) {
    return {
      success: false,
      message: 'qBittorrent not reachable. Set QBITTORRENT_URL, QBITTORRENT_USER, QBITTORRENT_PASS in .env.',
    };
  }

  return {
    success: true,
    torrents: torrents ?? [],
    transfer: transfer ?? undefined,
  };
}

/**
 * Add torrent(s) by magnet link or .torrent URL.
 */
export async function addTorrent(urls: string | string[]): Promise<QbittorrentAddResult> {
  const list = Array.isArray(urls) ? urls : [urls];
  const valid = list.filter((u) => u && (u.startsWith('magnet:') || u.startsWith('http')));
  if (valid.length === 0) {
    return { success: false, message: 'Provide a magnet link or .torrent URL.' };
  }

  const params = new URLSearchParams();
  valid.forEach((u) => params.append('urls', u));

  const ok = await apiPost('/torrents/add', params);
  if (!ok) {
    return { success: false, message: 'Failed to add torrent. Check qBittorrent is running and credentials.' };
  }
  return { success: true, message: `Added ${valid.length} torrent(s) to qBittorrent.` };
}

/**
 * Pause torrents by hash (or "all").
 */
export async function pauseTorrents(hashes: string | string[]): Promise<QbittorrentAddResult> {
  const list = Array.isArray(hashes) ? hashes : [hashes];
  const params = new URLSearchParams({ hashes: list.join('|') });
  const ok = await apiPost('/torrents/pause', params);
  return ok ? { success: true, message: 'Torrent(s) paused.' } : { success: false, message: 'Failed to pause.' };
}

/**
 * Resume torrents by hash (or "all").
 */
export async function resumeTorrents(hashes: string | string[]): Promise<QbittorrentAddResult> {
  const list = Array.isArray(hashes) ? hashes : [hashes];
  const params = new URLSearchParams({ hashes: list.join('|') });
  const ok = await apiPost('/torrents/resume', params);
  return ok ? { success: true, message: 'Torrent(s) resumed.' } : { success: false, message: 'Failed to resume.' };
}

// ============================================================================
// Formatting
// ============================================================================

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec === 0) return '0 B/s';
  return `${formatBytes(bytesPerSec)}/s`;
}

function formatEta(seconds: number): string {
  if (seconds < 0 || seconds >= 8640000) return '∞';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function stateLabel(state: string): string {
  const s = state.toLowerCase();
  if (s.includes('downloading')) return '⬇️';
  if (s.includes('uploading') || s.includes('seeding')) return '⬆️';
  if (s.includes('paused')) return '⏸️';
  if (s.includes('stalled')) return '⏳';
  if (s.includes('checking')) return '🔍';
  if (s.includes('queued')) return '📋';
  if (s.includes('error')) return '❌';
  return '•';
}

export function formatQbittorrentStatus(status: QbittorrentStatus): string {
  if (!status.success) return status.message || 'qBittorrent unavailable';

  const lines: string[] = ['## qBittorrent', ''];

  if (status.transfer) {
    const t = status.transfer;
    lines.push(
      `**Transfer:** ↓ ${formatSpeed(t.dl_info_speed)} / ↑ ${formatSpeed(t.up_info_speed)}`,
      `**Total:** ↓ ${formatBytes(t.dl_info_data)} / ↑ ${formatBytes(t.up_info_data)}`,
      ''
    );
  }

  const torrents = status.torrents ?? [];
  if (torrents.length === 0) {
    lines.push('No torrents.');
  } else {
    const active = torrents.filter((x) => x.state.toLowerCase().includes('downloading') || x.state.toLowerCase().includes('uploading'));
    const others = torrents.filter((x) => !active.includes(x));
    const show = [...active, ...others].slice(0, 15);

    for (const t of show) {
      const icon = stateLabel(t.state);
      const pct = Math.round(t.progress * 100);
      const speed = t.dlspeed > 0 ? ` ${formatSpeed(t.dlspeed)}` : t.upspeed > 0 ? ` ${formatSpeed(t.upspeed)}` : '';
      const eta = t.eta > 0 && t.eta < 8640000 ? ` ETA ${formatEta(t.eta)}` : '';
      const name = t.name.length > 50 ? t.name.slice(0, 47) + '…' : t.name;
      lines.push(`${icon} ${name} — ${pct}%${speed}${eta}`);
    }
    if (torrents.length > 15) lines.push(`… and ${torrents.length - 15} more`);
  }

  return lines.join('\n');
}
