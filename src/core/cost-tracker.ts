/**
 * Cost Tracker
 * Tracks LLM usage, tokens, and costs for optimization
 */

import { logger } from '../utils/logger.js';

// Pricing per 1M tokens (as of 2026)
const PRICING = {
  'claude-3-5-haiku-20241022': { input: 1.00, output: 5.00 },
  'claude-sonnet-4-20250514': { input: 3.00, output: 15.00 },
  'claude-opus-4-20250514': { input: 15.00, output: 75.00 },
  // Cached pricing (90% discount on input)
  'claude-3-5-haiku-20241022-cached': { input: 0.10, output: 5.00 },
  'claude-sonnet-4-20250514-cached': { input: 0.30, output: 15.00 },
  'claude-opus-4-20250514-cached': { input: 1.50, output: 75.00 }
};

interface UsageRecord {
  timestamp: Date;
  intent: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  cached: boolean;
  resolutionMethod: 'pattern' | 'llm';
}

interface DailyCosts {
  tokens: number;
  cost: number;
  calls: number;
  patternMatches: number;
  cacheHits: number;
}

interface CostsByCategory {
  byIntent: Record<string, number>;
  byModel: Record<string, number>;
}

// In-memory tracking (resets on restart)
const usageHistory: UsageRecord[] = [];
const dailyCosts: DailyCosts = {
  tokens: 0,
  cost: 0,
  calls: 0,
  patternMatches: 0,
  cacheHits: 0
};
const costsByCategory: CostsByCategory = {
  byIntent: {},
  byModel: {}
};

let sessionStartTime = Date.now();

/**
 * Calculate cost for a request
 */
function calculateCost(model: string, inputTokens: number, outputTokens: number, cached: boolean): number {
  const modelKey = cached ? `${model}-cached` : model;
  const pricing = PRICING[modelKey as keyof typeof PRICING] || PRICING['claude-sonnet-4-20250514'];
  
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  
  return inputCost + outputCost;
}

/**
 * Track a pattern-matched request (FREE - no LLM call)
 */
export function trackPatternMatch(intent: string): void {
  dailyCosts.patternMatches++;
  
  usageHistory.push({
    timestamp: new Date(),
    intent,
    model: 'none',
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    cached: false,
    resolutionMethod: 'pattern'
  });
  
  logger.debug(`[COST] ${intent}: pattern-matched = $0.00`);
}

/**
 * Track an LLM request
 */
export function trackLLMUsage(
  intent: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cached: boolean = false
): void {
  const cost = calculateCost(model, inputTokens, outputTokens, cached);
  
  // Update daily totals
  dailyCosts.tokens += inputTokens + outputTokens;
  dailyCosts.cost += cost;
  dailyCosts.calls++;
  if (cached) dailyCosts.cacheHits++;
  
  // Update by category
  costsByCategory.byIntent[intent] = (costsByCategory.byIntent[intent] || 0) + cost;
  costsByCategory.byModel[model] = (costsByCategory.byModel[model] || 0) + cost;
  
  // Add to history
  usageHistory.push({
    timestamp: new Date(),
    intent,
    model,
    inputTokens,
    outputTokens,
    cost,
    cached,
    resolutionMethod: 'llm'
  });
  
  // Log for visibility
  const cacheTag = cached ? ' [CACHED]' : '';
  logger.info(`[COST] ${intent}: ${model}${cacheTag} - ${inputTokens}+${outputTokens} tokens = $${cost.toFixed(4)}`);
}

/**
 * Get daily cost report
 */
export function getDailyReport(): string {
  const uptimeMs = Date.now() - sessionStartTime;
  const uptimeHours = (uptimeMs / (1000 * 60 * 60)).toFixed(1);
  
  const avgPerCall = dailyCosts.calls > 0 ? dailyCosts.cost / dailyCosts.calls : 0;
  const patternRate = dailyCosts.calls + dailyCosts.patternMatches > 0
    ? (dailyCosts.patternMatches / (dailyCosts.calls + dailyCosts.patternMatches) * 100).toFixed(0)
    : '0';
  const cacheRate = dailyCosts.calls > 0
    ? (dailyCosts.cacheHits / dailyCosts.calls * 100).toFixed(0)
    : '0';
  
  // Top intents by cost
  const topIntents = Object.entries(costsByCategory.byIntent)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([intent, cost]) => `  - ${intent}: $${cost.toFixed(4)}`)
    .join('\n');
  
  // Model breakdown
  const modelBreakdown = Object.entries(costsByCategory.byModel)
    .sort((a, b) => b[1] - a[1])
    .map(([model, cost]) => `  - ${model.split('-').slice(-1)[0]}: $${cost.toFixed(4)}`)
    .join('\n');
  
  return `## Daily Cost Report

**Session:** ${uptimeHours} hours

**Totals:**
- Total cost: **$${dailyCosts.cost.toFixed(4)}**
- Total tokens: ${dailyCosts.tokens.toLocaleString()}
- LLM calls: ${dailyCosts.calls}
- Pattern matches: ${dailyCosts.patternMatches} (${patternRate}% free)

**Efficiency:**
- Avg cost/call: $${avgPerCall.toFixed(4)}
- Cache hit rate: ${cacheRate}%
- Pattern match rate: ${patternRate}%

**By Intent:**
${topIntents || '  (no data yet)'}

**By Model:**
${modelBreakdown || '  (no data yet)'}`;
}

/**
 * Reset daily counters (call at midnight or on demand)
 */
export function resetDailyCounters(): void {
  dailyCosts.tokens = 0;
  dailyCosts.cost = 0;
  dailyCosts.calls = 0;
  dailyCosts.patternMatches = 0;
  dailyCosts.cacheHits = 0;
  costsByCategory.byIntent = {};
  costsByCategory.byModel = {};
  usageHistory.length = 0;
  sessionStartTime = Date.now();
  
  logger.info('Cost counters reset');
}

/**
 * Get recent usage history
 */
export function getRecentUsage(limit: number = 10): UsageRecord[] {
  return usageHistory.slice(-limit);
}

/**
 * Get current session stats
 */
export function getSessionStats() {
  return {
    totalCost: dailyCosts.cost,
    totalTokens: dailyCosts.tokens,
    llmCalls: dailyCosts.calls,
    patternMatches: dailyCosts.patternMatches,
    cacheHits: dailyCosts.cacheHits,
    uptimeMs: Date.now() - sessionStartTime
  };
}
