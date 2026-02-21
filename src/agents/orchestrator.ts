/**
 * Multi-Agent Orchestrator (Option B)
 *
 * Planner, Executor, Validator as explicit agents. Executor uses direct Aider spawn (no MCP).
 * Wraps existing orchestrator modules for structured agent flow.
 */

import { generateSpec } from '../core/orchestrator/spec-generator.js';
import { executeWithAider, runTestsAfterAider } from '../core/orchestrator/aider-executor.js';
import { validateAndIterate } from '../core/orchestrator/validator.js';
import type { PRDRequest, AntigravitySpec, ExecutionResult, IterationResult } from '../core/orchestrator/types.js';
import type { Playbook } from '../core/orchestrator/types.js';

export type AgentName = 'planner' | 'executor' | 'validator';

/** Planner agent: PRD + context + playbooks -> spec */
export async function runPlanner(
  prd: PRDRequest,
  options: { playbooks?: Playbook[]; agenticContext?: string; playbookTemplate?: string; taskId?: string }
): Promise<AntigravitySpec> {
  return generateSpec(prd, {
    playbooks: options.playbooks,
    agenticContext: options.agenticContext,
    playbookTemplate: options.playbookTemplate,
    taskId: options.taskId,
  });
}

/** Executor agent: runs Aider with spec, then tests. Direct spawn (no MCP). */
export async function runExecutor(spec: AntigravitySpec): Promise<ExecutionResult> {
  let execution = await executeWithAider(spec);
  if (execution.test_results?.output !== 'stub' && (execution.status === 'completed' || !execution.test_results?.error)) {
    const realTests = runTestsAfterAider(spec);
    execution = {
      ...execution,
      status: realTests.passed ? 'completed' : 'failed',
      test_results: {
        passed: realTests.passed,
        error: realTests.error,
        output: realTests.output,
      },
    };
  }
  return execution;
}

/** Validator agent: analyze execution, decide success / retry / escalate */
export async function runValidator(
  spec: AntigravitySpec,
  execution: ExecutionResult,
  iteration: number
): Promise<IterationResult> {
  return validateAndIterate(spec, execution, iteration);
}
