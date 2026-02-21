/**
 * Context session cache: reuse assembled context for the same topic within TTL.
 * Reduces repeated 6-layer assembly when the user sends follow-up messages.
 * Supports project-scoped keys and optional disk persistence.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

export interface ContextSession {
  id: string;
  topic: string;
  assembledContext: string;
  layersLoaded: string[];
  tokensUsed: number;
  createdAt: number;
  lastAccessedAt: number;
  hitCount: number;
  projectPath?: string;
  action?: string;
}

const sessions = new Map<string, ContextSession>();
const SESSION_TTL = parseInt(process.env.CONTEXT_CACHE_TTL_MS || '900000', 10) || 15 * 60 * 1000; // 15 min default
const MAX_SESSIONS = parseInt(process.env.CONTEXT_CACHE_MAX_SESSIONS || '20', 10) || 20;
const CACHE_FILE = join(process.cwd(), 'data', 'context-cache.json');

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'shall', 'should',
  'may', 'might', 'must', 'can', 'could', 'i', 'you', 'he', 'she', 'it', 'we', 'they',
  'me', 'him', 'her', 'us', 'them', 'my', 'your', 'his', 'its', 'our', 'their',
  'this', 'that', 'these', 'those', 'what', 'which', 'who', 'whom', 'how', 'when',
  'where', 'why', 'not', 'no', 'yes', 'just', 'also', 'very', 'too', 'only',
]);

export function getTopicFingerprint(message: string): string {
  const words = message
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w: string) => w.length > 2 && !STOP_WORDS.has(w))
    .sort();
  return words.join('_');
}

function buildCacheKey(message: string, projectPath?: string, action?: string): string {
  const fingerprint = getTopicFingerprint(message);
  const proj = (projectPath || '').replace(/\//g, '_');
  const act = action || '';
  return `${proj}|${act}|${fingerprint}`;
}

function topicSimilarity(a: string, b: string): number {
  const setA = new Set(a.split('_'));
  const setB = new Set(b.split('_'));
  const intersection = new Set([...setA].filter((x) => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

export interface GetCachedSessionOptions {
  projectPath?: string;
  action?: string;
}

export function getCachedSession(message: string, options?: GetCachedSessionOptions): ContextSession | null {
  loadFromDisk();
  const key = buildCacheKey(message, options?.projectPath, options?.action);
  const now = Date.now();

  for (const [k, session] of sessions) {
    if (now - session.lastAccessedAt > SESSION_TTL) {
      sessions.delete(k);
    }
  }

  const parts = key.split('|');
  const fingerprint = parts.slice(2).join('|');
  for (const [k, session] of sessions) {
    const kParts = k.split('|');
    const kFingerprint = kParts.slice(2).join('|');
    const sameProjAct = kParts[0] === parts[0] && kParts[1] === parts[1];
    if (sameProjAct && (k === key || topicSimilarity(kFingerprint, fingerprint) > 0.7)) {
      session.lastAccessedAt = now;
      session.hitCount++;
      return session;
    }
  }

  return null;
}

export interface CacheSessionOptions {
  projectPath?: string;
  action?: string;
}

export function cacheSession(
  message: string,
  assembledContext: string,
  layersLoaded: string[],
  tokensUsed: number,
  options?: CacheSessionOptions
): void {
  const key = buildCacheKey(message, options?.projectPath, options?.action);

  if (sessions.size >= MAX_SESSIONS) {
    let oldest: [string, ContextSession] | null = null;
    for (const entry of sessions) {
      if (!oldest || entry[1].lastAccessedAt < oldest[1].lastAccessedAt) {
        oldest = entry;
      }
    }
    if (oldest) sessions.delete(oldest[0]);
  }

  sessions.set(key, {
    id: `session_${Date.now()}`,
    topic: key,
    assembledContext,
    layersLoaded,
    tokensUsed,
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
    hitCount: 1,
    projectPath: options?.projectPath,
    action: options?.action,
  });
  persistToDisk();
}

export function invalidateSessionsForFile(filePath: string): void {
  const fileName = (filePath.split('/').pop() ?? '').replace(/\.[^.]+$/, '').toLowerCase();
  if (!fileName) return;
  for (const [key] of sessions) {
    if (key.includes(fileName)) {
      sessions.delete(key);
    }
  }
  persistToDisk();
}

export function invalidateSessionsForProject(projectPath: string): void {
  const proj = projectPath.replace(/\//g, '_');
  for (const [key] of sessions) {
    if (key.startsWith(proj + '|')) {
      sessions.delete(key);
    }
  }
  persistToDisk();
}

let loadAttempted = false;

function loadFromDisk(): void {
  if (loadAttempted || process.env.CONTEXT_CACHE_PERSIST !== 'true') return;
  loadAttempted = true;
  try {
    if (existsSync(CACHE_FILE)) {
      const raw = readFileSync(CACHE_FILE, 'utf-8');
      const data = JSON.parse(raw) as Array<{ key: string; session: ContextSession }>;
      const cutoff = Date.now() - SESSION_TTL;
      for (const { key, session } of data) {
        if (session.lastAccessedAt > cutoff && sessions.size < MAX_SESSIONS) {
          sessions.set(key, session);
        }
      }
    }
  } catch {
    // ignore
  }
}

function persistToDisk(): void {
  if (process.env.CONTEXT_CACHE_PERSIST !== 'true') return;
  try {
    const dir = join(process.cwd(), 'data');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const data = Array.from(sessions.entries()).map(([key, session]) => ({ key, session }));
    writeFileSync(CACHE_FILE, JSON.stringify(data), 'utf-8');
  } catch {
    // ignore
  }
}
