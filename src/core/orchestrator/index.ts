/**
 * Antigravity Orchestrator: main entrypoint.
 * PRD -> intake -> spec -> execute (Antigravity) -> validate -> iterate or escalate -> record.
 */

import { analyzePRD } from './prd-intake.js';
import { generateSpec, writeSpecFile } from './spec-generator.js';
import { executeWithAntigravity } from './antigravity-executor.js';
import { validateAndIterate } from './validator.js';
import { getRelevantPlaybooks } from './learnings-applier.js';
import { recordIteration, recordTask } from '../observer/interaction-recorder.js';
import type { PRDRequest, AntigravitySpec, OrchestrationResult } from './types.js';
import { logger } from '../../utils/logger.js';

const MAX_ITERATIONS = parseInt(process.env.MAX_ITERATIONS || '3', 10) || 3;

let currentTask: { task_id: string; phase: string; iteration?: number; prd_title?: string } | null = null;

export function getActiveOrchestrationTask(): typeof currentTask {
  return currentTask;
}

export interface OrchestrateOptions {
  /** If true, stop after writing the spec file; do not run Antigravity. */
  handoffOnly?: boolean;
}

/**
 * Run full orchestration: intake -> spec -> loop(execute, validate) -> record.
 * With handoffOnly (or ANTIGRAVITY_HANDOFF_ONLY): stop after writing spec, return spec_path.
 */
export async function orchestrate(prd: PRDRequest, options?: OrchestrateOptions): Promise<OrchestrationResult> {
  const handoffOnly = options?.handoffOnly ?? (process.env.ANTIGRAVITY_HANDOFF_ONLY === 'true');
  const { broadcastToWeb } = await import('../../integrations/cursor-orchestrator.js').catch(() => ({ broadcastToWeb: () => {} }));
  const emit = (phase: string, data: unknown) => {
    try {
      broadcastToWeb('orchestration_phase', { phase, ...(typeof data === 'object' && data !== null ? data : { data }) });
    } catch {
      // ignore
    }
  };

  const intake = await analyzePRD(prd);
  if (!intake.ready && intake.questions.length > 0) {
    return {
      success: false,
      needsClarification: true,
      questions: intake.questions,
      message: `Need clarification (${intake.questions.length} questions).`,
    };
  }

  currentTask = { task_id: '', phase: 'spec_generation', prd_title: prd.title };
  emit('spec_generation', {});
  const playbooks = getRelevantPlaybooks(prd);
  const spec = await generateSpec(prd, { playbooks });
  const specPath = writeSpecFile(spec);
  recordTask(spec.task_id, JSON.stringify(prd), 'in_progress');
  currentTask = { task_id: spec.task_id, phase: 'spec_ready', prd_title: prd.title };
  emit('spec_ready', { task_id: spec.task_id });

  if (handoffOnly) {
    currentTask = null;
    return {
      success: true,
      task_id: spec.task_id,
      status: 'handoff',
      message: `Spec ready. No build run. Open in Antigravity when you want to build.\nSpec: ${specPath}`,
      spec_path: specPath,
    };
  }

  let iteration = 1;
  let lastSpec = spec;
  let totalDuration = 0;
  let serveWebUrl: string | undefined;

  while (iteration <= MAX_ITERATIONS) {
    currentTask = { task_id: spec.task_id, phase: 'antigravity_run', iteration, prd_title: prd.title };
    emit('antigravity_run', { iteration, task_id: spec.task_id });
    const execution = await executeWithAntigravity(lastSpec);
    if (execution.serve_web_url) serveWebUrl = execution.serve_web_url;
    totalDuration += execution.duration_ms;
    recordIteration({
      task_id: spec.task_id,
      iteration,
      spec: lastSpec,
      antigravity_output: execution.stdout ?? execution.test_results?.output ?? '',
      test_result: execution.test_results.passed ? 'pass' : 'fail',
      error: execution.test_results.error,
      duration_ms: execution.duration_ms,
    });
    emit('validation', { iteration, passed: execution.test_results.passed, serve_web_url: serveWebUrl });

    const validation = await validateAndIterate(lastSpec, execution, iteration);
    if (validation.status === 'success') {
      currentTask = null;
      recordTask(spec.task_id, JSON.stringify(prd), 'success', {
        completed_at: Math.floor(Date.now() / 1000),
        final_code: execution.stdout?.slice(-8000),
      });
      emit('complete', { task_id: spec.task_id, iteration });
      const successMsg = `Task completed in ${iteration} iteration(s). Tests passed.`;
      return {
        success: true,
        task_id: spec.task_id,
        status: 'success',
        message: serveWebUrl ? `${successMsg}\n\nWatch in browser: ${serveWebUrl}` : successMsg,
        iteration_count: iteration,
        final_code: execution.stdout?.slice(-4000),
      };
    }
    if (validation.status === 'escalate') {
      currentTask = null;
      recordTask(spec.task_id, JSON.stringify(prd), 'escalated', {
        completed_at: Math.floor(Date.now() / 1000),
      });
      emit('escalate', { task_id: spec.task_id, message: validation.message });
      const escalateMsg = validation.message ?? 'Escalated after max iterations.';
      return {
        success: false,
        task_id: spec.task_id,
        status: 'escalated',
        message: serveWebUrl ? `${escalateMsg}\n\nWatch in browser: ${serveWebUrl}` : escalateMsg,
        iteration_count: iteration,
      };
    }
    if (validation.action === 'antigravity_retry' && validation.feedback) {
      lastSpec = { ...lastSpec, context: { ...lastSpec.context, gotchas: [...lastSpec.context.gotchas, validation.feedback] } };
      writeSpecFile(lastSpec);
    }
    iteration++;
  }

  currentTask = null;
  recordTask(spec.task_id, JSON.stringify(prd), 'escalated', { completed_at: Math.floor(Date.now() / 1000) });
  const finalMsg = `Stopped after ${MAX_ITERATIONS} iterations. Need human help.`;
  return {
    success: false,
    task_id: spec.task_id,
    status: 'escalated',
    message: serveWebUrl ? `${finalMsg}\n\nWatch in browser: ${serveWebUrl}` : finalMsg,
    iteration_count: MAX_ITERATIONS,
  };
}
