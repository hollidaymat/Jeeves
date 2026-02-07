/**
 * Cursor Agent Refinement Loop
 * 
 * When a Cursor background agent completes a task and creates a PR,
 * this module reviews the PR against the original requirements,
 * identifies gaps, and sends targeted follow-up instructions
 * for the agent to address.
 * 
 * Flow:
 *   Task completes → extract PR URL → fetch diff → analyze vs PRD →
 *   ACCEPT (archive) or REFINE (follow-up + resume polling)
 * 
 * Constraints:
 *   - Max 3 refinement rounds per task
 *   - Haiku-only analysis (500 tokens max per round)
 *   - Budget-enforced via 'cursor_refinement' feature
 *   - If no PR URL found, skip refinement (can't review nothing)
 */

import { logger } from '../utils/logger.js';
import { getGitHubClient } from './github-client.js';
import { getCursorClient } from './cursor-client.js';
import { enforceBudget, recordFeatureUsage, getFeatureMaxTokens } from '../core/cost-tracker.js';
import { config } from '../config.js';
import type { CursorTask } from './cursor-orchestrator.js';

// ============================================================================
// Types
// ============================================================================

export interface RefinementState {
  taskId: string;
  agentId: string;
  prUrl: string;
  prNumber: number;
  repoFullName: string;
  requirements: string[];
  description: string;
  roundsCompleted: number;
  maxRounds: number;
  history: RefinementRound[];
  status: 'reviewing' | 'waiting_for_agent' | 'accepted' | 'max_rounds_reached' | 'skipped';
}

export interface RefinementRound {
  round: number;
  timestamp: string;
  filesReviewed: number;
  additionsReviewed: number;
  verdict: 'accept' | 'refine';
  issues: string[];
  followUpSent?: string;
}

// ============================================================================
// Constants
// ============================================================================

const MAX_REFINEMENT_ROUNDS = 3;
const MAX_DIFF_CHARS = 8000;  // Truncate diff to keep Haiku prompt small

// Active refinement states
const activeRefinements = new Map<string, RefinementState>();

// Callback to resume polling after refinement follow-up
let resumePollingFn: ((taskId: string) => void) | null = null;
// Callback to archive a completed task
let archiveTaskFn: ((task: CursorTask) => void) | null = null;
// Callback to broadcast events
let broadcastFn: ((type: string, payload: unknown) => void) | null = null;

// ============================================================================
// Setup
// ============================================================================

export function setRefinementCallbacks(callbacks: {
  resumePolling: (taskId: string) => void;
  archiveTask: (task: CursorTask) => void;
  broadcast: (type: string, payload: unknown) => void;
}): void {
  resumePollingFn = callbacks.resumePolling;
  archiveTaskFn = callbacks.archiveTask;
  broadcastFn = callbacks.broadcast;
}

function broadcast(type: string, payload: unknown): void {
  if (broadcastFn) broadcastFn(type, payload);
}

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Called when a Cursor agent task completes.
 * Decides whether to accept the result or start a refinement loop.
 * 
 * Returns true if refinement is being handled (caller should NOT archive).
 * Returns false if refinement was skipped (caller should archive normally).
 */
export async function onTaskCompleted(task: CursorTask): Promise<boolean> {
  // No PR URL = nothing to review
  if (!task.prUrl) {
    logger.debug('Refinement skipped: no PR URL', { taskId: task.id });
    return false;
  }

  // No GitHub client = can't review
  const github = getGitHubClient();
  if (!github) {
    logger.debug('Refinement skipped: GitHub not configured', { taskId: task.id });
    return false;
  }

  // No Cursor client = can't send follow-ups
  const cursor = getCursorClient();
  if (!cursor) {
    logger.debug('Refinement skipped: Cursor not configured', { taskId: task.id });
    return false;
  }

  // Parse PR URL → owner/repo + PR number
  const parsed = parsePrUrl(task.prUrl);
  if (!parsed) {
    logger.debug('Refinement skipped: could not parse PR URL', { prUrl: task.prUrl });
    return false;
  }

  // Budget check
  const budgetCheck = enforceBudget('cursor_refinement');
  if (!budgetCheck.allowed) {
    logger.debug('Refinement skipped: budget exhausted', { reason: budgetCheck.reason });
    return false;
  }

  // Simple tasks don't need refinement — single-requirement, low complexity
  if (task.spec.estimatedComplexity === 'low' && task.spec.requirements.length <= 1) {
    logger.debug('Refinement skipped: simple task', { taskId: task.id });
    return false;
  }

  // Start refinement
  const state: RefinementState = {
    taskId: task.id,
    agentId: task.agentId!,
    prUrl: task.prUrl,
    prNumber: parsed.prNumber,
    repoFullName: parsed.repoFullName,
    requirements: task.spec.requirements,
    description: task.spec.description,
    roundsCompleted: 0,
    maxRounds: MAX_REFINEMENT_ROUNDS,
    history: [],
    status: 'reviewing',
  };

  activeRefinements.set(task.id, state);

  logger.info('Starting refinement review', {
    taskId: task.id,
    prUrl: task.prUrl,
    requirements: task.spec.requirements.length,
  });

  broadcast('cursor:refinement:started', {
    taskId: task.id,
    prUrl: task.prUrl,
    maxRounds: MAX_REFINEMENT_ROUNDS,
  });

  // Run the first review
  await runRefinementRound(task, state);

  return true;
}

// ============================================================================
// Refinement Round
// ============================================================================

async function runRefinementRound(task: CursorTask, state: RefinementState): Promise<void> {
  const github = getGitHubClient()!;
  const roundNum = state.roundsCompleted + 1;

  try {
    // 1. Fetch PR metadata and file list
    const [pr, files] = await Promise.all([
      github.getPullRequest(state.repoFullName, state.prNumber).catch(() => null),
      github.getPullRequestFiles(state.repoFullName, state.prNumber).catch(() => []),
    ]);

    if (!pr) {
      logger.warn('Refinement: could not fetch PR', { prUrl: state.prUrl });
      state.status = 'skipped';
      finishRefinement(task, state);
      return;
    }

    // 2. Build a summary of what was delivered
    const fileSummary = files.map(f => 
      `${f.status} ${f.filename} (+${f.additions}/-${f.deletions})`
    ).join('\n');

    // 3. Get a truncated diff for analysis
    let diffText = '';
    try {
      const fullDiff = await github.getPullRequestDiff(state.repoFullName, state.prNumber);
      diffText = fullDiff.length > MAX_DIFF_CHARS
        ? fullDiff.substring(0, MAX_DIFF_CHARS) + '\n... (diff truncated)'
        : fullDiff;
    } catch {
      // Diff might be too large or unavailable — work with file list only
      diffText = '(diff unavailable)';
    }

    // 4. Check CI status if available
    let ciStatus = '';
    try {
      const checks = await github.getCheckStatus(state.repoFullName, pr.head.sha);
      ciStatus = checks.state || 'unknown';
      if (checks.statuses?.length > 0) {
        const failed = checks.statuses.filter(s => s.state === 'failure');
        if (failed.length > 0) {
          ciStatus = `FAILING: ${failed.map(f => `${f.context}: ${f.description}`).join('; ')}`;
        }
      }
    } catch {
      ciStatus = 'unknown';
    }

    // 5. Analyze with Haiku
    const budgetCheck = enforceBudget('cursor_refinement');
    if (!budgetCheck.allowed) {
      logger.info('Refinement: budget exhausted, accepting as-is', { taskId: task.id });
      state.status = 'accepted';
      finishRefinement(task, state);
      return;
    }

    const analysis = await analyzeDelivery({
      requirements: state.requirements,
      description: state.description,
      fileSummary,
      diffText,
      ciStatus,
      prTitle: pr.title,
      prBody: pr.body || '',
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changed_files,
      roundNum,
      previousIssues: state.history.flatMap(h => h.issues),
    });

    // 6. Record the round
    const round: RefinementRound = {
      round: roundNum,
      timestamp: new Date().toISOString(),
      filesReviewed: files.length,
      additionsReviewed: pr.additions,
      verdict: analysis.verdict,
      issues: analysis.issues,
    };

    state.roundsCompleted = roundNum;

    // 7. Act on verdict
    if (analysis.verdict === 'accept') {
      state.status = 'accepted';
      state.history.push(round);

      logger.info('Refinement: accepted', { taskId: task.id, round: roundNum });
      broadcast('cursor:refinement:accepted', {
        taskId: task.id,
        round: roundNum,
        message: analysis.summary,
      });

      finishRefinement(task, state);
      return;
    }

    // Verdict is 'refine'
    if (roundNum >= MAX_REFINEMENT_ROUNDS) {
      state.status = 'max_rounds_reached';
      state.history.push(round);

      logger.info('Refinement: max rounds reached, accepting', { taskId: task.id });
      broadcast('cursor:refinement:max_rounds', {
        taskId: task.id,
        round: roundNum,
        issues: analysis.issues,
      });

      finishRefinement(task, state);
      return;
    }

    // Send follow-up to Cursor agent
    const followUpText = buildFollowUp(analysis.issues, analysis.summary, roundNum);
    round.followUpSent = followUpText;
    state.history.push(round);

    try {
      const cursor = getCursorClient()!;
      await cursor.followUp(state.agentId, followUpText);
      state.status = 'waiting_for_agent';

      logger.info('Refinement: follow-up sent', {
        taskId: task.id,
        round: roundNum,
        issueCount: analysis.issues.length,
      });

      broadcast('cursor:refinement:followup_sent', {
        taskId: task.id,
        round: roundNum,
        issues: analysis.issues,
        summary: analysis.summary,
      });

      // Reset task status to running and resume polling
      task.status = 'running';
      task.pollCount = 0;  // Reset poll count for the new round

      if (resumePollingFn) {
        resumePollingFn(task.id);
      }
    } catch (err) {
      logger.error('Refinement: failed to send follow-up', { error: String(err) });
      state.status = 'accepted';  // Accept as-is if we can't send follow-up
      finishRefinement(task, state);
    }

  } catch (err) {
    logger.error('Refinement round failed', { error: String(err), taskId: task.id });
    state.status = 'skipped';
    finishRefinement(task, state);
  }
}

// ============================================================================
// LLM Analysis
// ============================================================================

interface AnalysisResult {
  verdict: 'accept' | 'refine';
  issues: string[];
  summary: string;
}

async function analyzeDelivery(context: {
  requirements: string[];
  description: string;
  fileSummary: string;
  diffText: string;
  ciStatus: string;
  prTitle: string;
  prBody: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  roundNum: number;
  previousIssues: string[];
}): Promise<AnalysisResult> {
  try {
    const { generateText } = await import('ai');
    const { createAnthropic } = await import('@ai-sdk/anthropic');
    const provider = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY || '' });

    const prompt = `You are reviewing a Cursor Background Agent's PR delivery against requirements.

## Original Task
${context.description}

## Requirements
${context.requirements.map((r, i) => `${i + 1}. ${r}`).join('\n')}

## PR: ${context.prTitle}
Files changed: ${context.changedFiles} | +${context.additions} / -${context.deletions}
CI status: ${context.ciStatus}

## Files Modified
${context.fileSummary}

## Diff (may be truncated)
${context.diffText}

## PR Description
${context.prBody || '(none)'}

${context.previousIssues.length > 0 ? `## Previously Reported Issues (should be fixed now)\n${context.previousIssues.map(i => `- ${i}`).join('\n')}\n` : ''}
## Review Round: ${context.roundNum} of ${MAX_REFINEMENT_ROUNDS}

Analyze whether ALL requirements have been met. Check for:
1. Missing requirements that weren't implemented
2. Build/CI failures
3. Obvious structural issues (empty files, missing imports, broken patterns)

Do NOT nitpick style, naming, or minor preferences. Only flag real gaps.

Respond with EXACTLY this JSON format:
{"verdict":"accept"|"refine","issues":["specific issue 1","specific issue 2"],"summary":"one sentence overall assessment"}

If everything looks solid, use "accept" with empty issues array. Only "refine" if there are real, actionable gaps.`;

    const maxTokens = getFeatureMaxTokens('cursor_refinement');

    const { text } = await generateText({
      model: provider(config.claude.haiku_model),
      messages: [{ role: 'user', content: prompt }],
      maxTokens,
    });

    recordFeatureUsage('cursor_refinement', 0.002);  // ~$0.002 per Haiku analysis

    // Parse JSON response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn('Refinement: could not parse LLM response', { text: text.substring(0, 200) });
      return { verdict: 'accept', issues: [], summary: 'Could not parse analysis — accepting as-is.' };
    }

    const parsed = JSON.parse(jsonMatch[0]) as { verdict?: string; issues?: string[]; summary?: string };
    return {
      verdict: (parsed.verdict === 'refine') ? 'refine' : 'accept',
      issues: Array.isArray(parsed.issues) ? parsed.issues : [],
      summary: parsed.summary || 'Analysis complete.',
    };

  } catch (err) {
    logger.error('Refinement analysis failed', { error: String(err) });
    return { verdict: 'accept', issues: [], summary: 'Analysis failed — accepting as-is.' };
  }
}

// ============================================================================
// Follow-Up Builder
// ============================================================================

function buildFollowUp(issues: string[], summary: string, roundNum: number): string {
  const header = `## Refinement Round ${roundNum} — Issues Found\n\n${summary}\n\nPlease address the following:`;
  const issueList = issues.map((issue, i) => `${i + 1}. ${issue}`).join('\n');
  const footer = `\nAfter fixing, create a new commit on the same branch and update the PR. Do not create a new PR.`;

  return `${header}\n\n${issueList}\n${footer}`;
}

// ============================================================================
// Completion
// ============================================================================

function finishRefinement(task: CursorTask, state: RefinementState): void {
  // Archive the completed task
  task.status = 'completed';
  task.completedAt = new Date().toISOString();

  // Attach refinement summary to task
  (task as CursorTask & { refinement?: RefinementState }).refinement = state;

  if (archiveTaskFn) {
    archiveTaskFn(task);
  }

  activeRefinements.delete(task.id);

  broadcast('cursor:refinement:complete', {
    taskId: task.id,
    status: state.status,
    roundsCompleted: state.roundsCompleted,
    history: state.history,
  });

  logger.info('Refinement complete', {
    taskId: task.id,
    status: state.status,
    rounds: state.roundsCompleted,
  });
}

// ============================================================================
// Re-entry Point (called when agent completes after a follow-up)
// ============================================================================

/**
 * Called when a task that's in refinement completes again after a follow-up.
 * Runs the next review round.
 */
export async function onRefinedTaskCompleted(task: CursorTask): Promise<boolean> {
  const state = activeRefinements.get(task.id);
  if (!state) return false;

  // Update PR URL if it changed
  if (task.prUrl) {
    const parsed = parsePrUrl(task.prUrl);
    if (parsed) {
      state.prNumber = parsed.prNumber;
      state.repoFullName = parsed.repoFullName;
      state.prUrl = task.prUrl;
    }
  }

  state.status = 'reviewing';
  await runRefinementRound(task, state);
  return true;
}

/**
 * Check if a task is currently in a refinement loop
 */
export function isInRefinement(taskId: string): boolean {
  return activeRefinements.has(taskId);
}

/**
 * Get refinement state for a task
 */
export function getRefinementState(taskId: string): RefinementState | null {
  return activeRefinements.get(taskId) || null;
}

/**
 * Get all active refinements
 */
export function getActiveRefinements(): RefinementState[] {
  return Array.from(activeRefinements.values());
}

// ============================================================================
// Helpers
// ============================================================================

function parsePrUrl(url: string): { repoFullName: string; prNumber: number } | null {
  // https://github.com/owner/repo/pull/123
  const match = url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  if (!match) return null;
  return {
    repoFullName: match[1],
    prNumber: parseInt(match[2], 10),
  };
}
