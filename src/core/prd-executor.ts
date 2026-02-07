/**
 * PRD Executor - Phase 5
 * 
 * Autonomous building from PRD specs with:
 * - Planning phase (requires approval)
 * - Execution phase (with checkpoints)
 * - Review phase (deviation reports)
 */

import { generateText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { isAgentAvailable, startAgentSession, sendToAgent, applyChanges } from './cursor-agent.js';
import { recordTask, recordRollback, getTrustPermissions } from './trust.js';
import { MODELS } from './model-selector.js';
import { 
  startBuildTracking, 
  recordPhase, 
  completeBuildTracking,
  getCurrentBuildCost,
  resetCircuitBreaker
} from './learning.js';
import { persistCosts } from './cost-tracker.js';
import type { 
  ExecutionPlan, 
  PrdPhase, 
  PrdDeviation, 
  PrdCheckpoint 
} from '../types/index.js';

// Active execution plan
let activePlan: ExecutionPlan | null = null;
let checkpointCallbacks: ((checkpoint: PrdCheckpoint) => void)[] = [];

/**
 * Check if a message triggers PRD mode
 */
export function isPrdTrigger(message: string): boolean {
  if (!config.prd.enabled) return false;
  
  const lowerMessage = message.toLowerCase();
  return config.prd.triggers.some(trigger => lowerMessage.includes(trigger.toLowerCase()));
}

/**
 * Submit a PRD for planning
 */
export async function submitPrd(
  prdContent: string, 
  projectPath: string
): Promise<{ success: boolean; plan?: ExecutionPlan; message: string }> {
  logger.info('PRD submitted for planning', { projectPath, contentLength: prdContent.length });

  // Ensure we have an active AI session
  if (!isAgentAvailable()) {
    const result = await startAgentSession(projectPath);
    if (!result.success) {
      return { success: false, message: result.message };
    }
  }

  try {
    const anthropic = createAnthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });

    const planningPrompt = `You are a senior software engineer planning the implementation of a PRD.

Analyze this PRD and create a detailed execution plan. Break it into 3-6 phases, each with:
- Clear deliverables
- Time estimate
- Technical decisions (what YOU decided, not questions - pick sensible defaults)

IMPORTANT: Do NOT ask questions. Make your own best decisions for each technical choice.
Pick the simplest, most maintainable approach. Use industry best practices.

## PRD CONTENT:
${prdContent}

## OUTPUT FORMAT (JSON):
{
  "phases": [
    {
      "id": "phase-1",
      "name": "Database Schema",
      "description": "Create tables and RLS policies",
      "estimatedDuration": "30min",
      "decisions": ["Using junction table for better query performance", "UUID for IDs"]
    }
  ],
  "totalEstimate": "4 hours",
  "confidence": 85,
  "constraints": ["Use existing design patterns", "Follow project conventions"]
}

Respond with ONLY valid JSON, no markdown or explanation.`;

    // LESSON LEARNED (build-4): Use Sonnet for PRD planning, not Opus
    // Sonnet 4 produces equivalent quality plans at 1/5 the cost
    // Opus should ONLY be used for enterprise architecture decisions
    logger.info('Using Sonnet for PRD planning', { model: MODELS.sonnet.modelId });
    
    const { text } = await generateText({
      model: anthropic(MODELS.sonnet.modelId),
      prompt: planningPrompt,
      maxTokens: 2000
    });

    // Parse the JSON response
    let planData;
    try {
      // Extract JSON if wrapped in markdown
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        planData = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found in response');
      }
    } catch (parseError) {
      logger.error('Failed to parse planning response', { error: String(parseError), text });
      return { 
        success: false, 
        message: 'Failed to generate execution plan. AI response was not valid JSON.' 
      };
    }

    // Build the execution plan
    const plan: ExecutionPlan = {
      id: `prd-${Date.now()}`,
      prdContent,
      projectPath,
      projectName: projectPath.split(/[\\/]/).pop() || 'unknown',
      phases: planData.phases.map((p: Partial<PrdPhase>) => ({
        ...p,
        status: 'pending'
      })),
      totalEstimate: planData.totalEstimate,
      confidence: planData.confidence,
      constraints: planData.constraints || [],
      createdAt: new Date().toISOString(),
      status: 'awaiting_approval',
      currentPhaseIndex: 0,
      deviations: []
    };

    activePlan = plan;
    logger.info('Execution plan created', { 
      phases: plan.phases.length, 
      estimate: plan.totalEstimate,
      confidence: plan.confidence 
    });

    return {
      success: true,
      plan,
      message: formatPlanForDisplay(plan)
    };
  } catch (error) {
    logger.error('PRD planning failed', { error: String(error) });
    return { 
      success: false, 
      message: `Planning failed: ${error instanceof Error ? error.message : 'Unknown error'}` 
    };
  }
}

/**
 * Format execution plan for display
 */
function formatPlanForDisplay(plan: ExecutionPlan): string {
  const lines: string[] = [
    '## PRD Execution Plan',
    '',
    `**Project:** ${plan.projectName}`,
    `**Total Estimate:** ${plan.totalEstimate}`,
    `**Confidence:** ${plan.confidence}%`,
    ''
  ];

  plan.phases.forEach((phase, i) => {
    lines.push(`### Phase ${i + 1}: ${phase.name} (${phase.estimatedDuration})`);
    lines.push(phase.description);
    // Show decisions made (not questions) - support both old and new format
    const decisions = phase.decisions || phase.decisionPoints || [];
    if (decisions.length > 0) {
      lines.push(`**Approach:**`);
      decisions.forEach(d => lines.push(`- ${d}`));
    }
    lines.push('');
  });

  if (plan.constraints.length > 0) {
    lines.push('**Constraints:**');
    plan.constraints.forEach(c => lines.push(`- ${c}`));
    lines.push('');
  }

  lines.push('---');
  lines.push('Say **"approve"** to start building, or provide feedback to adjust the plan.');

  return lines.join('\n');
}

/**
 * Approve the execution plan and start building
 */
export async function approvePlan(constraints?: string[]): Promise<{ success: boolean; message: string }> {
  if (!activePlan) {
    return { success: false, message: 'No pending execution plan. Submit a PRD first.' };
  }

  if (activePlan.status !== 'awaiting_approval') {
    return { success: false, message: `Plan is ${activePlan.status}, not awaiting approval.` };
  }

  // Add any additional constraints
  if (constraints && constraints.length > 0) {
    activePlan.constraints.push(...constraints);
  }

  activePlan.approvedAt = new Date().toISOString();
  activePlan.status = 'executing';

  // Start build tracking for cost monitoring
  startBuildTracking(activePlan.projectName, 'prd_phases');
  logger.info('Build tracking started for cost monitoring');

  // Create feature branch if configured
  if (config.prd.branch_strategy === 'feature-branch') {
    activePlan.branchName = `feature/prd-${activePlan.id.split('-').pop()}`;
    logger.info('Would create branch', { branch: activePlan.branchName });
    // Note: Actual git branch creation would happen here
  }

  logger.info('Plan approved, starting execution', { planId: activePlan.id });

  // Start executing phases
  executeNextPhase();

  return {
    success: true,
    message: `Plan approved! Starting Phase 1: ${activePlan.phases[0].name}\n\nI'll check in after each phase. Say "pause" at any time to stop.`
  };
}

/**
 * Execute the next phase in the plan
 */
async function executeNextPhase(): Promise<void> {
  if (!activePlan || activePlan.status !== 'executing') {
    return;
  }

  const phaseIndex = activePlan.currentPhaseIndex;
  const phase = activePlan.phases[phaseIndex];

  if (!phase) {
    // All phases complete
    await completePlan();
    return;
  }

  logger.info('Executing phase', { phase: phase.name, index: phaseIndex });
  phase.status = 'executing';
  phase.startedAt = new Date().toISOString();

  try {
    // Build prompt for this phase
    const phasePrompt = buildPhasePrompt(phase, activePlan);

    // Execute via the AI agent
    const response = await sendToAgent(phasePrompt);

    // Apply any changes
    const hasChanges = response.includes('file(s) ready to modify');
    if (hasChanges) {
      const applyResult = await applyChanges();
      if (applyResult.success) {
        phase.filesModified = extractFilesFromResult(applyResult.message);
      }
    }

    // Mark phase complete
    phase.status = 'completed';
    phase.completedAt = new Date().toISOString();
    phase.result = response;
    
    // Reset consecutive failure counter on success
    activePlan._consecutiveFailures = 0;

    // Record phase for learning system (cost tracking & circuit breaker)
    const phaseCost = getCurrentBuildCost();
    const learningResult = recordPhase(phase.name, 'completed', phaseCost);
    
    if (learningResult.warning) {
      logger.warn('Learning system warning', { warning: learningResult.warning });
      notifyCheckpoint({
        phaseId: phase.id,
        phaseName: phase.name,
        message: learningResult.warning,
        decisions: [],
        filesChanged: [],
        timestamp: new Date().toISOString(),
        requiresResponse: !learningResult.shouldContinue
      });
    }
    
    if (!learningResult.shouldContinue) {
      activePlan.status = 'paused';
      persistCosts();
      return;
    }

    // Record successful task for trust escalation
    recordTask({
      type: 'prd',
      description: `Completed phase: ${phase.name}`,
      startedAt: phase.startedAt || new Date().toISOString(),
      completedAt: new Date().toISOString(),
      success: true,
      rollback: false,
      corrections: 0
    });

    // Send checkpoint
    const checkpoint: PrdCheckpoint = {
      phaseId: phase.id,
      phaseName: phase.name,
      message: `Phase ${phaseIndex + 1} complete: ${phase.name}`,
      decisions: [],  // Would be populated from AI response
      filesChanged: phase.filesModified || [],
      timestamp: new Date().toISOString(),
      requiresResponse: false
    };

    notifyCheckpoint(checkpoint);

    // Move to next phase
    activePlan.currentPhaseIndex++;

    // Always auto-continue to next phase - no waiting for user confirmation
    // User can still say "pause" if they want to stop
    logger.info('Auto-continuing to next phase', { 
      nextPhase: activePlan.currentPhaseIndex + 1,
      totalPhases: activePlan.phases.length
    });
    
    // Small delay to allow UI to update, then continue
    setTimeout(() => {
      if (activePlan?.status === 'executing') {
        executeNextPhase();
      }
    }, 500);

  } catch (error) {
    const errorStr = error instanceof Error ? error.message : String(error);
    logger.error('Phase execution failed', { phase: phase.name, error: errorStr });
    phase.status = 'failed';
    
    // Detect rate limit errors -- pause and wait instead of burning through phases
    const isRateLimit = errorStr.includes('rate limit') || errorStr.includes('rate_limit') || errorStr.includes('429');
    
    if (isRateLimit) {
      activePlan.status = 'paused';
      logger.warn('Rate limit hit - pausing execution to cool down', { phase: phase.name });
      
      notifyCheckpoint({
        phaseId: phase.id,
        phaseName: phase.name,
        message: `Rate limit hit during "${phase.name}". Pausing for cooldown.\nSay "resume" in a few minutes to retry this phase.`,
        decisions: [],
        filesChanged: [],
        timestamp: new Date().toISOString(),
        requiresResponse: true
      });
      
      // Don't increment phase index -- retry the same phase on resume
      persistCosts();
      return;
    }
    
    // Track consecutive non-rate-limit failures
    if (!activePlan._consecutiveFailures) activePlan._consecutiveFailures = 0;
    activePlan._consecutiveFailures++;
    
    // Record failure for learning system (circuit breaker)
    const phaseCost = getCurrentBuildCost();
    const learningResult = recordPhase(phase.name, 'failed', phaseCost, errorStr);
    
    // Persist costs immediately on failure
    persistCosts();

    // Stop after 2 consecutive failures OR if circuit breaker triggers
    if (activePlan._consecutiveFailures >= 2 || !learningResult.shouldContinue) {
      activePlan.status = 'paused';
      logger.warn('Build paused after consecutive failures', { 
        phase: phase.name, 
        consecutiveFailures: activePlan._consecutiveFailures
      });
      
      notifyCheckpoint({
        phaseId: phase.id,
        phaseName: phase.name,
        message: learningResult.warning || `Phase "${phase.name}" failed (${activePlan._consecutiveFailures} consecutive failures). Build paused.\nSay "resume" to retry or "abort" to stop.`,
        decisions: [],
        filesChanged: [],
        timestamp: new Date().toISOString(),
        requiresResponse: true
      });
      return;
    }

    // Record failure for trust de-escalation
    recordRollback(`Phase "${phase.name}" failed: ${errorStr}`);

    notifyCheckpoint({
      phaseId: phase.id,
      phaseName: phase.name,
      message: `Phase failed: ${errorStr}. Skipping to next phase...`,
      decisions: [],
      filesChanged: [],
      timestamp: new Date().toISOString(),
      requiresResponse: false
    });
    
    // Skip to next phase (single non-rate-limit failure)
    activePlan.currentPhaseIndex++;
    setTimeout(() => {
      if (activePlan?.status === 'executing') {
        executeNextPhase();
      }
    }, 1000);
  }
}

/**
 * Build prompt for executing a phase
 */
function buildPhasePrompt(phase: PrdPhase, plan: ExecutionPlan): string {
  const completedPhases = plan.phases
    .filter(p => p.status === 'completed')
    .map(p => `- ${p.name}: ${p.result?.substring(0, 200)}...`)
    .join('\n');

  return `You are executing Phase "${phase.name}" of a PRD implementation.

## PHASE OBJECTIVE
${phase.description}

## CONSTRAINTS
${plan.constraints.map(c => `- ${c}`).join('\n')}

${completedPhases ? `## COMPLETED PHASES\n${completedPhases}` : ''}

## TECHNICAL APPROACH
${(phase.decisions || phase.decisionPoints || []).map(d => `- ${d}`).join('\n') || 'Use best practices'}

## ORIGINAL PRD
${plan.prdContent}

## INSTRUCTIONS
1. Implement the deliverables for this phase using the technical approach above
2. Make your own decisions for any unspecified details - pick sensible defaults
3. Do NOT ask questions - just build and explain your choices
4. Provide code changes using the edit format

Be thorough but efficient. Show your work.`;
}

/**
 * Complete the execution plan
 */
async function completePlan(): Promise<void> {
  if (!activePlan) return;

  activePlan.status = 'completed';
  activePlan.completedAt = new Date().toISOString();

  // Complete build tracking and analyze
  const completedPhases = activePlan.phases.filter(p => p.status === 'completed').length;
  const totalPhases = activePlan.phases.length;
  const prdCompliance = Math.round((completedPhases / totalPhases) * 100);
  const linesOfCode = activePlan.phases.reduce((sum, p) => sum + (p.filesModified?.length || 0) * 50, 0); // Estimate
  
  const analysis = completeBuildTracking(
    activePlan.projectName,
    'prd_phases',
    prdCompliance,
    linesOfCode,
    activePlan.deviations.map(d => d.prdSaid)
  );
  
  // Persist costs
  persistCosts();
  
  logger.info('Build analysis complete', { 
    efficiency: analysis.efficiency,
    costPerLine: analysis.costPerLine,
    newLessons: analysis.newLessons.length
  });

  // Generate summary
  const summary = generateCompletionSummary(activePlan);

  logger.info('PRD execution complete', { 
    planId: activePlan.id, 
    phases: activePlan.phases.length,
    deviations: activePlan.deviations.length 
  });

  notifyCheckpoint({
    phaseId: 'complete',
    phaseName: 'Execution Complete',
    message: summary,
    decisions: [],
    filesChanged: activePlan.phases.flatMap(p => p.filesModified || []),
    timestamp: new Date().toISOString(),
    requiresResponse: false
  });
}

/**
 * Generate completion summary
 */
function generateCompletionSummary(plan: ExecutionPlan): string {
  const filesChanged = plan.phases.flatMap(p => p.filesModified || []);
  
  const lines = [
    '## PRD Execution Complete',
    '',
    `**Project:** ${plan.projectName}`,
    `**Duration:** ${calculateDuration(plan)}`,
    `**Files Modified:** ${filesChanged.length}`,
    ''
  ];

  // Phase summary
  lines.push('### Phases Completed');
  plan.phases.forEach((phase, i) => {
    const status = phase.status === 'completed' ? '✅' : '❌';
    lines.push(`${status} Phase ${i + 1}: ${phase.name}`);
  });
  lines.push('');

  // Deviations
  if (plan.deviations.length > 0) {
    lines.push('### Deviations from PRD');
    plan.deviations.forEach(dev => {
      lines.push(`- **${dev.phase}:** ${dev.prdSaid} → ${dev.actualDid}`);
      lines.push(`  *Reason:* ${dev.reasoning}`);
    });
    lines.push('');
  }

  // Files
  if (filesChanged.length > 0) {
    lines.push('### Files Changed');
    filesChanged.forEach(f => lines.push(`- ${f}`));
  }

  return lines.join('\n');
}

/**
 * Calculate duration from plan
 */
function calculateDuration(plan: ExecutionPlan): string {
  if (!plan.approvedAt || !plan.completedAt) return 'Unknown';
  
  const start = new Date(plan.approvedAt).getTime();
  const end = new Date(plan.completedAt).getTime();
  const minutes = Math.round((end - start) / 60000);
  
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m`;
}

/**
 * Extract files from apply result
 */
function extractFilesFromResult(result: string): string[] {
  const files: string[] = [];
  const matches = result.matchAll(/[✓✗]\s+(?:Update|Partial update)\s+(.+)/g);
  for (const match of matches) {
    files.push(match[1]);
  }
  return files;
}

/**
 * Pause execution
 */
export function pauseExecution(): { success: boolean; message: string } {
  if (!activePlan || activePlan.status !== 'executing') {
    return { success: false, message: 'No execution in progress.' };
  }

  activePlan.status = 'paused';
  logger.info('Execution paused', { planId: activePlan.id, phase: activePlan.currentPhaseIndex });

  return {
    success: true,
    message: `Execution paused at Phase ${activePlan.currentPhaseIndex + 1}. Say "resume" to continue.`
  };
}

/**
 * Resume execution
 */
export function resumeExecution(): { success: boolean; message: string } {
  if (!activePlan) {
    return { success: false, message: 'No execution plan found.' };
  }

  if (activePlan.status !== 'paused') {
    return { success: false, message: `Plan is ${activePlan.status}, not paused.` };
  }

  activePlan.status = 'executing';
  logger.info('Execution resumed', { planId: activePlan.id });

  // Continue execution
  executeNextPhase();

  return {
    success: true,
    message: `Resuming execution at Phase ${activePlan.currentPhaseIndex + 1}.`
  };
}

/**
 * Abort execution
 */
export function abortExecution(): { success: boolean; message: string } {
  if (!activePlan) {
    return { success: false, message: 'No execution plan found.' };
  }

  const planId = activePlan.id;
  const currentPhase = activePlan.currentPhaseIndex;
  
  activePlan.status = 'failed';
  activePlan = null;

  logger.info('Execution aborted', { planId, phase: currentPhase });

  return {
    success: true,
    message: `Execution aborted at Phase ${currentPhase + 1}. Changes made so far have been applied.`
  };
}

/**
 * Get execution status
 */
export function getExecutionStatus(): { active: boolean; plan?: ExecutionPlan; summary?: string } {
  if (!activePlan) {
    return { active: false };
  }

  const currentPhase = activePlan.phases[activePlan.currentPhaseIndex];
  const completedCount = activePlan.phases.filter(p => p.status === 'completed').length;

  const summary = `**Status:** ${activePlan.status}
**Progress:** ${completedCount}/${activePlan.phases.length} phases
**Current:** ${currentPhase?.name || 'Complete'}`;

  return {
    active: true,
    plan: activePlan,
    summary
  };
}

/**
 * Register checkpoint callback
 */
export function onCheckpoint(callback: (checkpoint: PrdCheckpoint) => void): void {
  checkpointCallbacks.push(callback);
}

/**
 * Notify all checkpoint listeners
 */
function notifyCheckpoint(checkpoint: PrdCheckpoint): void {
  checkpointCallbacks.forEach(cb => cb(checkpoint));
}

/**
 * Get active plan
 */
export function getActivePlan(): ExecutionPlan | null {
  return activePlan;
}
