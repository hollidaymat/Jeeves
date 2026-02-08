/**
 * Alias Store
 * Persists learned aliases. When user confirms a fuzzy match, the phrase
 * is saved as an alias for that command. syncToRegistry() merges into commands at startup.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { COMMAND_REGISTRY } from './command-registry.js';
import { logger } from '../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ALIASES_PATH = `${__dirname}/../../data/aliases.json`;

export interface StoredAlias {
  phrase: string;
  commandId: string;
  useCount: number;
  lastUsed: string;
}

let aliases: StoredAlias[] = [];

async function loadAliases(): Promise<void> {
  try {
    const raw = await readFile(ALIASES_PATH, 'utf-8');
    aliases = JSON.parse(raw);
  } catch {
    aliases = [];
  }
}

async function saveAliases(): Promise<void> {
  try {
    await mkdir(dirname(ALIASES_PATH), { recursive: true });
    await writeFile(ALIASES_PATH, JSON.stringify(aliases, null, 2));
  } catch (err) {
    logger.warn('Failed to save aliases', { error: String(err) });
  }
}

/**
 * Add or increment alias for a command. Called when user confirms a fuzzy match.
 */
export async function addAlias(phrase: string, commandId: string): Promise<void> {
  const existing = aliases.find((a) => a.phrase.toLowerCase() === phrase.toLowerCase() && a.commandId === commandId);
  if (existing) {
    existing.useCount++;
    existing.lastUsed = new Date().toISOString();
  } else {
    aliases.push({
      phrase: phrase.trim(),
      commandId,
      useCount: 1,
      lastUsed: new Date().toISOString(),
    });
  }
  await saveAliases();
  syncToRegistry();
}

/**
 * Merge learned aliases into COMMAND_REGISTRY. Aliases with useCount >= 3 are promoted.
 */
export function syncToRegistry(): void {
  const promoted = aliases.filter((a) => a.useCount >= 3);
  for (const cmd of COMMAND_REGISTRY) {
    const existingAliases = new Set((cmd.aliases ?? []).map((a) => a.toLowerCase()));
    for (const a of promoted) {
      if (a.commandId === cmd.id && !existingAliases.has(a.phrase.toLowerCase())) {
        if (!cmd.aliases) cmd.aliases = [];
        cmd.aliases.push(a.phrase);
        existingAliases.add(a.phrase.toLowerCase());
      }
    }
  }
}

/**
 * Initialize: load aliases and sync to registry. Call at startup.
 */
export async function initAliasStore(): Promise<void> {
  await loadAliases();
  syncToRegistry();
}
