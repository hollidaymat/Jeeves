/**
 * Validator: check execution result, decide success / retry / escalate.
 */

import { generateText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { config } from '../../config.js';
import type { AntigravitySpec, ExecutionResult, IterationResult } from './types.js';
import { logger } from '../../utils/logger.js';

const MAX_ITERATIONS = parseInt(process.env.MAX_ITERATIONS || '3', 10) || 3;

/**
 * Validate execution and decide next step: success, retry (Jeeves fix or Antigravity retry), or escalate.
 */
export async function validateAndIterate(
  spec: AntigravitySpec,
  execution: ExecutionResult,
  iteration: number
): Promise<IterationResult> {
  if (execution.test_results.passed) {
    return {
      status: 'success',
      iteration_count: iteration,
      ready_to_deploy: true,
    };
  }

  if (iteration >= MAX_ITERATIONS) {
    return {
      status: 'escalate',
      iteration_count: iteration,
      error: execution.test_results.error,
      message: `Failed after ${iteration} iterations. ${execution.test_results.error ?? 'Tests did not pass.'} Need human help.`,
      ready_to_deploy: false,
    };
  }

  const errorAnalysis = await analyzeTestFailure(execution.test_results.error ?? execution.test_results.output ?? '');
  if (errorAnalysis.type === 'simple_fix' && errorAnalysis.suggested_fix) {
    return {
      status: 'retry',
      iteration: iteration + 1,
      action: 'jeeves_fixes',
      fix: errorAnalysis.suggested_fix,
    };
  }
  return {
    status: 'retry',
    iteration: iteration + 1,
    action: 'antigravity_retry',
    feedback: errorAnalysis.feedback_for_antigravity,
  };
}

async function analyzeTestFailure(errorOutput: string): Promise<{
  type: 'simple_fix' | 'complex';
  suggested_fix?: string;
  feedback_for_antigravity?: string;
}> {
  const prompt = `Test failure output from a code generation run:

\`\`\`
${errorOutput.slice(-3000)}
\`\`\`

If this looks like a small fix (single typo, wrong import, one-line logic error), respond with JSON: {"type":"simple_fix","suggested_fix":"concrete one-line or short fix description"}

If it needs design or multi-file changes, respond with JSON: {"type":"complex","feedback_for_antigravity":"Clear instructions for the code generator on what went wrong and what to do differently"}`;

  try {
    const anthropic = createAnthropic({
      apiKey: process.env.ANTHROPIC_API_KEY ?? '',
      baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
    });
    const { text } = await generateText({
      model: anthropic(config.claude.haiku_model),
      prompt,
      maxTokens: 400,
    });
    const trimmed = text.trim().replace(/^```json?\s*|\s*```$/g, '');
    const parsed = JSON.parse(trimmed) as { type?: string; suggested_fix?: string; feedback_for_antigravity?: string };
    if (parsed.type === 'simple_fix' && parsed.suggested_fix) {
      return { type: 'simple_fix', suggested_fix: parsed.suggested_fix };
    }
    return { type: 'complex', feedback_for_antigravity: parsed.feedback_for_antigravity ?? errorOutput.slice(-500) };
  } catch (e) {
    logger.warn('[orchestrator] Validator LLM failed', { error: String(e) });
    return { type: 'complex', feedback_for_antigravity: `Previous run failed: ${errorOutput.slice(-500)}` };
  }
}
