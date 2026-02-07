/**
 * Client Registry
 * 
 * CRUD operations for DiveConnect client records.
 * Persists to data/clients.json with lazy loading and write-through caching.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../../utils/logger.js';
import type { ClientData } from './client-template.js';

// ============================================================================
// Constants
// ============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, '../../../data');
const CLIENTS_PATH = join(DATA_DIR, 'clients.json');
const MAX_CLIENTS = 100;

// ============================================================================
// In-memory cache
// ============================================================================

interface ClientStore {
  clients: ClientData[];
  lastUpdated: string;
}

let store: ClientStore | null = null;

// ============================================================================
// Persistence
// ============================================================================

/**
 * Load clients from disk. Returns cached store if already loaded.
 */
function loadStore(): ClientStore {
  if (store) return store;

  try {
    if (existsSync(CLIENTS_PATH)) {
      const raw = readFileSync(CLIENTS_PATH, 'utf-8');
      store = JSON.parse(raw) as ClientStore;
      logger.debug('Client registry loaded', { count: store.clients.length });
      return store;
    }
  } catch (error) {
    logger.error('Failed to load client registry', { error: String(error) });
  }

  // Initialize empty store
  store = { clients: [], lastUpdated: '' };
  return store;
}

/**
 * Save the current store to disk.
 */
function saveStore(): void {
  if (!store) return;

  try {
    // Ensure data directory exists
    if (!existsSync(DATA_DIR)) {
      mkdirSync(DATA_DIR, { recursive: true });
    }

    store.lastUpdated = new Date().toISOString();
    writeFileSync(CLIENTS_PATH, JSON.stringify(store, null, 2), 'utf-8');
    logger.debug('Client registry saved', { count: store.clients.length });
  } catch (error) {
    logger.error('Failed to save client registry', { error: String(error) });
  }
}

// ============================================================================
// CRUD Operations
// ============================================================================

/**
 * Get all clients.
 */
export function getClients(): ClientData[] {
  const s = loadStore();
  return [...s.clients];
}

/**
 * Get a single client by ID.
 */
export function getClient(id: string): ClientData | null {
  const s = loadStore();
  return s.clients.find((c) => c.id === id) ?? null;
}

/**
 * Get a single client by slug.
 */
export function getClientBySlug(slug: string): ClientData | null {
  const s = loadStore();
  return s.clients.find((c) => c.slug === slug) ?? null;
}

/**
 * Add a new client. Throws if at capacity.
 */
export function addClient(client: ClientData): void {
  const s = loadStore();

  if (s.clients.length >= MAX_CLIENTS) {
    throw new Error(`Client registry is at capacity (${MAX_CLIENTS}). Archive or remove existing clients first.`);
  }

  // Check for duplicate slug
  if (s.clients.some((c) => c.slug === client.slug)) {
    throw new Error(`A client with slug "${client.slug}" already exists.`);
  }

  s.clients.push(client);
  saveStore();

  logger.info('Client added to registry', {
    id: client.id,
    slug: client.slug,
    businessName: client.businessName,
  });
}

/**
 * Update an existing client by ID. Merges partial updates.
 */
export function updateClient(id: string, updates: Partial<ClientData>): void {
  const s = loadStore();
  const index = s.clients.findIndex((c) => c.id === id);

  if (index === -1) {
    throw new Error(`Client not found: ${id}`);
  }

  // Prevent changing the ID
  const { id: _ignoredId, ...safeUpdates } = updates;

  s.clients[index] = { ...s.clients[index], ...safeUpdates };
  saveStore();

  logger.info('Client updated', { id, fields: Object.keys(safeUpdates) });
}

/**
 * Delete a client by ID.
 */
export function deleteClient(id: string): void {
  const s = loadStore();
  const index = s.clients.findIndex((c) => c.id === id);

  if (index === -1) {
    throw new Error(`Client not found: ${id}`);
  }

  const removed = s.clients.splice(index, 1)[0];
  saveStore();

  logger.info('Client deleted from registry', {
    id: removed.id,
    slug: removed.slug,
    businessName: removed.businessName,
  });
}
