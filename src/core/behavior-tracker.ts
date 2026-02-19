/**
 * Behavior Tracker — Loop Detection
 *
 * Detects when Jeeves produces the same response repeatedly.
 * Uses structure-based fingerprinting to catch "same structure different words" loops
 * (e.g. "I recognize I'm in a loop" repeated with slight variations).
 * Hard-coded breakers - Claude cannot break its own loops.
 */

import { logger } from '../utils/logger.js';

const WINDOW_SIZE = 5;
const LOOP_THRESHOLD = 3;

const LOOP_BREAKERS = [
  "I'm stuck in a loop. Give me a specific task - not a question about my performance.",
  "Caught myself repeating. What do you need done? One concrete thing.",
  "Loop detected. Resetting. Next message: tell me what to build, fix, or check.",
];

const fingerprints: string[] = [];
let breakerIndex = 0;

/** Structure-based fingerprint - catches same structure different words loops */
function fingerprint(response: string): string {
  const len = response.length > 1600 ? 'L' : response.length > 800 ? 'M' : 'S';
  const lists = (response.match(/\n[-*\d]/g) || []).length;
  const questions = (response.match(/\?/g) || []).length;
  return `${len}-${lists}-${questions}`;
}

/**
 * Return one of several hard-coded escape messages. Never Claude-generated.
 */
export function getLoopBreaker(): string {
  const msg = LOOP_BREAKERS[breakerIndex % LOOP_BREAKERS.length];
  breakerIndex++;
  return msg;
}

export interface LoopCheckResult {
  isLoop: boolean;
  action?: 'BREAK_LOOP';
  response?: string;
}

/** Skip loop check for short system/template messages (e.g. "AI session ready") so repeated "open X" doesn't trigger. */
function isSystemTemplateResponse(response: string): boolean {
  if (!response || response.length > 400) return false;
  return /AI assistant ready for|Loaded \d+KB of project context|No active AI session|session (ready|ended)/i.test(response);
}

/** Skip loop check for plan-style responses (user correcting "didn't work" + agent re-proposing plan). */
function isPlanProposalResponse(response: string): boolean {
  if (!response) return false;
  return (/```plan|COMMANDS:\s*\n/i.test(response) && /mkdir|ls\s|pwd|test\s+-d|cat\s+>.*<</i.test(response));
}

/** Skip fingerprint when response is mainly asking user to approve/run (so "go" next turn doesn't trigger loop). */
function isWaitingForApprovalResponse(response: string): boolean {
  if (!response || response.length > 800) return false;
  const hasApprovalWording = /say\s+['"]?go['"]?|reply\s+go\s+to\s+run|approve\s+to\s+execute|run\s+these\s+commands/i.test(response);
  const hasPlanOrCommands = /COMMANDS:\s*\n|```plan|Say 'go' to run/i.test(response);
  return hasApprovalWording && hasPlanOrCommands;
}

/** Skip fingerprint for confirmation requests and feedback acknowledgments (avoids loop on "yes go ahead"). */
function isConfirmationOrFeedbackResponse(response: string): boolean {
  if (!response || response.length > 600) return false;
  return (
    /Would you like me to/i.test(response) ||
    /^Got it\./i.test(response.trim()) ||
    /^Noted\./i.test(response.trim()) ||
    /I(?:'ll| will) (?:run|execute|check|list)/i.test(response) ||
    /Running\s+\w+/i.test(response) ||
    /^Sure,? (?:running|executing)/i.test(response.trim())
  );
}

/**
 * Check if the response indicates a loop (3+ identical fingerprints in last 5).
 * Call before returning any response from cognitive/normal path.
 */
export function checkForLoop(response: string): LoopCheckResult {
  if (!response || response.length < 10) {
    return { isLoop: false };
  }
  if (isSystemTemplateResponse(response)) {
    return { isLoop: false };
  }
  if (isPlanProposalResponse(response)) {
    return { isLoop: false };
  }
  if (isWaitingForApprovalResponse(response)) {
    return { isLoop: false };
  }
  if (isConfirmationOrFeedbackResponse(response)) {
    return { isLoop: false };
  }

  const fp = fingerprint(response);
  fingerprints.push(fp);
  if (fingerprints.length > WINDOW_SIZE) {
    fingerprints.shift();
  }

  const count = fingerprints.filter((f) => f === fp).length;
  if (count >= LOOP_THRESHOLD) {
    logger.info('Loop detected', { count, threshold: LOOP_THRESHOLD, fp });
    const breaker = getLoopBreaker();
    fingerprints.length = 0; // reset window
    return { isLoop: true, action: 'BREAK_LOOP', response: breaker };
  }

  return { isLoop: false };
}
