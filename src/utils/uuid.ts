// smoke test Final
// smoke test Final
// smoke test Final
// Jeeves learned this
/**
 * UUID Utility
 * Centralized UUID generation for the application
 */

import { randomUUID } from 'crypto';

/**
 * Generate a new UUID v4
 * @returns A new UUID string
 */
export function generateUUID(): string {
  return randomUUID();
}

/**
 * Validate if a string is a valid UUID
 * @param uuid - String to validate
 * @returns True if valid UUID format
 */
export function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

/**
 * Generate a short UUID (first 8 characters)
 * Useful for display purposes where full UUID is too long
 * @returns Short UUID string
 */
export function generateShortUUID(): string {
  return randomUUID().split('-')[0];
}
