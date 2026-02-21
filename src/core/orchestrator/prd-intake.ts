/**
 * PRD Intake for Antigravity Orchestrator
 * Analyzes PRD against codebase context and returns clarifying questions if needed.
 */

import { generateText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { config } from '../../config.js';
import { assembleContextWithFallback, formatContextForPrompt, agenticRetrieve } from '../context/index.js';
import type { PRDRequest } from './types.js';
import { logger } from '../../utils/logger.js';

export interface PRDIntakeResult {
  ready: boolean;
  questions: string[];
}

/**
 * Analyze PRD and optionally load codebase context. Return clarifying questions (2-5) if the PRD is ambiguous; otherwise return ready.
 */
export async function analyzePRD(prd: PRDRequest): Promise<PRDIntakeResult> {
  let contextBlock = '';
  try {
    if (process.env.AGENTIC_RAG_ENABLED === 'true') {
      const agentic = await agenticRetrieve({
        taskDescription: `${prd.title}\n${prd.description}`,
        projectPath: prd.projectPath,
      });
      contextBlock = agentic.context;
    } else {
      const { result } = await assembleContextWithFallback({
        message: prd.description,
        action: 'agent_ask',
        projectPath: prd.projectPath,
        model: 'haiku',
      });
      contextBlock = result.cachedFormatted ?? formatContextForPrompt(result);
    }
    if (contextBlock.length > 4000) contextBlock = contextBlock.slice(0, 4000) + '\n...[truncated]';
  } catch (e) {
    logger.debug('[orchestrator] PRD intake: no context assembled', { error: String(e) });
  }

  const criteriaBlock = prd.acceptance_criteria?.length
    ? prd.acceptance_criteria.map((c) => `- ${c}`).join('\n')
    : '(none provided)';

  // Short continuation phrases = user wants to proceed without more questions
  if (/^(?:just\s+build\s+it|just\s+do\s+it|go\s+ahead|proceed|use\s+defaults|skip\s+questions|make\s+it\s+work)$/i.test(prd.description?.trim() || '')) {
    return { ready: true, questions: [] };
  }

  const prompt = `You are analyzing a Product Requirements Document (PRD) before implementation.

PRD TITLE: ${prd.title}

DESCRIPTION:
${prd.description}

ACCEPTANCE CRITERIA:
${criteriaBlock}

${contextBlock ? `CODEBASE CONTEXT (for reference):\n${contextBlock}\n` : ''}

BIAS TOWARD READY. If the user has specified: target service/app, endpoint path (or similar), HTTP method, and response format, respond with exactly: {"questions": []}. Do NOT ask about: error handling, logging, code conventions, edge cases, or "existing vs new" when it's obvious. Assume reasonable defaults.

Only ask questions when the PRD is genuinely ambiguous (e.g. conflicting requirements, missing which of 2+ services, no idea what to build). Prefer 0-2 questions max. If in doubt, respond with {"questions": []}.

Respond with ONLY valid JSON: {"questions": ["..."]}`;

  try {
    const anthropic = createAnthropic({
      apiKey: process.env.ANTHROPIC_API_KEY ?? '',
      baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
    });
    const { text } = await generateText({
      model: anthropic(config.claude.haiku_model),
      prompt,
      maxTokens: 500,
    });
    const trimmed = text.trim().replace(/^```json?\s*|\s*```$/g, '');
    const parsed = JSON.parse(trimmed) as { questions?: string[] };
    const questions = Array.isArray(parsed.questions) ? parsed.questions.filter((q) => typeof q === 'string') : [];
    return {
      ready: questions.length === 0,
      questions,
    };
  } catch (e) {
    logger.warn('[orchestrator] PRD intake LLM failed, assuming ready', { error: String(e) });
    return { ready: true, questions: [] };
  }
}
