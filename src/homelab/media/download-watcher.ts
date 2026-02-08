/**
 * Download Watcher
 * 
 * Monitors active downloads after a user requests one.
 * - Polls Sonarr/Radarr queue every 30s while downloads are active
 * - Detects stalled downloads (no progress for 10 minutes)
 * - Restarts stuck items via Sonarr/Radarr queue API
 * - Sends Signal notification when downloads complete
 * - Broadcasts status over WebSocket for UI
 * - Automatically stops polling when queue is empty
 */

import { logger } from '../../utils/logger.js';
import { getDownloadQueue, type QueueItem } from './search.js';

// ============================================================================
// Types
// ============================================================================

export interface WatchedDownload {
  title: string;
  type: 'movie' | 'episode';
  addedAt: number;           // timestamp when tracking started
  lastProgress: number;      // last known progress %
  lastProgressAt: number;    // timestamp of last progress change
  stallCount: number;        // how many times we detected a stall
  restarted: boolean;        // whether we attempted a restart
  completed: boolean;        // finished downloading
  completedAt?: number;      // when it completed
  notified: boolean;         // Signal notification sent
  queueId: number;           // Sonarr/Radarr queue item ID
  source: 'sonarr' | 'radarr';
  size?: string;
}

export interface DownloadWatcherStatus {
  active: boolean;
  watching: WatchedDownload[];
  recentlyCompleted: WatchedDownload[];
  pollIntervalMs: number;
  lastPollAt: string | null;
}

// ============================================================================
// Config
// ============================================================================

const POLL_INTERVAL_MS = 30_000;       // Check every 30 seconds
const STALL_THRESHOLD_MS = 10 * 60_000; // 10 minutes with no progress = stalled
const MAX_RESTART_ATTEMPTS = 2;         // Max times to restart a stuck download
const COMPLETED_RETENTION = 20;         // Keep last N completed downloads in memory
const DEFAULT_HOST = '192.168.7.50';

// ============================================================================
// State
// ============================================================================

let pollTimer: ReturnType<typeof setInterval> | null = null;
const watched = new Map<string, WatchedDownload>();  // key = title
const recentlyCompleted: WatchedDownload[] = [];
let lastPollAt: string | null = null;

// Callback hooks
let onCompletionCallback: ((download: WatchedDownload) => Promise<void>) | null = null;
let onStallCallback: ((download: WatchedDownload, action: string) => Promise<void>) | null = null;
let broadcastCallback: ((status: DownloadWatcherStatus) => void) | null = null;

// ============================================================================
// Public API
// ============================================================================

/**
 * Register a callback for when a download completes (used for Signal notifications).
 */
export function onDownloadComplete(cb: (download: WatchedDownload) => Promise<void>): void {
  onCompletionCallback = cb;
}

/**
 * Register a callback for when a stall is detected (used for logging/alerts).
 */
export function onDownloadStall(cb: (download: WatchedDownload, action: string) => Promise<void>): void {
  onStallCallback = cb;
}

/**
 * Register a broadcast function for WebSocket updates.
 */
export function setDownloadBroadcast(cb: (status: DownloadWatcherStatus) => void): void {
  broadcastCallback = cb;
}

/**
 * Start watching downloads. Called after a user requests a download.
 * Idempotent — safe to call multiple times.
 */
export function startWatching(): void {
  if (pollTimer) return; // Already watching

  logger.info('[download-watcher] Starting download monitor');
  pollTimer = setInterval(() => void pollDownloads(), POLL_INTERVAL_MS);

  // Do an immediate poll
  void pollDownloads();
}

/**
 * Stop watching downloads. Called when queue is empty and no active downloads.
 */
export function stopWatching(): void {
  if (!pollTimer) return;

  clearInterval(pollTimer);
  pollTimer = null;
  logger.info('[download-watcher] Stopped download monitor (queue empty)');
}

/**
 * Check if the watcher is actively polling.
 */
export function isWatching(): boolean {
  return pollTimer !== null;
}

/**
 * Get the current watcher status (for API/UI).
 */
export function getWatcherStatus(): DownloadWatcherStatus {
  return {
    active: pollTimer !== null,
    watching: Array.from(watched.values()).filter(d => !d.completed),
    recentlyCompleted: [...recentlyCompleted],
    pollIntervalMs: POLL_INTERVAL_MS,
    lastPollAt,
  };
}

/**
 * Manually add a download to watch (called when user triggers a download).
 */
export function trackDownload(title: string, type: 'movie' | 'episode', source: 'sonarr' | 'radarr'): void {
  const now = Date.now();
  watched.set(title.toLowerCase(), {
    title,
    type,
    addedAt: now,
    lastProgress: 0,
    lastProgressAt: now,
    stallCount: 0,
    restarted: false,
    completed: false,
    notified: false,
    queueId: 0,  // Will be filled on first poll
    source,
  });

  logger.info('[download-watcher] Tracking new download', { title, type, source });
  startWatching();
}

// ============================================================================
// Core Poll Logic
// ============================================================================

async function pollDownloads(): Promise<void> {
  try {
    const result = await getDownloadQueue();
    lastPollAt = new Date().toISOString();

    if (!result.success) {
      logger.debug('[download-watcher] Queue fetch failed, will retry');
      return;
    }

    const currentQueue = result.queue;
    const now = Date.now();

    // Update tracked downloads with queue data
    for (const item of currentQueue) {
      const key = item.title.toLowerCase();
      let entry = watched.get(key);

      // Auto-track any download that appears in the queue
      // (catches items added directly via Sonarr/Radarr UI too)
      if (!entry) {
        entry = {
          title: item.title,
          type: item.type,
          addedAt: now,
          lastProgress: item.progress,
          lastProgressAt: now,
          stallCount: 0,
          restarted: false,
          completed: false,
          notified: false,
          queueId: item.id,
          source: item.type === 'movie' ? 'radarr' : 'sonarr',
          size: item.size,
        };
        watched.set(key, entry);
      }

      // Update progress
      entry.queueId = item.id;
      entry.size = item.size;

      if (item.progress > entry.lastProgress) {
        entry.lastProgress = item.progress;
        entry.lastProgressAt = now;
        entry.stallCount = 0; // Reset stall counter on progress
      }

      // Detect stall
      if (
        item.progress < 100 &&
        item.progress > 0 &&
        now - entry.lastProgressAt > STALL_THRESHOLD_MS &&
        entry.stallCount < MAX_RESTART_ATTEMPTS
      ) {
        entry.stallCount++;
        const action = await handleStall(entry, item);
        if (onStallCallback) {
          await onStallCallback(entry, action).catch(err =>
            logger.debug('[download-watcher] Stall callback error', { error: String(err) })
          );
        }
      }
    }

    // Check for completions: items that were tracked but are no longer in queue
    const queueTitles = new Set(currentQueue.map(q => q.title.toLowerCase()));

    for (const [key, entry] of watched) {
      if (entry.completed) continue;

      // If item was in queue before but now gone, it completed (or was removed)
      // Only mark as completed if it had progress > 0 (actually started downloading)
      if (!queueTitles.has(key) && entry.lastProgress > 0) {
        entry.completed = true;
        entry.completedAt = now;

        logger.info('[download-watcher] Download completed', {
          title: entry.title,
          size: entry.size,
          duration: Math.round((now - entry.addedAt) / 1000) + 's',
        });

        // Move to recently completed
        recentlyCompleted.unshift(entry);
        if (recentlyCompleted.length > COMPLETED_RETENTION) {
          recentlyCompleted.pop();
        }

        // Notify
        if (!entry.notified && onCompletionCallback) {
          entry.notified = true;
          await onCompletionCallback(entry).catch(err =>
            logger.error('[download-watcher] Completion callback error', { error: String(err) })
          );
        }
      }
    }

    // Clean up completed entries from watched map
    for (const [key, entry] of watched) {
      if (entry.completed && entry.notified) {
        watched.delete(key);
      }
    }

    // If nothing left to watch, stop polling
    const activeCount = Array.from(watched.values()).filter(d => !d.completed).length;
    if (activeCount === 0 && currentQueue.length === 0) {
      stopWatching();
    }

    // Broadcast status to UI
    if (broadcastCallback) {
      broadcastCallback(getWatcherStatus());
    }

  } catch (error) {
    logger.debug('[download-watcher] Poll error', { error: String(error) });
  }
}

// ============================================================================
// Stall Handling
// ============================================================================

async function handleStall(entry: WatchedDownload, _queueItem: QueueItem): Promise<string> {
  const stalledMinutes = Math.round((Date.now() - entry.lastProgressAt) / 60_000);
  logger.warn('[download-watcher] Download stalled', {
    title: entry.title,
    progress: entry.lastProgress,
    stalledMinutes,
    stallCount: entry.stallCount,
  });

  // Try to restart via Sonarr/Radarr queue delete + re-search
  if (entry.stallCount <= MAX_RESTART_ATTEMPTS) {
    try {
      const restarted = await restartDownload(entry);
      if (restarted) {
        entry.restarted = true;
        entry.lastProgressAt = Date.now(); // Reset stall timer
        return `Restarted download for "${entry.title}" after ${stalledMinutes}min stall (attempt ${entry.stallCount}/${MAX_RESTART_ATTEMPTS})`;
      }
    } catch (error) {
      logger.error('[download-watcher] Restart failed', { title: entry.title, error: String(error) });
    }
  }

  return `Download "${entry.title}" stalled at ${entry.lastProgress}% for ${stalledMinutes}min (${entry.stallCount} stall${entry.stallCount > 1 ? 's' : ''})`;
}

/**
 * Restart a stuck download by removing from queue and triggering a new search.
 * Sonarr/Radarr will find a new torrent and send it to qBittorrent.
 */
async function restartDownload(entry: WatchedDownload): Promise<boolean> {
  const baseUrl = entry.source === 'sonarr'
    ? (process.env.SONARR_URL || `http://${DEFAULT_HOST}:8989`)
    : (process.env.RADARR_URL || `http://${DEFAULT_HOST}:7878`);

  const apiKey = entry.source === 'sonarr'
    ? (process.env.SONARR_API_KEY || '')
    : (process.env.RADARR_API_KEY || '');

  if (!apiKey || !entry.queueId) return false;

  try {
    // Delete the stuck queue item (blacklist it so a different release is tried)
    const deleteUrl = `${baseUrl}/api/v3/queue/${entry.queueId}?removeFromClient=true&blocklist=true`;
    const deleteRes = await fetch(deleteUrl, {
      method: 'DELETE',
      headers: { 'X-Api-Key': apiKey },
      signal: AbortSignal.timeout(10_000),
    });

    if (!deleteRes.ok) {
      logger.debug('[download-watcher] Queue delete failed', { status: deleteRes.status });
      return false;
    }

    logger.info('[download-watcher] Removed stalled item from queue, triggering re-search', {
      title: entry.title,
      source: entry.source,
    });

    // The blacklisting + removal will cause Sonarr/Radarr to automatically
    // search for a new release if the item is still monitored.
    // No need to manually trigger a search — it happens automatically.

    return true;
  } catch (error) {
    logger.error('[download-watcher] Restart API call failed', { error: String(error) });
    return false;
  }
}
