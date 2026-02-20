/**
 * PRD Intake for Antigravity Orchestrator
 * Analyzes PRD against codebase context and returns clarifying questions if needed.
 */

import { generateText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { config } from '../../config.js';
import { assembleContext, formatContextForPrompt } from '../context/index.js';
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
    const result = await assembleContext({
      message: prd.description,
      action: 'agent_ask',
      projectPath: prd.projectPath,
      model: 'haiku',
    });
    contextBlock = result.cachedFormatted ?? formatContextForPrompt(result);
    if (contextBlock.length > 4000) contextBlock = contextBlock.slice(0, 4000) + '\n...[truncated]';
  } catch (e) {
    logger.debug('[orchestrator] PRD intake: no context assembled', { error: String(e) });
  }

  const criteriaBlock = prd.acceptance_criteria?.length
    ? prd.acceptance_criteria.map((c) => `- ${c}`).join('\n')
    : '(none provided)';

  const prompt = `You are analyzing a Product Requirements Document (PRD) before implementation.

PRD TITLE: ${prd.title}

DESCRIPTION:
${prd.description}

ACCEPTANCE CRITERIA:
${criteriaBlock}

${contextBlock ? `CODEBASE CONTEXT (for reference):\n${contextBlock}\n` : ''}

If this PRD is clear enough to implement (we have enough detail on what to build, which files might change, and how to test), respond with exactly: {"questions": []}

If important details are missing (e.g. which endpoints, auth approach, response format, error handling), list 2-5 specific clarifying questions as a JSON array. Example: {"questions": ["Should this be a new /api/xyz or extend existing /api/foo?", "Store API key in env or secrets manager?"]}

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
