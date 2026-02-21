/**
 * Opik manual tracing for Anthropic LLM calls.
 * No-op when OPIK_API_KEY is not set.
 */

import { Opik } from 'opik';

let client: Opik | null = null;

export function getOpikClient(): Opik | null {
  if (!process.env.OPIK_API_KEY) return null;
  if (client) return client;
  client = new Opik({
    apiKey: process.env.OPIK_API_KEY,
    apiUrl: process.env.OPIK_URL_OVERRIDE ?? undefined,
    projectName: process.env.OPIK_PROJECT_NAME ?? 'jeeves',
  });
  return client;
}

export type TraceLlmCallOpts = {
  name: string;
  component: string;
  model?: string;
  input?: Record<string, unknown>;
};

function serializeForOpik(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(serializeForOpik).filter((v) => v !== undefined);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const s = serializeForOpik(v);
      if (s !== undefined) out[k] = s;
    }
    return out;
  }
  return String(value);
}

/**
 * Wrap an async LLM call with Opik trace + span.
 * Records input, output, usage, and errors. No-op when Opik is not configured.
 */
export async function traceLlmCall<T>(
  opts: TraceLlmCallOpts,
  fn: () => Promise<T>,
  extractOutput: (result: T) => Record<string, unknown>
): Promise<T> {
  const c = getOpikClient();
  if (!c) return fn();

  const input = opts.input ? (serializeForOpik(opts.input) as Record<string, unknown>) : {};
  const trace = c.trace({
    name: opts.name,
    input,
  });
  const span = trace.span({
    name: `llm:${opts.model ?? 'unknown'}`,
    type: 'llm',
    input,
    model: opts.model,
    provider: 'anthropic',
  });

  try {
    const result = await fn();
    const out = extractOutput(result);
    const output = serializeForOpik(out) as Record<string, unknown>;
    const usage = typeof out.usage === 'object' && out.usage !== null ? (out.usage as Record<string, number>) : undefined;
    span.update({ output, ...(usage && { usage }) });
    return result;
  } catch (err) {
    const errObj = err instanceof Error ? err : new Error(String(err));
    span.update({
      errorInfo: {
        exceptionType: errObj.name,
        message: errObj.message,
        traceback: errObj.stack ?? '',
      },
    });
    throw err;
  } finally {
    span.end();
    trace.end();
  }
}

/**
 * Flush buffered traces to Opik. Call on graceful shutdown.
 */
export async function flushOpik(): Promise<void> {
  const c = getOpikClient();
  if (c) await c.flush();
}
