/**
 * Spec generator: converts PRD + context into Antigravity-readable spec file.
 */

import { generateText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { config } from '../../config.js';
import { generateId } from '../context/db.js';
import type { PRDRequest, AntigravitySpec, Playbook } from './types.js';
import { logger } from '../../utils/logger.js';

const TASK_TEMP_DIR = process.env.TASK_TEMP_DIR || '/tmp/antigravity_tasks';

function getTaskDir(): string {
  if (!existsSync(TASK_TEMP_DIR)) mkdirSync(TASK_TEMP_DIR, { recursive: true });
  return TASK_TEMP_DIR;
}

/**
 * Build spec from PRD, optional answers, and optional playbook learnings.
 */
export async function generateSpec(
  prd: PRDRequest,
  options?: { answers?: string[]; playbooks?: Playbook[] }
): Promise<AntigravitySpec> {
  const task_id = `ag-${generateId('t').replace(/[^a-z0-9-]/gi, '-')}`;
  const criteria = prd.acceptance_criteria ?? [];
  const playbookContext =
    options?.playbooks?.length &&
    options.playbooks
      .slice(0, 2)
      .map(
        (p) =>
          `Pattern "${p.pattern}": success_rate=${p.success_rate}, common_errors: ${(p.common_errors || []).slice(0, 3).join('; ')}. Winning template hint: ${(p.winning_spec_template || '').slice(0, 200)}`
      )
      .join('\n');

  const prompt = `Generate a structured implementation spec for this PRD. Output valid JSON only.

PRD TITLE: ${prd.title}
DESCRIPTION: ${prd.description}
ACCEPTANCE CRITERIA:
${criteria.map((c) => `- ${c}`).join('\n')}
${options?.answers?.length ? `CLARIFYING ANSWERS:\n${options.answers.join('\n')}\n` : ''}
${playbookContext ? `LEARNINGS FROM SIMILAR TASKS:\n${playbookContext}\n` : ''}

Output a single JSON object with these exact keys (all strings except arrays):
- task_id: "${task_id}"
- title: short title
- description: 2-4 sentence summary
- acceptance_criteria: array of strings (checkable items)
- files_to_modify: array of file paths likely to change
- files_to_create: array of new files to create
- dependencies: array of libs/services
- test_command: e.g. "npm test" or "npm run test -- auth"
- estimated_complexity: "low" | "medium" | "high"
- context: object with architecture_notes (string), existing_patterns (array of strings), gotchas (array of strings)

Be concrete: real paths, real test commands.`;

  try {
    const anthropic = createAnthropic({
      apiKey: process.env.ANTHROPIC_API_KEY ?? '',
      baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
    });
    const { text } = await generateText({
      model: anthropic(config.claude.model),
      prompt,
      maxTokens: 2000,
    });
    const trimmed = text.trim().replace(/^```json?\s*|\s*```$/g, '');
    const raw = JSON.parse(trimmed) as Record<string, unknown>;
    const spec: AntigravitySpec = {
      task_id: String(raw.task_id ?? task_id),
      title: String(raw.title ?? prd.title),
      description: String(raw.description ?? prd.description),
      acceptance_criteria: Array.isArray(raw.acceptance_criteria) ? raw.acceptance_criteria.map(String) : [],
      files_to_modify: Array.isArray(raw.files_to_modify) ? raw.files_to_modify.map(String) : [],
      files_to_create: Array.isArray(raw.files_to_create) ? raw.files_to_create.map(String) : [],
      dependencies: Array.isArray(raw.dependencies) ? raw.dependencies.map(String) : [],
      test_command: String(raw.test_command ?? 'npm test'),
      estimated_complexity: ['low', 'medium', 'high'].includes(String(raw.estimated_complexity))
        ? (raw.estimated_complexity as 'low' | 'medium' | 'high')
        : 'medium',
      context: (() => {
        const ctx = raw.context as Record<string, unknown> | undefined;
        return {
          architecture_notes: String(ctx?.architecture_notes ?? ''),
          existing_patterns: Array.isArray(ctx?.existing_patterns) ? (ctx.existing_patterns as unknown[]).map(String) : [],
          gotchas: Array.isArray(ctx?.gotchas) ? (ctx.gotchas as unknown[]).map(String) : [],
        };
      })(),
    };
    const ctx = raw.context as Record<string, unknown> | undefined;
    if (Array.isArray(ctx?.previous_winning_patterns)) {
      spec.context.previous_winning_patterns = ctx.previous_winning_patterns as string[];
    }
    if (Array.isArray(ctx?.common_mistakes)) {
      spec.context.common_mistakes = ctx.common_mistakes as string[];
    }
    return spec;
  } catch (e) {
    logger.warn('[orchestrator] Spec generator LLM failed, using minimal spec', { error: String(e) });
    return {
      task_id,
      title: prd.title,
      description: prd.description,
      acceptance_criteria: criteria,
      files_to_modify: [],
      files_to_create: [],
      dependencies: [],
      test_command: 'npm test',
      estimated_complexity: 'medium',
      context: { architecture_notes: '', existing_patterns: [], gotchas: [] },
    };
  }
}

/**
 * Write spec to markdown file for Antigravity CLI.
 */
export function writeSpecFile(spec: AntigravitySpec): string {
  const dir = getTaskDir();
  const path = join(dir, `antigravity_task_${spec.task_id}.md`);
  const body = `# Task: ${spec.title}

## Description
${spec.description}

## Acceptance Criteria
${spec.acceptance_criteria.map((c) => `- [ ] ${c}`).join('\n')}

## Files to Modify
${spec.files_to_modify.map((f) => `- ${f}`).join('\n') || '(none)'}

## Files to Create
${spec.files_to_create.map((f) => `- ${f}`).join('\n') || '(none)'}

## Dependencies
${spec.dependencies.join(', ') || '(none)'}

## Architecture Context
${spec.context.architecture_notes}
Existing patterns: ${spec.context.existing_patterns.join('; ') || 'none'}
Gotchas: ${spec.context.gotchas.join('; ') || 'none'}

## Test Command
\`${spec.test_command}\`

## Estimated Complexity
${spec.estimated_complexity}
`;
  writeFileSync(path, body, 'utf-8');
  logger.info('[orchestrator] Spec file written', { path, task_id: spec.task_id });
  return path;
}
