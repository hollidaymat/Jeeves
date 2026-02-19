/**
 * Dev LLM (devtools)
 * LLM calls for development tasks: assess, plan, analyze failure.
 */

import { generateText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { trackLLMUsage } from '../core/cost-tracker.js';
import type { FileReadResult } from './file-reader.js';
import type { TestResult } from './test-runner.js';

export interface TaskAssessment {
  relevantFiles: string[];
  approach: string;
  risk: 'low' | 'medium' | 'high';
  estimatedComplexity: number;
}

export interface DevPlan {
  steps: DevStep[];
  testStrategy: string;
}

export interface DevStep {
  file: string;
  action: 'create' | 'modify';
  description: string;
  content?: string;
  oldContent?: string;
  newContent?: string;
}

export interface FailureAnalysis {
  canFix: boolean;
  reasoning: string;
  newSteps: DevStep[];
}

const HAIKU = config.claude.haiku_model;
const SONNET = config.claude.model;

function parseJson<T>(text: string, fallback: T): T {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return fallback;
  try {
    return JSON.parse(m[0]) as T;
  } catch {
    return fallback;
  }
}

export async function assessTask(description: string): Promise<TaskAssessment> {
  const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const { listDirectory } = await import('./file-reader.js');
  let structure = '';
  try {
    const src = await listDirectory('src');
    const tests = await listDirectory('tests');
    structure = `src: ${src.slice(0, 80).join(' ')}\ntests: ${tests.slice(0, 30).join(' ')}`;
  } catch {
    structure = 'src/, tests/ (list failed)';
  }
  const prompt = `You are Jeeves' development planner. Given this task and project structure, respond with ONLY valid JSON.

TASK: ${description}

PROJECT STRUCTURE (sample): ${structure}

Determine:
1. relevantFiles: array of file paths (relative to project root) that need to be read to understand the code, e.g. ["src/devtools/file-reader.ts"]
2. approach: one or two sentence high-level approach
3. risk: "low" (additive, no existing behavior changed), "medium" (modifies existing behavior), "high" (security/trust/config)
4. estimatedComplexity: number 1-10

Respond with ONLY this JSON, no markdown:
{"relevantFiles":["path1","path2"],"approach":"...","risk":"low|medium|high","estimatedComplexity":5}`;

  const llmStart = Date.now();
  const result = await generateText({
    model: anthropic(HAIKU),
    prompt,
    maxTokens: 800,
  });
  try {
    const { recordMetric } = await import('../core/profiler/performance-collector.js');
    recordMetric({ category: 'response_time', source: 'llm_call', metric_name: 'response_time_ms', value: Date.now() - llmStart, metadata: { model: HAIKU, call: 'assessTask' } });
  } catch (_) {}
  if (result.usage) {
    trackLLMUsage('dev_assess', HAIKU, result.usage.promptTokens, result.usage.completionTokens, false);
  }
  const parsed = parseJson<TaskAssessment>(result.text, {
    relevantFiles: [],
    approach: 'Read relevant files and implement changes.',
    risk: 'medium',
    estimatedComplexity: 5,
  });
  if (!Array.isArray(parsed.relevantFiles)) parsed.relevantFiles = [];
  return parsed;
}

export async function generatePlan(
  description: string,
  fileContents: FileReadResult[],
  approach: string
): Promise<DevPlan> {
  const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const filesContext = fileContents
    .map(
      (f) =>
        `FILE: ${f.path}\nLINES: ${f.lines}\n---\n${f.content.slice(0, 8000)}${f.content.length > 8000 ? '\n... (truncated)' : ''}`
    )
    .join('\n\n');
  const prompt = `You are Jeeves' code generator. Given the task, approach, and file contents, produce a precise implementation plan.

TASK: ${description}
APPROACH: ${approach}

FILES (with content):
${filesContext}

RULES:
1. Only produce steps for files the TASK explicitly asks to change (e.g. if the task says "add a comment to src/devtools/test-runner.ts", output steps only for that file).
2. For "modify": you MUST provide exact oldContent and newContent. Copy the full file content from FILES above for oldContent; set newContent to the result after your edit. For "add at top" use oldContent=full file, newContent=new line + full file.
3. For "create": provide full content.
4. Follow existing code style. Use existing utilities.
5. Export new functions so they can be tested.

Respond with ONLY valid JSON:
{"steps":[{"file":"src/...","action":"modify|create","description":"...","oldContent":"...","newContent":"..."}],"testStrategy":"..."}
For create steps use "content" instead of oldContent/newContent.`;

  const llmStart = Date.now();
  const result = await generateText({
    model: anthropic(SONNET),
    prompt,
    maxTokens: 4000,
  });
  try {
    const { recordMetric } = await import('../core/profiler/performance-collector.js');
    recordMetric({ category: 'response_time', source: 'llm_call', metric_name: 'response_time_ms', value: Date.now() - llmStart, metadata: { model: SONNET, call: 'generatePlan' } });
  } catch (_) {}
  if (result.usage) {
    trackLLMUsage('dev_plan', SONNET, result.usage.promptTokens, result.usage.completionTokens, false);
  }
  const parsed = parseJson<DevPlan>(result.text, { steps: [], testStrategy: 'Run type check and npm test.' });
  if (!Array.isArray(parsed.steps)) parsed.steps = [];
  return parsed;
}

export async function analyzeFailure(
  testResult: TestResult,
  fileContents: FileReadResult[],
  currentPlan: DevPlan
): Promise<FailureAnalysis> {
  const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const filesContext = fileContents
    .map((f) => `FILE: ${f.path}\n${f.content.slice(0, 4000)}`)
    .join('\n\n');
  const prompt = `Tests failed after code changes. Analyze and decide if fixable.

TEST OUTPUT: ${testResult.output.slice(0, 2000)}
FAILURES: ${JSON.stringify(testResult.failures)}

CURRENT PLAN STEPS: ${currentPlan.steps.length}
FILES CHANGED: ${fileContents.map((f) => f.path).join(', ')}

CURRENT FILE CONTENTS (relevant):
${filesContext}

If fixable, provide newSteps (same format as plan steps: file, action, description, oldContent/newContent or content).
If not fixable (architectural issue, missing dep), set canFix: false and explain in reasoning.

Respond with ONLY valid JSON:
{"canFix":true|false,"reasoning":"...","newSteps":[]}`;

  const llmStart = Date.now();
  const result = await generateText({
    model: anthropic(HAIKU),
    prompt,
    maxTokens: 2000,
  });
  try {
    const { recordMetric } = await import('../core/profiler/performance-collector.js');
    recordMetric({ category: 'response_time', source: 'llm_call', metric_name: 'response_time_ms', value: Date.now() - llmStart, metadata: { model: HAIKU, call: 'analyzeFailure' } });
  } catch (_) {}
  if (result.usage) {
    trackLLMUsage('dev_analyze_failure', HAIKU, result.usage.promptTokens, result.usage.completionTokens, false);
  }
  const parsed = parseJson<FailureAnalysis>(result.text, {
    canFix: false,
    reasoning: 'Could not parse analysis.',
    newSteps: [],
  });
  if (!Array.isArray(parsed.newSteps)) parsed.newSteps = [];
  return parsed;
}
