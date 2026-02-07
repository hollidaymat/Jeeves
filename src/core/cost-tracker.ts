/**
 * Cost Tracker
 * Tracks LLM usage, tokens, and costs for optimization
 * 
 * LESSON LEARNED (build-4): Persist costs to disk to survive restarts
 * and enable post-mortem analysis of expensive builds.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const COST_LOG_PATH = join(__dirname, '../../data/cost-log.json');

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
  
  // Log for visibility (debug level — viewable in Costs tab, not in chat)
  const cacheTag = cached ? ' [CACHED]' : '';
  logger.debug(`[COST] ${intent}: ${model}${cacheTag} - ${inputTokens}+${outputTokens} tokens = $${cost.toFixed(4)}`);
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

/**
 * Persist current session costs to disk
 */
export function persistCosts(): void {
  try {
    const costLog = loadCostLog();
    
    // Add today's session
    const today = new Date().toISOString().split('T')[0];
    const existing = costLog.sessions.find(s => s.date === today);
    
    if (existing) {
      // Update existing session
      existing.cost += dailyCosts.cost;
      existing.tokens += dailyCosts.tokens;
      existing.calls += dailyCosts.calls;
    } else {
      // New session for today
      costLog.sessions.push({
        date: today,
        cost: dailyCosts.cost,
        tokens: dailyCosts.tokens,
        calls: dailyCosts.calls,
        byModel: { ...costsByCategory.byModel }
      });
    }
    
    // Update totals
    costLog.totalSpent = costLog.sessions.reduce((sum, s) => sum + s.cost, 0);
    costLog.lastUpdated = new Date().toISOString();
    
    writeFileSync(COST_LOG_PATH, JSON.stringify(costLog, null, 2));
    logger.debug('Costs persisted to disk', { total: costLog.totalSpent });
  } catch (error) {
    logger.error('Failed to persist costs', { error: String(error) });
  }
}

/**
 * Load persisted cost log
 */
function loadCostLog(): CostLog {
  try {
    if (existsSync(COST_LOG_PATH)) {
      return JSON.parse(readFileSync(COST_LOG_PATH, 'utf-8'));
    }
  } catch (error) {
    logger.error('Failed to load cost log', { error: String(error) });
  }
  return { 
    sessions: [], 
    totalSpent: 0, 
    lastUpdated: new Date().toISOString() 
  };
}

/**
 * Get total historical spend
 */
export function getTotalHistoricalSpend(): number {
  const costLog = loadCostLog();
  return costLog.totalSpent + dailyCosts.cost;
}

/**
 * Get cost summary for user
 */
export function getCostSummary(): string {
  const costLog = loadCostLog();
  const recentSessions = costLog.sessions.slice(-7);
  
  let summary = `## Cost Summary\n\n`;
  summary += `**All-time Spend:** $${(costLog.totalSpent + dailyCosts.cost).toFixed(2)}\n`;
  summary += `**Today's Session:** $${dailyCosts.cost.toFixed(2)}\n\n`;
  
  if (recentSessions.length > 0) {
    summary += `### Last 7 Days\n`;
    recentSessions.forEach(s => {
      summary += `- ${s.date}: $${s.cost.toFixed(2)} (${s.calls} calls)\n`;
    });
  }
  
  return summary;
}

interface CostLog {
  sessions: Array<{
    date: string;
    cost: number;
    tokens: number;
    calls: number;
    byModel?: Record<string, number>;
  }>;
  totalSpent: number;
  lastUpdated: string;
}

// ============================================================================
// Dashboard Data (for Cost Dashboard tab)
// ============================================================================

/**
 * Load the persisted cost log (public export for dashboard use)
 */
export function getCostLog(): CostLog {
  return loadCostLog();
}

/**
 * Get cost for the current week (Mon-Sun)
 */
export function getWeeklyCost(): number {
  const costLog = loadCostLog();
  const now = new Date();
  const dayOfWeek = now.getDay() || 7; // 1=Mon..7=Sun
  const monday = new Date(now);
  monday.setDate(now.getDate() - dayOfWeek + 1);
  monday.setHours(0, 0, 0, 0);
  const mondayStr = monday.toISOString().split('T')[0];

  let weekCost = 0;
  for (const session of costLog.sessions) {
    if (session.date >= mondayStr) {
      weekCost += session.cost;
    }
  }
  // Add current session's cost for today
  const todayStr = now.toISOString().split('T')[0];
  const todaySession = costLog.sessions.find(s => s.date === todayStr);
  if (!todaySession) {
    weekCost += dailyCosts.cost;
  }
  return weekCost;
}

/**
 * Get cost for the current month
 */
export function getMonthlyCost(): number {
  const costLog = loadCostLog();
  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

  let monthCost = 0;
  for (const session of costLog.sessions) {
    if (session.date >= monthStart) {
      monthCost += session.cost;
    }
  }
  // Add current session if today not yet persisted
  const todayStr = now.toISOString().split('T')[0];
  const todaySession = costLog.sessions.find(s => s.date === todayStr);
  if (!todaySession) {
    monthCost += dailyCosts.cost;
  }
  return monthCost;
}

// ============================================================================
// Budget Enforcement Engine
// ============================================================================

// Hourly cost accumulator (rolling window)
const hourlyCosts: { timestamp: number; cost: number }[] = [];

// Per-feature call counters: feature -> { periodStart, calls, cost }
const featureCounters = new Map<string, { periodStart: number; calls: number; cost: number }>();

// Circuit breaker state
let consecutiveFailures = 0;
let circuitBreakerOpenUntil = 0;

/**
 * Record an LLM failure for circuit breaker tracking
 */
export function recordLLMFailure(): void {
  consecutiveFailures++;
  const threshold = config.budgets?.circuitBreakerThreshold ?? 3;
  if (consecutiveFailures >= threshold) {
    const pauseMs = config.budgets?.circuitBreakerPauseMs ?? 60000;
    circuitBreakerOpenUntil = Date.now() + pauseMs;
    logger.warn(`Circuit breaker OPEN — ${consecutiveFailures} consecutive failures, pausing LLM for ${pauseMs / 1000}s`);
  }
}

/**
 * Record an LLM success (resets circuit breaker)
 */
export function recordLLMSuccess(): void {
  consecutiveFailures = 0;
}

/**
 * Get the hourly cost total (rolling 60-minute window)
 */
function getHourlyCost(): number {
  const oneHourAgo = Date.now() - 3600000;
  // Prune old entries
  while (hourlyCosts.length > 0 && hourlyCosts[0].timestamp < oneHourAgo) {
    hourlyCosts.shift();
  }
  return hourlyCosts.reduce((sum, e) => sum + e.cost, 0);
}

/**
 * Record a cost entry in the hourly tracker
 */
export function recordHourlyCost(cost: number): void {
  hourlyCosts.push({ timestamp: Date.now(), cost });
}

/**
 * Check whether a feature is allowed to make an LLM call.
 * Returns { allowed: true } or { allowed: false, reason: string }.
 * Call BEFORE making any LLM request.
 */
export function enforceBudget(feature: string): { allowed: boolean; reason?: string; throttled?: boolean } {
  const budgets = config.budgets;
  if (!budgets) return { allowed: true };

  // 1. Circuit breaker
  if (Date.now() < circuitBreakerOpenUntil) {
    const remaining = Math.ceil((circuitBreakerOpenUntil - Date.now()) / 1000);
    return { allowed: false, reason: `Circuit breaker open — ${remaining}s remaining after ${consecutiveFailures} consecutive failures` };
  }

  // 2. Global daily hard cap
  if (budgets.dailyHardCap > 0 && dailyCosts.cost >= budgets.dailyHardCap) {
    return { allowed: false, reason: `Daily budget exhausted ($${dailyCosts.cost.toFixed(2)} / $${budgets.dailyHardCap.toFixed(2)})` };
  }

  // 3. Hourly soft cap — don't block, but flag throttle
  const hourlyCost = getHourlyCost();
  const throttled = budgets.hourlySoftCap > 0 && hourlyCost >= budgets.hourlySoftCap;
  if (throttled) {
    logger.debug(`Hourly soft cap reached ($${hourlyCost.toFixed(2)} / $${budgets.hourlySoftCap.toFixed(2)}) — Haiku-only mode`);
  }

  // 4. Per-feature budget
  const featureBudget = budgets.features?.[feature];
  if (featureBudget) {
    const now = Date.now();
    let counter = featureCounters.get(feature);

    // Reset counter if period has elapsed
    if (!counter || (featureBudget.periodMs > 0 && now - counter.periodStart >= featureBudget.periodMs)) {
      counter = { periodStart: now, calls: 0, cost: 0 };
      featureCounters.set(feature, counter);
    }

    // Check call limit
    if (featureBudget.maxCallsPerPeriod > 0 && counter.calls >= featureBudget.maxCallsPerPeriod) {
      return { allowed: false, reason: `${feature}: call limit reached (${counter.calls}/${featureBudget.maxCallsPerPeriod} per period)` };
    }

    // Check daily dollar cap for this feature
    if (featureBudget.dailyCap > 0 && counter.cost >= featureBudget.dailyCap) {
      return { allowed: false, reason: `${feature}: daily cap reached ($${counter.cost.toFixed(2)} / $${featureBudget.dailyCap.toFixed(2)})` };
    }
  }

  return { allowed: true, throttled };
}

/**
 * Record that a feature used an LLM call (call AFTER the request succeeds)
 */
export function recordFeatureUsage(feature: string, cost: number): void {
  const counter = featureCounters.get(feature);
  if (counter) {
    counter.calls++;
    counter.cost += cost;
  } else {
    featureCounters.set(feature, { periodStart: Date.now(), calls: 1, cost });
  }
  recordHourlyCost(cost);
  recordLLMSuccess();
}

/**
 * Get the max tokens allowed for a feature (respects config)
 */
export function getFeatureMaxTokens(feature: string): number {
  return config.budgets?.features?.[feature]?.maxTokens ?? config.claude.max_tokens;
}

/**
 * Get budget status for all features (for dashboard)
 */
export function getBudgetStatus(): {
  global: { dailyUsed: number; dailyCap: number; hourlyUsed: number; hourlyCap: number; circuitBreakerOpen: boolean };
  features: Record<string, { calls: number; maxCalls: number; costUsed: number; dailyCap: number; maxTokens: number }>;
} {
  const budgets = config.budgets;
  const features: Record<string, { calls: number; maxCalls: number; costUsed: number; dailyCap: number; maxTokens: number }> = {};

  if (budgets?.features) {
    for (const [name, fb] of Object.entries(budgets.features)) {
      const counter = featureCounters.get(name);
      features[name] = {
        calls: counter?.calls ?? 0,
        maxCalls: fb.maxCallsPerPeriod,
        costUsed: counter?.cost ?? 0,
        dailyCap: fb.dailyCap,
        maxTokens: fb.maxTokens,
      };
    }
  }

  return {
    global: {
      dailyUsed: dailyCosts.cost,
      dailyCap: budgets?.dailyHardCap ?? 5.00,
      hourlyUsed: getHourlyCost(),
      hourlyCap: budgets?.hourlySoftCap ?? 2.00,
      circuitBreakerOpen: Date.now() < circuitBreakerOpenUntil,
    },
    features,
  };
}

/**
 * Get structured data for the cost dashboard UI
 */
export function getCostDashboardData(monthlyLimit: number = 50): {
  today: number;
  week: number;
  month: number;
  limits: { daily: number; weekly: number; monthly: number };
  byModel: Record<string, number>;
  byCategory: Record<string, number>;
  trend: number;
} {
  const costLog = loadCostLog();
  const today = dailyCosts.cost;
  const week = getWeeklyCost();
  const month = getMonthlyCost();

  // Calculate trend: compare this week vs last week
  const now = new Date();
  const dayOfWeek = now.getDay() || 7;
  const lastMonday = new Date(now);
  lastMonday.setDate(now.getDate() - dayOfWeek + 1 - 7);
  const lastMondayStr = lastMonday.toISOString().split('T')[0];
  const thisMondayStr = new Date(now.getTime() - (dayOfWeek - 1) * 86400000).toISOString().split('T')[0];

  let lastWeekCost = 0;
  for (const session of costLog.sessions) {
    if (session.date >= lastMondayStr && session.date < thisMondayStr) {
      lastWeekCost += session.cost;
    }
  }

  const trend = lastWeekCost > 0 ? Math.round(((week - lastWeekCost) / lastWeekCost) * 100) : 0;

  return {
    today,
    week,
    month,
    limits: {
      daily: Math.round((monthlyLimit / 30) * 100) / 100,
      weekly: Math.round((monthlyLimit / 4) * 100) / 100,
      monthly: monthlyLimit,
    },
    byModel: { ...costsByCategory.byModel },
    byCategory: { ...costsByCategory.byIntent },
    trend,
  };
}
