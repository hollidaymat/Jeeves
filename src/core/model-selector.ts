/**
 * Smart LLM Selection - Phase 6 Enhancement
 * 
 * Chooses the right model based on task complexity:
 * - Haiku: Simple questions, status checks, quick answers
 * - Sonnet: Normal coding, explanations, troubleshooting
 * - Opus: Complex architecture, PRD planning, difficult problems
 */

import { logger } from '../utils/logger.js';

export type ModelTier = 'haiku' | 'sonnet' | 'opus';

export interface ModelInfo {
  tier: ModelTier;
  modelId: string;
  costPer1kInput: number;   // USD
  costPer1kOutput: number;  // USD
  description: string;
}

// Model definitions (Haiku 4.5, Sonnet 4.6, Opus 4.6 – 2026)
export const MODELS: Record<ModelTier, ModelInfo> = {
  haiku: {
    tier: 'haiku',
    modelId: 'claude-haiku-4-5-20251001',
    costPer1kInput: 0.001,
    costPer1kOutput: 0.005,
    description: 'Fast & cheap - Haiku 4.5, Sonnet-level quality at 1/3 cost'
  },
  sonnet: {
    tier: 'sonnet',
    modelId: 'claude-sonnet-4-6',
    costPer1kInput: 0.003,
    costPer1kOutput: 0.015,
    description: 'Balanced - Sonnet 4.6, coding, design, agentic workflows'
  },
  opus: {
    tier: 'opus',
    modelId: 'claude-opus-4-6',
    costPer1kInput: 0.015,
    costPer1kOutput: 0.075,
    description: 'Most capable - complex architecture, PRD planning, hard problems'
  }
};

// Patterns that indicate simple tasks (use Haiku)
// Be aggressive with Haiku to save money - it handles most questions fine
const SIMPLE_PATTERNS = [
  // Greetings and short responses
  /^(hi|hello|hey|yo|sup)[\s!.?]*$/i,
  /^(thanks|thank you|thx|ty)[\s!.?]*$/i,
  /^(yes|no|ok|okay|sure|yep|nope|yeah|nah)[\s!.?]*$/i,
  /^(status|trust|help|list|stop|quit|exit)[\s!.?]*$/i,
  
  // General questions - Haiku can handle these
  /^what (is|are|was|were|does|do|can|could|would|should)/i,
  /^how (do|does|can|could|would|should|to|is)/i,
  /^why (is|are|do|does|did|would|should|can)/i,
  /^when (is|are|do|does|did|would|should|can)/i,
  /^where (is|are|do|does|did|can|should)/i,
  /^who (is|are|was|were|can|does)/i,
  /^can (you|i|we|it)/i,
  /^is (it|there|this|that)/i,
  /^does (it|this|that)/i,
  /^tell me (about|how|what|why)/i,
  /^explain/i,
  /^describe/i,
  
  // Commands and system queries
  /^show/i,
  /^list/i,
  /^get/i,
  /^check/i,
];

// Patterns that indicate complex tasks (use Sonnet - Opus is too expensive)
// Note: Sonnet 4 is highly capable for code generation, Opus reserved for truly exceptional cases
const COMPLEX_PATTERNS = [
  /architect.*enterprise/i,      // Only enterprise-scale architecture
  /design.*distributed.*system/i, // Distributed systems only
  /migrate.*entire.*database/i,   // Full database migrations
  /security.*penetration/i,       // Penetration testing only
  // Removed: PRD, refactor, build from scratch - Sonnet handles these fine
];

// Keywords that require actual work (use Sonnet)
// These involve making changes or complex troubleshooting
const WORK_PATTERNS = [
  /\b(fix|debug|repair|solve)\b/i,
  /\b(add|create|write|implement|build)\b/i,
  /\b(update|change|modify|edit|refactor)\b/i,
  /\b(delete|remove|drop)\b/i,
  /\b(install|configure|setup|deploy)\b/i,
  /\b(troubleshoot|diagnose)\b/i,
  /\b(review|analyze|audit)\b/i,
];

/**
 * Analyze prompt complexity and select appropriate model
 * Default to Haiku (cheapest) and only escalate when needed
 */
export function selectModel(prompt: string, forceModel?: ModelTier): ModelInfo {
  // Allow forcing a specific model
  if (forceModel && MODELS[forceModel]) {
    logger.debug('Model forced', { tier: forceModel });
    return MODELS[forceModel];
  }

  const trimmedPrompt = prompt.trim();
  
  // Check for complex patterns first (Opus) - very rare, reserved for exceptional cases
  for (const pattern of COMPLEX_PATTERNS) {
    if (pattern.test(trimmedPrompt)) {
      logger.debug('Selected model', { tier: 'opus', reason: 'complex pattern' });
      return MODELS.opus;
    }
  }

  // Long prompts use Sonnet (not Opus) - Sonnet 4 handles large context well
  // PRD execution, code generation, etc. all work great with Sonnet
  if (trimmedPrompt.length > 2000) {
    logger.debug('Selected model', { tier: 'sonnet', reason: 'long prompt' });
    return MODELS.sonnet;
  }

  // Check for work patterns (Sonnet) - actual tasks that modify things
  for (const pattern of WORK_PATTERNS) {
    if (pattern.test(trimmedPrompt)) {
      logger.debug('Selected model', { tier: 'sonnet', reason: 'work pattern' });
      return MODELS.sonnet;
    }
  }

  // Check for simple patterns (Haiku) - questions, greetings, etc.
  for (const pattern of SIMPLE_PATTERNS) {
    if (pattern.test(trimmedPrompt)) {
      logger.debug('Selected model', { tier: 'haiku', reason: 'simple pattern' });
      return MODELS.haiku;
    }
  }

  // Short prompts default to Haiku
  if (trimmedPrompt.length < 100) {
    logger.debug('Selected model', { tier: 'haiku', reason: 'short prompt' });
    return MODELS.haiku;
  }

  // Default to Haiku - be cost conscious
  // Only escalate when we have clear signals
  logger.debug('Selected model', { tier: 'haiku', reason: 'default (cost saving)' });
  return MODELS.haiku;
}

/**
 * Estimate cost for a request
 */
export function estimateCost(
  model: ModelInfo, 
  inputTokens: number, 
  outputTokens: number
): number {
  const inputCost = (inputTokens / 1000) * model.costPer1kInput;
  const outputCost = (outputTokens / 1000) * model.costPer1kOutput;
  return inputCost + outputCost;
}

/**
 * Get a human-readable model description
 */
export function getModelDescription(tier: ModelTier): string {
  return MODELS[tier]?.description || 'Unknown model';
}
