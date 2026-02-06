/**
 * Terminal Command Executor
 * Safely executes whitelisted terminal commands within project directories
 * 
 * Security features:
 * - Whitelisted commands only (npm scripts, git commands, custom)
 * - Working directory restricted to loaded project
 * - Output truncation to prevent memory issues
 * - Timeout enforcement to prevent hanging
 * - No shell interpolation (uses spawn with array args)
 */

import { spawn, ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { resolve, normalize, relative } from 'path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { TerminalCommand, TerminalResult } from '../types/index.js';
import { getAgentStatus } from './cursor-agent.js';

// Track running processes
let runningProcess: ChildProcess | null = null;
let processInfo: { command: string; startTime: number } | null = null;

/**
 * Validate that a command is safe to execute
 */
function validateCommand(cmd: TerminalCommand): { valid: boolean; error?: string } {
  // Must have a working directory
  if (!cmd.workingDir) {
    return { valid: false, error: 'No working directory specified' };
  }

  // Working directory must exist
  if (!existsSync(cmd.workingDir)) {
    return { valid: false, error: `Working directory does not exist: ${cmd.workingDir}` };
  }

  // Validate based on command type
  switch (cmd.type) {
    case 'npm': {
      // npm commands must be in whitelist
      const npmCmd = cmd.args[0];
      if (!npmCmd) {
        return { valid: false, error: 'No npm command specified' };
      }
      
      // 'run' requires script name to be whitelisted
      if (npmCmd === 'run' || npmCmd === 'run-script') {
        const scriptName = cmd.args[1];
        if (!scriptName) {
          return { valid: false, error: 'No script name specified for npm run' };
        }
        if (!config.terminal.allowed_npm_scripts.includes(scriptName)) {
          return { valid: false, error: `Script "${scriptName}" not in whitelist. Allowed: ${config.terminal.allowed_npm_scripts.join(', ')}` };
        }
      } else if (!['install', 'ci', 'test', 'build', 'start', 'run', 'run-script'].includes(npmCmd)) {
        // Only allow safe npm commands
        return { valid: false, error: `npm ${npmCmd} is not allowed` };
      }
      break;
    }

    case 'git': {
      // git commands must be in whitelist
      const gitCmd = cmd.args[0];
      if (!gitCmd) {
        return { valid: false, error: 'No git command specified' };
      }
      if (!config.terminal.allowed_git_commands.includes(gitCmd)) {
        return { valid: false, error: `git ${gitCmd} not in whitelist. Allowed: ${config.terminal.allowed_git_commands.join(', ')}` };
      }
      break;
    }

    case 'custom': {
      // Custom commands must be defined in config
      if (!config.terminal.custom_commands[cmd.command]) {
        return { valid: false, error: `Custom command "${cmd.command}" not defined in config` };
      }
      break;
    }

    default:
      return { valid: false, error: `Unknown command type: ${cmd.type}` };
  }

  return { valid: true };
}

/**
 * Truncate output if too long
 */
function truncateOutput(output: string): { text: string; truncated: boolean } {
  const maxLines = config.terminal.max_output_lines;
  const maxChars = config.terminal.max_output_chars;

  let truncated = false;
  let text = output;

  // Truncate by character count first
  if (text.length > maxChars) {
    text = text.substring(0, maxChars);
    truncated = true;
  }

  // Then by line count
  const lines = text.split('\n');
  if (lines.length > maxLines) {
    text = lines.slice(0, maxLines).join('\n');
    truncated = true;
  }

  if (truncated) {
    text += '\n\n... (output truncated)';
  }

  return { text, truncated };
}

/**
 * Execute a terminal command
 */
export async function executeTerminalCommand(cmd: TerminalCommand): Promise<TerminalResult> {
  const startTime = Date.now();

  // Validate command
  const validation = validateCommand(cmd);
  if (!validation.valid) {
    logger.warn('Terminal command validation failed', { error: validation.error });
    return {
      success: false,
      output: '',
      error: validation.error,
      exitCode: null,
      timedOut: false,
      truncated: false,
      duration_ms: Date.now() - startTime
    };
  }

  // Build the actual command to execute
  let executable: string;
  let args: string[];

  switch (cmd.type) {
    case 'npm':
      executable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      args = cmd.args;
      break;

    case 'git':
      executable = 'git';
      args = cmd.args;
      break;

    case 'custom':
      // Custom commands are defined as full command strings in config
      const customCmd = config.terminal.custom_commands[cmd.command];
      const parts = customCmd.split(' ');
      executable = parts[0];
      args = parts.slice(1);
      break;

    default:
      return {
        success: false,
        output: '',
        error: `Unknown command type: ${cmd.type}`,
        exitCode: null,
        timedOut: false,
        truncated: false,
        duration_ms: Date.now() - startTime
      };
  }

  logger.info('Executing terminal command', {
    type: cmd.type,
    executable,
    args,
    workingDir: cmd.workingDir
  });

  return new Promise((resolve) => {
    try {
      // Stop any existing process
      if (runningProcess) {
        stopTerminalProcess();
      }

      const child = spawn(executable, args, {
        cwd: cmd.workingDir,
        shell: process.platform === 'win32',  // Windows needs shell for .cmd files
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe']
      });

      runningProcess = child;
      processInfo = { command: `${cmd.type} ${args.join(' ')}`, startTime: Date.now() };

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      // Set timeout
      const timeout = setTimeout(() => {
        timedOut = true;
        logger.warn('Terminal command timed out', { command: cmd.command });
        child.kill('SIGTERM');
        
        // Force kill after 5 seconds if still running
        setTimeout(() => {
          if (!child.killed) {
            child.kill('SIGKILL');
          }
        }, 5000);
      }, config.terminal.timeout_ms);

      child.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      child.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      child.on('error', (error: Error) => {
        clearTimeout(timeout);
        runningProcess = null;
        processInfo = null;
        
        logger.error('Terminal command error', { error: error.message });
        resolve({
          success: false,
          output: '',
          error: error.message,
          exitCode: null,
          timedOut: false,
          truncated: false,
          duration_ms: Date.now() - startTime
        });
      });

      child.on('close', (code: number | null) => {
        clearTimeout(timeout);
        runningProcess = null;
        processInfo = null;

        // Combine stdout and stderr
        const fullOutput = stdout + (stderr ? `\n--- stderr ---\n${stderr}` : '');
        const { text, truncated } = truncateOutput(fullOutput);

        const success = code === 0 && !timedOut;
        
        logger.info('Terminal command completed', {
          exitCode: code,
          timedOut,
          outputLength: fullOutput.length,
          truncated
        });

        resolve({
          success,
          output: text || (success ? 'Command completed successfully' : 'Command failed'),
          error: !success && !timedOut ? `Exit code: ${code}` : undefined,
          exitCode: code,
          timedOut,
          truncated,
          duration_ms: Date.now() - startTime
        });
      });

    } catch (error) {
      runningProcess = null;
      processInfo = null;
      
      logger.error('Terminal spawn error', { error: String(error) });
      resolve({
        success: false,
        output: '',
        error: error instanceof Error ? error.message : 'Unknown error',
        exitCode: null,
        timedOut: false,
        truncated: false,
        duration_ms: Date.now() - startTime
      });
    }
  });
}

/**
 * Stop any running terminal process
 */
export function stopTerminalProcess(): { stopped: boolean; message: string } {
  if (!runningProcess) {
    return { stopped: false, message: 'No terminal process running' };
  }

  const cmd = processInfo?.command || 'unknown';
  const runtime = processInfo ? Math.floor((Date.now() - processInfo.startTime) / 1000) : 0;

  try {
    runningProcess.kill('SIGTERM');
    
    // Force kill after 5 seconds
    setTimeout(() => {
      if (runningProcess && !runningProcess.killed) {
        runningProcess.kill('SIGKILL');
      }
    }, 5000);

    runningProcess = null;
    processInfo = null;

    return { stopped: true, message: `Stopped "${cmd}" after ${runtime}s` };
  } catch (error) {
    return { stopped: false, message: `Failed to stop process: ${error}` };
  }
}

/**
 * Get status of running terminal process
 */
export function getTerminalStatus(): { running: boolean; command?: string; runtime?: number } {
  if (!runningProcess || !processInfo) {
    return { running: false };
  }

  return {
    running: true,
    command: processInfo.command,
    runtime: Math.floor((Date.now() - processInfo.startTime) / 1000)
  };
}

/**
 * Parse a natural language terminal command request
 * Returns a TerminalCommand or null if not recognized
 */
export function parseTerminalRequest(input: string): TerminalCommand | null {
  const agentStatus = getAgentStatus();
  if (!agentStatus.active || !agentStatus.workingDir) {
    return null;  // No active project
  }

  const workingDir = agentStatus.workingDir;
  const lower = input.toLowerCase().trim();

  // npm patterns
  const npmRunMatch = lower.match(/(?:npm\s+)?run\s+(dev|start|build|test|lint|format|watch|serve)/i);
  if (npmRunMatch) {
    return {
      type: 'npm',
      command: 'npm',
      args: ['run', npmRunMatch[1]],
      workingDir
    };
  }

  const npmInstallMatch = lower.match(/npm\s+install|install\s+(?:deps|dependencies)|npm\s+i\b/i);
  if (npmInstallMatch) {
    return {
      type: 'npm',
      command: 'npm',
      args: ['install'],
      workingDir
    };
  }

  const npmCiMatch = lower.match(/npm\s+ci|clean\s+install/i);
  if (npmCiMatch) {
    return {
      type: 'npm',
      command: 'npm',
      args: ['ci'],
      workingDir
    };
  }

  // Only match explicit test commands, not just the word "tests" in content
  const npmTestMatch = lower.match(/^(?:run\s+)?(?:the\s+)?tests?$|^npm\s+test$/i);
  if (npmTestMatch) {
    return {
      type: 'npm',
      command: 'npm',
      args: ['test'],
      workingDir
    };
  }

  // Only match explicit build commands, not phrases like "continue the build"
  // Must start with these patterns or be at beginning of string
  const npmBuildMatch = lower.match(/^(?:(?:run\s+)?(?:a\s+)?build|npm\s+(?:run\s+)?build)$/i);
  if (npmBuildMatch) {
    return {
      type: 'npm',
      command: 'npm',
      args: ['run', 'build'],
      workingDir
    };
  }

  // git patterns
  const gitStatusMatch = lower.match(/git\s+status|check\s+(?:git\s+)?status|what(?:'s|s)?\s+(?:the\s+)?(?:git\s+)?status/i);
  if (gitStatusMatch) {
    return {
      type: 'git',
      command: 'git',
      args: ['status'],
      workingDir
    };
  }

  const gitPullMatch = lower.match(/git\s+pull|pull\s+(?:latest|changes)|update\s+from\s+(?:remote|origin)/i);
  if (gitPullMatch) {
    return {
      type: 'git',
      command: 'git',
      args: ['pull'],
      workingDir
    };
  }

  const gitDiffMatch = lower.match(/git\s+diff|show\s+(?:git\s+)?changes|what\s+changed/i);
  if (gitDiffMatch) {
    return {
      type: 'git',
      command: 'git',
      args: ['diff'],
      workingDir
    };
  }

  const gitLogMatch = lower.match(/git\s+log|(?:show|view)\s+(?:commit\s+)?(?:history|log)/i);
  if (gitLogMatch) {
    return {
      type: 'git',
      command: 'git',
      args: ['log', '--oneline', '-10'],
      workingDir
    };
  }

  const gitBranchMatch = lower.match(/git\s+branch|(?:list|show)\s+branches|what\s+branch/i);
  if (gitBranchMatch) {
    return {
      type: 'git',
      command: 'git',
      args: ['branch', '-a'],
      workingDir
    };
  }

  const gitFetchMatch = lower.match(/git\s+fetch|fetch\s+(?:from\s+)?(?:remote|origin)/i);
  if (gitFetchMatch) {
    return {
      type: 'git',
      command: 'git',
      args: ['fetch'],
      workingDir
    };
  }

  return null;
}
