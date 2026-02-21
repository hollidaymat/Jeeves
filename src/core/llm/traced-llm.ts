/**
 * Traced wrappers for AI SDK generateText, generateObject, streamText.
 * Sends traces to Opik when OPIK_API_KEY is set.
 */

import {
  generateText as aiGenerateText,
  generateObject as aiGenerateObject,
  streamText as aiStreamText,
} from 'ai';
import { traceLlmCall, getOpikClient } from './opik-tracer.js';

const MAX_OUTPUT_CHARS = 10000;

function getModelId(options: { model?: unknown }): string | undefined {
  const m = options?.model;
  if (!m) return undefined;
  if (typeof m === 'string') return m;
  if (m && typeof m === 'object' && 'modelId' in m) return String((m as { modelId?: string }).modelId);
  return String(m);
}

function getInputFromOptions(options: { prompt?: string; messages?: unknown }): Record<string, unknown> {
  if (options.prompt) return { prompt: options.prompt };
  if (options.messages && Array.isArray(options.messages))
    return { messages: options.messages };
  return {};
}

export async function generateText(
  options: Parameters<typeof aiGenerateText>[0]
): ReturnType<typeof aiGenerateText> {
  const component = (options as { metadata?: { component?: string } }).metadata?.component ?? 'generateText';
  const modelId = getModelId(options);

  return traceLlmCall(
    {
      name: 'generateText',
      component,
      model: modelId,
      input: { ...getInputFromOptions(options), model: modelId },
    },
    () => aiGenerateText(options),
    (r) => ({
      text: r.text?.slice(0, MAX_OUTPUT_CHARS) ?? '',
      usage: r.usage,
    })
  );
}

export const generateObject: typeof aiGenerateObject = (async (options: Parameters<typeof aiGenerateObject>[0]) => {
  const component = (options as { metadata?: { component?: string } }).metadata?.component ?? 'generateObject';
  const modelId = getModelId(options);

  return traceLlmCall(
    {
      name: 'generateObject',
      component,
      model: modelId,
      input: { ...getInputFromOptions(options), model: modelId },
    },
    () => aiGenerateObject(options as Parameters<typeof aiGenerateObject>[0]),
    (r) => ({
      object: r.object,
      usage: r.usage,
    })
  );
}) as typeof aiGenerateObject;

export function streamText(
  options: Parameters<typeof aiStreamText>[0]
): ReturnType<typeof aiStreamText> {
  const component = (options as { metadata?: { component?: string } }).metadata?.component ?? 'streamText';
  const modelId = getModelId(options);
  const client = getOpikClient();

  if (!client) {
    return aiStreamText(options);
  }

  const input = { ...getInputFromOptions(options), model: modelId };
  const trace = client.trace({ name: 'streamText', input });
  const span = trace.span({
    name: `llm:${modelId ?? 'unknown'}`,
    type: 'llm',
    input,
    model: modelId,
    provider: 'anthropic',
  });

  const userOnFinish = options.onFinish;
  const wrappedOptions = {
    ...options,
    onFinish: (params: { text?: string; usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number } }) => {
      const usageObj = params.usage;
      const usage: Record<string, number> | undefined =
        usageObj && typeof usageObj === 'object'
          ? (Object.fromEntries(
              Object.entries(usageObj).filter(([, v]) => typeof v === 'number') as [string, number][]
            ) as Record<string, number>)
          : undefined;
      span.update({
        output: { text: params.text?.slice(0, MAX_OUTPUT_CHARS) ?? '' },
        ...(usage && Object.keys(usage).length > 0 ? { usage } : {}),
      });
      span.end();
      trace.end();
      userOnFinish?.(params as Parameters<NonNullable<typeof userOnFinish>>[0]);
    },
  };

  try {
    return aiStreamText(wrappedOptions);
  } catch (err) {
    const errObj = err instanceof Error ? err : new Error(String(err));
    span.update({
      errorInfo: {
        exceptionType: errObj.name,
        message: errObj.message,
        traceback: errObj.stack ?? '',
      },
    });
    span.end();
    trace.end();
    throw err;
  }
}
