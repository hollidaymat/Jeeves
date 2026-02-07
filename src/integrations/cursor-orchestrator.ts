/**
 * Cursor Task Orchestrator
 * 
 * Bridges Jeeves' intent system with Cursor's Background Agent API.
 * Handles: task creation, agent launch, polling, follow-ups, and status reporting.
 * 
 * Flow: user message → classify → build task spec → confirm → launch agent → poll → report
 */

import { randomUUID } from 'crypto';
import { getCursorClient, isCursorEnabled } from './cursor-client.js';
import { type TaskSpec } from './cursor-prompts.js';
import { logger } from '../utils/logger.js';
import { onTaskCompleted, onRefinedTaskCompleted, isInRefinement, setRefinementCallbacks } from './cursor-refinement.js';

// ============================================================================
// Types
// ============================================================================

export type CursorTaskStatus = 'pending' | 'confirmed' | 'running' | 'completed' | 'stuck' | 'error' | 'stopped';

export interface CursorTask {
  id: string;
  agentId?: string;
  spec: TaskSpec;
  status: CursorTaskStatus;
  startedAt: string;
  completedAt?: string;
  lastChecked?: string;
  lastMessage?: string;
  prUrl?: string;
  cursorUrl?: string;
  error?: string;
  pollCount: number;
}

// ============================================================================
// Repository Mapping
// ============================================================================

const REPO_MAP: Record<string, string> = {
  'dive-connect':        'https://github.com/hollidaymat/Dive_Connect',
  'dive_connect':        'https://github.com/hollidaymat/Dive_Connect',
  'diveconnect':         'https://github.com/hollidaymat/Dive_Connect',
  'diveconnect-ai':      'https://github.com/hollidaymat/diveconnect_ai',
  'diveconnect_ai':      'https://github.com/hollidaymat/diveconnect_ai',
  'diveconnect-mobile':  'https://github.com/hollidaymat/diveconnect-mobile',
  'legends-agile':       'https://github.com/hollidaymat/Legends-Agile',
  'legends_agile':       'https://github.com/hollidaymat/Legends-Agile',
  'legends':             'https://github.com/hollidaymat/Legends-Agile',
  'sentinel':            'https://github.com/hollidaymat/sentinel',
  'jeeves':              'https://github.com/hollidaymat/Jeeves',
  'signal-cursor-controller': 'https://github.com/hollidaymat/Jeeves',
};

export function resolveRepository(projectName: string): string | null {
  const key = projectName.toLowerCase().trim().replace(/\s+/g, '-');
  return REPO_MAP[key] || null;
}

export function getAvailableRepos(): Array<{ name: string; url: string }> {
  const seen = new Set<string>();
  const repos: Array<{ name: string; url: string }> = [];
  for (const [name, url] of Object.entries(REPO_MAP)) {
    if (!seen.has(url)) {
      seen.add(url);
      repos.push({ name, url });
    }
  }
  return repos;
}

// ============================================================================
// Orchestrator State
// ============================================================================

const activeTasks = new Map<string, CursorTask>();
const completedTasks: CursorTask[] = [];
let pendingConfirmation: CursorTask | null = null;
const MAX_COMPLETED = 50;
const POLL_INTERVAL_MS = 15000;  // 15 seconds
const STUCK_THRESHOLD_MS = 300000;  // 5 minutes
const MAX_POLL_COUNT = 200;  // ~50 minutes max

// WebSocket broadcast callback (set by web.ts)
let broadcastFn: ((type: string, payload: unknown) => void) | null = null;

export function setBroadcast(fn: (type: string, payload: unknown) => void): void {
  broadcastFn = fn;

  // Wire refinement callbacks now that we have broadcast
  setRefinementCallbacks({
    resumePolling: (taskId: string) => schedulePoll(taskId),
    archiveTask: (task: CursorTask) => archiveTask(task),
    broadcast: fn,
  });
}

function broadcast(type: string, payload: unknown): void {
  if (broadcastFn) broadcastFn(type, payload);
}

// ============================================================================
// New Project Creation
// ============================================================================

/**
 * Create a brand new GitHub repo, scaffold it with a PRD, then queue
 * a Cursor agent task to implement it.
 */
export async function createNewProject(
  projectName: string,
  prd: string,
  options?: { isPrivate?: boolean }
): Promise<{ success: boolean; message: string }> {
  const { getGitHubClient, isGitHubEnabled } = await import('./github-client.js');

  if (!isGitHubEnabled()) {
    return { success: false, message: 'GITHUB_TOKEN not set. Add it to .env to enable project creation.' };
  }

  const github = getGitHubClient();
  if (!github) {
    return { success: false, message: 'Failed to initialize GitHub client.' };
  }

  // Sanitize project name for GitHub
  const repoName = projectName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

  try {
    // Check if repo already exists
    const exists = await github.repoExists(repoName);
    if (exists) {
      return { success: false, message: `Repository "${repoName}" already exists on GitHub.` };
    }

    // Create the repo (auto_init gives us a default README + main branch)
    const repo = await github.createRepo({
      name: repoName,
      description: `Jeeves project: ${projectName}`,
      isPrivate: options?.isPrivate ?? true,
      autoInit: true,
    });

    // Push the PRD and cursor rules as initial scaffold
    const cursorRules = `# Project Rules

## Context
This project was bootstrapped by Jeeves and is being built by a Cursor Background Agent.

## Conventions
- Use TypeScript where possible
- Follow the PRD in README.md for all requirements
- Commit with clear messages prefixed with [jeeves]
- Create clean, well-documented code
- Include error handling and edge cases
- Make it production-quality even for small projects
`;

    await github.pushFiles(repoName, [
      { path: 'README.md', content: `# ${projectName}\n\n${prd}` },
      { path: '.cursor/rules/project.mdc', content: cursorRules },
    ], '[jeeves] Initial scaffold with PRD and cursor rules');

    // Register this repo in the REPO_MAP for future use
    REPO_MAP[repoName] = repo.html_url;

    logger.info('New project created', { repo: repo.full_name, url: repo.html_url });

    // Now create a Cursor task for it
    const task = createTask(
      `Implement the full PRD for ${projectName}`,
      repoName,
      {
        type: 'feature',
        requirements: ['Implement ALL requirements from the README.md PRD'],
        complexity: 'high',
      }
    );

    if (!task) {
      return {
        success: true,
        message: `Repo created: ${repo.html_url}\n\nBut failed to create Cursor task. Use "cursor build implement PRD for ${repoName}" manually.`,
      };
    }

    const plan = getPendingPlan();
    return {
      success: true,
      message: `New project created!\n\nRepo: ${repo.html_url}\n\n${plan || 'Send "go" to launch the Cursor agent.'}`,
    };
  } catch (error) {
    logger.error('Failed to create new project', { error: String(error) });
    return { success: false, message: `Failed to create project: ${error}` };
  }
}

// ============================================================================
// Task Lifecycle
// ============================================================================

/**
 * Create a task spec from user input (called by parser/executor)
 */
export function createTask(
  description: string,
  project: string,
  options?: {
    type?: TaskSpec['type'];
    requirements?: string[];
    relatedFiles?: string[];
    complexity?: TaskSpec['estimatedComplexity'];
  }
): CursorTask | null {
  const repository = resolveRepository(project);
  if (!repository) {
    logger.warn('Unknown project for Cursor task', { project });
    return null;
  }

  const taskId = `task-${Date.now().toString(36)}`;
  const branch = `jeeves/${taskId}`;

  const spec: TaskSpec = {
    id: taskId,
    type: options?.type || 'general',
    summary: description.length > 80 ? description.substring(0, 80) + '...' : description,
    description,
    project,
    repository,
    branch,
    requirements: options?.requirements || [description],
    relatedFiles: options?.relatedFiles || [],
    estimatedComplexity: options?.complexity || 'medium',
  };

  const task: CursorTask = {
    id: taskId,
    spec,
    status: 'pending',
    startedAt: new Date().toISOString(),
    pollCount: 0,
  };

  // Store as pending confirmation
  pendingConfirmation = task;

  return task;
}

/**
 * Get the formatted plan for user confirmation
 */
export function getPendingPlan(): string | null {
  if (!pendingConfirmation) return null;

  const t = pendingConfirmation.spec;
  return `**Plan: ${t.summary}**

Project: ${t.project}
Complexity: ${t.estimatedComplexity}
Branch: ${t.branch}
Repository: ${t.repository}

Requirements:
${t.requirements.map(r => `  - ${r}`).join('\n')}
${t.relatedFiles.length > 0 ? `\nFiles likely affected:\n${t.relatedFiles.map(f => `  - ${f}`).join('\n')}` : ''}

Send "go" to launch the Cursor agent, or reply with changes.`;
}

/**
 * Check if there's a pending task waiting for confirmation
 */
export function hasPendingCursorTask(): boolean {
  return pendingConfirmation !== null;
}

/**
 * Confirm and launch the pending task
 */
export async function confirmAndLaunch(): Promise<{ success: boolean; message: string }> {
  if (!pendingConfirmation) {
    return { success: false, message: 'No pending Cursor task to confirm.' };
  }

  const client = getCursorClient();
  if (!client) {
    return { success: false, message: 'Cursor API not configured. Set CURSOR_API_KEY in .env.' };
  }

  const task = pendingConfirmation;
  pendingConfirmation = null;

  try {
    // Build the prompt with learned preferences
    const { buildPromptWithPreferences } = await import('./cursor-prompts.js');
    const prompt = await buildPromptWithPreferences(task.spec);

    // Launch the agent — always branch from 'main', Cursor auto-creates its working branch
    const agent = await client.launchAgent(prompt, task.spec.repository, 'main');

    task.agentId = agent.id;
    task.status = 'running';
    // Extract cursor web URL from launch response
    const target = agent as Record<string, unknown>;
    task.cursorUrl = ((target.target as Record<string, unknown>)?.url as string) || `https://cursor.com/agents?id=${agent.id}`;
    activeTasks.set(task.id, task);

    broadcast('cursor:task:started', {
      taskId: task.id,
      agentId: agent.id,
      summary: task.spec.summary,
      project: task.spec.project,
      branch: task.spec.branch,
      cursorUrl: task.cursorUrl,
    });

    // Start polling
    schedulePoll(task.id);

    logger.info('Cursor agent launched', {
      taskId: task.id,
      agentId: agent.id,
      project: task.spec.project,
      branch: task.spec.branch,
    });

    return {
      success: true,
      message: `Cursor agent launched.\nAgent: ${agent.id}\nBranch: ${task.spec.branch}\n\nI'll keep you posted on progress.`,
    };
  } catch (error) {
    task.status = 'error';
    task.error = String(error);
    archiveTask(task);
    logger.error('Failed to launch Cursor agent', { error: String(error) });
    return { success: false, message: `Failed to launch Cursor agent: ${error}` };
  }
}

/**
 * Cancel the pending confirmation
 */
export function cancelPendingTask(): void {
  pendingConfirmation = null;
}

// ============================================================================
// Polling
// ============================================================================

function schedulePoll(taskId: string): void {
  setTimeout(() => pollAgent(taskId), POLL_INTERVAL_MS);
}

async function pollAgent(taskId: string): Promise<void> {
  const task = activeTasks.get(taskId);
  if (!task || !task.agentId) return;

  const client = getCursorClient();
  if (!client) return;

  try {
    // Primary: check agent status endpoint for definitive state
    let agentStatus: string | undefined;
    let agentUrl: string | undefined;
    try {
      const agentInfo = await client.getAgent(task.agentId);
      agentStatus = (agentInfo.status || '').toString().toUpperCase();
      // Extract cursor web URL if available
      const target = agentInfo as Record<string, unknown>;
      agentUrl = ((target.target as Record<string, unknown>)?.url as string) || undefined;
      if (agentUrl) task.cursorUrl = agentUrl;
    } catch {
      // Agent detail endpoint might not be available, fall back to conversation
    }

    task.lastChecked = new Date().toISOString();
    task.pollCount++;

    // Definitive status from agent endpoint
    if (agentStatus === 'COMPLETED' || agentStatus === 'FINISHED') {
      // Get last conversation message for PR URL extraction
      try {
        const conv = await client.getConversation(task.agentId);
        const msgs = conv.messages || [];
        task.lastMessage = msgs[msgs.length - 1]?.content?.substring(0, 500) || '';
      } catch { /* ok */ }

      task.status = 'completed';
      task.completedAt = new Date().toISOString();
      task.prUrl = extractPrUrl(task.lastMessage || '');

      broadcast('cursor:task:completed', {
        taskId: task.id,
        agentId: task.agentId,
        summary: task.spec.summary,
        prUrl: task.prUrl,
        cursorUrl: task.cursorUrl,
      });

      logger.info('Cursor task completed', { taskId: task.id, agentId: task.agentId, prUrl: task.prUrl });

      // Hand off to refinement loop — it decides whether to accept or iterate
      try {
        const handled = isInRefinement(task.id)
          ? await onRefinedTaskCompleted(task)
          : await onTaskCompleted(task);
        if (handled) return;  // Refinement is managing this task now
      } catch (err) {
        logger.debug('Refinement check failed, archiving normally', { error: String(err) });
      }

      archiveTask(task);
      return;
    }

    if (agentStatus === 'FAILED' || agentStatus === 'ERROR') {
      task.status = 'error';
      task.error = `Agent status: ${agentStatus}`;

      broadcast('cursor:task:error', {
        taskId: task.id,
        agentId: task.agentId,
        error: task.error,
      });

      logger.error('Cursor task error', { taskId: task.id, error: task.error });
      archiveTask(task);
      return;
    }

    if (agentStatus === 'STOPPED' || agentStatus === 'CANCELLED') {
      task.status = 'stopped';
      task.completedAt = new Date().toISOString();
      archiveTask(task);
      return;
    }

    // Secondary: check conversation for keyword-based completion detection
    let lastMessage = '';
    try {
      const conversation = await client.getConversation(task.agentId);
      const messages = conversation.messages || [];
      const lastMsg = messages[messages.length - 1];
      lastMessage = lastMsg?.content?.substring(0, 500) || '';
      task.lastMessage = lastMessage;

      if (isCompleted(conversation)) {
        task.status = 'completed';
        task.completedAt = new Date().toISOString();
        task.prUrl = extractPrUrl(lastMessage);

        broadcast('cursor:task:completed', {
          taskId: task.id,
          agentId: task.agentId,
          summary: task.spec.summary,
          prUrl: task.prUrl,
          cursorUrl: task.cursorUrl,
        });

        logger.info('Cursor task completed (keyword)', { taskId: task.id, prUrl: task.prUrl });

        // Hand off to refinement loop
        try {
          const handled = isInRefinement(task.id)
            ? await onRefinedTaskCompleted(task)
            : await onTaskCompleted(task);
          if (handled) return;
        } catch (err) {
          logger.debug('Refinement check failed, archiving normally', { error: String(err) });
        }

        archiveTask(task);
        return;
      }

      if (hasError(conversation)) {
        task.status = 'error';
        task.error = extractError(conversation);

        broadcast('cursor:task:error', {
          taskId: task.id,
          agentId: task.agentId,
          error: task.error,
        });

        archiveTask(task);
        return;
      }
    } catch {
      // Conversation fetch failed, continue with status-only polling
    }

    // Check for stuck (no activity for STUCK_THRESHOLD_MS)
    if (task.pollCount > 3 && task.lastMessage === lastMessage && isStuckByTime(task)) {
      task.status = 'stuck';

      broadcast('cursor:task:stuck', {
        taskId: task.id,
        agentId: task.agentId,
        lastActivity: task.lastMessage?.substring(0, 200),
      });

      logger.warn('Cursor task may be stuck', { taskId: task.id });
      setTimeout(() => pollAgent(taskId), POLL_INTERVAL_MS * 2);
      return;
    }

    // Check max polls
    if (task.pollCount >= MAX_POLL_COUNT) {
      task.status = 'stuck';
      task.error = 'Max polling time exceeded';
      broadcast('cursor:task:stuck', {
        taskId: task.id,
        agentId: task.agentId,
        lastActivity: 'Exceeded max polling time (~50 minutes)',
      });
      archiveTask(task);
      return;
    }

    // Still running — broadcast progress
    broadcast('cursor:task:progress', {
      taskId: task.id,
      agentId: task.agentId,
      lastMessage: task.lastMessage?.substring(0, 200),
      elapsed: Date.now() - new Date(task.startedAt).getTime(),
      pollCount: task.pollCount,
      cursorUrl: task.cursorUrl,
    });

    schedulePoll(taskId);
  } catch (err) {
    logger.debug(`Poll failed for ${taskId}`, { error: String(err) });
    if (task.pollCount < MAX_POLL_COUNT) {
      setTimeout(() => pollAgent(taskId), POLL_INTERVAL_MS * 2);
    }
  }
}

// ============================================================================
// Detection Helpers
// ============================================================================

function isCompleted(conversation: { messages?: Array<{ content?: string }>; status?: string }): boolean {
  if (conversation.status === 'completed') return true;

  const lastMsg = conversation.messages?.[conversation.messages.length - 1];
  if (!lastMsg?.content) return false;

  const text = lastMsg.content.toLowerCase();
  return (
    text.includes('pull request') ||
    text.includes('pr created') ||
    text.includes('pr has been created') ||
    text.includes('created a pull request') ||
    text.includes('opened a pull request') ||
    text.includes('successfully created')
  );
}

function isStuckByTime(task: CursorTask): boolean {
  if (!task.lastChecked) return false;
  const lastCheck = new Date(task.lastChecked).getTime();
  const elapsed = Date.now() - new Date(task.startedAt).getTime();
  // Only consider stuck after at least STUCK_THRESHOLD_MS total elapsed
  return elapsed > STUCK_THRESHOLD_MS && (Date.now() - lastCheck) < POLL_INTERVAL_MS * 3;
}

function hasError(conversation: { messages?: Array<{ content?: string }>; status?: string }): boolean {
  if (conversation.status === 'failed') return true;

  const lastMsg = conversation.messages?.[conversation.messages.length - 1];
  if (!lastMsg?.content) return false;

  const text = lastMsg.content.toLowerCase();
  return (
    text.includes('fatal error') ||
    text.includes('build failed') ||
    text.includes('compilation error') ||
    text.includes('unable to complete')
  );
}

function extractError(conversation: { messages?: Array<{ content?: string }> }): string {
  const lastMsg = conversation.messages?.[conversation.messages.length - 1];
  return lastMsg?.content?.substring(0, 500) || 'Unknown error';
}

function extractPrUrl(text: string): string | undefined {
  const match = text?.match(/https:\/\/github\.com\/[^\s)]+\/pull\/\d+/);
  return match?.[0];
}

// ============================================================================
// Task Management
// ============================================================================

function archiveTask(task: CursorTask): void {
  activeTasks.delete(task.id);
  completedTasks.unshift(task);
  if (completedTasks.length > MAX_COMPLETED) {
    completedTasks.pop();
  }
}

/**
 * Send follow-up to an active task
 */
export async function sendFollowUp(
  taskIdOrAgentId: string,
  instruction: string
): Promise<{ success: boolean; message: string }> {
  const client = getCursorClient();
  if (!client) return { success: false, message: 'Cursor not configured' };

  // Find by task ID or agent ID
  let task: CursorTask | undefined;
  for (const t of activeTasks.values()) {
    if (t.id === taskIdOrAgentId || t.agentId === taskIdOrAgentId) {
      task = t;
      break;
    }
  }

  if (!task?.agentId) {
    return { success: false, message: `No active Cursor task found: ${taskIdOrAgentId}` };
  }

  try {
    await client.followUp(task.agentId, instruction);
    task.status = 'running';  // Reset from stuck if needed
    return { success: true, message: `Follow-up sent to Cursor agent ${task.agentId}` };
  } catch (error) {
    return { success: false, message: `Failed to send follow-up: ${error}` };
  }
}

/**
 * Stop an active task
 */
export async function stopCursorTask(
  taskIdOrAgentId: string
): Promise<{ success: boolean; message: string }> {
  const client = getCursorClient();
  if (!client) return { success: false, message: 'Cursor not configured' };

  let task: CursorTask | undefined;
  for (const t of activeTasks.values()) {
    if (t.id === taskIdOrAgentId || t.agentId === taskIdOrAgentId) {
      task = t;
      break;
    }
  }

  if (!task?.agentId) {
    return { success: false, message: `No active Cursor task found: ${taskIdOrAgentId}` };
  }

  try {
    await client.stopAgent(task.agentId);
    task.status = 'stopped';
    task.completedAt = new Date().toISOString();
    archiveTask(task);
    return { success: true, message: `Stopped Cursor agent ${task.agentId}` };
  } catch (error) {
    return { success: false, message: `Failed to stop agent: ${error}` };
  }
}

// ============================================================================
// Status / Queries
// ============================================================================

/**
 * Get all active tasks
 */
export function getActiveCursorTasks(): CursorTask[] {
  return Array.from(activeTasks.values());
}

/**
 * Get recent completed tasks
 */
export function getCompletedCursorTasks(limit = 10): CursorTask[] {
  return completedTasks.slice(0, limit);
}

/**
 * Get all tasks for the dashboard
 */
export function getAllCursorTasks(): { active: CursorTask[]; completed: CursorTask[] } {
  return {
    active: getActiveCursorTasks(),
    completed: getCompletedCursorTasks(),
  };
}

/**
 * Get a formatted status string
 */
export function getCursorTasksStatus(): string {
  const active = getActiveCursorTasks();
  const completed = getCompletedCursorTasks(5);

  if (active.length === 0 && completed.length === 0) {
    return 'No Cursor tasks. Send a coding request to get started.';
  }

  let output = '';

  if (active.length > 0) {
    output += `**Active Cursor Tasks (${active.length}):**\n`;
    for (const t of active) {
      const elapsed = Math.round((Date.now() - new Date(t.startedAt).getTime()) / 60000);
      output += `  - [${t.status.toUpperCase()}] ${t.spec.summary}\n`;
      output += `    Agent: ${t.agentId || 'pending'} | ${elapsed}min | Branch: ${t.spec.branch}\n`;
    }
  }

  if (completed.length > 0) {
    output += `\n**Recent Completed (${completed.length}):**\n`;
    for (const t of completed) {
      output += `  - [${t.status.toUpperCase()}] ${t.spec.summary}`;
      if (t.prUrl) output += ` → ${t.prUrl}`;
      output += '\n';
    }
  }

  return output;
}

/**
 * Get conversation for a specific task
 */
export async function getTaskConversation(
  taskIdOrAgentId: string
): Promise<{ success: boolean; message: string }> {
  const client = getCursorClient();
  if (!client) return { success: false, message: 'Cursor not configured' };

  // Find task
  let agentId = taskIdOrAgentId;
  for (const t of [...activeTasks.values(), ...completedTasks]) {
    if (t.id === taskIdOrAgentId) {
      agentId = t.agentId || taskIdOrAgentId;
      break;
    }
  }

  try {
    const conversation = await client.getConversation(agentId);
    const messages = conversation.messages || [];

    if (messages.length === 0) {
      return { success: true, message: 'No conversation messages yet.' };
    }

    let output = `**Cursor Agent Conversation** (${messages.length} messages)\n\n`;
    // Show last 5 messages
    const recent = messages.slice(-5);
    for (const msg of recent) {
      const role = msg.role === 'user' ? 'PROMPT' : 'CURSOR';
      const content = msg.content?.substring(0, 300) || '';
      output += `**${role}:** ${content}${content.length >= 300 ? '...' : ''}\n\n`;
    }

    return { success: true, message: output };
  } catch (error) {
    return { success: false, message: `Failed to get conversation: ${error}` };
  }
}
