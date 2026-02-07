/**
 * Command Executor
 * Safely executes whitelisted commands using spawn (not exec)
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
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
  
  // ===== HOMELAB ACTIONS =====
  if (intent.action.startsWith('homelab_') || intent.action.startsWith('media_')) {
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

    const result = await executeHomelabAction(intent, currentTrust);

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
      const response = await sendToAgent(intent.prompt, intent.attachments);
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
    const response = await sendToAgent(intent.prompt, intent.attachments);
    
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
  
  // Handle PRD execution commands
  if (intent.action === 'prd_submit') {
    if (!intent.prompt) {
      return {
        success: false,
        error: 'No PRD content provided',
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
    
    const result = await submitPrd(intent.prompt, agentStatus.workingDir);
    return {
      success: result.success,
      output: result.message,
      duration_ms: Date.now() - startTime
    };
  }
  
  if (intent.action === 'prd_approve') {
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
      duration_ms: Date.now() - startTime
    };
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
        output: `📸 Screenshot saved: ${screenshotPath}`,
        duration_ms: Date.now() - startTime
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
      output += `\n📸 Screenshot: ${result.screenshotPath}`;
    }
    
    return {
      success: result.success,
      output: result.success ? output : undefined,
      error: result.success ? undefined : result.message,
      duration_ms: Date.now() - startTime
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
