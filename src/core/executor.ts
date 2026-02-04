/**
 * Command Executor
 * Safely executes whitelisted commands using spawn (not exec)
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { ParsedIntent, ExecutionResult } from '../types/index.js';

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
  
  // Execute using spawn (no shell injection possible)
  return new Promise((resolve) => {
    try {
      const child = spawn(executable, args, {
        shell: false,  // Critical: no shell
        detached: true,  // Don't wait for Cursor to close
        stdio: 'ignore'  // Don't capture output (Cursor is GUI)
      });
      
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
