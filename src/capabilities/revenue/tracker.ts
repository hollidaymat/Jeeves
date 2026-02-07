/**
 * Revenue Tracker
 * 
 * Tracks revenue, costs, and profit for freelance projects.
 * Persists to data/revenue.json.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, '../../../data');
const REVENUE_PATH = join(DATA_DIR, 'revenue.json');

// ============================================================================
// Types
// ============================================================================

export interface RevenueEntry {
  id: string;
  client: string;
  charged: number;
  costs: { cursor: number; hosting: number; api: number };
  profit: number;
  startDate: string;
  completedDate?: string;
  status: 'in_progress' | 'completed' | 'cancelled';
}

interface RevenueFile {
  entries: RevenueEntry[];
  lastUpdated: string;
}

// ============================================================================
// Persistence
// ============================================================================

function loadRevenueFile(): RevenueFile {
  try {
    if (!existsSync(DATA_DIR)) {
      mkdirSync(DATA_DIR, { recursive: true });
    }

    if (existsSync(REVENUE_PATH)) {
      const content = readFileSync(REVENUE_PATH, 'utf-8');
      return JSON.parse(content) as RevenueFile;
    }
  } catch (error) {
    logger.error('Failed to load revenue data', { error: String(error) });
  }

  // Return default structure
  return { entries: [], lastUpdated: '' };
}

function saveRevenueFile(data: RevenueFile): void {
  try {
    if (!existsSync(DATA_DIR)) {
      mkdirSync(DATA_DIR, { recursive: true });
    }

    data.lastUpdated = new Date().toISOString();
    writeFileSync(REVENUE_PATH, JSON.stringify(data, null, 2));
    logger.debug('Revenue data saved', { entries: data.entries.length });
  } catch (error) {
    logger.error('Failed to save revenue data', { error: String(error) });
  }
}

// ============================================================================
// ID Generator
// ============================================================================

function generateId(): string {
  return `rev-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Add a new revenue entry. Returns the entry with a generated ID.
 */
export function addRevenueEntry(entry: Omit<RevenueEntry, 'id'>): RevenueEntry {
  const data = loadRevenueFile();

  const newEntry: RevenueEntry = {
    id: generateId(),
    ...entry,
  };

  data.entries.push(newEntry);
  saveRevenueFile(data);

  logger.info('Revenue entry added', {
    id: newEntry.id,
    client: newEntry.client,
    charged: newEntry.charged,
    profit: newEntry.profit,
  });

  return newEntry;
}

/**
 * Get all revenue entries.
 */
export function getRevenueEntries(): RevenueEntry[] {
  const data = loadRevenueFile();
  return data.entries;
}

/**
 * Update an existing revenue entry by ID.
 */
export function updateRevenueEntry(id: string, updates: Partial<RevenueEntry>): void {
  const data = loadRevenueFile();
  const index = data.entries.findIndex(e => e.id === id);

  if (index === -1) {
    logger.warn('Revenue entry not found for update', { id });
    return;
  }

  // Don't allow changing the ID
  const { id: _ignoreId, ...safeUpdates } = updates;
  data.entries[index] = { ...data.entries[index], ...safeUpdates };
  saveRevenueFile(data);

  logger.info('Revenue entry updated', { id, updates: Object.keys(safeUpdates) });
}

/**
 * Get a summary of all revenue data.
 */
export function getRevenueSummary(): {
  totalRevenue: number;
  totalCosts: number;
  totalProfit: number;
  projectCount: number;
  avgMargin: string;
} {
  const entries = getRevenueEntries();

  const totalRevenue = entries.reduce((sum, e) => sum + e.charged, 0);
  const totalCosts = entries.reduce((sum, e) => {
    return sum + e.costs.cursor + e.costs.hosting + e.costs.api;
  }, 0);
  const totalProfit = entries.reduce((sum, e) => sum + e.profit, 0);
  const projectCount = entries.length;

  const avgMargin = totalRevenue > 0
    ? `${((totalProfit / totalRevenue) * 100).toFixed(1)}%`
    : 'N/A';

  return {
    totalRevenue,
    totalCosts,
    totalProfit,
    projectCount,
    avgMargin,
  };
}
