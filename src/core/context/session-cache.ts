/**
 * Context session cache: reuse assembled context for the same topic within TTL.
 * Reduces repeated 6-layer assembly when the user sends follow-up messages.
 */

export interface ContextSession {
  id: string;
  topic: string;
  assembledContext: string;
  layersLoaded: string[];
  tokensUsed: number;
  createdAt: number;
  lastAccessedAt: number;
  hitCount: number;
}

const sessions = new Map<string, ContextSession>();
const SESSION_TTL = 5 * 60 * 1000; // 5 minutes
const MAX_SESSIONS = 10;

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

function topicSimilarity(a: string, b: string): number {
  const setA = new Set(a.split('_'));
  const setB = new Set(b.split('_'));
  const intersection = new Set([...setA].filter((x) => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

export function getCachedSession(message: string): ContextSession | null {
  const fingerprint = getTopicFingerprint(message);
  const now = Date.now();

  for (const [key, session] of sessions) {
    if (now - session.lastAccessedAt > SESSION_TTL) {
      sessions.delete(key);
    }
  }

  for (const [key, session] of sessions) {
    if (key === fingerprint || topicSimilarity(key, fingerprint) > 0.7) {
      session.lastAccessedAt = now;
      session.hitCount++;
      return session;
    }
  }

  return null;
}

export function cacheSession(
  message: string,
  assembledContext: string,
  layersLoaded: string[],
  tokensUsed: number
): void {
  const fingerprint = getTopicFingerprint(message);

  if (sessions.size >= MAX_SESSIONS) {
    let oldest: [string, ContextSession] | null = null;
    for (const entry of sessions) {
      if (!oldest || entry[1].lastAccessedAt < oldest[1].lastAccessedAt) {
        oldest = entry;
      }
    }
    if (oldest) sessions.delete(oldest[0]);
  }

  sessions.set(fingerprint, {
    id: `session_${Date.now()}`,
    topic: fingerprint,
    assembledContext,
    layersLoaded,
    tokensUsed,
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
    hitCount: 1,
  });
}

export function invalidateSessionsForFile(filePath: string): void {
  const fileName = (filePath.split('/').pop() ?? '').replace(/\.[^.]+$/, '').toLowerCase();
  if (!fileName) return;
  for (const [key] of sessions) {
    if (key.includes(fileName)) {
      sessions.delete(key);
    }
  }
}
