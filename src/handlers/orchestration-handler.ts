/**
 * Orchestration Handler
 * Validates PRD, starts orchestration async, returns taskId for tracking.
 * Used by aider_orchestrate so the reply includes taskId.
 */

import { orchestrate } from '../core/orchestrator/index.js';
import { analyzePRD } from '../core/orchestrator/prd-intake.js';
import { generateId } from '../core/context/db.js';
import type { PRDRequest } from '../core/orchestrator/types.js';
import { logger } from '../utils/logger.js';

export interface HandlePRDResult {
  success: boolean;
  taskId?: string;
  message: string;
  needsClarification?: boolean;
  questions?: string[];
}

/**
 * Generate a task ID for async orchestration (same format as spec-generator).
 */
function generateTaskId(): string {
  return `ag-${generateId('t').replace(/[^a-z0-9-]/gi, '-')}`;
}

/**
 * Validate PRD, start orchestration in background, return taskId immediately.
 * If clarification is needed, returns needsClarification + questions (no taskId).
 */
export async function handlePRD(prd: PRDRequest, _userId?: string): Promise<HandlePRDResult> {
  const intake = await analyzePRD(prd);
  if (!intake.ready && intake.questions.length > 0) {
    return {
      success: false,
      message: `Need clarification (${intake.questions.length} questions).`,
      needsClarification: true,
      questions: intake.questions,
    };
  }

  const taskId = generateTaskId();

  // Start orchestration in background — do not await
  orchestrate(prd, { taskId })
    .then((result) => {
      logger.info('[orchestration-handler] Task completed', {
        task_id: taskId,
        status: result.status,
        success: result.success,
      });
    })
    .catch((err) => {
      logger.error('[orchestration-handler] Task failed', {
        task_id: taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

  return {
    success: true,
    taskId,
    message: `Orchestration started. Task ID: \`${taskId}\` — track at /api/orchestration/${taskId} or the ORCHESTRATION tab.`,
  };
}
