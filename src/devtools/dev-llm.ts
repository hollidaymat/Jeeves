/**
 * Dev LLM (devtools)
 * LLM calls for development tasks: assess, plan, analyze failure.
 */

import { generateText } from '../core/llm/traced-llm.js';
import { createAnthropic } from '@ai-sdk/anthropic';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { trackLLMUsage } from '../core/cost-tracker.js';
import type { FileReadResult } from './file-reader.js';
import type { TestResult } from './test-runner.js';
import type { Learning } from '../core/context/layers/learnings.js';
import { selectBestApproach, type ApproachOption } from '../core/cognitive/confidence.js';
import { addReasoningStep } from '../core/ooda-logger.js';

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

export type ErrorCategory =
  | 'syntax'
  | 'logic'
  | 'architecture'
  | 'dependency'
  | 'permission'
  | 'unknown';

export interface CategorizedError {
  category: ErrorCategory;
  description: string;
  recoverable: boolean;
  action: 'fix_in_place' | 'replan_step' | 'replan_all' | 'escalate' | 'skip';
  retryFromStep: number;
}

export interface FailureAnalysis {
  canFix: boolean;
  reasoning: string;
  newSteps: DevStep[];
  errorCategory?: ErrorCategory;
}

// ----- Tool composition (Phase 6) -----
export type ToolKind = 'read' | 'search' | 'list' | 'write' | 'edit' | 'test' | 'typecheck';

export interface ToolCall {
  id: string;
  tool: ToolKind;
  args: Record<string, unknown>;
  dependsOn?: string;
}

export interface ToolChainPlan {
  calls: ToolCall[];
  reasoning: string;
  approach?: string;
  risk?: 'low' | 'medium' | 'high';
  estimatedComplexity?: number;
}

const HAIKU = config.claude.haiku_model;
const SONNET = config.claude.model;

/** Rule-based error categorization so we can fix or escalate instead of blind retries. */
export function categorizeError(testResult: TestResult, writeError?: string): CategorizedError {
  const errorText =
    writeError ||
    (testResult.failures?.map((f) => f.error).join('\n') || '') ||
    testResult.output ||
    '';

  if (
    /PROTECTED|ACCESS DENIED|Cannot modify|trust level/i.test(errorText)
  ) {
    return {
      category: 'permission',
      description: 'Blocked by security guardrails',
      recoverable: false,
      action: 'escalate',
      retryFromStep: -2,
    };
  }

  if (
    /Cannot find module|Module not found|ECONNREFUSED|ETIMEDOUT|npm ERR/i.test(errorText)
  ) {
    return {
      category: 'dependency',
      description: 'Missing or broken dependency',
      recoverable: false,
      action: 'escalate',
      retryFromStep: -2,
    };
  }

  if (
    /error TS|SyntaxError|Unexpected token|Cannot find name|is not assignable/i.test(errorText) ||
    (/Property/i.test(errorText) && /does not exist/i.test(errorText))
  ) {
    return {
      category: 'syntax',
      description: 'TypeScript or syntax error',
      recoverable: true,
      action: 'fix_in_place',
      retryFromStep: -1,
    };
  }

  if (
    (/expected/i.test(errorText) && /received/i.test(errorText)) ||
    /AssertionError|toBe|toEqual|not to throw/i.test(errorText)
  ) {
    return {
      category: 'logic',
      description: 'Test assertion failed - logic error',
      recoverable: true,
      action: 'replan_step',
      retryFromStep: -1,
    };
  }

  if (
    /circular dependency|stack overflow|Maximum call stack/i.test(errorText) ||
    errorText.length > 2000
  ) {
    return {
      category: 'architecture',
      description: 'Fundamental approach issue',
      recoverable: true,
      action: 'replan_all',
      retryFromStep: 0,
    };
  }

  return {
    category: 'unknown',
    description: 'Unrecognized error pattern',
    recoverable: false,
    action: 'escalate',
    retryFromStep: -2,
  };
}

function parseJson<T>(text: string, fallback: T): T {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return fallback;
  try {
    return JSON.parse(m[0]) as T;
  } catch {
    return fallback;
  }
}

async function callLLMForDevTask(
  prompt: string,
  modelKey: 'haiku' | 'sonnet',
  maxTokens: number
): Promise<string> {
  const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const model = modelKey === 'sonnet' ? anthropic(SONNET) : anthropic(HAIKU);
  const result = await generateText({ model, prompt, maxTokens });
  if (result.usage) {
    trackLLMUsage(
      `dev_${modelKey}_fix`,
      modelKey === 'sonnet' ? SONNET : HAIKU,
      result.usage.promptTokens,
      result.usage.completionTokens,
      false
    );
  }
  return result.text;
}

function extractJSON(text: string): string {
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) return jsonMatch[1].trim();
  const braceMatch = text.match(/\{[\s\S]*\}/);
  if (braceMatch) return braceMatch[0];
  return text;
}

function resolveDependencies(
  args: Record<string, unknown>,
  dependsOn: string | undefined,
  results: Map<string, unknown>
): Record<string, unknown> {
  if (!dependsOn) return args;
  const depResult = results.get(dependsOn);
  if (depResult == null) return args;
  const resolved = { ...args };
  const dep = depResult as Record<string, unknown>;
  for (const [key, value] of Object.entries(resolved)) {
    if (typeof value === 'string' && value.includes(`{{${dependsOn}.`)) {
      (resolved as Record<string, unknown>)[key] = value.replace(
        new RegExp(`\\{\\{${dependsOn}\\.([^}]+)\\}\\}`, 'g'),
        (_match, field) => String(dep[field] ?? (dep as { content?: string }).content ?? '')
      );
    }
  }
  return resolved;
}

async function planToolChain(
  taskDescription: string,
  context: FileReadResult[],
  understandOnly?: boolean
): Promise<ToolChainPlan> {
  const fileList =
    context.length > 0
      ? context.map((f) => `${f.path} (${f.lines} lines)`).join('\n')
      : 'No files in context yet.';

  const toolsSection = understandOnly
    ? `Only use these tools: read, list, search.
- read: { "path": "src/..." } - Read a file
- list: { "path": "src" } - List directory
- search: { "pattern": "regex", "options": { "glob": "*.ts", "maxResults": 20 } } - Grep across project

Also return: "approach" (1-2 sentence plan), "risk" (low|medium|high), "estimatedComplexity" (1-10).`
    : `Available tools:
- read: { "path": "src/..." }
- list: { "path": "src" }
- search: { "pattern": "regex", "options": { "glob": "*.ts" } }
- write: { "path": "...", "content": "...", "taskId": "...", "description": "..." }
- edit: { "path": "...", "oldString": "...", "newString": "...", "taskId": "...", "description": "..." }
- test: { "testFile": "optional path" }
- typecheck: {}`;

  const prompt = `You are Jeeves' tool planner. Plan ALL tool operations needed for this task.

${toolsSection}

Files already in context:
${fileList}

Task: ${taskDescription}

Return ONLY valid JSON:
{
  "calls": [
    { "id": "step1", "tool": "read", "args": { "path": "src/foo.ts" } },
    { "id": "step2", "tool": "read", "args": { "path": "src/bar.ts" }, "dependsOn": "step1" }
  ],
  "reasoning": "Brief explanation"
  ${understandOnly ? ', "approach": "...", "risk": "low|medium|high", "estimatedComplexity": 5' : ''}
}
Rules: Use dependsOn when a step needs prior output. Minimize steps. ${understandOnly ? 'Plan only read/list/search to gather context.' : 'If code is modified, end with typecheck or test.'}`;

  const response = await callLLMForDevTask(prompt, 'sonnet', 2000);
  const raw = parseJson<ToolChainPlan & { approach?: string; risk?: string; estimatedComplexity?: number }>(
    extractJSON(response),
    { calls: [], reasoning: '' }
  );
  const calls = Array.isArray(raw.calls) ? raw.calls : [];
  const plan: ToolChainPlan = {
    calls: calls.map((c) => ({
      id: (c as ToolCall).id ?? `step${calls.indexOf(c) + 1}`,
      tool: (c as ToolCall).tool,
      args: (c as ToolCall).args ?? {},
      dependsOn: (c as ToolCall).dependsOn,
    })),
    reasoning: raw.reasoning ?? '',
    approach: raw.approach,
    risk: raw.risk === 'low' || raw.risk === 'medium' || raw.risk === 'high' ? raw.risk : undefined,
    estimatedComplexity: typeof raw.estimatedComplexity === 'number' ? raw.estimatedComplexity : undefined,
  };
  return plan;
}

export interface ToolChainResult {
  results: Map<string, unknown>;
  plan: ToolChainPlan;
}

export async function planAndExecuteToolChain(
  taskDescription: string,
  context: FileReadResult[],
  opts: { understandOnly?: boolean; taskId?: string; description?: string } = {}
): Promise<ToolChainResult> {
  const { understandOnly = false, taskId = '', description = '' } = opts;
  const plan = await planToolChain(taskDescription, context, understandOnly);
  const results = new Map<string, unknown>();

  const allowedInUnderstand = new Set<ToolKind>(['read', 'list', 'search']);
  const calls = understandOnly ? plan.calls.filter((c) => allowedInUnderstand.has(c.tool)) : plan.calls;

  const { readProjectFile, listDirectory, searchProject } = await import('./file-reader.js');

  for (const call of calls) {
    const resolvedArgs = resolveDependencies(call.args, call.dependsOn, results) as Record<string, string | Record<string, unknown>>;
    let result: unknown;
    try {
      switch (call.tool) {
        case 'read':
          result = await readProjectFile(String(resolvedArgs.path ?? ''));
          break;
        case 'list':
          result = await listDirectory(String(resolvedArgs.path ?? ''));
          break;
        case 'search':
          result = await searchProject(String(resolvedArgs.pattern ?? ''), (resolvedArgs.options as { glob?: string; maxResults?: number }) ?? {});
          break;
        case 'write':
          if (understandOnly) break;
          result = await (await import('./file-writer.js')).writeProjectFile(
            String(resolvedArgs.path),
            String(resolvedArgs.content),
            String(resolvedArgs.taskId ?? taskId),
            String(resolvedArgs.description ?? description)
          );
          break;
        case 'edit':
          if (understandOnly) break;
          result = await (await import('./file-writer.js')).editProjectFile(
            String(resolvedArgs.path),
            String(resolvedArgs.oldString),
            String(resolvedArgs.newString),
            String(resolvedArgs.taskId ?? taskId),
            String(resolvedArgs.description ?? description)
          );
          break;
        case 'test':
          if (understandOnly) break;
          result = await (await import('./test-runner.js')).runProjectTests(resolvedArgs.testFile as string | undefined);
          break;
        case 'typecheck':
          if (understandOnly) break;
          result = await (await import('./test-runner.js')).runTypeCheck();
          break;
        default:
          result = { error: `Unknown tool: ${call.tool}` };
      }
    } catch (err) {
      result = { error: err instanceof Error ? err.message : String(err) };
    }
    if (result !== undefined) results.set(call.id, result);
  }

  return { results, plan };
}

/** Fetch learnings relevant to a task description (and optional file paths) for injection into prompts. */
export async function getRelevantLearnings(
  taskDescription: string,
  filePaths?: string[]
): Promise<Learning[]> {
  try {
    const { findRelevantLearnings } = await import('../core/context/layers/learnings.js');
    const description = filePaths?.length
      ? `${taskDescription} ${filePaths.join(' ')}`
      : taskDescription;
    return findRelevantLearnings(description, undefined).slice(0, 5);
  } catch {
    return [];
  }
}

function formatLearningsForPrompt(learnings: Learning[]): string {
  if (learnings.length === 0) return '';
  return `\n\nRELEVANT PAST LEARNINGS (apply these when relevant):
${learnings.map((l, i) => `${i + 1}. [${l.category}] ${l.lesson}\n   Fix applied: ${l.fix}\n   Confidence: ${(l.confidence * 100).toFixed(0)}%`).join('\n')}
Consider these when assessing risk and choosing approach. If a learning says a certain approach failed before, choose a different one.`;
}

export async function assessTask(description: string): Promise<TaskAssessment> {
  const { listDirectory } = await import('./file-reader.js');
  const learnings = await getRelevantLearnings(description);
  const learningsContext = formatLearningsForPrompt(learnings);
  let structure = '';
  try {
    const src = await listDirectory('src');
    const tests = await listDirectory('tests');
    structure = `src: ${src.slice(0, 80).join(' ')}\ntests: ${tests.slice(0, 30).join(' ')}`;
  } catch {
    structure = 'src/, tests/ (list failed)';
  }

  const prompt = `You are Jeeves' development planner. For this task, propose 2-3 different approaches. For each approach, estimate:
- confidence (0.0-1.0): How likely this approach will work
- risk (low/medium/high): What could go wrong
- estimatedIterations (1-5): How many tries to get it right
- relevantFiles: array of file paths to read
- approach: one or two sentence high-level approach

TASK: ${description}

PROJECT STRUCTURE (sample): ${structure}
${learningsContext}

Return ONLY valid JSON, no markdown:
{"approaches":[{"id":"a1","description":"...","confidence":0.8,"risk":"low","estimatedIterations":1,"estimatedTokenCost":500,"relevantFiles":["path1"],"approach":"..."},{"id":"a2",...}]}`;

  const response = await callLLMForDevTask(prompt, 'sonnet', 2000);
  const parsed = parseJson<{ approaches: ApproachOption[] }>(extractJSON(response), { approaches: [] });
  const approaches = Array.isArray(parsed.approaches) ? parsed.approaches : [];

  if (approaches.length === 0) {
    return {
      relevantFiles: [],
      approach: 'Read relevant files and implement changes.',
      risk: 'medium',
      estimatedComplexity: 5,
    };
  }

  const options: ApproachOption[] = approaches.map((a, i) => ({
    id: a.id ?? `a${i + 1}`,
    description: a.description ?? a.approach ?? '',
    confidence: typeof a.confidence === 'number' ? a.confidence : 0.7,
    risk: a.risk === 'low' || a.risk === 'medium' || a.risk === 'high' ? a.risk : 'medium',
    estimatedIterations: typeof a.estimatedIterations === 'number' ? a.estimatedIterations : 2,
    estimatedTokenCost: a.estimatedTokenCost,
    pros: a.pros,
    cons: a.cons,
    relevantFiles: a.relevantFiles,
    approach: a.approach,
  }));

  let selected: ApproachOption;
  let reasoning: string;
  try {
    const out = selectBestApproach(options);
    selected = out.selected;
    reasoning = out.reasoning;
  } catch {
    selected = options[0];
    reasoning = 'Using first approach (selection failed)';
  }

  addReasoningStep({
    phase: 'orient',
    thought: reasoning,
    data: { allApproaches: options.length, selectedId: selected.id },
    alternatives: options.filter((a) => a.id !== selected.id).map((a) => a.description),
    confidence: selected.confidence,
    duration: 0,
  });

  return {
    relevantFiles: Array.isArray(selected.relevantFiles) ? selected.relevantFiles : [],
    approach: selected.approach ?? selected.description ?? 'Read relevant files and implement changes.',
    risk: selected.risk,
    estimatedComplexity: Math.min(10, Math.max(1, selected.estimatedIterations * 2)),
  };
}

export async function generatePlan(
  description: string,
  fileContents: FileReadResult[],
  approach: string
): Promise<DevPlan> {
  const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const learnings = await getRelevantLearnings(description, fileContents.map((f) => f.path));
  const learningsContext = formatLearningsForPrompt(learnings);
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
${learningsContext}

IMPORTANT: If past learnings indicate a specific pattern failed, DO NOT repeat it. Use the lessons to inform your plan.

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

async function generateSyntaxFix(
  testResult: TestResult,
  fileContents: FileReadResult[],
  currentPlan: DevPlan
): Promise<FailureAnalysis> {
  const failureDetails = (testResult.failures || [])
    .map(
      (f) =>
        `File: ${f.file ?? 'unknown'}, Line: ${f.line ?? '?'}, Error: ${f.error}`
    )
    .join('\n');
  const prompt = `Fix these TypeScript/syntax errors. Return ONLY valid JSON.

Errors:
${failureDetails}

Current plan steps:
${JSON.stringify(currentPlan.steps.map((s) => ({ file: s.file, action: s.action, desc: s.description })))}

Relevant file contents (first 2000 chars each):
${fileContents.slice(0, 3).map((f) => `${f.path}:\n${f.content.slice(0, 2000)}`).join('\n\n')}

Return JSON: { "canFix": true, "reasoning": "what was wrong", "newSteps": [{"file":"...","action":"modify|create","description":"...","oldContent":"...","newContent":"..."}] }
For create use "content" instead of oldContent/newContent.`;

  const response = await callLLMForDevTask(prompt, 'haiku', 1500);
  const parsed = parseJson<FailureAnalysis>(extractJSON(response), {
    canFix: false,
    reasoning: 'Syntax fix parse failed',
    newSteps: [],
  });
  if (!Array.isArray(parsed.newSteps)) parsed.newSteps = [];
  parsed.errorCategory = 'syntax';
  return parsed;
}

async function generateLogicFix(
  testResult: TestResult,
  fileContents: FileReadResult[],
  currentPlan: DevPlan
): Promise<FailureAnalysis> {
  const failureLines = (testResult.failures || [])
    .map(
      (f) =>
        `${f.test}: ${f.expected ?? ''} / ${f.actual ?? ''}. Error: ${f.error}`
    )
    .join('\n');
  const prompt = `Test assertions failed. The code compiles but produces wrong results.

Test failures:
${failureLines}

Relevant file contents:
${fileContents.slice(0, 3).map((f) => `--- ${f.path} ---\n${f.content.slice(0, 2000)}`).join('\n\n')}

Fix the logic error. Return ONLY valid JSON: { "canFix": true, "reasoning": "what the logic error was", "newSteps": [DevStep] }`;

  const response = await callLLMForDevTask(prompt, 'sonnet', 2000);
  const parsed = parseJson<FailureAnalysis>(extractJSON(response), {
    canFix: false,
    reasoning: 'Logic fix parse failed',
    newSteps: [],
  });
  if (!Array.isArray(parsed.newSteps)) parsed.newSteps = [];
  parsed.errorCategory = 'logic';
  return parsed;
}

async function generateArchitectureFix(
  testResult: TestResult,
  fileContents: FileReadResult[],
  currentPlan: DevPlan
): Promise<FailureAnalysis> {
  const prompt = `The implementation approach has a fundamental issue. Replan from scratch.

Error: ${testResult.output.slice(0, 1500)}

Original plan:
${JSON.stringify(currentPlan.steps.map((s) => ({ file: s.file, action: s.action, desc: s.description })))}

Generate a completely new plan. Different approach. Return ONLY valid JSON: { "canFix": true, "reasoning": "why the old approach failed and what the new approach is", "newSteps": [DevStep] }`;

  const response = await callLLMForDevTask(prompt, 'sonnet', 3000);
  const parsed = parseJson<FailureAnalysis>(extractJSON(response), {
    canFix: false,
    reasoning: 'Architecture fix parse failed',
    newSteps: [],
  });
  if (!Array.isArray(parsed.newSteps)) parsed.newSteps = [];
  parsed.errorCategory = 'architecture';
  return parsed;
}

/** Analyze write failure (e.g. old_string not found) and return fixed content for retry. */
export async function analyzeWriteFailure(
  error: string,
  step: DevStep,
  fileContents: FileReadResult[]
): Promise<{ canFix: boolean; newOldContent?: string; newNewContent?: string }> {
  if (!error || (!error.includes('old_string not found') && !error.includes('not found in file'))) {
    return { canFix: false };
  }
  const { readProjectFile } = await import('./file-reader.js');
  const currentFile = await readProjectFile(step.file);
  const analysis = await analyzeFailure(
    {
      suite: 'write-fix',
      passed: 0,
      failed: 1,
      skipped: 0,
      total: 1,
      duration: 0,
      failures: [{ test: 'write', error: 'old_string not found. Current file content available.' }],
      output: `Attempted old_string:\n${(step.oldContent ?? '').slice(0, 2000)}\n\nCurrent file (first 3000 chars):\n${currentFile.content.slice(0, 3000)}`,
    },
    fileContents,
    { steps: [step], testStrategy: '' }
  );
  if (analysis.canFix && analysis.newSteps[0]) {
    const fixStep = analysis.newSteps[0];
    return {
      canFix: true,
      newOldContent: fixStep.oldContent,
      newNewContent: fixStep.newContent,
    };
  }
  return { canFix: false };
}

export async function analyzeFailure(
  testResult: TestResult,
  fileContents: FileReadResult[],
  currentPlan: DevPlan,
  writeError?: string
): Promise<FailureAnalysis> {
  const error = categorizeError(testResult, writeError);

  if (!error.recoverable) {
    return {
      canFix: false,
      reasoning: `${error.category} error: ${error.description}. Requires human intervention.`,
      newSteps: [],
      errorCategory: error.category,
    };
  }

  if (error.action === 'fix_in_place') {
    return await generateSyntaxFix(testResult, fileContents, currentPlan);
  }
  if (error.action === 'replan_step') {
    return await generateLogicFix(testResult, fileContents, currentPlan);
  }
  if (error.action === 'replan_all') {
    return await generateArchitectureFix(testResult, fileContents, currentPlan);
  }

  return {
    canFix: false,
    reasoning: `Unhandled action: ${error.action}`,
    newSteps: [],
    errorCategory: error.category,
  };
}
