/**
 * Zep long-horizon memory client (@getzep/zep-js).
 * Optional: when ZEP_API_URL and ZEP_API_KEY are set, provides session memory for context assembly.
 * Reference: ai-engineering-hub zep-memory-assistant, agent-with-mcp-memory, context-engineering-workflow
 */

import { ZepClient } from '@getzep/zep-js';
import { logger } from '../../utils/logger.js';

let _client: ZepClient | null = null;

function getClient(): ZepClient | null {
  const url = process.env.ZEP_API_URL;
  const key = process.env.ZEP_API_KEY ?? '';
  if (!url || !key) return null;
  if (!_client) {
    try {
      _client = new ZepClient({
        baseUrl: url.replace(/\/$/, ''),
        apiKey: key,
      });
    } catch (e) {
      logger.warn('[zep-client] Failed to init ZepClient', { error: String(e) });
      return null;
    }
  }
  return _client;
}

export function isZepAvailable(): boolean {
  return !!(process.env.ZEP_API_URL && process.env.ZEP_API_KEY);
}

export interface ZepMemoryContext {
  summary?: string;
  recentMessages?: string;
}

/**
 * Get memory context for a session (summary + recent messages) for injection into assembler.
 */
export async function getZepMemoryContext(sessionId: string): Promise<ZepMemoryContext | null> {
  const client = getClient();
  if (!client) return null;

  try {
    const memory = await client.memory.get(sessionId);
    if (!memory) return null;

    const parts: string[] = [];
    if (memory.summary?.content) {
      parts.push(`Summary: ${memory.summary.content}`);
    }
    if (memory.messages && memory.messages.length > 0) {
      const recent = memory.messages
        .slice(-5)
        .map((m) => `${m.role ?? 'unknown'}: ${(m.content ?? '').slice(0, 300)}`)
        .join('\n');
      if (recent) parts.push(`Recent:\n${recent}`);
    }
    if (parts.length === 0) return null;

    return {
      summary: memory.summary?.content,
      recentMessages: parts.join('\n\n'),
    };
  } catch (e) {
    logger.debug('[zep-client] get memory failed', { sessionId, error: String(e) });
    return null;
  }
}

/**
 * Add messages to a Zep session.
 */
export async function addZepMemory(
  sessionId: string,
  messages: Array<{ role: string; content: string }>
): Promise<void> {
  const client = getClient();
  if (!client) return;

  try {
    await client.memory.add(sessionId, {
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    });
  } catch (e) {
    logger.debug('[zep-client] add memory failed', { sessionId, error: String(e) });
  }
}

/**
 * Ensure a session exists in Zep.
 */
export async function ensureZepSession(sessionId: string): Promise<void> {
  const client = getClient();
  if (!client) return;

  try {
    await client.memory.addSession({ sessionId });
  } catch (e) {
    logger.debug('[zep-client] addSession failed (may exist)', { sessionId, error: String(e) });
  }
}
