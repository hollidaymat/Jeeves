/**
 * File Sharing via Signal
 * Send server files as Signal attachments, limited to whitelisted directories.
 */

import { existsSync, statSync, readdirSync } from 'fs';
import { resolve, basename, dirname } from 'path';
import { logger } from '../../utils/logger.js';

// Whitelisted directories for file sharing
const ALLOWED_DIRS = [
  '/opt/stacks',
  '/home/jeeves/signal-cursor-controller',
  '/tmp/jeeves-grafana',
  '/tmp/jeeves-screenshots',
  '/home/jeeves',
];

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

/**
 * Check if a path is within allowed directories.
 */
function isPathAllowed(filePath: string): boolean {
  const resolved = resolve(filePath);
  return ALLOWED_DIRS.some(dir => resolved.startsWith(dir));
}

/**
 * Resolve a file path, supporting partial paths and docker-compose shortcuts.
 */
export function resolveFilePath(input: string): string | null {
  // Direct path
  if (existsSync(input) && isPathAllowed(input)) {
    return resolve(input);
  }

  // Try as relative to /opt/stacks
  const stackPath = `/opt/stacks/${input}`;
  if (existsSync(stackPath) && isPathAllowed(stackPath)) {
    return resolve(stackPath);
  }

  // Try as a stack name (look for docker-compose.yml)
  const composePath = `/opt/stacks/${input}/docker-compose.yml`;
  if (existsSync(composePath)) {
    return resolve(composePath);
  }
  const composeYaml = `/opt/stacks/${input}/docker-compose.yaml`;
  if (existsSync(composeYaml)) {
    return resolve(composeYaml);
  }

  return null;
}

/**
 * Validate a file for sharing (size, existence, permissions).
 */
export function validateFileForSharing(filePath: string): { valid: boolean; error?: string; path?: string; size?: number } {
  const resolved = resolveFilePath(filePath);

  if (!resolved) {
    return { valid: false, error: `File not found or not in an allowed directory: ${filePath}` };
  }

  if (!isPathAllowed(resolved)) {
    return { valid: false, error: `Access denied. Only files in ${ALLOWED_DIRS.join(', ')} can be shared.` };
  }

  try {
    const stat = statSync(resolved);

    if (stat.isDirectory()) {
      // List directory contents instead
      const files = readdirSync(resolved).slice(0, 20);
      return { valid: false, error: `That's a directory. Files inside:\n${files.join('\n')}` };
    }

    if (stat.size > MAX_FILE_SIZE) {
      return { valid: false, error: `File too large (${(stat.size / 1024 / 1024).toFixed(1)} MB). Max is 50MB.` };
    }

    return { valid: true, path: resolved, size: stat.size };
  } catch (error) {
    return { valid: false, error: `Cannot read file: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Get info about a file for sharing.
 */
export function getFileInfo(filePath: string): string {
  const result = validateFileForSharing(filePath);
  if (!result.valid) return result.error!;

  const name = basename(result.path!);
  const sizeKB = Math.round((result.size || 0) / 1024);

  return `${name} (${sizeKB} KB) — ready to send`;
}
