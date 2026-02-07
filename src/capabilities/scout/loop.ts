/**
 * Knowledge Scout - Main Loop
 * Periodically checks registered sources for new findings.
 * Persists state to data/scout.json. Uses GitHub API for release
 * checks and child_process.exec for local command sources.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';

import { logger } from '../../utils/logger.js';
import type { ScoutSource, ScoutFinding } from './sources.js';
import { getDefaultSources } from './sources.js';
import { scoreRelevance } from './relevance.js';
import { addToDigest, setDigestQueue, getDigestQueue } from './digest.js';

const execAsync = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_PATH = join(__dirname, '../../../data/scout.json');

// ============================================================================
// Constants
// ============================================================================

/** Loop checks every 5 minutes which sources are due */
const LOOP_INTERVAL_MS = 300_000;

/** Maximum findings stored (FIFO) */
const MAX_FINDINGS = 200;

/** Minimum relevance score to include in digest */
const DIGEST_THRESHOLD = 50;

// ============================================================================
// Persisted state shape
// ============================================================================

interface ScoutState {
  sources: ScoutSource[];
  findings: ScoutFinding[];
  lastLoopRun: string;
  digestQueue: ScoutFinding[];
  /** Tracks last-known release tag per source target (e.g. "jellyfin/jellyfin" → "v10.9.0") */
  knownVersions?: Record<string, string>;
}

// ============================================================================
// In-memory state
// ============================================================================

let state: ScoutState = {
  sources: [],
  findings: [],
  lastLoopRun: '',
  digestQueue: [],
  knownVersions: {},
};

let loopTimer: ReturnType<typeof setInterval> | null = null;
let running = false;

// ============================================================================
// Persistence
// ============================================================================

function loadState(): void {
  try {
    if (existsSync(DATA_PATH)) {
      const raw = readFileSync(DATA_PATH, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<ScoutState>;
      state = {
        sources: parsed.sources ?? [],
        findings: parsed.findings ?? [],
        lastLoopRun: parsed.lastLoopRun ?? '',
        digestQueue: parsed.digestQueue ?? [],
        knownVersions: parsed.knownVersions ?? {},
      };
      // Restore digest queue in the digest module
      setDigestQueue(state.digestQueue);
      logger.debug('Scout state loaded', { sources: state.sources.length, findings: state.findings.length });
    }
  } catch (error) {
    logger.error('Failed to load scout state', { error: String(error) });
  }
}

function saveState(): void {
  try {
    // Sync digest queue from digest module
    state.digestQueue = getDigestQueue();

    const dir = dirname(DATA_PATH);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(DATA_PATH, JSON.stringify(state, null, 2));
    logger.debug('Scout state saved');
  } catch (error) {
    logger.error('Failed to save scout state', { error: String(error) });
  }
}

// ============================================================================
// Source checking
// ============================================================================

function isDue(source: ScoutSource): boolean {
  return Date.now() - source.lastChecked >= source.intervalMs;
}

/**
 * Build GitHub API request headers.
 * Uses GITHUB_TOKEN if available to avoid rate limits on public repos.
 */
function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'Jeeves-Scout/1.0',
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

/**
 * Check a GitHub release source.
 * Compares the latest tag_name against the last-known version.
 */
async function checkGitHubRelease(source: ScoutSource): Promise<ScoutFinding[]> {
  const [owner, repo] = source.target.split('/');
  if (!owner || !repo) {
    logger.warn('Invalid github_api target', { target: source.target });
    return [];
  }

  const url = `https://api.github.com/repos/${owner}/${repo}/releases/latest`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const res = await fetch(url, {
      headers: githubHeaders(),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      // 404 means no releases yet — not an error
      if (res.status === 404) return [];
      logger.warn('GitHub API error', { source: source.name, status: res.status });
      return [];
    }

    const data = await res.json() as {
      tag_name: string;
      name: string;
      html_url: string;
      body?: string;
      published_at?: string;
    };

    const knownVersions = state.knownVersions ?? {};
    const lastKnown = knownVersions[source.target];

    // If this is the first check, just record the version — no finding
    if (!lastKnown) {
      knownVersions[source.target] = data.tag_name;
      state.knownVersions = knownVersions;
      return [];
    }

    // No change
    if (data.tag_name === lastKnown) {
      return [];
    }

    // New release detected
    knownVersions[source.target] = data.tag_name;
    state.knownVersions = knownVersions;

    const findingType: ScoutFinding['type'] = source.type === 'tech' ? 'tech' : 'release';

    const finding: ScoutFinding = {
      id: randomUUID(),
      sourceId: source.name,
      type: findingType,
      severity: 'info',
      title: `${source.name}: ${lastKnown} → ${data.tag_name}`,
      summary: data.name || `New release ${data.tag_name} for ${source.target}`,
      detail: data.body?.slice(0, 500),
      url: data.html_url,
      relevanceScore: 0, // Will be scored below
      actionable: true,
      recommendedAction: `Consider updating ${source.target.split('/')[1]} to ${data.tag_name}`,
      timestamp: data.published_at ?? new Date().toISOString(),
      acknowledged: false,
    };

    return [finding];
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      logger.warn('GitHub API timeout', { source: source.name });
    } else {
      logger.error('GitHub release check failed', { source: source.name, error: String(error) });
    }
    return [];
  }
}

/**
 * Check a command-based source (npm audit, docker scout, etc.).
 */
async function checkCommand(source: ScoutSource): Promise<ScoutFinding[]> {
  try {
    const { stdout } = await execAsync(source.target, { timeout: 30000 });

    // Try to parse JSON output
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      // Non-JSON output — skip
      return [];
    }

    const findings: ScoutFinding[] = [];

    // npm audit format
    if (parsed && typeof parsed === 'object' && 'vulnerabilities' in (parsed as Record<string, unknown>)) {
      const audit = parsed as { vulnerabilities?: Record<string, { severity: string; name: string; via: unknown[] }> };
      if (audit.vulnerabilities) {
        for (const [name, vuln] of Object.entries(audit.vulnerabilities)) {
          const severity = (['high', 'medium', 'low', 'info'].includes(vuln.severity)
            ? vuln.severity
            : 'info') as ScoutFinding['severity'];

          findings.push({
            id: randomUUID(),
            sourceId: source.name,
            type: 'security',
            severity,
            title: `npm vulnerability: ${name}`,
            summary: `${vuln.severity} severity vulnerability in ${name}`,
            relevanceScore: 0,
            actionable: true,
            recommendedAction: `Run: npm audit fix`,
            timestamp: new Date().toISOString(),
            acknowledged: false,
          });
        }
      }
    }

    // Docker scout returns an array of CVEs
    if (Array.isArray(parsed)) {
      for (const cve of parsed as Array<{ id?: string; severity?: string; description?: string }>) {
        if (cve.id) {
          const severity = (['high', 'medium', 'low', 'info'].includes(cve.severity ?? '')
            ? cve.severity
            : 'medium') as ScoutFinding['severity'];

          findings.push({
            id: randomUUID(),
            sourceId: source.name,
            type: 'security',
            severity,
            title: `Docker CVE: ${cve.id}`,
            summary: cve.description ?? `CVE ${cve.id} found in container images`,
            relevanceScore: 0,
            actionable: true,
            recommendedAction: 'Review and update affected container images',
            timestamp: new Date().toISOString(),
            acknowledged: false,
          });
        }
      }
    }

    return findings;
  } catch (error) {
    logger.error('Command source check failed', { source: source.name, error: String(error) });
    return [];
  }
}

// ============================================================================
// Relevance context — detect running services / active deps
// ============================================================================

function getRelevanceContext(): { runningServices: string[]; activeProjects: string[] } {
  // Best-effort: these are the services we track via sources
  // On a real homelab, this would query Docker / systemd
  const runningServices = state.sources
    .filter(s => s.type === 'github_release' && s.enabled)
    .map(s => s.target.split('/')[1]?.toLowerCase() ?? '');

  const activeProjects = state.sources
    .filter(s => s.type === 'tech' && s.enabled)
    .map(s => {
      const repo = s.target.split('/')[1]?.toLowerCase() ?? '';
      // Map repo names to package names
      if (repo === 'next.js') return 'next';
      if (repo === 'tailwindcss') return 'tailwindcss';
      return repo;
    });

  return { runningServices, activeProjects };
}

// ============================================================================
// Main loop tick
// ============================================================================

async function tick(): Promise<void> {
  state.lastLoopRun = new Date().toISOString();

  const dueSources = state.sources.filter(s => s.enabled && isDue(s));
  if (dueSources.length === 0) return;

  logger.info('Scout loop tick', { dueSources: dueSources.length, totalSources: state.sources.length });

  const context = getRelevanceContext();

  for (const source of dueSources) {
    let newFindings: ScoutFinding[] = [];

    try {
      switch (source.checkMethod) {
        case 'github_api':
          newFindings = await checkGitHubRelease(source);
          break;
        case 'command':
          newFindings = await checkCommand(source);
          break;
        case 'web':
          // Web sources not yet implemented
          logger.debug('Web source check not yet implemented', { source: source.name });
          break;
      }
    } catch (error) {
      logger.error('Scout source check error', { source: source.name, error: String(error) });
    }

    // Score each finding
    for (const finding of newFindings) {
      finding.relevanceScore = await scoreRelevance(finding, context);

      // Add to digest if relevant enough
      if (finding.relevanceScore >= DIGEST_THRESHOLD) {
        addToDigest(finding);
      }
    }

    // Store findings (FIFO, max 200)
    state.findings.push(...newFindings);
    if (state.findings.length > MAX_FINDINGS) {
      state.findings = state.findings.slice(-MAX_FINDINGS);
    }

    // Update last checked
    source.lastChecked = Date.now();

    logger.info('Scout checked source', { name: source.name, findingsCount: newFindings.length });
  }

  saveState();
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Start the scout loop. Initialises sources from defaults if none are persisted.
 */
export function startScoutLoop(): void {
  if (running) {
    logger.warn('Scout loop already running');
    return;
  }

  loadState();

  // Initialise with default sources if empty
  if (state.sources.length === 0) {
    state.sources = getDefaultSources();
    saveState();
    logger.info('Scout initialised with default sources', { count: state.sources.length });
  }

  running = true;

  // Run first tick immediately (non-blocking)
  tick().catch(err => logger.error('Scout tick error', { error: String(err) }));

  // Then schedule recurring ticks
  loopTimer = setInterval(() => {
    tick().catch(err => logger.error('Scout tick error', { error: String(err) }));
  }, LOOP_INTERVAL_MS);

  logger.info('Scout loop started', { intervalMs: LOOP_INTERVAL_MS, sources: state.sources.length });
}

/**
 * Stop the scout loop.
 */
export function stopScoutLoop(): void {
  if (loopTimer) {
    clearInterval(loopTimer);
    loopTimer = null;
  }
  running = false;
  saveState();
  logger.info('Scout loop stopped');
}

/**
 * Get current scout status.
 */
export function getScoutStatus(): {
  running: boolean;
  sources: number;
  enabledSources: number;
  findings: number;
  digestQueue: number;
  lastLoopRun: string;
} {
  return {
    running,
    sources: state.sources.length,
    enabledSources: state.sources.filter(s => s.enabled).length,
    findings: state.findings.length,
    digestQueue: getDigestQueue().length,
    lastLoopRun: state.lastLoopRun,
  };
}

/**
 * Get all stored findings, optionally filtered.
 */
export function getFindings(opts?: {
  type?: ScoutFinding['type'];
  severity?: ScoutFinding['severity'];
  unacknowledged?: boolean;
  limit?: number;
}): ScoutFinding[] {
  let results = [...state.findings];

  if (opts?.type) {
    results = results.filter(f => f.type === opts.type);
  }
  if (opts?.severity) {
    results = results.filter(f => f.severity === opts.severity);
  }
  if (opts?.unacknowledged) {
    results = results.filter(f => !f.acknowledged);
  }

  // Most recent first
  results.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  if (opts?.limit) {
    results = results.slice(0, opts.limit);
  }

  return results;
}

/**
 * Acknowledge one or more findings by ID.
 */
export function acknowledgeFindings(ids: string[]): number {
  let count = 0;
  const idSet = new Set(ids);

  for (const finding of state.findings) {
    if (idSet.has(finding.id) && !finding.acknowledged) {
      finding.acknowledged = true;
      count++;
    }
  }

  if (count > 0) {
    saveState();
    logger.info('Findings acknowledged', { count });
  }

  return count;
}
