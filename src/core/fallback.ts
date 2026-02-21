/**
 * Graceful Degradation – Fallback Chain
 * Port of agentic_rag / firecrawl-agent pattern: try primary, on failure try fallbacks.
 */

export interface FallbackStep<T> {
  name: string;
  fn: () => Promise<T>;
}

export interface FallbackOptions<T> {
  primary: () => Promise<T>;
  fallbacks: FallbackStep<T>[];
  onAllFailed: (errors: Error[]) => T;
}

/**
 * Run primary; on failure, try fallbacks in order. If all fail, call onAllFailed.
 * Returns the name of the step that succeeded (or 'none' if onAllFailed returned).
 */
export async function runWithFallback<T>(options: FallbackOptions<T>): Promise<{ result: T; stepUsed: string }> {
  const { primary, fallbacks, onAllFailed } = options;
  const errors: Error[] = [];

  try {
    const result = await primary();
    return { result, stepUsed: 'primary' };
  } catch (e) {
    errors.push(e instanceof Error ? e : new Error(String(e)));
  }

  for (const step of fallbacks) {
    try {
      const result = await step.fn();
      return { result, stepUsed: step.name };
    } catch (e) {
      errors.push(e instanceof Error ? e : new Error(String(e)));
    }
  }

  const result = onAllFailed(errors);
  return { result, stepUsed: 'none' };
}
