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
import { buildPrompt, type TaskSpec } from './cursor-prompts.js';
import { logger } from '../utils/logger.js';

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
}

function broadcast(type: string, payload: unknown): void {
  if (broadcastFn) broadcastFn(type, payload);
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
    // Build the prompt
    const prompt = buildPrompt(task.spec);

    // Launch the agent
    const agent = await client.launchAgent(prompt, task.spec.repository, task.spec.branch);

    task.agentId = agent.id;
    task.status = 'running';
    activeTasks.set(task.id, task);

    broadcast('cursor:task:started', {
      taskId: task.id,
      agentId: agent.id,
      summary: task.spec.summary,
      project: task.spec.project,
      branch: task.spec.branch,
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
    const conversation = await client.getConversation(task.agentId);
    task.lastChecked = new Date().toISOString();
    task.pollCount++;

    const messages = conversation.messages || [];
    const lastMsg = messages[messages.length - 1];
    task.lastMessage = lastMsg?.content?.substring(0, 500) || '';

    // Check for completion
    if (isCompleted(conversation)) {
      task.status = 'completed';
      task.completedAt = new Date().toISOString();
      task.prUrl = extractPrUrl(task.lastMessage);

      broadcast('cursor:task:completed', {
        taskId: task.id,
        agentId: task.agentId,
        summary: task.spec.summary,
        prUrl: task.prUrl,
      });

      logger.info('Cursor task completed', {
        taskId: task.id,
        agentId: task.agentId,
        prUrl: task.prUrl,
      });

      archiveTask(task);
      return;
    }

    // Check for stuck
    if (isStuck(conversation, task)) {
      task.status = 'stuck';

      broadcast('cursor:task:stuck', {
        taskId: task.id,
        agentId: task.agentId,
        lastActivity: task.lastMessage?.substring(0, 200),
      });

      logger.warn('Cursor task may be stuck', { taskId: task.id, agentId: task.agentId });
      // Keep polling but less frequently
      setTimeout(() => pollAgent(taskId), POLL_INTERVAL_MS * 2);
      return;
    }

    // Check for errors
    if (hasError(conversation)) {
      task.status = 'error';
      task.error = extractError(conversation);

      broadcast('cursor:task:error', {
        taskId: task.id,
        agentId: task.agentId,
        error: task.error,
      });

      logger.error('Cursor task error', { taskId: task.id, error: task.error });
      archiveTask(task);
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

    // Still running - broadcast progress and continue polling
    broadcast('cursor:task:progress', {
      taskId: task.id,
      agentId: task.agentId,
      lastMessage: task.lastMessage?.substring(0, 200),
      elapsed: Date.now() - new Date(task.startedAt).getTime(),
      pollCount: task.pollCount,
    });

    schedulePoll(taskId);
  } catch (err) {
    logger.debug(`Poll failed for ${taskId}`, { error: String(err) });
    // Retry with backoff
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

function isStuck(
  conversation: { messages?: Array<{ content?: string; timestamp?: string }> },
  task: CursorTask
): boolean {
  const lastMsg = conversation.messages?.[conversation.messages.length - 1];
  if (!lastMsg?.timestamp) return false;

  const lastActivity = new Date(lastMsg.timestamp).getTime();
  return (Date.now() - lastActivity) > STUCK_THRESHOLD_MS;
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
