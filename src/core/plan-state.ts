/**
 * Plan State Module
 * Manages pending plans and execution results
 * Separated to avoid circular imports between parser and cursor-agent
 */

import { logger } from '../utils/logger.js';

// Pending plan for approval workflow
interface PendingPlan {
  commands: string[];
  description: string;
  createdAt: Date;
}

let pendingPlan: PendingPlan | null = null;

// Last execution results for context
interface ExecutionResults {
  description: string;
  results: string[];
  timestamp: Date;
}

let lastExecutionResults: ExecutionResults | null = null;

// TTL for execution results (5 minutes)
const EXECUTION_RESULTS_TTL_MS = 5 * 60 * 1000;

/**
 * Store a pending plan for user approval
 */
export function setPendingPlan(commands: string[], description: string): void {
  pendingPlan = {
    commands,
    description,
    createdAt: new Date()
  };
  logger.info('Pending plan set', { commands: commands.length, description });
}

/**
 * Get the current pending plan
 */
export function getPendingPlan(): PendingPlan | null {
  return pendingPlan;
}

/**
 * Clear the pending plan
 */
export function clearPendingPlan(): void {
  pendingPlan = null;
}

/**
 * Get last execution results if recent
 */
export function getLastExecutionResults(): ExecutionResults | null {
  if (!lastExecutionResults) return null;
  
  const age = Date.now() - lastExecutionResults.timestamp.getTime();
  if (age > EXECUTION_RESULTS_TTL_MS) {
    lastExecutionResults = null;
    return null;
  }
  
  return lastExecutionResults;
}

/**
 * Store execution results
 */
export function setExecutionResults(description: string, results: string[]): void {
  lastExecutionResults = {
    description,
    results,
    timestamp: new Date()
  };
  logger.debug('Stored execution results for context', { 
    description, 
    resultsCount: results.length 
  });
}
