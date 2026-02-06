/**
 * Jeeves Homelab - Media Search & Download
 *
 * Integrates with Sonarr and Radarr APIs to let Jeeves handle
 * natural language media requests like "download Fallout season 2".
 *
 * Flow:
 *   1. searchMedia(query) → searches both Sonarr (TV) and Radarr (movies)
 *   2. addMedia(id, type) → adds to library + triggers monitored search
 *   3. getDownloadQueue() → shows active downloads from both services
 */

import { logger } from '../../utils/logger.js';

// ============================================================================
// Types
// ============================================================================

export interface MediaResult {
  id: number;            // Sonarr/Radarr internal ID (0 = not yet added)
  tvdbId?: number;       // TVDB ID (for series)
  tmdbId?: number;       // TMDB ID (for movies)
  title: string;
  year: number;
  overview: string;
  type: 'movie' | 'series';
  status: string;        // e.g., 'released', 'continuing', 'ended'
  inLibrary: boolean;    // Already added to Sonarr/Radarr
  monitored: boolean;
  seasonCount?: number;
  runtime?: number;      // minutes
  remotePoster?: string;
}

export interface QueueItem {
  id: number;
  title: string;
  status: string;        // e.g., 'downloading', 'queued', 'completed'
  progress: number;      // 0-100
  size: string;
  timeLeft: string;
  type: 'movie' | 'episode';
  indexer?: string;
}

export interface MediaSearchResult {
  success: boolean;
  results: MediaResult[];
  message: string;
}

export interface MediaAddResult {
  success: boolean;
  message: string;
  title?: string;
}

export interface MediaQueueResult {
  success: boolean;
  queue: QueueItem[];
  message: string;
}

// ============================================================================
// Pending Selection State
// ============================================================================

let pendingResults: MediaResult[] = [];
let pendingQuery: { query: string; season?: number; type?: 'movie' | 'series' } | null = null;

export function getPendingMediaResults(): MediaResult[] {
  return pendingResults;
}

export function clearPendingMedia(): void {
  pendingResults = [];
  pendingQuery = null;
}

export function hasPendingMedia(): boolean {
  return pendingResults.length > 0;
}

/**
 * Select a pending media result by index (1-based) and add it to the library.
 */
export async function selectMedia(index: number): Promise<MediaAddResult> {
  if (pendingResults.length === 0) {
    return { success: false, message: 'No pending media results. Search or download something first.' };
  }

  if (index < 1 || index > pendingResults.length) {
    return { success: false, message: `Pick a number between 1 and ${pendingResults.length}` };
  }

  const selected = pendingResults[index - 1];
  const season = pendingQuery?.season;

  // Clear pending state
  const title = selected.title;
  clearPendingMedia();

  if (selected.type === 'series' && selected.tvdbId) {
    return addSonarrSeries(selected.tvdbId, title, { season });
  }

  if (selected.type === 'movie' && selected.tmdbId) {
    return addRadarrMovie(selected.tmdbId, title);
  }

  return { success: false, message: `No valid ID for "${title}"` };
}

// ============================================================================
// Config - reads API keys and URLs from environment or defaults
// ============================================================================

const DEFAULT_HOST = '192.168.7.50';

function getSonarrConfig() {
  return {
    url: process.env.SONARR_URL || `http://${DEFAULT_HOST}:8989`,
    apiKey: process.env.SONARR_API_KEY || '',
  };
}

function getRadarrConfig() {
  return {
    url: process.env.RADARR_URL || `http://${DEFAULT_HOST}:7878`,
    apiKey: process.env.RADARR_API_KEY || '',
  };
}

// ============================================================================
// API Helpers
// ============================================================================

async function apiGet<T>(baseUrl: string, apiKey: string, endpoint: string): Promise<T> {
  const url = `${baseUrl}/api/v3${endpoint}`;
  const res = await fetch(url, {
    headers: { 'X-Api-Key': apiKey, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${res.status}: ${text.substring(0, 200)}`);
  }

  return (await res.json()) as T;
}

async function apiPost<T>(baseUrl: string, apiKey: string, endpoint: string, body: unknown): Promise<T> {
  const url = `${baseUrl}/api/v3${endpoint}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Api-Key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${res.status}: ${text.substring(0, 200)}`);
  }

  return (await res.json()) as T;
}

// ============================================================================
// Sonarr API
// ============================================================================

interface SonarrSeries {
  id: number;
  tvdbId: number;
  title: string;
  year: number;
  overview: string;
  status: string;
  seasonCount: number;
  monitored: boolean;
  remotePoster?: string;
  added?: string;
  rootFolderPath?: string;
  qualityProfileId?: number;
  seasons?: SonarrSeason[];
}

interface SonarrSeason {
  seasonNumber: number;
  monitored: boolean;
}

interface SonarrRootFolder {
  id: number;
  path: string;
  freeSpace: number;
}

interface SonarrQualityProfile {
  id: number;
  name: string;
}

async function searchSonarr(query: string): Promise<MediaResult[]> {
  const { url, apiKey } = getSonarrConfig();
  if (!apiKey) {
    logger.warn('SONARR_API_KEY not set, skipping Sonarr search');
    return [];
  }

  try {
    const results = await apiGet<SonarrSeries[]>(url, apiKey, `/series/lookup?term=${encodeURIComponent(query)}`);

    // Check which are already in library
    const library = await apiGet<SonarrSeries[]>(url, apiKey, '/series');
    const libraryTvdbIds = new Set(library.map(s => s.tvdbId));

    return results.slice(0, 10).map(s => ({
      id: s.id || 0,
      tvdbId: s.tvdbId,
      title: s.title,
      year: s.year,
      overview: (s.overview || '').substring(0, 200),
      type: 'series' as const,
      status: s.status,
      inLibrary: libraryTvdbIds.has(s.tvdbId),
      monitored: s.monitored,
      seasonCount: s.seasonCount,
      remotePoster: s.remotePoster,
    }));
  } catch (error) {
    logger.error('Sonarr search failed', { error: String(error) });
    return [];
  }
}

async function addSonarrSeries(
  tvdbId: number,
  title: string,
  options?: { season?: number },
): Promise<MediaAddResult> {
  const { url, apiKey } = getSonarrConfig();
  if (!apiKey) return { success: false, message: 'SONARR_API_KEY not set' };

  try {
    // Get root folder and quality profile
    const rootFolders = await apiGet<SonarrRootFolder[]>(url, apiKey, '/rootfolder');
    const profiles = await apiGet<SonarrQualityProfile[]>(url, apiKey, '/qualityprofile');

    if (rootFolders.length === 0) return { success: false, message: 'No root folder configured in Sonarr' };
    if (profiles.length === 0) return { success: false, message: 'No quality profile configured in Sonarr' };

    // Look up the series to get full metadata
    const lookupResults = await apiGet<SonarrSeries[]>(url, apiKey, `/series/lookup?term=tvdb:${tvdbId}`);
    const series = lookupResults[0];
    if (!series) return { success: false, message: `Series not found for TVDB ID ${tvdbId}` };

    // Check if already in library
    const library = await apiGet<SonarrSeries[]>(url, apiKey, '/series');
    const existing = library.find(s => s.tvdbId === tvdbId);

    if (existing) {
      // Already in library -- monitor the requested season if specified
      if (options?.season !== undefined) {
        // Toggle monitoring for the specific season
        const updatedSeasons = (existing.seasons || []).map(s => ({
          ...s,
          monitored: s.seasonNumber === options.season ? true : s.monitored,
        }));

        await fetch(`${url}/api/v3/series/${existing.id}`, {
          method: 'PUT',
          headers: {
            'X-Api-Key': apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ...existing, seasons: updatedSeasons, monitored: true }),
          signal: AbortSignal.timeout(15_000),
        });

        // Trigger search for the season
        await apiPost(url, apiKey, '/command', {
          name: 'SeasonSearch',
          seriesId: existing.id,
          seasonNumber: options.season,
        });

        return {
          success: true,
          message: `${title} S${String(options.season).padStart(2, '0')} is now monitored and searching for downloads`,
          title,
        };
      }

      // No specific season -- trigger full search
      await apiPost(url, apiKey, '/command', {
        name: 'SeriesSearch',
        seriesId: existing.id,
      });

      return {
        success: true,
        message: `${title} is already in library. Triggered download search.`,
        title,
      };
    }

    // Build seasons list -- monitor specific season or all
    const seasons = (series.seasons || []).map(s => ({
      seasonNumber: s.seasonNumber,
      monitored: options?.season !== undefined ? s.seasonNumber === options.season : true,
    }));

    // Add new series
    const addPayload = {
      tvdbId: series.tvdbId,
      title: series.title,
      qualityProfileId: profiles[0].id,
      rootFolderPath: rootFolders[0].path,
      monitored: true,
      seasons,
      addOptions: {
        searchForMissingEpisodes: true,
        monitor: options?.season !== undefined ? 'none' : 'all',
      },
    };

    await apiPost<SonarrSeries>(url, apiKey, '/series', addPayload);

    const seasonNote = options?.season !== undefined
      ? ` (monitoring season ${options.season})`
      : '';

    return {
      success: true,
      message: `${title}${seasonNote} added to Sonarr and searching for downloads`,
      title,
    };
  } catch (error) {
    logger.error('Sonarr add failed', { error: String(error), tvdbId, title });
    return { success: false, message: `Failed to add ${title}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function getSonarrQueue(): Promise<QueueItem[]> {
  const { url, apiKey } = getSonarrConfig();
  if (!apiKey) return [];

  try {
    const data = await apiGet<{ records: Array<{
      id: number;
      title: string;
      status: string;
      sizeleft: number;
      size: number;
      timeleft: string;
      indexer: string;
      episode?: { title: string; seasonNumber: number; episodeNumber: number };
      series?: { title: string };
    }> }>(url, apiKey, '/queue?pageSize=50');

    return data.records.map(r => {
      const progress = r.size > 0 ? Math.round(((r.size - r.sizeleft) / r.size) * 100) : 0;
      const episodeLabel = r.episode
        ? `${r.series?.title || ''} S${String(r.episode.seasonNumber).padStart(2, '0')}E${String(r.episode.episodeNumber).padStart(2, '0')} - ${r.episode.title}`
        : r.title;

      return {
        id: r.id,
        title: episodeLabel,
        status: r.status,
        progress,
        size: formatBytes(r.size),
        timeLeft: r.timeleft || 'unknown',
        type: 'episode' as const,
        indexer: r.indexer,
      };
    });
  } catch (error) {
    logger.error('Sonarr queue fetch failed', { error: String(error) });
    return [];
  }
}

// ============================================================================
// Radarr API
// ============================================================================

interface RadarrMovie {
  id: number;
  tmdbId: number;
  title: string;
  year: number;
  overview: string;
  status: string;
  monitored: boolean;
  hasFile: boolean;
  runtime: number;
  remotePoster?: string;
  added?: string;
  rootFolderPath?: string;
  qualityProfileId?: number;
}

interface RadarrRootFolder {
  id: number;
  path: string;
  freeSpace: number;
}

interface RadarrQualityProfile {
  id: number;
  name: string;
}

async function searchRadarr(query: string): Promise<MediaResult[]> {
  const { url, apiKey } = getRadarrConfig();
  if (!apiKey) {
    logger.warn('RADARR_API_KEY not set, skipping Radarr search');
    return [];
  }

  try {
    const results = await apiGet<RadarrMovie[]>(url, apiKey, `/movie/lookup?term=${encodeURIComponent(query)}`);

    // Check which are already in library
    const library = await apiGet<RadarrMovie[]>(url, apiKey, '/movie');
    const libraryTmdbIds = new Set(library.map(m => m.tmdbId));

    return results.slice(0, 10).map(m => ({
      id: m.id || 0,
      tmdbId: m.tmdbId,
      title: m.title,
      year: m.year,
      overview: (m.overview || '').substring(0, 200),
      type: 'movie' as const,
      status: m.status,
      inLibrary: libraryTmdbIds.has(m.tmdbId),
      monitored: m.monitored,
      runtime: m.runtime,
      remotePoster: m.remotePoster,
    }));
  } catch (error) {
    logger.error('Radarr search failed', { error: String(error) });
    return [];
  }
}

async function addRadarrMovie(tmdbId: number, title: string): Promise<MediaAddResult> {
  const { url, apiKey } = getRadarrConfig();
  if (!apiKey) return { success: false, message: 'RADARR_API_KEY not set' };

  try {
    // Get root folder and quality profile
    const rootFolders = await apiGet<RadarrRootFolder[]>(url, apiKey, '/rootfolder');
    const profiles = await apiGet<RadarrQualityProfile[]>(url, apiKey, '/qualityprofile');

    if (rootFolders.length === 0) return { success: false, message: 'No root folder configured in Radarr' };
    if (profiles.length === 0) return { success: false, message: 'No quality profile configured in Radarr' };

    // Check if already in library
    const library = await apiGet<RadarrMovie[]>(url, apiKey, '/movie');
    const existing = library.find(m => m.tmdbId === tmdbId);

    if (existing) {
      // Already in library -- trigger search
      await apiPost(url, apiKey, '/command', {
        name: 'MoviesSearch',
        movieIds: [existing.id],
      });

      return {
        success: true,
        message: `${title} is already in library. Triggered download search.`,
        title,
      };
    }

    // Look up full metadata
    const lookupResults = await apiGet<RadarrMovie[]>(url, apiKey, `/movie/lookup?term=tmdb:${tmdbId}`);
    const movie = lookupResults[0];
    if (!movie) return { success: false, message: `Movie not found for TMDB ID ${tmdbId}` };

    // Add to library
    const addPayload = {
      tmdbId: movie.tmdbId,
      title: movie.title,
      qualityProfileId: profiles[0].id,
      rootFolderPath: rootFolders[0].path,
      monitored: true,
      addOptions: {
        searchForMovie: true,
      },
    };

    await apiPost<RadarrMovie>(url, apiKey, '/movie', addPayload);

    return {
      success: true,
      message: `${title} (${movie.year}) added to Radarr and searching for downloads`,
      title,
    };
  } catch (error) {
    logger.error('Radarr add failed', { error: String(error), tmdbId, title });
    return { success: false, message: `Failed to add ${title}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function getRadarrQueue(): Promise<QueueItem[]> {
  const { url, apiKey } = getRadarrConfig();
  if (!apiKey) return [];

  try {
    const data = await apiGet<{ records: Array<{
      id: number;
      title: string;
      status: string;
      sizeleft: number;
      size: number;
      timeleft: string;
      indexer: string;
      movie?: { title: string; year: number };
    }> }>(url, apiKey, '/queue?pageSize=50');

    return data.records.map(r => {
      const progress = r.size > 0 ? Math.round(((r.size - r.sizeleft) / r.size) * 100) : 0;
      return {
        id: r.id,
        title: r.movie ? `${r.movie.title} (${r.movie.year})` : r.title,
        status: r.status,
        progress,
        size: formatBytes(r.size),
        timeLeft: r.timeleft || 'unknown',
        type: 'movie' as const,
        indexer: r.indexer,
      };
    });
  } catch (error) {
    logger.error('Radarr queue fetch failed', { error: String(error) });
    return [];
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Search for media across both Sonarr (TV) and Radarr (movies).
 * Returns combined results sorted by relevance.
 */
export async function searchMedia(query: string): Promise<MediaSearchResult> {
  logger.info('Media search', { query });

  const [sonarrResults, radarrResults] = await Promise.all([
    searchSonarr(query),
    searchRadarr(query),
  ]);

  // Combine and sort by title similarity to query (best match first)
  const results = [...sonarrResults, ...radarrResults].sort((a, b) => {
    const scoreA = titleSimilarity(query, a.title);
    const scoreB = titleSimilarity(query, b.title);
    return scoreB - scoreA;
  });

  if (results.length === 0) {
    const missingKeys: string[] = [];
    if (!getSonarrConfig().apiKey) missingKeys.push('SONARR_API_KEY');
    if (!getRadarrConfig().apiKey) missingKeys.push('RADARR_API_KEY');

    const keyNote = missingKeys.length > 0
      ? ` (missing: ${missingKeys.join(', ')})`
      : '';

    return {
      success: true,
      results: [],
      message: `No results found for "${query}"${keyNote}`,
    };
  }

  return {
    success: true,
    results,
    message: `Found ${results.length} result(s) for "${query}"`,
  };
}

/**
 * Add media to library and trigger download.
 *
 * For series: optionally specify a season number.
 * For movies: adds and searches immediately.
 */
export async function addMedia(
  query: string,
  options?: { season?: number; type?: 'movie' | 'series' },
): Promise<MediaAddResult> {
  logger.info('Media add', { query, options });

  // Search first to find the best match
  const searchResult = await searchMedia(query);
  if (!searchResult.success || searchResult.results.length === 0) {
    return { success: false, message: `Could not find "${query}" in Sonarr or Radarr` };
  }

  // If type is specified, filter results
  let candidates = searchResult.results;
  if (options?.type) {
    candidates = candidates.filter(r => r.type === options.type);
  }

  // If season is specified, prefer series results
  if (options?.season !== undefined) {
    const seriesResults = candidates.filter(r => r.type === 'series');
    if (seriesResults.length > 0) {
      candidates = seriesResults;
    }
  }

  if (candidates.length === 0) {
    return { success: false, message: `No matching ${options?.type || 'media'} found for "${query}"` };
  }

  // If the top result is a near-exact match (score >= 0.9), auto-select it
  const topScore = titleSimilarity(query, candidates[0].title);
  if (topScore >= 0.9 && candidates.length === 1) {
    const match = candidates[0];
    if (match.type === 'series' && match.tvdbId) {
      return addSonarrSeries(match.tvdbId, match.title, { season: options?.season });
    }
    if (match.type === 'movie' && match.tmdbId) {
      return addRadarrMovie(match.tmdbId, match.title);
    }
  }

  // Multiple candidates or uncertain match -- show options and let user pick
  const top = candidates.slice(0, 5);
  pendingResults = top;
  pendingQuery = { query, season: options?.season, type: options?.type };

  let message = `Found ${candidates.length} result(s) for "${query}". Pick one:\n\n`;
  for (let i = 0; i < top.length; i++) {
    const r = top[i];
    const icon = r.type === 'movie' ? '🎬' : '📺';
    const inLib = r.inLibrary ? ' ✅' : '';
    const extra = r.type === 'series' && r.seasonCount ? ` (${r.seasonCount} seasons)` : '';
    message += `${i + 1}. ${icon} ${r.title} (${r.year})${extra}${inLib}\n`;
  }
  message += `\nReply with a number (1-${top.length}) to download.`;

  return { success: true, message };
}

/**
 * Get the combined download queue from Sonarr + Radarr.
 */
export async function getDownloadQueue(): Promise<MediaQueueResult> {
  logger.info('Fetching download queue');

  const [sonarrQueue, radarrQueue] = await Promise.all([
    getSonarrQueue(),
    getRadarrQueue(),
  ]);

  const queue = [...sonarrQueue, ...radarrQueue];

  if (queue.length === 0) {
    return {
      success: true,
      queue: [],
      message: 'No active downloads',
    };
  }

  return {
    success: true,
    queue,
    message: `${queue.length} item(s) in download queue`,
  };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Score how similar a title is to a search query (0-1).
 * Handles cases like "old boy" matching "Oldboy".
 */
function titleSimilarity(query: string, title: string): number {
  const q = query.toLowerCase().replace(/[^a-z0-9]/g, '');
  const t = title.toLowerCase().replace(/[^a-z0-9]/g, '');

  // Exact match (ignoring spaces/punctuation)
  if (q === t) return 1.0;

  // Query is contained within title or vice versa
  if (t.includes(q)) return 0.9;
  if (q.includes(t)) return 0.8;

  // Check word-level overlap
  const qWords = query.toLowerCase().split(/\s+/);
  const tWords = title.toLowerCase().split(/\s+/);
  const matches = qWords.filter(w => tWords.some(tw => tw.includes(w) || w.includes(tw)));
  const wordScore = matches.length / Math.max(qWords.length, 1);

  return wordScore * 0.7;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

/**
 * Parse a natural language media query into structured parts.
 *
 * Examples:
 *   "Fallout season 2"       → { query: "Fallout", season: 2 }
 *   "The Office"             → { query: "The Office" }
 *   "Interstellar"           → { query: "Interstellar" }
 *   "download Breaking Bad"  → { query: "Breaking Bad" }
 */
export function parseMediaQuery(input: string): { query: string; season?: number; type?: 'movie' | 'series' } {
  let cleaned = input.trim();

  // Strip leading verbs
  cleaned = cleaned.replace(/^(?:download|get|find|search|add|grab|queue)\s+/i, '');

  // Extract season number
  const seasonMatch = cleaned.match(/\b(?:season|s)\s*(\d+)\b/i);
  const season = seasonMatch ? parseInt(seasonMatch[1], 10) : undefined;

  // Remove season part from query
  if (seasonMatch) {
    cleaned = cleaned.replace(seasonMatch[0], '').trim();
  }

  // Detect type hints
  let type: 'movie' | 'series' | undefined;
  if (/\b(?:movie|film)\b/i.test(cleaned)) {
    type = 'movie';
    cleaned = cleaned.replace(/\b(?:the\s+)?(?:movie|film)\b/i, '').trim();
  } else if (/\b(?:show|series|tv)\b/i.test(cleaned)) {
    type = 'series';
    cleaned = cleaned.replace(/\b(?:the\s+)?(?:show|series|tv)\b/i, '').trim();
  } else if (season !== undefined) {
    type = 'series'; // If a season is specified, it's definitely a series
  }

  // Strip descriptive qualifiers that aren't part of the title
  // e.g., "the korean version", "the original", "the 2003 one", "in english"
  cleaned = cleaned.replace(/,?\s*(?:the\s+)?(?:korean|japanese|chinese|french|spanish|english|american|original|new|old|remake|dubbed|subbed|subtitled)\s*(?:version|one|edition|cut|dub)?/gi, '');

  // Strip "the X one" / "from YYYY" / "by director"
  cleaned = cleaned.replace(/,?\s*(?:from\s+\d{4}|the\s+\d{4}\s+one|by\s+\w+)/gi, '');

  // Strip year references like "the 2003 one" but keep years that are part of titles
  cleaned = cleaned.replace(/,?\s*(?:the\s+)?\d{4}\s+(?:one|version|film|movie)/gi, '');

  // Clean up extra whitespace, commas, and trailing articles
  cleaned = cleaned
    .replace(/^(?:the\s+)?(?:movie|show|series)\s+/i, '')
    .replace(/,+/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Remove trailing "the" left over from stripping
  cleaned = cleaned.replace(/\s+the$/i, '').trim();

  return { query: cleaned, season, type };
}
