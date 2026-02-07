/**
 * Layer 2: Annotations (Owner Rules & Preferences)
 * 
 * Human-curated rules that override defaults.
 * Preferences, policies, exceptions discovered through interaction.
 * Seeded from known preferences, updated via learning.
 */

import { getDb, generateId } from '../db.js';
import { logger } from '../../../utils/logger.js';

// ==========================================
// TYPES
// ==========================================

export interface Annotation {
  id: string;
  category: 'preference' | 'policy' | 'exception';
  key: string;
  value: string;  // JSON-encoded value
  addedAt: number;
  source: 'seed' | 'learned' | 'user-confirmed';
}

export interface AnnotationSet {
  preferences: Record<string, unknown>;
  policies: Record<string, unknown>;
  exceptions: Array<{ rule: string; exception: string }>;
}

// ==========================================
// SEED DATA
// ==========================================

const SEED_ANNOTATIONS: Array<Omit<Annotation, 'id' | 'addedAt'>> = [
  // Media preferences
  { category: 'preference', key: 'media.preferred_quality', value: '"1080p"', source: 'seed' },
  { category: 'preference', key: 'media.confirm_before_download', value: 'true', source: 'seed' },
  { category: 'preference', key: 'media.max_results_per_page', value: '5', source: 'seed' },
  { category: 'preference', key: 'media.quarantine_enabled', value: 'true', source: 'seed' },

  // Communication preferences
  { category: 'preference', key: 'communication.verbosity', value: '"concise"', source: 'seed' },
  { category: 'preference', key: 'communication.checkpoint_frequency', value: '"per-phase"', source: 'seed' },
  { category: 'preference', key: 'communication.notify_on_completion', value: 'true', source: 'seed' },
  { category: 'preference', key: 'communication.notify_on_error', value: 'true', source: 'seed' },

  // Docker preferences
  { category: 'preference', key: 'docker.inter_service_urls', value: '"use container names on shared network, not IPs"', source: 'seed' },
  { category: 'preference', key: 'docker.network', value: '"proxy"', source: 'seed' },

  // System preferences
  { category: 'preference', key: 'system.static_ip', value: '"192.168.7.50"', source: 'seed' },

  // Git preferences
  { category: 'preference', key: 'git.no_coauthor_tags', value: 'true', source: 'seed' },

  // Policies
  { category: 'policy', key: 'policies.never_auto_restart', value: '["postgres", "vaultwarden"]', source: 'seed' },
  { category: 'policy', key: 'policies.always_teardown_before_reinstall', value: 'true', source: 'seed' },
  { category: 'policy', key: 'policies.always_backup_before', value: '["upgrade", "migration", "config-change"]', source: 'seed' },
  { category: 'policy', key: 'policies.max_concurrent_downloads', value: '3', source: 'seed' },
  { category: 'policy', key: 'policies.kill_order', value: '["lidarr", "bazarr", "overseerr", "tautulli", "sonarr", "radarr"]', source: 'seed' },
  { category: 'policy', key: 'policies.never_kill', value: '["postgres", "redis", "traefik", "pihole", "tailscale"]', source: 'seed' },
];

// ==========================================
// DATABASE OPERATIONS
// ==========================================

/**
 * Seed the annotations table with known preferences (idempotent).
 */
export function seedAnnotations(): void {
  const db = getDb();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO annotations (id, category, key, value, source)
    VALUES (?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction(() => {
    for (const ann of SEED_ANNOTATIONS) {
      const id = `seed-${ann.key}`;
      insert.run(id, ann.category, ann.key, ann.value, ann.source);
    }
  });

  insertMany();
  logger.debug('Annotations seeded', { count: SEED_ANNOTATIONS.length });
}

/**
 * Get all annotations.
 */
export function getAllAnnotations(): Annotation[] {
  const db = getDb();
  return db.prepare('SELECT * FROM annotations ORDER BY category, key').all() as Annotation[];
}

/**
 * Get a specific annotation value by key.
 */
export function getAnnotation(key: string): unknown | null {
  const db = getDb();
  const row = db.prepare('SELECT value FROM annotations WHERE key = ?').get(key) as { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

/**
 * Set or update an annotation.
 */
export function setAnnotation(
  key: string,
  value: unknown,
  category: 'preference' | 'policy' | 'exception' = 'preference',
  source: 'seed' | 'learned' | 'user-confirmed' = 'learned'
): void {
  const db = getDb();
  const id = `ann-${key}`;
  const serialized = JSON.stringify(value);

  db.prepare(`
    INSERT INTO annotations (id, category, key, value, source)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      value = excluded.value,
      source = excluded.source,
      added_at = strftime('%s', 'now')
  `).run(id, category, key, serialized, source);

  logger.debug('Annotation set', { key, value, source });
}

/**
 * Get annotations relevant to a specific task/message.
 * Returns only applicable preferences and policies.
 */
export function getRelevantAnnotations(message: string, entities: string[]): AnnotationSet | null {
  const db = getDb();
  const all = db.prepare('SELECT * FROM annotations').all() as Array<{
    id: string;
    category: string;
    key: string;
    value: string;
    source: string;
  }>;

  if (all.length === 0) {
    // Auto-seed if empty
    seedAnnotations();
    return getRelevantAnnotations(message, entities);
  }

  const lower = message.toLowerCase();
  const result: AnnotationSet = {
    preferences: {},
    policies: {},
    exceptions: []
  };

  for (const row of all) {
    const keyParts = row.key.split('.');
    const domain = keyParts[0]; // e.g., 'media', 'docker', 'policies'
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value);
    } catch {
      parsed = row.value;
    }

    // Always include communication preferences
    if (domain === 'communication') {
      result.preferences[row.key] = parsed;
      continue;
    }

    // Include policies that mention relevant services
    if (row.category === 'policy') {
      if (Array.isArray(parsed)) {
        const hasRelevant = entities.some(e => (parsed as string[]).includes(e));
        if (hasRelevant || entities.length === 0) {
          result.policies[row.key] = parsed;
        }
      } else {
        result.policies[row.key] = parsed;
      }
      continue;
    }

    // Include domain-relevant preferences
    if (lower.includes(domain) || domain === 'system' || domain === 'docker') {
      result.preferences[row.key] = parsed;
      continue;
    }

    // Media preferences for media-related tasks
    if (domain === 'media' && /\b(download|media|movie|show|series|music|search|find)\b/i.test(lower)) {
      result.preferences[row.key] = parsed;
      continue;
    }

    // Git preferences for git-related tasks
    if (domain === 'git' && /\b(git|commit|push|pull|branch)\b/i.test(lower)) {
      result.preferences[row.key] = parsed;
    }

    // Exceptions
    if (row.category === 'exception') {
      result.exceptions.push({
        rule: row.key,
        exception: typeof parsed === 'string' ? parsed : JSON.stringify(parsed)
      });
    }
  }

  // Return null if nothing relevant found
  const hasContent = Object.keys(result.preferences).length > 0 ||
    Object.keys(result.policies).length > 0 ||
    result.exceptions.length > 0;

  return hasContent ? result : null;
}

/**
 * Propose an annotation based on repeated behavior.
 * Returns a human-readable proposal string.
 */
export function proposeAnnotation(
  key: string,
  value: unknown,
  reason: string
): string {
  return `I've noticed: ${reason}\nShould I add a rule: "${key}" = ${JSON.stringify(value)}?`;
}
