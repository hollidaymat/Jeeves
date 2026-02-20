/**
 * Command Executor
 * Safely executes whitelisted commands using spawn (not exec)
 */

import { spawn } from 'child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { ParsedIntent, ExecutionResult } from '../types/index.js';
import { 
  startAgentSession, 
  sendToAgent, 
  stopAgentSession, 
  getAgentStatus,
  applyChanges,
  rejectChanges,
  showDiff,
  setForcedModel,
  getForcedModel,
  listBackups,
  restoreFromBackup
} from './cursor-agent.js';
import { getDailyReport, trackPatternMatch, getCostSummary } from './cost-tracker.js';
import { getBuildSummary, loadLessons } from './learning.js';
import { executeHomelabAction, isHomelabEnabled } from '../homelab/index.js';
import {
  executeTerminalCommand,
  stopTerminalProcess,
  getTerminalStatus
} from './terminal.js';
import {
  clearProjectHistory,
  setPreference
} from './memory.js';
import { forceCompact, getCompactionStatus } from './session-compactor.js';
import { setCurrentTask, completeTask, failTask, updateTaskProgress } from '../models/activity.js';
import { 
  submitPrd, 
  approvePlan, 
  pauseExecution, 
  resumeExecution, 
  abortExecution,
  getExecutionStatus 
} from './prd-executor.js';
import { 
  requestTrustUpgrade, 
  getTrustStatus,
  getTrustHistory,
  getLearnedPreferences,
  getTrustLevel
} from './trust.js';
import {
  browse,
  takeScreenshot,
  click,
  type as browserType,
  closeBrowser,
  getBrowserStatus,
  getCurrentUrl
} from './browser.js';
import {
  startDevServer,
  stopDevServer,
  stopAllDevServers,
  openDevPreview,
  capturePreview,
  getDevServerStatus
} from './dev-server.js';
import {
  apiTest,
  formatApiResult
} from './api-tester.js';
import {
  executePendingPlan
} from './cursor-agent.js';
import { recordSuccess, recordError } from './context/index.js';
import { runSelfTest, formatSelfTestReport } from './self-test.js';

// Whitelisted executables
const ALLOWED_EXECUTABLES: Record<string, string> = {
  cursor: config.commands.cursor
};

/**
 * Validate that a command is safe to execute
 */
function validateCommand(intent: ParsedIntent): { valid: boolean; error?: string } {
  // Only certain actions can execute commands
  const executableActions = ['open_project', 'open_file', 'goto_line'];
  if (!executableActions.includes(intent.action)) {
    return { valid: false, error: `Action ${intent.action} does not execute commands` };
  }
  
  // Must have a resolved path
  if (!intent.resolved_path) {
    return { valid: false, error: 'No resolved path for command' };
  }
  
  // Path must exist
  if (!existsSync(intent.resolved_path)) {
    return { valid: false, error: `Path does not exist: ${intent.resolved_path}` };
  }
  
  return { valid: true };
}

/**
 * Build command arguments from intent
 */
function buildArgs(intent: ParsedIntent): string[] {
  const args: string[] = [];
  
  if (intent.action === 'goto_line' && intent.line && intent.resolved_path) {
    args.push('--goto', `${intent.resolved_path}:${intent.line}`);
  } else if (intent.resolved_path) {
    args.push(intent.resolved_path);
  }
  
  return args;
}

/**
 * Execute a validated command
 */
export async function executeCommand(intent: ParsedIntent): Promise<ExecutionResult> {
  const startTime = Date.now();
  
  // Handle non-executable actions
  if (intent.action === 'status') {
    return {
      success: true,
      output: 'Signal Cursor Controller is running. Ready for commands.',
      duration_ms: Date.now() - startTime
    };
  }
  
  if (intent.action === 'help' || intent.action === 'list_projects') {
    if (intent.resolutionMethod === 'pattern') trackPatternMatch(intent.action);
    if (intent.action === 'list_projects') {
      const { listProjects } = await import('./project-scanner.js');
      return {
        success: true,
        output: listProjects(),
        duration_ms: Date.now() - startTime
      };
    }
    return {
      success: true,
      output: intent.message || 'No message available',
      duration_ms: Date.now() - startTime
    };
  }
  
  if (intent.action === 'show_cost') {
    trackPatternMatch('show_cost');
    return {
      success: true,
      output: getDailyReport() + '\n\n' + getCostSummary(),
      duration_ms: Date.now() - startTime
    };
  }
  
  // Build history - shows past builds and their costs
  if (intent.action === 'show_builds') {
    trackPatternMatch('show_builds');
    return {
      success: true,
      output: getBuildSummary(),
      duration_ms: Date.now() - startTime
    };
  }
  
  // Lessons learned - shows optimization rules and anti-patterns
  if (intent.action === 'jeeves_self_test') {
    trackPatternMatch('jeeves_self_test');
    try {
      const results = await runSelfTest();
      const output = formatSelfTestReport(results);
      return {
        success: true,
        output,
        duration_ms: Date.now() - startTime,
      };
    } catch (err) {
      logger.error('Self-test failed', { error: String(err) });
      return {
        success: false,
        output: `Self-test failed: ${err instanceof Error ? err.message : String(err)}. Ensure jeeves-qa is at ../jeeves-qa and runnable.`,
        duration_ms: Date.now() - startTime,
      };
    }
  }

  if (intent.action === 'show_lessons') {
    trackPatternMatch('show_lessons');
    const lessons = loadLessons();
    if (!lessons) {
      return {
        success: true,
        output: 'No lessons learned yet. Build some projects first!',
        duration_ms: Date.now() - startTime
      };
    }
    
    let output = `## Lessons Learned\n\n`;
    
    output += `### Cost Optimization Rules\n`;
    lessons.costOptimization.rules.forEach(rule => {
      output += `- **${rule.rule}** (learned from ${rule.learnedFrom})\n`;
      output += `  ${rule.reason}\n`;
    });
    
    output += `\n### Build Anti-Patterns\n`;
    lessons.buildExecution.antiPatterns.forEach(ap => {
      output += `- ❌ **${ap.pattern}**\n`;
      output += `  Problem: ${ap.problem}\n`;
      output += `  ✅ Solution: ${ap.solution}\n`;
    });
    
    output += `\n### Priority Improvements\n`;
    lessons.nextImprovements.forEach(imp => {
      output += `${imp.priority}. ${imp.improvement} (saves: ${imp.estimatedSavings})\n`;
    });
    
    return {
      success: true,
      output,
      duration_ms: Date.now() - startTime
    };
  }
  
  // Session compaction
  if (intent.action === 'compact_session') {
    trackPatternMatch('compact_session');
    const compactionStatus = getCompactionStatus();
    
    if (!compactionStatus.needsCompaction) {
      return {
        success: true,
        output: `No compaction needed. Current session: ${compactionStatus.currentTokens.toLocaleString()} tokens (${compactionStatus.percentOfThreshold}% of threshold)`,
        duration_ms: Date.now() - startTime
      };
    }
    
    const result = await forceCompact();
    return {
      success: result.success,
      output: result.message,
      duration_ms: Date.now() - startTime
    };
  }
  
  if (intent.action === 'set_model') {
    const tier = intent.target as 'haiku' | 'sonnet' | 'opus' | 'auto';
    if (tier === 'auto') {
      setForcedModel(null);
      return {
        success: true,
        output: 'Model selection set to **AUTO**. Will choose the best model based on task complexity.',
        duration_ms: Date.now() - startTime
      };
    } else {
      setForcedModel(tier);
      return {
        success: true,
        output: `Model locked to **${tier.toUpperCase()}**. All requests will now use ${tier} until you say "use auto".`,
        duration_ms: Date.now() - startTime
      };
    }
  }
  
  // Handle backup operations
  if (intent.action === 'list_backups') {
    // Get project path from active session or intent
    const projectPath = intent.resolved_path || process.cwd();
    const fileName = intent.target;
    
    if (!fileName) {
      return {
        success: true,
        output: 'Usage: `backups <filename>` - List available backups for a file\nExample: `backups styles.css`',
        duration_ms: Date.now() - startTime
      };
    }
    
    const backups = await listBackups(fileName, projectPath);
    
    if (backups.length === 0) {
      return {
        success: true,
        output: `No backups found for "${fileName}"`,
        duration_ms: Date.now() - startTime
      };
    }
    
    const backupList = backups.map((b, i) => 
      `${i + 1}. ${b.timestamp.toLocaleString()} (${Math.round(b.size / 1024)}KB)`
    ).join('\n');
    
    return {
      success: true,
      output: `**Backups for ${fileName}:**\n${backupList}\n\nRestore with: \`restore ${fileName} <number>\``,
      duration_ms: Date.now() - startTime
    };
  }
  
  if (intent.action === 'restore_backup') {
    const projectPath = intent.resolved_path || process.cwd();
    const fileName = intent.target;
    const backupIndex = parseInt(intent.message || '1', 10) - 1;
    
    if (!fileName) {
      return {
        success: false,
        error: 'Usage: `restore <filename> [number]` - Restore a file from backup\nExample: `restore styles.css 1`',
        duration_ms: Date.now() - startTime
      };
    }
    
    const backups = await listBackups(fileName, projectPath);
    
    if (backups.length === 0) {
      return {
        success: false,
        error: `No backups found for "${fileName}"`,
        duration_ms: Date.now() - startTime
      };
    }
    
    if (backupIndex < 0 || backupIndex >= backups.length) {
      return {
        success: false,
        error: `Invalid backup number. Available: 1-${backups.length}`,
        duration_ms: Date.now() - startTime
      };
    }
    
    const backup = backups[backupIndex];
    // Reconstruct original path from backup
    const originalPath = backup.path.replace(/\.jeeves-backup[/\\]/, '').replace(/\.\d+\.bak$/, '');
    
    const result = await restoreFromBackup(backup.path, originalPath);
    
    return {
      success: result.success,
      output: result.success ? result.message : undefined,
      error: result.success ? undefined : result.message,
      duration_ms: Date.now() - startTime
    };
  }
  
  // ===== NOTES (always available, no homelab required) =====
  if (intent.action === 'note_add' || intent.action === 'note_list' || intent.action === 'note_search') {
    trackPatternMatch(intent.action);
    try {
      const { addNote, listNotes, searchNotes, formatNotes } = await import('../capabilities/notes/scratchpad.js');
      if (intent.action === 'note_add') {
        const content = (intent.target || '').trim();
        if (!content) {
          return { success: false, error: 'Say what to save, e.g. "note: printer IP is 192.168.7.55" or "add a note that the VPN is in signal-cursor-controller/.env"', duration_ms: Date.now() - startTime };
        }
        const note = addNote(content);
        return { success: true, output: `Saved note: "${note.content.substring(0, 120)}${note.content.length > 120 ? '...' : ''}"`, duration_ms: Date.now() - startTime };
      }
      if (intent.action === 'note_list') {
        const notes = listNotes();
        return { success: true, output: formatNotes(notes), duration_ms: Date.now() - startTime };
      }
      if (intent.action === 'note_search') {
        const query = (intent.target || '').trim();
        const results = query ? searchNotes(query) : listNotes();
        return { success: true, output: formatNotes(results), duration_ms: Date.now() - startTime };
      }
    } catch (err) {
      logger.error('Notes action failed', { action: intent.action, error: err });
      return { success: false, error: `Notes failed: ${err instanceof Error ? err.message : String(err)}`, duration_ms: Date.now() - startTime };
    }
  }

  // ===== HOMELAB ACTIONS =====
  const homelabActions = [
    'homelab_', 'media_', 'qbittorrent_', 'deploy_gluetun_stack', 'disk_health', 'docker_cleanup', 'log_errors',
    'pihole_stats', 'speed_test', 'image_updates', 'ssl_check', 'service_deps',
    'home_assistant', 'tailscale_status', 'nextcloud_', 'grafana_', 'uptime_kuma',
    'bandwidth', 'reminder_', 'schedule_', 'timeline', 'quiet_hours', 'mute_notifications', 'security_acknowledge', 'music_indexer_status',
    'file_share',
  ];
  if (homelabActions.some(prefix => intent.action.startsWith(prefix))) {
    trackPatternMatch(intent.action);
    
    if (!isHomelabEnabled()) {
      return {
        success: false,
        error: 'Homelab mode is not enabled. Set homelab.enabled = true in config.json (Linux only).',
        duration_ms: Date.now() - startTime
      };
    }

    // Track activity
    setCurrentTask({
      name: intent.action.replace(/_/g, ' '),
      phase: 1,
      totalPhases: 1,
      progress: 0,
      startedAt: new Date().toISOString(),
      cost: 0,
    });

    // Get current trust level for gating
    const currentTrust = getTrustLevel();

    let result = await executeHomelabAction(intent, currentTrust);

    // When file_share can't resolve target, delegate to agent for context resolution
    if (!result.success && result.delegateToAgent) {
      try {
        const response = await sendToAgent(result.delegateToAgent);
        // Try to extract a file path from the agent's response
        const pathMatch = response.match(/(\/[\w\-./]+\.?\w*)/);
        const candidatePath = pathMatch?.[1]?.trim();
        if (candidatePath) {
          const { validateFileForSharing } = await import('../capabilities/file-share/file-share.js');
          const validated = validateFileForSharing(candidatePath);
          if (validated.valid) {
            completeTask({ cost: 0 });
            recordSuccess(
              { message: intent.message || intent.action, action: intent.action, target: intent.target },
              [intent.action, intent.target || ''].filter(Boolean)
            ).catch(() => {});
            return {
              success: true,
              output: `Sending file: ${validated.path}`,
              attachments: [validated.path!],
              duration_ms: Date.now() - startTime
            };
          }
        }
        // No valid path found — use agent's explanation as response
        result = { success: true, output: response, duration_ms: Date.now() - startTime };
      } catch (err) {
        result = { success: false, error: `Couldn't resolve file: ${err instanceof Error ? err.message : String(err)}`, duration_ms: Date.now() - startTime };
      }
    }

    // Complete activity tracking
    if (result.success) {
      completeTask({ cost: 0 });
      recordSuccess(
        { message: intent.message || intent.action, action: intent.action, target: intent.target },
        [intent.action, intent.target || ''].filter(Boolean)
      ).catch(() => {});
    } else if (result.error) {
      failTask(result.error);
      recordError(
        result.error,
        'pending',
        intent.action.startsWith('media_') ? 'media' : 'homelab',
        intent.target
      ).catch(() => {});
    }

    return {
      success: result.success,
      output: result.output || result.error,
      error: result.error,
      attachments: result.attachments,
      duration_ms: Date.now() - startTime
    };
  }

  // Handle feedback -- acknowledge, store, but do NOT immediately start coding
  if (intent.action === 'feedback') {
    const feedbackText = intent.prompt || intent.message || '';
    logger.info('Feedback received', { feedback: feedbackText.substring(0, 100) });

    // Store as an annotation/preference for future reference
    try {
      const { setAnnotation } = await import('./context/layers/annotations.js');
      setAnnotation(
        `feedback.${Date.now()}`,
        feedbackText,
        'preference',
        'user-confirmed'
      );
    } catch {
      // Context system not available, that's fine
    }

    return {
      success: true,
      output: `Noted. ${feedbackText.length > 80 ? 'I\'ve stored that feedback.' : ''} Want me to make changes based on this, or is this just for future reference?`,
      duration_ms: Date.now() - startTime
    };
  }

  // ===== ANTIGRAVITY (test connection, handoff, or full orchestrate) =====

  if (intent.action === 'antigravity_test') {
    trackPatternMatch('antigravity_test');
    try {
      const { testAntigravityConnection } = await import('../core/orchestrator/antigravity-executor.js');
      const t = testAntigravityConnection();
      return {
        success: t.ok,
        output: t.ok ? `Antigravity: ${t.message} ${t.details ?? ''}`.trim() : `Antigravity: ${t.message}. ${t.details ?? ''}`.trim(),
        error: t.ok ? undefined : t.message,
        duration_ms: Date.now() - startTime
      };
    } catch (err) {
      return {
        success: false,
        error: `Test failed: ${err instanceof Error ? err.message : String(err)}`,
        duration_ms: Date.now() - startTime
      };
    }
  }

  if (intent.action === 'antigravity_serve_web') {
    trackPatternMatch('antigravity_serve_web');
    try {
      const { startAntigravityServeWeb } = await import('../core/orchestrator/antigravity-executor.js');
      const r = startAntigravityServeWeb();
      return {
        success: r.ok,
        output: r.message + (r.url ? ` (Orchestration tab has the link.)` : ''),
        error: r.ok ? undefined : r.message,
        duration_ms: Date.now() - startTime
      };
    } catch (err) {
      return {
        success: false,
        error: `Failed: ${err instanceof Error ? err.message : String(err)}`,
        duration_ms: Date.now() - startTime
      };
    }
  }

  if (intent.action === 'antigravity_handoff') {
    trackPatternMatch('antigravity_handoff');
    const description = (intent.target ?? intent.prompt ?? '').trim();
    if (!description) {
      return {
        success: false,
        error: 'Say what to hand off (e.g. "send to antigravity: add login" or "antigravity notes: JWT auth").',
        duration_ms: Date.now() - startTime
      };
    }
    try {
      const { orchestrate } = await import('../core/orchestrator/index.js');
      const result = await orchestrate(
        { title: description.slice(0, 80), description },
        { handoffOnly: true }
      );
      if (result.needsClarification && result.questions?.length) {
        return {
          success: true,
          output: `Clarifying:\n${result.questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}\n\nSpec not written yet—reply with answers or rephrase.`,
          duration_ms: Date.now() - startTime
        };
      }
      return {
        success: result.success,
        output: result.message + (result.spec_path ? `\n\nYou can open this in Antigravity when ready to build.` : ''),
        error: result.success ? undefined : result.message,
        duration_ms: Date.now() - startTime
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        error: `Handoff failed: ${msg}`,
        duration_ms: Date.now() - startTime
      };
    }
  }

  if (intent.action === 'antigravity_orchestrate') {
    trackPatternMatch('antigravity_orchestrate');
    const description = (intent.target ?? intent.prompt ?? '').trim();
    if (!description) {
      return {
        success: false,
        error: 'Please specify what to build (e.g. "build add JWT auth" or "antigravity build add login").',
        duration_ms: Date.now() - startTime
      };
    }
    try {
      const { orchestrate } = await import('../core/orchestrator/index.js');
      const result = await orchestrate({
        title: description.slice(0, 80),
        description,
      });
      if (result.needsClarification && result.questions?.length) {
        return {
          success: true,
          output: `Need clarification:\n${result.questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`,
          duration_ms: Date.now() - startTime
        };
      }
      return {
        success: result.success,
        output: result.message,
        error: result.success ? undefined : result.message,
        duration_ms: Date.now() - startTime
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        error: `Orchestration failed: ${msg}`,
        duration_ms: Date.now() - startTime
      };
    }
  }

  // ===== CURSOR BACKGROUND AGENT ACTIONS =====

  if (intent.action === 'cursor_launch') {
    trackPatternMatch('cursor_launch');
    const { createTask, getPendingPlan } = await import('../integrations/cursor-orchestrator.js');
    const { isCursorEnabled } = await import('../integrations/cursor-client.js');

    if (!isCursorEnabled()) {
      return {
        success: false,
        error: 'Cursor API not configured. Set CURSOR_API_KEY in .env.',
        duration_ms: Date.now() - startTime
      };
    }

    const description = intent.prompt || '';
    // Try to extract project name from the description
    const projectMatch = description.match(/(?:for|on|in)\s+(\S+)\s*$/i);
    const project = projectMatch ? projectMatch[1] : 'dive-connect';  // default

    const task = createTask(description, project);
    if (!task) {
      return {
        success: false,
        error: `Could not resolve project "${project}". Use "cursor repos" to see available repos.`,
        duration_ms: Date.now() - startTime
      };
    }

    const plan = getPendingPlan();
    return {
      success: true,
      output: plan || 'Task created. Send "go" to launch.',
      duration_ms: Date.now() - startTime
    };
  }

  if (intent.action === 'cursor_confirm') {
    const { confirmAndLaunch } = await import('../integrations/cursor-orchestrator.js');
    const result = await confirmAndLaunch();
    return {
      success: result.success,
      output: result.success ? result.message : undefined,
      error: result.success ? undefined : result.message,
      duration_ms: Date.now() - startTime
    };
  }

  if (intent.action === 'cursor_status') {
    trackPatternMatch('cursor_status');
    const { getCursorTasksStatus } = await import('../integrations/cursor-orchestrator.js');
    const { isCursorEnabled } = await import('../integrations/cursor-client.js');

    if (!isCursorEnabled()) {
      return {
        success: true,
        output: 'Cursor integration not enabled. Set CURSOR_API_KEY in .env.',
        duration_ms: Date.now() - startTime
      };
    }

    return {
      success: true,
      output: getCursorTasksStatus(),
      duration_ms: Date.now() - startTime
    };
  }

  if (intent.action === 'cursor_followup') {
    const { sendFollowUp, getActiveCursorTasks } = await import('../integrations/cursor-orchestrator.js');
    const tasks = getActiveCursorTasks();

    if (tasks.length === 0) {
      return {
        success: false,
        error: 'No active Cursor tasks to follow up on.',
        duration_ms: Date.now() - startTime
      };
    }

    // Send to the most recent active task
    const latestTask = tasks[tasks.length - 1];
    const result = await sendFollowUp(latestTask.id, intent.prompt || '');
    return {
      success: result.success,
      output: result.success ? result.message : undefined,
      error: result.success ? undefined : result.message,
      duration_ms: Date.now() - startTime
    };
  }

  if (intent.action === 'cursor_stop') {
    const { stopCursorTask, getActiveCursorTasks } = await import('../integrations/cursor-orchestrator.js');
    const tasks = getActiveCursorTasks();

    if (tasks.length === 0) {
      return {
        success: false,
        error: 'No active Cursor tasks to stop.',
        duration_ms: Date.now() - startTime
      };
    }

    // Stop the most recent active task
    const latestTask = tasks[tasks.length - 1];
    const result = await stopCursorTask(latestTask.id);
    return {
      success: result.success,
      output: result.success ? result.message : undefined,
      error: result.success ? undefined : result.message,
      duration_ms: Date.now() - startTime
    };
  }

  if (intent.action === 'cursor_conversation') {
    const { getTaskConversation, getActiveCursorTasks, getCompletedCursorTasks } = await import('../integrations/cursor-orchestrator.js');
    const active = getActiveCursorTasks();
    const completed = getCompletedCursorTasks(1);
    const latest = active[active.length - 1] || completed[0];

    if (!latest) {
      return {
        success: false,
        error: 'No Cursor tasks to show.',
        duration_ms: Date.now() - startTime
      };
    }

    const result = await getTaskConversation(latest.id);
    return {
      success: result.success,
      output: result.success ? result.message : undefined,
      error: result.success ? undefined : result.message,
      duration_ms: Date.now() - startTime
    };
  }

  if (intent.action === 'cursor_repos') {
    trackPatternMatch('cursor_repos');
    const { getAvailableRepos } = await import('../integrations/cursor-orchestrator.js');
    const repos = getAvailableRepos();
    const output = '**Available Repositories:**\n' + repos.map(r => `  - ${r.name}: ${r.url}`).join('\n');
    return {
      success: true,
      output,
      duration_ms: Date.now() - startTime
    };
  }

  // --- DEVELOPMENT (autonomous dev loop) ---
  if (intent.action === 'dev_task') {
    const startTimeDev = Date.now();
    const description = (intent.target || intent.message || '').trim();
    if (!description) {
      return {
        success: false,
        error: 'No task description. Say e.g. "add rate limiting to the voice endpoint".',
        duration_ms: Date.now() - startTime
      };
    }
    const { executeDevTask } = await import('../devtools/dev-loop.js');
    const { recordLearning } = await import('./context/layers/learnings.js');
    type DevRes = Awaited<ReturnType<typeof executeDevTask>>;
    const formatDevResult = (r: DevRes): string => {
      const lines = [`**${r.status.toUpperCase()}** (${r.iterations} iteration${r.iterations !== 1 ? 's' : ''})`, r.summary];
      if (r.phase) lines.push(`Phase: ${r.phase}`);
      if (r.error && (r.status === 'failed' || r.status === 'blocked')) lines.push(`Error: ${r.error}`);
      if (r.filesChanged.length) lines.push(`Files: ${r.filesChanged.join(', ')}`);
      if (r.testResults.length) {
        const last = r.testResults[r.testResults.length - 1];
        lines.push(`Tests: ${last.passed} passed, ${last.failed} failed`);
      }
      if (r.rollbackAvailable) lines.push('Rollback available: say "rollback last" to undo.');
      return lines.join('\n');
    };
    const testMode = (intent as { mode?: 'typecheck-only' | 'smoke-test' | 'full-test' }).mode ?? 'smoke-test';
    const task = {
      id: `dev-${Date.now()}`,
      description,
      requestedBy: 'user',
      priority: 'medium' as const,
      createdAt: new Date().toISOString(),
      testMode,
    };
    const result = await executeDevTask(task);
    const output = formatDevResult(result);
    const { recordDevTaskExecution, getCanonicalProjectRoot } = await import('./execution-logger.js');
    const devOutcome = result.status === 'blocked' ? 'failed' : result.status;
    recordDevTaskExecution(
      task.description,
      getCanonicalProjectRoot(),
      devOutcome,
      [{ command: task.description, success: devOutcome === 'success' || devOutcome === 'partial', error: result.error, outputSnippet: result.summary }],
      result.summary
    );
    if (result.status === 'success' || result.status === 'partial') {
      recordLearning({
        category: 'development',
        trigger: task.description,
        rootCause: 'development_task',
        fix: result.summary,
        lesson: `Task completed in ${result.iterations} iterations. Files: ${result.filesChanged.join(', ') || 'none'}`,
        appliesTo: result.filesChanged.length ? result.filesChanged.join(',') : undefined,
      });
    } else {
      recordLearning({
        category: 'development_failure',
        trigger: task.description,
        rootCause: result.summary,
        fix: 'Task requires manual intervention or different approach.',
        lesson: result.testResults.length
          ? result.testResults.map((t) => t.failures.map((f) => f.error).join('; ')).join('; ')
          : result.summary,
        appliesTo: result.filesChanged.length ? result.filesChanged.join(',') : undefined,
      });
    }
    return {
      success: result.status === 'success' || result.status === 'partial',
      output,
      error: result.status === 'failed' || result.status === 'blocked' ? result.summary : undefined,
      duration_ms: Date.now() - startTimeDev,
    };
  }
  if (intent.action === 'dev_recent') {
    const { getRecentChanges } = await import('../devtools/file-writer.js');
    const changes = await getRecentChanges(5);
    if (changes.length === 0) {
      return { success: true, output: 'No recent development activity.', duration_ms: Date.now() - startTime };
    }
    const output = changes.map((c) => `${c.timestamp}: ${c.action} ${c.path} - ${c.description}`).join('\n');
    return { success: true, output, duration_ms: Date.now() - startTime };
  }
  if (intent.action === 'dev_rollback') {
    const { getRecentChanges, rollbackFile } = await import('../devtools/file-writer.js');
    const changes = await getRecentChanges(1);
    if (changes.length === 0 || !changes[0].backupPath) {
      return {
        success: false,
        output: 'No rollback available (last change may have been a new file).',
        duration_ms: Date.now() - startTime,
      };
    }
    const ok = await rollbackFile(changes[0].backupPath);
    const output = ok ? `Rolled back ${changes[0].path}` : 'Rollback failed.';
    return { success: ok, output, duration_ms: Date.now() - startTime };
  }
  if (intent.action === 'dev_changelog') {
    const { getRecentChanges } = await import('../devtools/file-writer.js');
    const changes = await getRecentChanges(20);
    if (changes.length === 0) {
      return { success: true, output: 'No changes recorded.', duration_ms: Date.now() - startTime };
    }
    const output =
      `Last ${changes.length} changes:\n` +
      changes
        .map(
          (c) =>
            `[${c.timestamp}] ${c.action.toUpperCase()} ${c.path}\n  ${c.description} (${c.linesChanged} lines)`
        )
        .join('\n\n');
    return { success: true, output, duration_ms: Date.now() - startTime };
  }

  if (intent.action === 'unknown') {
    return {
      success: false,
      error: intent.message || 'Could not understand command',
      duration_ms: Date.now() - startTime
    };
  }
  
  if (intent.action === 'denied') {
    return {
      success: false,
      error: intent.message || 'Command denied',
      duration_ms: Date.now() - startTime
    };
  }
  
  // Create new project
  if (intent.action === 'create_project') {
    if (!intent.target) {
      return {
        success: false,
        error: 'No project name specified',
        duration_ms: Date.now() - startTime
      };
    }
    const { createProject } = await import('./project-scanner.js');
    const result = createProject(intent.target);
    
    if (result.success && result.path) {
      // Auto-start the agent session for the new project
      const startResult = await startAgentSession(result.path);
      return {
        success: true,
        output: `Created project "${intent.target}" at ${result.path}\n\n${startResult.message}`,
        duration_ms: Date.now() - startTime
      };
    }
    return {
      success: false,
      error: result.error || 'Failed to create project',
      duration_ms: Date.now() - startTime
    };
  }
  
  // Handle agent actions
  if (intent.action === 'agent_start') {
    if (!intent.resolved_path) {
      return {
        success: false,
        error: 'No project path specified for agent',
        duration_ms: Date.now() - startTime
      };
    }
    const result = await startAgentSession(intent.resolved_path);
    return {
      success: result.success,
      output: result.success ? result.message : undefined,
      error: result.success ? undefined : result.message,
      duration_ms: Date.now() - startTime
    };
  }
  
  if (intent.action === 'agent_ask') {
    if (!intent.prompt) {
      return {
        success: false,
        error: 'No prompt provided',
        duration_ms: Date.now() - startTime
      };
    }
    setCurrentTask({
      name: 'AI request',
      phase: 1,
      totalPhases: 1,
      progress: 0,
      startedAt: new Date().toISOString(),
      cost: 0,
    });
    try {
      const response = await sendToAgent(intent.prompt, intent.attachments, intent.assembledContext);
      completeTask();
      return {
        success: true,
        output: response,
        duration_ms: Date.now() - startTime
      };
    } catch (err) {
      failTask(String(err));
      throw err;
    }
  }
  
  // AUTONOMOUS BUILD - fully autonomous loop that builds to completion
  if (intent.action === 'autonomous_build') {
    const { autonomousBuild, getActiveProject } = await import('./cursor-agent.js');
    
    const session = getActiveProject();
    if (!session) {
      return {
        success: false,
        error: 'No project is open. Use `open <project-name>` first.',
        duration_ms: Date.now() - startTime
      };
    }
    
    logger.info('Starting autonomous build', { project: session.workingDir });
    
    // Stream progress updates to the user via WebSocket
    const result = await autonomousBuild(session.workingDir, intent.prompt, {
      maxIterations: 15,
      onProgress: (progress) => {
        // Log progress for debugging
        logger.info('Build progress', { 
          iteration: progress.iteration, 
          totalChanges: progress.totalChanges,
          isComplete: progress.isComplete 
        });
      }
    });
    
    return {
      success: result.success,
      output: result.message,
      duration_ms: Date.now() - startTime
    };
  }
  
  // Special build mode - auto-applies all detected changes (legacy, kept for compatibility)
  if (intent.action === 'agent_build') {
    if (!intent.prompt) {
      return {
        success: false,
        error: 'No prompt provided',
        duration_ms: Date.now() - startTime
      };
    }
    const response = await sendToAgent(intent.prompt, intent.attachments, intent.assembledContext);
    
    // Auto-apply any pending changes
    const { applyChanges, getAgentStatus, getPendingChanges } = await import('./cursor-agent.js');
    const pending = getPendingChanges();
    if (pending.length > 0) {
      logger.info('Auto-applying changes from build command', { count: pending.length });
      const applyResult = await applyChanges();
      return {
        success: true,
        output: response + '\n\n' + applyResult.message,
        duration_ms: Date.now() - startTime
      };
    }
    
    return {
      success: true,
      output: response,
      duration_ms: Date.now() - startTime
    };
  }
  
  // Apply last response - manually re-parse and apply code from last AI response
  if (intent.action === 'apply_last') {
    const { reParseLastResponse } = await import('./cursor-agent.js');
    const result = await reParseLastResponse();
    return {
      success: result.success,
      output: result.message,
      error: result.success ? undefined : result.message,
      duration_ms: Date.now() - startTime
    };
  }
  
  if (intent.action === 'agent_stop') {
    const result = await stopAgentSession();
    return {
      success: result.success,
      output: result.message,
      duration_ms: Date.now() - startTime
    };
  }
  
  if (intent.action === 'agent_status') {
    const status = getAgentStatus();
    if (status.active) {
      return {
        success: true,
        output: `AI assistant active for ${status.workingDir?.split(/[\\/]/).pop()} (${status.contextSize}KB context, uptime: ${status.uptime}s)`,
        duration_ms: Date.now() - startTime
      };
    }
    return {
      success: true,
      output: 'No active AI session. Say "analyze <project>" to start.',
      duration_ms: Date.now() - startTime
    };
  }
  
  if (intent.action === 'apply_changes') {
    const result = await applyChanges();
    return {
      success: result.success,
      output: result.message,
      duration_ms: Date.now() - startTime
    };
  }
  
  if (intent.action === 'reject_changes') {
    const result = rejectChanges();
    return {
      success: result.success,
      output: result.message,
      duration_ms: Date.now() - startTime
    };
  }
  
  if (intent.action === 'show_diff') {
    const diff = showDiff();
    return {
      success: true,
      output: diff,
      duration_ms: Date.now() - startTime
    };
  }
  
  // Handle terminal commands
  if (intent.action === 'terminal_npm' || intent.action === 'terminal_git' || intent.action === 'terminal_run') {
    if (!intent.terminal_command) {
      return {
        success: false,
        error: 'No terminal command specified',
        duration_ms: Date.now() - startTime
      };
    }
    
    // Check if we have an active project session
    const agentStatus = getAgentStatus();
    if (!agentStatus.active || !agentStatus.workingDir) {
      return {
        success: false,
        error: 'No active project. Load a project first (e.g., "open sentinel")',
        duration_ms: Date.now() - startTime
      };
    }
    
    // Execute the terminal command
    const result = await executeTerminalCommand(intent.terminal_command);
    return {
      success: result.success,
      output: result.output,
      error: result.error,
      duration_ms: result.duration_ms
    };
  }
  
  if (intent.action === 'terminal_stop') {
    const result = stopTerminalProcess();
    return {
      success: result.stopped,
      output: result.message,
      duration_ms: Date.now() - startTime
    };
  }
  
  // Handle memory commands
  if (intent.action === 'memory_history' || intent.action === 'memory_summary') {
    return {
      success: true,
      output: intent.message || 'No memory available',
      duration_ms: Date.now() - startTime
    };
  }
  
  if (intent.action === 'memory_clear') {
    const agentStatus = getAgentStatus();
    if (!agentStatus.active || !agentStatus.workingDir) {
      // No active project - clear general conversation history instead
      const { clearGeneralConversations } = await import('./memory.js');
      const { resetCapabilitiesConversation } = await import('./skill-loader.js');
      const result = clearGeneralConversations();
      resetCapabilitiesConversation();
      return {
        success: true,
        output: `Cleared ${result.cleared} general conversation messages.`,
        duration_ms: Date.now() - startTime
      };
    }
    const result = clearProjectHistory(agentStatus.workingDir);
    return {
      success: result.success,
      output: result.message,
      duration_ms: Date.now() - startTime
    };
  }
  
  if (intent.action === 'set_preference') {
    const key = intent.target as 'verboseMode' | 'autoApplyChanges' | 'defaultProject';
    const value = intent.prompt;
    
    if (!key || value === undefined) {
      return {
        success: false,
        error: 'Invalid preference. Use: set verbose on/off, set auto-apply on/off, set default-project <name>',
        duration_ms: Date.now() - startTime
      };
    }
    
    // Parse the key and value
    let parsedKey: 'verboseMode' | 'autoApplyChanges' | 'defaultProject';
    let parsedValue: boolean | string;
    
    if (key.includes('verbose')) {
      parsedKey = 'verboseMode';
      parsedValue = ['on', 'true', 'yes', '1'].includes(value.toLowerCase());
    } else if (key.includes('auto')) {
      parsedKey = 'autoApplyChanges';
      parsedValue = ['on', 'true', 'yes', '1'].includes(value.toLowerCase());
    } else if (key.includes('default')) {
      parsedKey = 'defaultProject';
      parsedValue = value;
    } else {
      return {
        success: false,
        error: `Unknown preference: ${key}`,
        duration_ms: Date.now() - startTime
      };
    }
    
    setPreference(parsedKey, parsedValue as never);
    return {
      success: true,
      output: `Set ${parsedKey} = ${parsedValue}`,
      duration_ms: Date.now() - startTime
    };
  }
  
  // Write content into each ~/projects/*/prd.md (actual file write, not LLM reply)
  if (intent.action === 'write_projects_prd_content') {
    const content = (intent.prompt || '').trim();
    if (!content) {
      return {
        success: false,
        error: 'No content to write. Say e.g. "write into the 3 prd.md files: This will be the base for future PRDs."',
        duration_ms: Date.now() - startTime
      };
    }
    const projectsDir = process.env.HOME ? join(process.env.HOME, 'projects') : '/home/jeeves/projects';
    if (!existsSync(projectsDir)) {
      return {
        success: false,
        error: `Projects directory not found: ${projectsDir}`,
        duration_ms: Date.now() - startTime
      };
    }
    try {
      const subdirs = readdirSync(projectsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
      const written: string[] = [];
      const block = '\n\n' + content + '\n';
      for (const name of subdirs) {
        const file = join(projectsDir, name, 'prd.md');
        const existing = existsSync(file) ? readFileSync(file, 'utf8') : '# PRD\n\n';
        writeFileSync(file, existing.trimEnd() + block, 'utf8');
        written.push(`${name}/prd.md`);
      }
      return {
        success: true,
        output: `Wrote content into ${written.length} file(s): ${written.join(', ')}.`,
        duration_ms: Date.now() - startTime
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        success: false,
        error: `Failed to write to prd.md files: ${msg}`,
        duration_ms: Date.now() - startTime
      };
    }
  }

  // Handle PRD execution commands
  if (intent.action === 'prd_submit') {
    if (!intent.prompt) {
      return {
        success: false,
        error: 'No PRD content provided',
        duration_ms: Date.now() - startTime
      };
    }

    const prompt = (intent.prompt || '').trim().toLowerCase();
    const createPrdInFoldersMatch = prompt.match(/create\s+prd\.md\s+in\s+each\s+(?:of\s+)?(?:those\s+)?folders?/i);
    const projectsDir = process.env.HOME ? join(process.env.HOME, 'projects') : '/home/jeeves/projects';

    // No active project: allow "create prd.md in each of those folders" by writing stub into each subfolder of ~/projects
    const agentStatus = getAgentStatus();
    if ((!agentStatus.active || !agentStatus.workingDir) && createPrdInFoldersMatch && existsSync(projectsDir)) {
      try {
        const subdirs = readdirSync(projectsDir, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name);
        const stub = '# PRD\n\n';
        const created: string[] = [];
        for (const name of subdirs) {
          const dir = join(projectsDir, name);
          const file = join(dir, 'prd.md');
          writeFileSync(file, stub, 'utf8');
          created.push(join(name, 'prd.md'));
        }
        return {
          success: true,
          output: `Created prd.md in ${created.length} folder(s): ${created.join(', ')}.`,
          duration_ms: Date.now() - startTime
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          success: false,
          error: `Could not create prd.md in folders: ${msg}`,
          duration_ms: Date.now() - startTime
        };
      }
    }

    if (!agentStatus.active || !agentStatus.workingDir) {
      return {
        success: false,
        error: 'No active project. Load a project first (e.g., "open sentinel")',
        duration_ms: Date.now() - startTime
      };
    }

    const result = await submitPrd(intent.prompt, agentStatus.workingDir);
    return {
      success: result.success,
      output: result.message,
      duration_ms: Date.now() - startTime
    };
  }
  
  if (intent.action === 'prd_approve') {
    const { getActivePlan } = await import('./prd-executor.js');
    const prdPlan = getActivePlan();
    if (!prdPlan || prdPlan.status !== 'awaiting_approval') {
      // No PRD plan to approve — treat as continuation so LLM can proceed with what it proposed
      const { sendToAgent } = await import('./cursor-agent.js');
      const response = await sendToAgent('yes, please proceed', intent.attachments, intent.assembledContext);
      return {
        success: true,
        output: response,
        duration_ms: Date.now() - startTime
      };
    }
    const result = await approvePlan();
    return {
      success: result.success,
      output: result.message,
      error: result.success ? undefined : result.message,
      duration_ms: Date.now() - startTime
    };
  }
  
  if (intent.action === 'prd_pause') {
    const result = pauseExecution();
    return {
      success: result.success,
      output: result.message,
      duration_ms: Date.now() - startTime
    };
  }
  
  if (intent.action === 'prd_resume') {
    const result = resumeExecution();
    return {
      success: result.success,
      output: result.message,
      duration_ms: Date.now() - startTime
    };
  }
  
  if (intent.action === 'prd_abort') {
    const result = abortExecution();
    return {
      success: result.success,
      output: result.message,
      duration_ms: Date.now() - startTime
    };
  }
  
  if (intent.action === 'prd_status') {
    const status = getExecutionStatus();
    return {
      success: true,
      output: intent.message || status.summary || 'No PRD execution in progress.',
      duration_ms: Date.now() - startTime
    };
  }
  
  // Handle trust system commands
  if (intent.action === 'trust_status') {
    return {
      success: true,
      output: intent.message || getTrustStatus(),
      duration_ms: Date.now() - startTime
    };
  }
  
  if (intent.action === 'trust_upgrade') {
    const result = requestTrustUpgrade();
    return {
      success: result.success,
      output: result.message,
      duration_ms: Date.now() - startTime
    };
  }
  
  if (intent.action === 'trust_history') {
    return {
      success: true,
      output: intent.message || getTrustHistory(),
      duration_ms: Date.now() - startTime
    };
  }
  
  if (intent.action === 'show_learned') {
    return {
      success: true,
      output: intent.message || getLearnedPreferences(),
      duration_ms: Date.now() - startTime
    };
  }
  
  // Handle personality commands (already processed in parser, just return message)
  if (intent.action === 'remember' || intent.action === 'set_role' || intent.action === 'add_trait') {
    return {
      success: true,
      output: intent.message || 'Preference saved.',
      duration_ms: Date.now() - startTime
    };
  }
  
  // Handle browser actions
  if (intent.action === 'browse') {
    logger.info('Executing browse action', { target: intent.target });
    if (!intent.target) {
      // If no target, it's a status request
      return {
        success: true,
        output: intent.message || getBrowserStatus(),
        duration_ms: Date.now() - startTime
      };
    }
    
    // Always capture screenshot for AI vision
    logger.info('Calling browse function', { url: intent.target, screenshot: true });
    const result = await browse(intent.target, { screenshot: true });
    logger.info('Browse result', { success: result.success, error: result.error });
    
    let output = '';
    if (result.success) {
      output = `**${result.title || 'Page'}**\nURL: ${result.url}\n\n`;
      if (result.securityWarnings?.length) {
        output += `⚠️ Security Warnings:\n${result.securityWarnings.map(w => `  - ${w}`).join('\n')}\n\n`;
      }
      output += result.content || '[No content extracted]';
      if (result.screenshotPath) {
        output += `\n\n📸 Screenshot saved: ${result.screenshotPath}`;
      }
    } else {
      output = `Failed to browse: ${result.error}`;
    }
    
    return {
      success: result.success,
      output: result.success ? output : undefined,
      error: result.success ? undefined : output,
      duration_ms: Date.now() - startTime,
      attachments: result.screenshotPath ? [result.screenshotPath] : undefined
    };
  }
  
  // ===== VERCEL COMMANDS =====
  
  if (intent.action === 'vercel_url') {
    try {
      const { getProjectUrl } = await import('../api/vercel.js');
      const result = await getProjectUrl(intent.target || '');
      if (result.found) {
        const domainList = result.domains && result.domains.length > 0
          ? result.domains.map(d => `https://${d}`).join(', ')
          : 'none';
        return {
          success: true,
          output: `${result.name}: ${result.url || 'no URL available'}\nDomains: ${domainList}\nStatus: ${result.status}`,
          duration_ms: Date.now() - startTime
        };
      } else {
        return {
          success: false,
          error: `Couldn't find a Vercel project matching "${intent.target}". Try "vercel projects" to see what's available.`,
          duration_ms: Date.now() - startTime
        };
      }
    } catch (error) {
      return {
        success: false,
        error: `Vercel lookup failed: ${error instanceof Error ? error.message : String(error)}`,
        duration_ms: Date.now() - startTime
      };
    }
  }

  if (intent.action === 'vercel_deploy') {
    try {
      const { triggerDeployment } = await import('../api/vercel.js');
      const result = await triggerDeployment(intent.target || '');
      return {
        success: result.success,
        output: result.success ? `${result.message}${result.url ? `\n${result.url}` : ''}` : undefined,
        error: result.success ? undefined : result.message,
        duration_ms: Date.now() - startTime
      };
    } catch (error) {
      return {
        success: false,
        error: `Deploy failed: ${error instanceof Error ? error.message : String(error)}`,
        duration_ms: Date.now() - startTime
      };
    }
  }

  if (intent.action === 'vercel_projects') {
    try {
      const { listVercelProjects } = await import('../api/vercel.js');
      const result = await listVercelProjects();
      if (!result.enabled) {
        return {
          success: false,
          error: 'Vercel not configured. Set VERCEL_API_TOKEN and VERCEL_TEAM_ID.',
          duration_ms: Date.now() - startTime
        };
      }
      if (result.projects.length === 0) {
        return {
          success: true,
          output: 'No Vercel projects found.',
          duration_ms: Date.now() - startTime
        };
      }
      const lines = result.projects.map(p =>
        `${p.name}: ${p.url || 'no URL'} (${p.status})`
      );
      return {
        success: true,
        output: `Vercel Projects:\n${lines.join('\n')}`,
        duration_ms: Date.now() - startTime
      };
    } catch (error) {
      return {
        success: false,
        error: `Vercel projects failed: ${error instanceof Error ? error.message : String(error)}`,
        duration_ms: Date.now() - startTime
      };
    }
  }

  if (intent.action === 'screenshot') {
    try {
      // If target URL provided, navigate first
      if (intent.target) {
        const browseResult = await browse(intent.target);
        if (!browseResult.success) {
          return {
            success: false,
            error: `Failed to navigate: ${browseResult.error}`,
            duration_ms: Date.now() - startTime
          };
        }
      }
      
      const screenshotPath = await takeScreenshot();
      return {
        success: true,
        output: `📸 Screenshot captured`,
        duration_ms: Date.now() - startTime,
        attachments: [screenshotPath]
      };
    } catch (error) {
      return {
        success: false,
        error: `Screenshot failed: ${error instanceof Error ? error.message : String(error)}`,
        duration_ms: Date.now() - startTime
      };
    }
  }
  
  if (intent.action === 'browser_click') {
    if (!intent.target) {
      return {
        success: false,
        error: 'No selector specified for click',
        duration_ms: Date.now() - startTime
      };
    }
    
    const result = await click(intent.target);
    return {
      success: result.success,
      output: result.success 
        ? `Clicked "${intent.target}". Now at: ${result.url}` 
        : undefined,
      error: result.success ? undefined : result.error,
      duration_ms: Date.now() - startTime
    };
  }
  
  if (intent.action === 'browser_type') {
    if (!intent.target || !intent.data?.text) {
      return {
        success: false,
        error: 'Selector and text required for type action',
        duration_ms: Date.now() - startTime
      };
    }
    
    const result = await browserType(intent.target, intent.data.text as string);
    return {
      success: result.success,
      output: result.success ? `Typed text into "${intent.target}"` : undefined,
      error: result.success ? undefined : result.error,
      duration_ms: Date.now() - startTime
    };
  }
  
  if (intent.action === 'browser_close') {
    await closeBrowser();
    return {
      success: true,
      output: 'Browser closed.',
      duration_ms: Date.now() - startTime
    };
  }
  
  // Handle dev server actions
  if (intent.action === 'dev_start') {
    // Need active project context
    const agentStatus = getAgentStatus();
    if (!agentStatus.active || !agentStatus.workingDir) {
      return {
        success: false,
        error: 'No active project. Open a project first with "open <project>"',
        duration_ms: Date.now() - startTime
      };
    }
    
    const result = await startDevServer(agentStatus.workingDir, { openBrowser: true });
    return {
      success: result.success,
      output: result.success ? result.message : undefined,
      error: result.success ? undefined : result.message,
      duration_ms: Date.now() - startTime
    };
  }
  
  if (intent.action === 'dev_stop') {
    const agentStatus = getAgentStatus();
    if (agentStatus.active && agentStatus.workingDir) {
      const result = stopDevServer(agentStatus.workingDir);
      return {
        success: result.success,
        output: result.message,
        duration_ms: Date.now() - startTime
      };
    }
    
    // Stop all if no specific project
    const result = stopAllDevServers();
    return {
      success: result.success,
      output: result.message,
      duration_ms: Date.now() - startTime
    };
  }
  
  if (intent.action === 'dev_preview') {
    const agentStatus = getAgentStatus();
    if (!agentStatus.active || !agentStatus.workingDir) {
      return {
        success: false,
        error: 'No active project. Open a project first.',
        duration_ms: Date.now() - startTime
      };
    }
    
    const result = await openDevPreview(agentStatus.workingDir);
    let output = result.message;
    if (result.screenshotPath) {
      output += `\n📸 Screenshot attached`;
    }
    
    return {
      success: result.success,
      output: result.success ? output : undefined,
      error: result.success ? undefined : result.message,
      duration_ms: Date.now() - startTime,
      attachments: result.screenshotPath ? [result.screenshotPath] : undefined
    };
  }
  
  if (intent.action === 'dev_status') {
    return {
      success: true,
      output: intent.message || getDevServerStatus(),
      duration_ms: Date.now() - startTime
    };
  }
  
  // API Testing: GET
  if (intent.action === 'api_get') {
    if (!intent.target) {
      return { success: false, error: 'No URL provided', duration_ms: Date.now() - startTime };
    }
    const result = await apiTest('GET', intent.target);
    // success = 2xx only; 4xx/5xx = failure but show output (not error)
    return {
      success: result.success,
      output: formatApiResult(result),
      error: result.error, // Only set for network failures
      duration_ms: Date.now() - startTime
    };
  }
  
  // API Testing: POST
  if (intent.action === 'api_post') {
    if (!intent.target) {
      return { success: false, error: 'No URL provided', duration_ms: Date.now() - startTime };
    }
    const body = intent.data?.body;
    let parsedBody: unknown;
    if (typeof body === 'string') {
      try {
        parsedBody = JSON.parse(body);
      } catch {
        parsedBody = body;
      }
    }
    const result = await apiTest('POST', intent.target, { body: parsedBody });
    return {
      success: result.success,
      output: formatApiResult(result),
      error: result.error,
      duration_ms: Date.now() - startTime
    };
  }
  
  // API Testing: PUT
  if (intent.action === 'api_put') {
    if (!intent.target) {
      return { success: false, error: 'No URL provided', duration_ms: Date.now() - startTime };
    }
    const body = intent.data?.body;
    let parsedBody: unknown;
    if (typeof body === 'string') {
      try {
        parsedBody = JSON.parse(body);
      } catch {
        parsedBody = body;
      }
    }
    const result = await apiTest('PUT', intent.target, { body: parsedBody });
    return {
      success: result.success,
      output: formatApiResult(result),
      error: result.error,
      duration_ms: Date.now() - startTime
    };
  }
  
  // API Testing: DELETE
  if (intent.action === 'api_delete') {
    if (!intent.target) {
      return { success: false, error: 'No URL provided', duration_ms: Date.now() - startTime };
    }
    const result = await apiTest('DELETE', intent.target);
    return {
      success: result.success,
      output: formatApiResult(result),
      error: result.error,
      duration_ms: Date.now() - startTime
    };
  }
  
  // API Testing: PATCH
  if (intent.action === 'api_patch') {
    if (!intent.target) {
      return { success: false, error: 'No URL provided', duration_ms: Date.now() - startTime };
    }
    const body = intent.data?.body;
    let parsedBody: unknown;
    if (typeof body === 'string') {
      try {
        parsedBody = JSON.parse(body);
      } catch {
        parsedBody = body;
      }
    }
    const result = await apiTest('PATCH', intent.target, { body: parsedBody });
    return {
      success: result.success,
      output: formatApiResult(result),
      error: result.error,
      duration_ms: Date.now() - startTime
    };
  }
  
  // API Testing: History
  if (intent.action === 'api_history') {
    return {
      success: true,
      output: intent.message || 'No API requests yet.',
      duration_ms: Date.now() - startTime
    };
  }
  
  // Execute pending plan
  if (intent.action === 'execute_plan') {
    const result = await executePendingPlan();
    return {
      success: result.success,
      output: result.results.join('\n\n'),
      duration_ms: Date.now() - startTime
    };
  }
  
  // Validate the command
  const validation = validateCommand(intent);
  if (!validation.valid) {
    logger.warn('Command validation failed', { error: validation.error, intent: intent.action });
    return {
      success: false,
      error: validation.error,
      duration_ms: Date.now() - startTime
    };
  }
  
  // Get the executable path
  const executable = ALLOWED_EXECUTABLES.cursor;
  if (!executable) {
    return {
      success: false,
      error: 'Cursor executable not configured',
      duration_ms: Date.now() - startTime
    };
  }
  
  // Check executable exists
  if (!existsSync(executable)) {
    return {
      success: false,
      error: `Cursor executable not found at: ${executable}`,
      duration_ms: Date.now() - startTime
    };
  }
  
  // Build arguments
  const args = buildArgs(intent);
  
  logger.info('Executing command', { 
    executable, 
    args, 
    action: intent.action,
    target: intent.target 
  });
  
  // Execute using spawn
  // On Windows, .cmd files need shell: true to execute properly
  const isWindows = process.platform === 'win32';
  const isCmdFile = executable.endsWith('.cmd') || executable.endsWith('.bat');
  const useShell = isWindows && isCmdFile;
  
  return new Promise((resolve) => {
    try {
      let child;
      
      if (useShell) {
        // For .cmd files on Windows, use shell execution with proper quoting
        // This is safe because we've already validated the path exists
        const fullCommand = `"${executable}" ${args.map(a => `"${a}"`).join(' ')}`;
        child = spawn(fullCommand, [], {
          shell: true,
          detached: true,
          stdio: 'ignore',
          windowsHide: true
        });
      } else {
        // For regular executables, no shell needed
        child = spawn(executable, args, {
          shell: false,
          detached: true,
          stdio: 'ignore'
        });
      }
      
      child.unref();  // Allow the parent to exit independently
      
      // Give Cursor a moment to start
      setTimeout(() => {
        logger.security.command(intent.action, intent.target || '', true);
        
        resolve({
          success: true,
          output: `Opened ${intent.target || intent.resolved_path}`,
          duration_ms: Date.now() - startTime
        });
      }, 500);
      
      child.on('error', (error) => {
        logger.error('Command execution error', { error: String(error) });
        resolve({
          success: false,
          error: `Failed to execute: ${error.message}`,
          duration_ms: Date.now() - startTime
        });
      });
      
    } catch (error) {
      logger.error('Command spawn error', { error: String(error) });
      resolve({
        success: false,
        error: `Failed to spawn process: ${error instanceof Error ? error.message : 'Unknown error'}`,
        duration_ms: Date.now() - startTime
      });
    }
  });
}
