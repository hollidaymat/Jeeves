/**
 * Command Matcher
 * Matches messages against the command registry. Replaces parsePatternsOnly and handleSimpleCommand.
 */

import { COMMAND_REGISTRY, type Command } from './command-registry.js';
import type { ActionType } from '../types/index.js';

export interface MatchResult {
  commandId: string;
  command: Command;
  action: ActionType;
  params: Record<string, unknown>;
  confidence: number;
}

/** Special keys extract() can return: _skip = reject match, _action = override command.action */
const EXTRACT_SPECIAL = ['_skip', '_action'] as const;

/**
 * Match a message against the command registry.
 * Returns the first matching command, or null if none match.
 */
export function matchCommand(message: string): MatchResult | null {
  const trimmed = message.trim();
  if (!trimmed) return null;

  for (const command of COMMAND_REGISTRY) {
    const result = tryMatchCommand(command, trimmed);
    if (result) return result;
  }
  return null;
}

function tryMatchCommand(command: Command, message: string): MatchResult | null {
  // 1. Check aliases (exact, case-insensitive)
  const aliases = command.aliases ?? [];
  if (aliases.some((a) => a.toLowerCase() === message.toLowerCase())) {
    return buildResult(command, command.action, {}, 1.0);
  }

  // 2. Check patterns
  for (const pattern of command.patterns) {
    const match = message.match(pattern);
    if (!match) continue;

    let params: Record<string, unknown> = {};
    let action = command.action;

    if (command.extract) {
      const extracted = command.extract(match, message);
      if (extracted && (extracted as { _skip?: boolean })._skip) {
        continue; // Reject this match, try next command
      }
      if (extracted) {
        if ('_action' in extracted && typeof (extracted as { _action?: string })._action === 'string') {
          action = (extracted as { _action: string })._action;
        }
        for (const [k, v] of Object.entries(extracted)) {
          if (!EXTRACT_SPECIAL.includes(k as (typeof EXTRACT_SPECIAL)[number])) {
            params[k] = v;
          }
        }
      }
    }

    return buildResult(command, action, params, 0.9);
  }

  return null;
}

function buildResult(
  command: Command,
  action: string,
  params: Record<string, unknown>,
  confidence: number
): MatchResult {
  return {
    commandId: command.id,
    command,
    action: action as ActionType,
    params,
    confidence,
  };
}

/**
 * Convert MatchResult to ParsedIntent shape for executeCommand().
 */
export function matchResultToParsedIntent(match: MatchResult) {
  const target = match.params.target;
  return {
    action: match.action,
    target: typeof target === 'string' ? target : undefined,
    ...match.params,
    confidence: match.confidence,
    resolutionMethod: 'registry' as const,
    estimatedCost: 0,
  };
}
