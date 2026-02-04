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
  showDiff
} from './cursor-agent.js';
import {
  executeTerminalCommand,
  stopTerminalProcess,
  getTerminalStatus
} from './terminal.js';
import {
  clearProjectHistory,
  setPreference
} from './memory.js';
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
  getLearnedPreferences 
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
    return {
      success: true,
      output: intent.message || 'No message available',
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
    const response = await sendToAgent(intent.prompt);
    return {
      success: true,
      output: response,
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
      return {
        success: false,
        error: 'No active project. Load a project first.',
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
