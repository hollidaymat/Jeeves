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
  /** TMDB popularity (higher = more popular). Used to rank "most obvious" first. */
  popularity?: number;
  /** TMDB/TVDB vote average (e.g. 7.5). Used for ranking. */
  voteAverage?: number;
  /** TMDB/TVDB vote count. More votes = more established/obvious. */
  voteCount?: number;
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
let allCandidates: MediaResult[] = [];
let pendingPage = 0;
const PAGE_SIZE = 5;
let pendingQuery: { query: string; season?: number; type?: 'movie' | 'series'; context?: MediaQueryContext } | null = null;

export interface MediaQueryContext {
  actor?: string;     // "with Lin-Manuel Miranda", "starring X"
  year?: number;      // "the 2020 one", "from 2019"
  platform?: string;  // "disney", "broadway", "netflix", etc.
  isCollection?: boolean;  // "trilogy", "collection", "franchise"
}

export function getPendingMediaResults(): MediaResult[] {
  return pendingResults;
}

export function clearPendingMedia(): void {
  pendingResults = [];
  allCandidates = [];
  pendingPage = 0;
  pendingQuery = null;
}

export function hasPendingMedia(): boolean {
  return pendingResults.length > 0;
}

/**
 * Show the next page of results from a previous search.
 */
export function showNextResults(): { success: boolean; message: string } {
  if (allCandidates.length === 0) {
    return { success: false, message: 'No previous search results. Try downloading something first.' };
  }

  const nextPage = pendingPage + 1;
  const start = nextPage * PAGE_SIZE;
  if (start >= allCandidates.length) {
    return { success: false, message: `No more results. Showing all ${allCandidates.length} of ${allCandidates.length}.` };
  }

  pendingPage = nextPage;
  const top = allCandidates.slice(start, start + PAGE_SIZE);
  pendingResults = top;

  const totalShown = Math.min(start + PAGE_SIZE, allCandidates.length);
  let message = `Results ${start + 1}-${totalShown} of ${allCandidates.length} for "${pendingQuery?.query || '?'}":\n\n`;
  for (let i = 0; i < top.length; i++) {
    const r = top[i];
    const icon = r.type === 'movie' ? '🎬' : '📺';
    const inLib = r.inLibrary ? ' ✅' : '';
    const extra = r.type === 'series' && r.seasonCount ? ` (${r.seasonCount} seasons)` : '';
    message += `[${i + 1}] ${icon} ${r.title} (${r.year})${extra}${inLib}\n`;
  }
  message += `\nReply with a number (1-${top.length}) to download, or "more" for next page.`;

  return { success: true, message };
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
// Known disambiguation mappings (title + context → preferred search queries)
// TMDB/Radarr lookup doesn't support actor search, so we use title+year/platform.
// ============================================================================

const DISAMBIGUATION: Array<{
  titleMatch: RegExp;
  actorHint?: RegExp;
  platformHint?: RegExp;
  altQueries: string[];
}> = [
  // Hamilton: "Hamilton (2020)" = Disney+ filmed Broadway, Lin-Manuel Miranda
  { titleMatch: /^hamilton$/i, actorHint: /lin[- ]?manuel\s*miranda|miranda/i, altQueries: ['Hamilton 2020', 'Hamilton Disney', 'Hamilton'] },
  { titleMatch: /^hamilton$/i, platformHint: /disney|broadway/i, altQueries: ['Hamilton 2020', 'Hamilton Disney', 'Hamilton'] },
  // Dune: 2021 Villeneuve vs 1984 Lynch
  { titleMatch: /^dune$/i, platformHint: /new|2021|villeneuve|denis/i, altQueries: ['Dune 2021'] },
  { titleMatch: /^dune$/i, platformHint: /old|1984|lynch|david/i, altQueries: ['Dune 1984'] },
  // Spider-Man: often need year to disambiguate
  { titleMatch: /^spider[- ]?man$/i, platformHint: /no way home|2021|tom\s*holland/i, altQueries: ['Spider-Man No Way Home', 'Spider-Man 2021'] },
  // Batman
  { titleMatch: /^the\s+dark\s+knight$/i, altQueries: ['The Dark Knight 2008', 'Dark Knight'] },
  // Oldboy: 2003 Korean vs 2013 US remake
  { titleMatch: /^oldboy?$/i, platformHint: /korean|2003|original|park/i, altQueries: ['Oldboy 2003', 'Oldboy'] },
  { titleMatch: /^oldboy?$/i, platformHint: /american|2013|remake|spike/i, altQueries: ['Oldboy 2013'] },
];

// TMDB collection IDs for "download Lord of the Rings trilogy" / "Die Hard collection"
const COLLECTION_MAPPINGS: Array<{ pattern: RegExp; tmdbCollectionId: number }> = [
  { pattern: /^(?:the\s+)?lord\s+of\s+the\s+rings$/i, tmdbCollectionId: 119 },
  { pattern: /^lotr$/i, tmdbCollectionId: 119 },
  { pattern: /^die\s+hard$/i, tmdbCollectionId: 1570 },
  { pattern: /^the\s+godfather$/i, tmdbCollectionId: 1562 },
  { pattern: /^godfather$/i, tmdbCollectionId: 1562 },
  { pattern: /^harry\s+potter$/i, tmdbCollectionId: 1241 },
  { pattern: /^indiana\s+jones$/i, tmdbCollectionId: 84 },
  { pattern: /^star\s+wars$/i, tmdbCollectionId: 10 },
  { pattern: /^james\s+bond$/i, tmdbCollectionId: 645 },
  { pattern: /^007$/i, tmdbCollectionId: 645 },
  { pattern: /^matrix$/i, tmdbCollectionId: 2344 },
  { pattern: /^rocky$/i, tmdbCollectionId: 1367 },
  { pattern: /^rambo$/i, tmdbCollectionId: 1368 },
  { pattern: /^back\s+to\s+the\s+future$/i, tmdbCollectionId: 264 },
  { pattern: /^fast\s+and\s+furious$/i, tmdbCollectionId: 9485 },
  { pattern: /^mission\s+impossible$/i, tmdbCollectionId: 87359 },
];

function getAlternateQueries(baseTitle: string, context?: MediaQueryContext): string[] {
  const alts: string[] = [baseTitle];
  const lower = baseTitle.toLowerCase().trim();

  // Check known disambiguation
  for (const d of DISAMBIGUATION) {
    if (!d.titleMatch.test(baseTitle)) continue;
    if (d.actorHint && context?.actor && d.actorHint.test(context.actor)) {
      return [...d.altQueries, ...alts];
    }
    if (d.platformHint && context?.platform && d.platformHint.test(context.platform)) {
      return [...d.altQueries, ...alts];
    }
    if (!d.actorHint && !d.platformHint) {
      return [...d.altQueries, ...alts];
    }
  }

  // Generic: append year or actor if we have context
  if (context?.year) alts.unshift(`${baseTitle} ${context.year}`);
  if (context?.actor) alts.push(`${baseTitle} ${context.actor}`);
  if (context?.platform) alts.push(`${baseTitle} ${context.platform}`);

  return [...new Set(alts)];
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

function getLidarrConfig() {
  return {
    url: process.env.LIDARR_URL || `http://${DEFAULT_HOST}:8686`,
    apiKey: process.env.LIDARR_API_KEY || '',
  };
}

function getProwlarrConfig() {
  return {
    url: process.env.PROWLARR_URL || `http://${DEFAULT_HOST}:9696`,
    apiKey: process.env.PROWLARR_API_KEY || '',
  };
}

/** Newznab category IDs for music/audio (Lidarr uses these to know which indexers to query for music). */
const MUSIC_CATEGORY_IDS = [3000, 3010, 3020, 3030, 3040, 3050, 3060];

function hasMusicCategory(categories: number[] | Array<{ id?: number }> | undefined): boolean {
  if (!Array.isArray(categories)) return false;
  return categories.some((c) => {
    const id = typeof c === 'number' ? c : (c as { id?: number }).id;
    return id !== undefined && MUSIC_CATEGORY_IDS.includes(id);
  });
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

/** Lidarr uses /api/v1 */
async function lidarrGet<T>(baseUrl: string, apiKey: string, endpoint: string): Promise<T> {
  const url = `${baseUrl}/api/v1${endpoint}`;
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

async function lidarrPost<T>(baseUrl: string, apiKey: string, endpoint: string, body: unknown): Promise<T> {
  const url = `${baseUrl}/api/v1${endpoint}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
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
  popularity?: number;
  ratings?: { value: number; votes: number };
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
      popularity: s.popularity,
      voteAverage: s.ratings?.value,
      voteCount: s.ratings?.votes,
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
    throw new Error(`Sonarr API: ${error instanceof Error ? error.message : String(error)}`);
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
  popularity?: number;
  ratings?: { value: number; votes: number };
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

interface RadarrCollectionMovie {
  tmdbId: number;
  title: string;
  year: number;
  monitored: boolean;
  hasFile: boolean;
}

interface RadarrCollection {
  id: number;
  tmdbId: number;
  title: string;
  movies: RadarrCollectionMovie[];
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
      popularity: m.popularity,
      voteAverage: m.ratings?.value,
      voteCount: m.ratings?.votes,
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
    throw new Error(`Radarr API: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ============================================================================
// Lidarr API (music)
// ============================================================================

interface LidarrArtist {
  id?: number;
  foreignArtistId: string;
  name: string;
  overview?: string;
  status: string;
  monitored: boolean;
  rootFolderPath?: string;
  qualityProfileId?: number;
}

interface LidarrRootFolder {
  id: number;
  path: string;
  freeSpace?: number;
}

interface LidarrQualityProfile {
  id: number;
  name: string;
}

interface LidarrMetadataProfile {
  id: number;
  name: string;
}

async function searchLidarr(term: string): Promise<LidarrArtist[]> {
  const { url, apiKey } = getLidarrConfig();
  if (!apiKey) {
    logger.warn('LIDARR_API_KEY not set, skipping Lidarr search');
    return [];
  }
  try {
    const results = await lidarrGet<LidarrArtist[]>(url, apiKey, `/artist/lookup?term=${encodeURIComponent(term)}`);
    return (Array.isArray(results) ? results : []).slice(0, 10);
  } catch (error) {
    logger.error('Lidarr search failed', { error: String(error) });
    return [];
  }
}

async function addLidarrArtist(foreignArtistId: string, artistName: string): Promise<MediaAddResult> {
  const { url, apiKey } = getLidarrConfig();
  if (!apiKey) return { success: false, message: 'LIDARR_API_KEY not set' };

  try {
    const rootFolders = await lidarrGet<LidarrRootFolder[]>(url, apiKey, '/rootfolder');
    const profiles = await lidarrGet<LidarrQualityProfile[]>(url, apiKey, '/qualityprofile');
    const metaProfiles = await lidarrGet<LidarrMetadataProfile[]>(url, apiKey, '/metadataprofile').catch(() => [] as LidarrMetadataProfile[]);
    if (rootFolders.length === 0) return { success: false, message: 'No root folder configured in Lidarr' };
    if (profiles.length === 0) return { success: false, message: 'No quality profile configured in Lidarr' };

    const metadataProfileId = (Array.isArray(metaProfiles) && metaProfiles.length > 0)
      ? metaProfiles[0].id
      : 1;

    const library = await lidarrGet<LidarrArtist[]>(url, apiKey, '/artist');
    const existing = library.find((a: LidarrArtist) => a.foreignArtistId === foreignArtistId);
    if (existing) {
      await lidarrPost(url, apiKey, '/command', { name: 'ArtistSearch', artistId: existing.id });
      return { success: true, message: `${artistName} is already in library. Triggered download search.`, title: artistName };
    }

    const lookup = await lidarrGet<LidarrArtist[]>(url, apiKey, `/artist/lookup?term=lidarr:${foreignArtistId}`);
    const artist = lookup[0];
    if (!artist) return { success: false, message: `Artist not found for ID ${foreignArtistId}` };

    const addPayload = {
      ...artist,
      rootFolderPath: rootFolders[0].path,
      qualityProfileId: profiles[0].id,
      metadataProfileId,
      monitored: true,
      addOptions: { searchForNewAlbum: true },
    };
    await lidarrPost(url, apiKey, '/artist', addPayload);
    return { success: true, message: `${artistName} added to Lidarr and searching for albums`, title: artistName };
  } catch (error) {
    logger.error('Lidarr add failed', { error: String(error), artistName });
    return { success: false, message: `Failed to add ${artistName}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Diagnostic: report indexer categories for music (Prowlarr vs Lidarr).
 * If categories don't match or music categories are missing, Lidarr won't find releases.
 * See docs/MUSIC_INDEXER_CATEGORIES.md for how to fix.
 */
export async function getMusicIndexerCategoryStatus(): Promise<string> {
  const lines: string[] = ['Music indexer categories (Prowlarr ↔ Lidarr)'];
  lines.push('Music category IDs: 3000, 3010, 3020, 3030, 3040, 3050, 3060');
  lines.push('');

  const prowlarr = getProwlarrConfig();
  const lidarr = getLidarrConfig();

  if (!prowlarr.apiKey) {
    lines.push('Prowlarr: PROWLARR_API_KEY not set — cannot check.');
  } else {
    try {
      const raw = await fetch(`${prowlarr.url}/api/v1/indexer`, {
        headers: { 'X-Api-Key': prowlarr.apiKey, Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      }).then((r) => (r.ok ? r.json() : []));
      const prowlarrIndexers = (Array.isArray(raw) ? raw : []).map((i: Record<string, unknown>) => ({
        name: String(i.name ?? ''),
        enable: i.enable !== false,
        categories: (i.categories as number[] | Array<{ id?: number }> | undefined) ?? [],
      }));
      const withMusic = prowlarrIndexers.filter((i) => i.enable && hasMusicCategory(i.categories));
      const withoutMusic = prowlarrIndexers.filter((i) => i.enable && !hasMusicCategory(i.categories));
      lines.push(`Prowlarr: ${prowlarrIndexers.length} indexer(s). ${withMusic.length} with music categories, ${withoutMusic.length} without.`);
      if (withoutMusic.length > 0) {
        lines.push(`  Missing music categories: ${withoutMusic.map((i) => i.name || '?').join(', ')}`);
        lines.push('  → Edit each indexer in Prowlarr and enable Music/Audio categories (3000–3060), then sync to Lidarr.');
      }
    } catch (e) {
      lines.push(`Prowlarr: error — ${String(e)}`);
    }
  }

  if (!lidarr.apiKey) {
    lines.push('Lidarr: LIDARR_API_KEY not set — cannot check.');
  } else {
    try {
      const raw = await fetch(`${lidarr.url}/api/v1/indexer`, {
        headers: { 'X-Api-Key': lidarr.apiKey, Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      }).then((r) => (r.ok ? r.json() : []));
      const lidarrIndexers = (Array.isArray(raw) ? raw : []).map((i: Record<string, unknown>) => ({
        name: String(i.name ?? ''),
        enable: i.enable !== false,
        categories: (i.categories as number[] | Array<{ id?: number }> | undefined) ?? [],
      }));
      const withMusic = lidarrIndexers.filter((i) => i.enable && hasMusicCategory(i.categories));
      const withoutMusic = lidarrIndexers.filter((i) => i.enable && !hasMusicCategory(i.categories));
      lines.push(`Lidarr: ${lidarrIndexers.length} indexer(s). ${withMusic.length} with music categories, ${withoutMusic.length} without.`);
      if (withoutMusic.length > 0) {
        lines.push(`  Missing music categories: ${withoutMusic.map((i) => i.name || '?').join(', ')}`);
        lines.push('  → In Lidarr go to Settings → Indexers, edit each and add categories 3000, 3010, 3020, 3030.');
      }
    } catch (e) {
      lines.push(`Lidarr: error — ${String(e)}`);
    }
  }

  lines.push('');
  lines.push('See docs/MUSIC_INDEXER_CATEGORIES.md for full fix steps.');
  return lines.join('\n');
}

async function getRadarrCollection(tmdbCollectionId: number): Promise<RadarrCollection | null> {
  const { url, apiKey } = getRadarrConfig();
  if (!apiKey) return null;

  try {
    const collections = await apiGet<RadarrCollection[]>(
      url,
      apiKey,
      `/collection?tmdbId=${tmdbCollectionId}`
    );
    return collections?.[0] ?? null;
  } catch (error) {
    logger.error('Radarr collection fetch failed', { tmdbCollectionId, error: String(error) });
    return null;
  }
}

function resolveCollectionTmdbId(title: string): number | null {
  const normalized = title.trim().replace(/\s+/g, ' ');
  for (const { pattern, tmdbCollectionId } of COLLECTION_MAPPINGS) {
    if (pattern.test(normalized)) return tmdbCollectionId;
  }
  return null;
}

async function addRadarrCollection(tmdbCollectionId: number): Promise<MediaAddResult> {
  const collection = await getRadarrCollection(tmdbCollectionId);
  if (!collection || !collection.movies?.length) {
    return { success: false, message: `Collection not found for TMDB ID ${tmdbCollectionId}` };
  }

  const added: string[] = [];
  const errors: string[] = [];

  for (const movie of collection.movies) {
    const result = await addRadarrMovie(movie.tmdbId, movie.title);
    if (result.success && result.title) {
      added.push(result.title);
    } else {
      errors.push(`${movie.title}: ${result.message}`);
    }
  }

  const msg =
    added.length > 0
      ? `Added ${added.length} movie(s) from "${collection.title}": ${added.join(', ')}`
      : 'No movies added';
  if (errors.length > 0) {
    return { success: added.length > 0, message: `${msg}\nFailed: ${errors.join('; ')}` };
  }
  return { success: true, message: msg, title: collection.title };
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Search for media across both Sonarr (TV) and Radarr (movies).
 * Uses context (actor, year, platform) to try alternate queries for disambiguation.
 * Returns combined results sorted by relevance.
 */
export async function searchMedia(
  query: string,
  context?: MediaQueryContext
): Promise<MediaSearchResult> {
  logger.info('Media search', { query, context });

  const queriesToTry = getAlternateQueries(query, context);

  const seen = new Set<string>();
  const allResults: MediaResult[] = [];

  for (const q of queriesToTry) {
    const [sonarrResults, radarrResults] = await Promise.all([
      searchSonarr(q),
      searchRadarr(q),
    ]);

    for (const r of [...sonarrResults, ...radarrResults]) {
      const key = `${r.title.toLowerCase()}-${r.year}-${r.type}`;
      if (!seen.has(key)) {
        seen.add(key);
        allResults.push(r);
      }
    }
  }

  // Also try with spaces removed (e.g., "old boy" -> "oldboy") if still no results
  if (allResults.length === 0) {
    const noSpaces = query.replace(/\s+/g, '');
    if (noSpaces !== query) {
      const [extraSonarr, extraRadarr] = await Promise.all([
        searchSonarr(noSpaces),
        searchRadarr(noSpaces),
      ]);
      for (const r of [...extraSonarr, ...extraRadarr]) {
        const key = `${r.title.toLowerCase()}-${r.year}-${r.type}`;
        if (!seen.has(key)) {
          seen.add(key);
          allResults.push(r);
        }
      }
    }
  }

  const noSpaces = query.replace(/\s+/g, '');
  const results = allResults.sort((a, b) => {
    const scoreA = Math.max(titleSimilarity(query, a.title), titleSimilarity(noSpaces, a.title));
    const scoreB = Math.max(titleSimilarity(query, b.title), titleSimilarity(noSpaces, b.title));
    if (Math.abs(scoreB - scoreA) > 0.05) return scoreB - scoreA;
    // Tie-break: prefer higher popularity / vote count (most obvious choice first)
    const popA = (a.popularity ?? 0) + (a.voteCount ?? 0) * 0.01 + (a.voteAverage ?? 0) * 0.1;
    const popB = (b.popularity ?? 0) + (b.voteCount ?? 0) * 0.01 + (b.voteAverage ?? 0) * 0.1;
    return popB - popA;
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
 * For collections: "Lord of the Rings trilogy", "Die Hard collection" → add all movies.
 * Context (actor, year, platform) improves disambiguation for ambiguous titles.
 *
 * When autoSelectBest is true, always picks the best match and adds immediately (no "pick one" follow-up).
 */
export async function addMedia(
  query: string,
  options?: { season?: number; type?: 'movie' | 'series' | 'music'; context?: MediaQueryContext; autoSelectBest?: boolean },
): Promise<MediaAddResult> {
  logger.info('Media add', { query, options });

  // Music: Lidarr (artist by name or "Song by Artist")
  if (options?.type === 'music') {
    const artists = await searchLidarr(query);
    if (artists.length === 0) {
      return { success: false, message: `Could not find "${query}" in Lidarr. Set LIDARR_API_KEY and LIDARR_URL if needed.` };
    }
    const first = artists[0];
    if (!first.foreignArtistId) {
      return { success: false, message: `No artist ID for "${first.name}"` };
    }
    return addLidarrArtist(first.foreignArtistId, first.name);
  }

  // Collection: "Lord of the Rings trilogy", "Die Hard collection"
  if (options?.context?.isCollection) {
    const tmdbId = resolveCollectionTmdbId(query);
    if (tmdbId) {
      return addRadarrCollection(tmdbId);
    }
    // No mapping — fall through to regular search; user may get multiple options
  }

  // Search first to find the best match (with context for disambiguation)
  const searchResult = await searchMedia(query, options?.context);
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

  // Auto-select best match: when requested, or when single near-exact match
  const topScore = titleSimilarity(query, candidates[0].title);
  const shouldAutoSelect = options?.autoSelectBest === true || (topScore >= 0.9 && candidates.length === 1);

  if (shouldAutoSelect) {
    const match = candidates[0];
    if (match.type === 'series' && match.tvdbId) {
      return addSonarrSeries(match.tvdbId, match.title, { season: options?.season });
    }
    if (match.type === 'movie' && match.tmdbId) {
      return addRadarrMovie(match.tmdbId, match.title);
    }
  }

  // Multiple candidates and not auto-selecting -- show options and let user pick
  allCandidates = candidates;
  pendingPage = 0;
  const top = candidates.slice(0, PAGE_SIZE);
  pendingResults = top;
  pendingQuery = { query, season: options?.season, type: options?.type, context: options?.context };

  let message = `Found ${candidates.length} result(s) for "${query}". Pick one:\n\n`;
  for (let i = 0; i < top.length; i++) {
    const r = top[i];
    const icon = r.type === 'movie' ? '🎬' : '📺';
    const inLib = r.inLibrary ? ' ✅' : '';
    const extra = r.type === 'series' && r.seasonCount ? ` (${r.seasonCount} seasons)` : '';
    message += `[${i + 1}] ${icon} ${r.title} (${r.year})${extra}${inLib}\n`;
  }
  message += `\nReply with a number (1-${top.length}) to download`;
  if (candidates.length > PAGE_SIZE) {
    message += `, or "more" for next page`;
  }
  message += '.';

  return { success: true, message };
}

/**
 * Split a batch download string into individual items.
 * Splits on comma, " and ", or newline. Trims and drops empty entries.
 *
 * Examples:
 *   "Inception 2010, Dune 2021" → ["Inception 2010", "Dune 2021"]
 *   "Breaking Bad season 1 and Better Call Saul" → ["Breaking Bad season 1", "Better Call Saul"]
 */
export function parseBatchDownloadInput(input: string): string[] {
  if (!input || !input.trim()) return [];
  const normalized = input
    .replace(/\s*,\s*/g, '\n')
    .replace(/\s+and\s+/gi, '\n')
    .split(/\n/)
    .map(s => s.trim())
    .filter(Boolean);
  return normalized;
}

/**
 * Get the combined download queue from Sonarr + Radarr.
 * Returns success: false with error message if APIs fail (never fabricates empty).
 */
export async function getDownloadQueue(): Promise<MediaQueueResult> {
  logger.info('Fetching download queue');

  const [sonarrResult, radarrResult] = await Promise.allSettled([
    getSonarrQueue(),
    getRadarrQueue(),
  ]);

  const errors: string[] = [];
  const sonarrQueue = sonarrResult.status === 'fulfilled' ? sonarrResult.value : [];
  const radarrQueue = radarrResult.status === 'fulfilled' ? radarrResult.value : [];
  if (sonarrResult.status === 'rejected') errors.push(sonarrResult.reason?.message || String(sonarrResult.reason));
  if (radarrResult.status === 'rejected') errors.push(radarrResult.reason?.message || String(radarrResult.reason));

  const queue = [...sonarrQueue, ...radarrQueue];

  if (errors.length > 0) {
    return {
      success: false,
      queue,
      message: `Error: ${errors.join('; ')}`,
    };
  }

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
 * Extracts title, season, type, and context (actor, year, platform) for better search.
 *
 * Examples:
 *   "Fallout season 2"                    → { query: "Fallout", season: 2 }
 *   "Hamilton, the one with Lin-Manuel"   → { query: "Hamilton", context: { actor: "Lin-Manuel Miranda" } }
 *   "Dune, the new one"                   → { query: "Dune", context: { platform: "new" } }
 */
export function parseMediaQuery(input: string): {
  query: string;
  season?: number;
  type?: 'movie' | 'series' | 'music';
  context?: MediaQueryContext;
} {
  let cleaned = input.trim();

  // Strip leading verbs
  cleaned = cleaned.replace(/^(?:download|get|find|search|add|grab|queue)\s+/i, '');

  // Extract context BEFORE stripping (actor, year, platform, collection)
  const context: MediaQueryContext = {};

  // "trilogy", "collection", "franchise", "all of them"
  if (/\b(trilogy|collection|franchise|franchises|all\s+(?:of\s+)?(?:the\s+)?(?:movies?|films?)|the\s+whole\s+series)\b/i.test(cleaned)) {
    context.isCollection = true;
    cleaned = cleaned.replace(/\b(?:trilogy|collection|franchise|franchises|all\s+(?:of\s+)?(?:the\s+)?(?:movies?|films?)|the\s+whole\s+series)\b/gi, '').trim();
  }

  // "with X" / "the one with X" / "starring X" / "with Lin-Manuel Miranda"
  const actorMatch = cleaned.match(/(?:the\s+one\s+with|with|starring|featuring)\s+([^.]+?)(?:,|$|\.|and\s)/i)
    || cleaned.match(/(?:the\s+one\s+with|with|starring|featuring)\s+([^.]+)$/i);
  if (actorMatch) {
    context.actor = actorMatch[1].trim().replace(/\s+/g, ' ');
    cleaned = cleaned.replace(actorMatch[0], ',').trim();
  }

  // Year: "the 2020 one", "from 2019", "the 2003 version"
  const yearMatch = cleaned.match(/(?:from|the)\s+(\d{4})\s*(?:one|version|film|movie|edition)?/i)
    || cleaned.match(/(?:the\s+)?(\d{4})\s+(?:one|version|film|movie)/i);
  if (yearMatch) {
    context.year = parseInt(yearMatch[1], 10);
    cleaned = cleaned.replace(yearMatch[0], ',').trim();
  }

  // Platform/format: disney, broadway, netflix, hbo, korean, etc.
  const platformMatch = cleaned.match(/(?:on\s+)?(disney|broadway|netflix|hbo|hulu|prime|amazon|korean|japanese|american|original|remake|new|old|villeneuve|lynch)/i);
  if (platformMatch) {
    context.platform = platformMatch[1].toLowerCase();
    cleaned = cleaned.replace(platformMatch[0], ',').trim();
  }

  // Extract season number
  const seasonMatch = cleaned.match(/\b(?:season|s)\s*(\d+)\b/i);
  const season = seasonMatch ? parseInt(seasonMatch[1], 10) : undefined;
  if (seasonMatch) cleaned = cleaned.replace(seasonMatch[0], '').trim();

  let type: 'movie' | 'series' | 'music' | undefined;

  // Music: "Song by Artist" or "Artist - Song" → artist name for Lidarr
  if (/\s+by\s+/i.test(cleaned)) {
    const byParts = cleaned.split(/\s+by\s+/i);
    if (byParts.length >= 2) {
      const song = byParts[0].trim();
      const artist = byParts.slice(1).join(' by ').trim();
      context.actor = artist;
      cleaned = artist;
      type = 'music';
    }
  } else if (/\s+[-–—]\s+/.test(cleaned)) {
    const dashParts = cleaned.split(/\s+[-–—]\s+/);
    if (dashParts.length >= 2 && !/\d{4}/.test(cleaned)) {
      const artist = dashParts[0].trim();
      const song = dashParts[1].trim();
      context.actor = artist;
      cleaned = artist;
      type = 'music';
    }
  }

  // Detect type hints (only if not already music)
  if (type !== 'music') {
    if (/\bmusic\b/i.test(cleaned)) {
      type = 'music';
      cleaned = cleaned.replace(/\bmusic\b/gi, '').trim();
    } else if (/\b(?:movie|film)\b/i.test(cleaned)) {
      type = 'movie';
      cleaned = cleaned.replace(/\b(?:the\s+)?(?:movie|film)\b/i, '').trim();
    } else if (/\b(?:show|series|tv)\b/i.test(cleaned)) {
      type = 'series';
      cleaned = cleaned.replace(/\b(?:the\s+)?(?:show|series|tv)\b/i, '').trim();
    } else if (season !== undefined) {
      type = 'series';
    }
  }

  // Strip generic qualifiers
  cleaned = cleaned.replace(/,?\s*(?:the\s+)?(?:korean|japanese|original|remake|dubbed|subbed)\s*(?:version|one|edition)?/gi, '');
  cleaned = cleaned.replace(/,?\s*(?:the\s+)?(?:old|new)\s+(?:version|one|edition|cut)/gi, '');
  cleaned = cleaned.replace(/,?\s*(?:from\s+\d{4}|by\s+\w+)/gi, '');
  cleaned = cleaned
    .replace(/^(?:the\s+)?(?:movie|show|series)\s+/i, '')
    .replace(/,+/g, ',')
    .replace(/\s*,\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  cleaned = cleaned.replace(/\s+the$/i, '').trim();

  const hasContext = context.actor || context.year || context.platform;
  return { query: cleaned, season, type, context: hasContext ? context : undefined };
}
