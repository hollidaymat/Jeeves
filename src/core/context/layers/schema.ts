/**
 * Layer 1: Schema (Infrastructure Map)
 * 
 * Live inventory of everything Jeeves manages.
 * Auto-discovers containers, storage, networks from Docker + registry.
 * Queried every task (cheap -- local JSON read).
 */

import { getDb } from '../db.js';
import { logger } from '../../../utils/logger.js';

// ==========================================
// TYPES
// ==========================================

export interface ContainerInfo {
  name: string;
  image: string;
  ports: (number | string)[];
  status?: string;
  health?: string;
  tier?: string;
  ramLimit?: string;
  composePath?: string;
}

export interface StorageInfo {
  path: string;
  purpose: string;
  sizeGB?: number;
  usedGB?: number;
  availableGB?: number;
}

export interface NetworkInfo {
  name: string;
  driver: string;
  subnet?: string;
}

export interface ServerInfo {
  hostname?: string;
  ip?: string;
  os?: string;
  cpu?: string;
  ramTotalMB?: number;
  diskTotalGB?: number;
}

export interface SchemaSnapshot {
  server: ServerInfo;
  containers: Record<string, ContainerInfo>;
  storage: Record<string, StorageInfo>;
  networks: Record<string, NetworkInfo>;
  timestamp: number;
}

// ==========================================
// SCHEMA DISCOVERY
// ==========================================

/**
 * Build a schema snapshot from the service registry (works on any platform).
 * On Linux with Docker, could be enriched with live container data.
 */
export function buildSchemaFromRegistry(): SchemaSnapshot {
  const snapshot: SchemaSnapshot = {
    server: {
      hostname: 'daemon',
      ip: '192.168.7.50',
      os: 'Ubuntu 24.04 LTS',
      cpu: 'Intel N150 4-core',
      ramTotalMB: 16384,
      diskTotalGB: 512
    },
    containers: {},
    storage: {
      '/data/media': { path: '/data/media', purpose: 'media files' },
      '/data/downloads': { path: '/data/downloads', purpose: 'download staging' },
      '/data/downloads/quarantine': { path: '/data/downloads/quarantine', purpose: 'quarantine area' },
      '/opt/stacks': { path: '/opt/stacks', purpose: 'docker compose files' }
    },
    networks: {
      proxy: { name: 'proxy', driver: 'bridge' }
    },
    timestamp: Date.now()
  };

  // Service registry loaded asynchronously at first snapshot
  // See refreshSchema() for live data population

  return snapshot;
}

/**
 * Build schema snapshot with live data from service registry.
 * Async version that can import ESM modules.
 */
export async function buildSchemaFromRegistryAsync(): Promise<SchemaSnapshot> {
  const snapshot = buildSchemaFromRegistry();

  try {
    const registry = await import('../../../homelab/services/registry.js');
    if (registry && typeof registry.getAllServices === 'function') {
      const services = registry.getAllServices();
      for (const svc of services) {
        snapshot.containers[svc.name] = {
          name: svc.name,
          image: svc.image,
          ports: svc.ports || [],
          tier: svc.tier,
          composePath: `/opt/stacks/${svc.name}/docker-compose.yml`
        };
      }
    }
  } catch {
    logger.debug('Service registry not available for schema discovery');
  }

  return snapshot;
}

/**
 * Save a schema snapshot to the database.
 */
export function saveSnapshot(snapshot: SchemaSnapshot): void {
  const db = getDb();
  db.prepare('INSERT INTO schema_snapshots (data) VALUES (?)').run(
    JSON.stringify(snapshot)
  );

  // Keep only the last 10 snapshots
  db.prepare(`
    DELETE FROM schema_snapshots WHERE id NOT IN (
      SELECT id FROM schema_snapshots ORDER BY timestamp DESC LIMIT 10
    )
  `).run();
}

/**
 * Get the latest schema snapshot from the database.
 */
export function getLatestSnapshot(): SchemaSnapshot | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT data FROM schema_snapshots ORDER BY timestamp DESC LIMIT 1'
  ).get() as { data: string } | undefined;

  if (!row) return null;
  return JSON.parse(row.data);
}

/**
 * Get schema information relevant to specific entities.
 * Returns only the services/storage mentioned, plus server basics.
 */
export function getRelevantSchema(entities: string[]): Partial<SchemaSnapshot> | null {
  let snapshot = getLatestSnapshot();

  // If no snapshot exists, build one and save it
  if (!snapshot) {
    snapshot = buildSchemaFromRegistry();
    saveSnapshot(snapshot);
  }

  if (entities.length === 0) {
    // Return just server basics
    return {
      server: {
        ramTotalMB: snapshot.server.ramTotalMB,
        diskTotalGB: snapshot.server.diskTotalGB,
        ip: snapshot.server.ip
      },
      containers: {},
      storage: {},
      networks: {},
      timestamp: snapshot.timestamp
    };
  }

  // Filter to only relevant containers
  const relevantContainers: Record<string, ContainerInfo> = {};
  for (const entity of entities) {
    if (snapshot.containers[entity]) {
      relevantContainers[entity] = snapshot.containers[entity];
    }
  }

  return {
    server: {
      ramTotalMB: snapshot.server.ramTotalMB,
      diskTotalGB: snapshot.server.diskTotalGB,
      ip: snapshot.server.ip
    },
    containers: relevantContainers,
    storage: snapshot.storage,
    networks: snapshot.networks,
    timestamp: snapshot.timestamp
  };
}

/**
 * Refresh the schema snapshot (call periodically or on-demand).
 */
export function refreshSchema(): SchemaSnapshot {
  const snapshot = buildSchemaFromRegistry();
  saveSnapshot(snapshot);
  return snapshot;
}
