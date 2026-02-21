/**
 * Agentic RAG Context Retriever
 *
 * Iterative retrieval with confidence scoring. Uses ai-engineering-hub patterns.
 * Input: PRD/task description. Output: structured context for planner.
 * Uses assembleContext + Firecrawl web fallback (@mendable/firecrawl-js) when context insufficient.
 */

import { generateText } from '../llm/traced-llm.js';
import { createAnthropic } from '@ai-sdk/anthropic';
import Firecrawl from '@mendable/firecrawl-js';
import { config } from '../../config.js';
import { assembleContext, formatContextForPrompt } from './index.js';
import { getDb, generateId } from './db.js';
import { extractJsonFromText } from '../orchestrator/json-utils.js';
import { logger } from '../../utils/logger.js';

const MAX_ROUNDS = 3;
const CONFIDENCE_THRESHOLD = 0.8;

export interface AgenticRetrieveInput {
  taskDescription: string;
  taskId?: string;
  projectPath?: string;
}

export interface AgenticRetrieveResult {
  context: string;
  sources: string[];
  retrievalRounds: number;
  finalConfidence: number;
  success: boolean;
}

/**
 * Iteratively retrieve context until sufficient or max rounds.
 * Uses assembleContext per round; Haiku validates "is this enough?"
 */
export async function agenticRetrieve(input: AgenticRetrieveInput): Promise<AgenticRetrieveResult> {
  const taskId = input.taskId ?? generateId('ctx');
  const sources: string[] = [];
  let lastContext = '';
  let finalConfidence = 0;
  let round = 0;

  for (round = 1; round <= MAX_ROUNDS; round++) {
    const result = await assembleContext({
      message: input.taskDescription,
      action: 'agent_ask',
      projectPath: input.projectPath,
      model: 'haiku',
    });
    const formatted = result.cachedFormatted ?? formatContextForPrompt(result);
    lastContext = formatted.length > 4000 ? formatted.slice(0, 4000) + '\n...[truncated]' : formatted;
    result.layersIncluded.forEach((l) => {
      if (!sources.includes(l)) sources.push(l);
    });

    const validation = await validateContextSufficiency(lastContext, input.taskDescription, round);
    finalConfidence = validation.confidence;

    if (validation.sufficient || validation.confidence >= CONFIDENCE_THRESHOLD) {
      break;
    }
    if (validation.missing && round < MAX_ROUNDS) {
      const webContext = await firecrawlWebFallback(input.taskDescription, validation.missing);
      if (webContext) {
        lastContext = lastContext + '\n\n## Web Search Results\n' + webContext;
        sources.push('firecrawl');
        const revalidate = await validateContextSufficiency(lastContext, input.taskDescription, round + 1);
        finalConfidence = revalidate.confidence;
        if (revalidate.sufficient || revalidate.confidence >= CONFIDENCE_THRESHOLD) {
          round = round + 1;
          break;
        }
      }
      input.taskDescription = `${input.taskDescription}\n\nAdditional context needed: ${validation.missing}`;
    }
  }

  const success = finalConfidence >= 0.5 || lastContext.length > 0;
  recordContextUsage({
    task_id: taskId,
    context_sources: sources,
    retrieval_rounds: round,
    final_confidence: finalConfidence,
    success,
  });

  logger.debug('[agentic-retriever] Retrieved context', {
    rounds: round,
    confidence: finalConfidence,
    sources: sources.length,
  });

  return {
    context: lastContext,
    sources,
    retrievalRounds: round,
    finalConfidence,
    success,
  };
}

interface ValidationResult {
  sufficient: boolean;
  confidence: number;
  missing?: string;
}

async function validateContextSufficiency(
  contextBlock: string,
  taskDescription: string,
  round: number
): Promise<ValidationResult> {
  const prompt = `You are validating whether assembled context is sufficient to implement a task.

TASK: ${taskDescription.slice(0, 500)}

CONTEXT ASSEMBLED (round ${round}):
${contextBlock.slice(0, 3000)}

Respond with ONLY valid JSON: {"sufficient": boolean, "confidence": number 0-1, "missing": "what else is needed if insufficient, else omit"}

Bias: If context has project files, schema, or patterns, confidence should be >= 0.7.`;

  try {
    const anthropic = createAnthropic({
      apiKey: process.env.ANTHROPIC_API_KEY ?? '',
      baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
    });
    const { text } = await generateText({
      model: anthropic(config.claude.haiku_model),
      prompt,
      maxTokens: 200,
    });
    const trimmed = extractJsonFromText(text);
    const parsed = JSON.parse(trimmed) as { sufficient?: boolean; confidence?: number; missing?: string };
    return {
      sufficient: !!parsed.sufficient,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
      missing: parsed.missing,
    };
  } catch (e) {
    logger.warn('[agentic-retriever] Validation LLM failed, assuming sufficient', { error: String(e) });
    return { sufficient: true, confidence: 0.7 };
  }
}

async function firecrawlWebFallback(taskDescription: string, missing: string): Promise<string | null> {
  if (!process.env.FIRECRAWL_API_KEY) return null;
  try {
    const firecrawl = new Firecrawl({ apiKey: process.env.FIRECRAWL_API_KEY });
    const query = `${taskDescription.slice(0, 100)} ${missing}`.trim();
    const data = await firecrawl.search(query, {
      limit: 3,
      sources: ['web'],
      scrapeOptions: { formats: ['markdown'] },
    });
    const web = data?.web ?? [];
    const chunks: string[] = [];
    for (const item of web) {
      const doc = item as { url?: string; markdown?: string; title?: string; description?: string };
      const text = doc.markdown ?? [doc.title, doc.description].filter(Boolean).join(': ');
      if (text) chunks.push(`### ${doc.url || 'Source'}\n${text.slice(0, 2000)}`);
    }
    if (chunks.length === 0) return null;
    logger.debug('[agentic-retriever] Firecrawl web fallback', { query: query.slice(0, 60), results: chunks.length });
    return chunks.join('\n\n');
  } catch (e) {
    logger.warn('[agentic-retriever] Firecrawl fallback failed', { error: String(e) });
    return null;
  }
}

function recordContextUsage(params: {
  task_id: string;
  context_sources: string[];
  retrieval_rounds: number;
  final_confidence: number;
  success: boolean;
}): void {
  try {
    const db = getDb();
    const id = generateId('cu');
    db.prepare(
      `INSERT INTO context_usage (id, task_id, context_sources, retrieval_rounds, final_confidence, success, created_at)
       VALUES (?, ?, ?, ?, ?, ?, strftime('%s', 'now'))`
    ).run(
      id,
      params.task_id,
      JSON.stringify(params.context_sources),
      params.retrieval_rounds,
      params.final_confidence,
      params.success ? 1 : 0
    );
  } catch (e) {
    logger.debug('[agentic-retriever] Could not record context_usage', { error: String(e) });
  }
}
