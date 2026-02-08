/**
 * Fuzzy Matcher
 * When patterns don't match, try Levenshtein distance against command examples.
 * Used to offer "Did you mean: X?" before falling back to LLM.
 */

import { COMMAND_REGISTRY } from './command-registry.js';
/** Levenshtein distance between two strings */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array(m + 1)
    .fill(null)
    .map(() => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}

/** Similarity score 0-1 (1 = identical) */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const maxLen = Math.max(a.length, b.length);
  const dist = levenshtein(a.toLowerCase(), b.toLowerCase());
  return 1 - dist / maxLen;
}

export interface FuzzyMatch {
  commandId: string;
  confidence: number;
  suggestion: string;
  bestExample: string;
}

const MIN_SIMILARITY = 0.6;

/**
 * Find best fuzzy match against command examples.
 * Returns null if no match >= MIN_SIMILARITY.
 */
export function fuzzyMatch(message: string): FuzzyMatch | null {
  const trimmed = message.trim().toLowerCase();
  if (!trimmed || trimmed.length < 2) return null;

  let best: { commandId: string; confidence: number; suggestion: string; bestExample: string } | null = null;

  for (const cmd of COMMAND_REGISTRY) {
    for (const ex of cmd.examples) {
      const exLower = ex.toLowerCase();
      const sim = similarity(trimmed, exLower);
      if (sim >= MIN_SIMILARITY && (!best || sim > best.confidence)) {
        best = {
          commandId: cmd.id,
          confidence: sim,
          suggestion: ex,
          bestExample: ex,
        };
      }
    }
    for (const alias of cmd.aliases ?? []) {
      const aliasLower = alias.toLowerCase();
      const sim = similarity(trimmed, aliasLower);
      if (sim >= MIN_SIMILARITY && (!best || sim > best.confidence)) {
        best = {
          commandId: cmd.id,
          confidence: sim,
          suggestion: alias,
          bestExample: alias,
        };
      }
    }
  }

  return best;
}
