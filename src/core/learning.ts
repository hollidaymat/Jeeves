/**
 * Learning Module - Jeeves Meta-Learning System
 * 
 * Tracks build history, learns from expensive mistakes,
 * and optimizes future builds based on past experience.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';
import { getSessionStats } from './cost-tracker.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = join(__dirname, '../../data');
const BUILD_HISTORY_PATH = join(DATA_DIR, 'build-history.json');
const LESSONS_PATH = join(DATA_DIR, 'lessons-learned.json');

// Budget thresholds
const BUDGET_THRESHOLDS = {
  warning: 2.00,   // Warn at $2
  critical: 5.00,  // Critical at $5
  abort: 10.00     // Abort at $10
};

// Consecutive failure limit before circuit breaker
const MAX_CONSECUTIVE_FAILURES = 2;

interface BuildRecord {
  id: string;
  project: string;
  date: string;
  method: string;
  totalCost: number;
  estimatedCost: number | null;
  prdCompliance: number;
  linesOfCode: number;
  phases: PhaseRecord[];
  issues: string[];
  lessonsLearned: string[];
  modelUsage?: Record<string, { calls: number; cost: number }>;
}

interface PhaseRecord {
  name: string;
  status: 'completed' | 'failed' | 'skipped';
  error?: string;
  cost: number;
}

interface BuildHistory {
  builds: BuildRecord[];
  aggregateStats: {
    totalSpent: number;
    averageCostPerBuild: number;
    mostExpensiveBuild: string;
    bestPrdCompliance: string;
    averagePrdCompliance: number;
  };
}

interface LessonsLearned {
  version: string;
  lastUpdated: string;
  costOptimization: {
    rules: Array<{
      id: string;
      rule: string;
      reason: string;
      learnedFrom: string;
      savings?: string;
      implementation?: string;
    }>;
    modelGuidelines: Record<string, string[]>;
  };
  buildExecution: {
    rules: Array<{
      id: string;
      rule: string;
      reason: string;
      learnedFrom: string;
      implementation?: string;
      savings?: string;
    }>;
    antiPatterns: Array<{
      pattern: string;
      problem: string;
      solution: string;
    }>;
  };
  parsingPatterns: {
    falsePositives: Array<{
      input: string;
      wrongInterpretation: string;
      correctInterpretation: string;
      fix: string;
    }>;
  };
  metricsToTrack: string[];
  nextImprovements: Array<{
    priority: number;
    improvement: string;
    estimatedSavings: string;
  }>;
}

// In-memory state
let currentBuildId: string | null = null;
let buildStartCost = 0;
let consecutiveFailures = 0;
let phaseRecords: PhaseRecord[] = [];

/**
 * Load build history
 */
function loadBuildHistory(): BuildHistory {
  try {
    if (existsSync(BUILD_HISTORY_PATH)) {
      return JSON.parse(readFileSync(BUILD_HISTORY_PATH, 'utf-8'));
    }
  } catch (error) {
    logger.error('Failed to load build history', { error: String(error) });
  }
  return { builds: [], aggregateStats: { totalSpent: 0, averageCostPerBuild: 0, mostExpensiveBuild: '', bestPrdCompliance: '', averagePrdCompliance: 0 } };
}

/**
 * Save build history
 */
function saveBuildHistory(history: BuildHistory): void {
  try {
    writeFileSync(BUILD_HISTORY_PATH, JSON.stringify(history, null, 2));
  } catch (error) {
    logger.error('Failed to save build history', { error: String(error) });
  }
}

/**
 * Load lessons learned
 */
export function loadLessons(): LessonsLearned | null {
  try {
    if (existsSync(LESSONS_PATH)) {
      return JSON.parse(readFileSync(LESSONS_PATH, 'utf-8'));
    }
  } catch (error) {
    logger.error('Failed to load lessons', { error: String(error) });
  }
  return null;
}

/**
 * Start tracking a new build
 */
export function startBuildTracking(project: string, method: string): string {
  const stats = getSessionStats();
  buildStartCost = stats.totalCost;
  currentBuildId = `build-${Date.now()}`;
  consecutiveFailures = 0;
  phaseRecords = [];
  
  logger.info('Build tracking started', { buildId: currentBuildId, project, startCost: buildStartCost });
  return currentBuildId;
}

/**
 * Record a phase completion/failure
 */
export function recordPhase(name: string, status: 'completed' | 'failed', cost: number, error?: string): {
  shouldContinue: boolean;
  warning?: string;
} {
  phaseRecords.push({ name, status, cost, error });
  
  if (status === 'failed') {
    consecutiveFailures++;
  } else {
    consecutiveFailures = 0;
  }
  
  // Check circuit breaker
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    logger.warn('Circuit breaker triggered', { failures: consecutiveFailures });
    return {
      shouldContinue: false,
      warning: `⚠️ Circuit breaker: ${consecutiveFailures} consecutive failures. Pausing to prevent wasted costs.`
    };
  }
  
  // Check budget
  const stats = getSessionStats();
  const buildCost = stats.totalCost - buildStartCost;
  
  if (buildCost >= BUDGET_THRESHOLDS.abort) {
    logger.error('Budget exceeded - aborting', { cost: buildCost });
    return {
      shouldContinue: false,
      warning: `🛑 Budget exceeded: $${buildCost.toFixed(2)} spent. Aborting build.`
    };
  }
  
  if (buildCost >= BUDGET_THRESHOLDS.critical) {
    return {
      shouldContinue: true,
      warning: `🚨 CRITICAL: Build cost at $${buildCost.toFixed(2)}. Consider aborting.`
    };
  }
  
  if (buildCost >= BUDGET_THRESHOLDS.warning) {
    return {
      shouldContinue: true,
      warning: `⚠️ Warning: Build cost at $${buildCost.toFixed(2)}`
    };
  }
  
  return { shouldContinue: true };
}

/**
 * Complete build tracking and analyze
 */
export function completeBuildTracking(
  project: string,
  method: string,
  prdCompliance: number,
  linesOfCode: number,
  issues: string[]
): BuildAnalysis {
  const stats = getSessionStats();
  const totalCost = stats.totalCost - buildStartCost;
  
  // Create build record
  const record: BuildRecord = {
    id: currentBuildId || `build-${Date.now()}`,
    project,
    date: new Date().toISOString().split('T')[0],
    method,
    totalCost,
    estimatedCost: null,
    prdCompliance,
    linesOfCode,
    phases: phaseRecords,
    issues,
    lessonsLearned: []
  };
  
  // Analyze and add lessons
  const analysis = analyzeBuild(record);
  record.lessonsLearned = analysis.newLessons;
  
  // Save to history
  const history = loadBuildHistory();
  history.builds.push(record);
  updateAggregateStats(history);
  saveBuildHistory(history);
  
  // Reset state
  currentBuildId = null;
  buildStartCost = 0;
  phaseRecords = [];
  
  logger.info('Build tracking completed', { 
    buildId: record.id, 
    cost: totalCost, 
    compliance: prdCompliance 
  });
  
  return analysis;
}

/**
 * Analyze a build and extract lessons
 */
function analyzeBuild(record: BuildRecord): BuildAnalysis {
  const analysis: BuildAnalysis = {
    efficiency: 'unknown',
    costPerLine: 0,
    newLessons: [],
    recommendations: [],
    comparison: null
  };
  
  // Calculate cost per line
  if (record.linesOfCode > 0) {
    analysis.costPerLine = record.totalCost / record.linesOfCode;
  }
  
  // Efficiency rating
  if (record.totalCost < 1.00 && record.prdCompliance >= 70) {
    analysis.efficiency = 'excellent';
  } else if (record.totalCost < 3.00 && record.prdCompliance >= 50) {
    analysis.efficiency = 'good';
  } else if (record.totalCost < 5.00) {
    analysis.efficiency = 'fair';
  } else {
    analysis.efficiency = 'poor';
  }
  
  // Extract lessons from issues
  if (record.totalCost > 5.00) {
    analysis.newLessons.push('Build exceeded $5 - investigate model usage');
  }
  
  const failedPhases = record.phases.filter(p => p.status === 'failed');
  if (failedPhases.length >= 2) {
    analysis.newLessons.push(`${failedPhases.length} phases failed - check API stability before retrying`);
  }
  
  if (record.prdCompliance < 50) {
    analysis.newLessons.push('Low PRD compliance - verify phase validation is working');
  }
  
  // Recommendations
  if (record.totalCost > 3.00) {
    analysis.recommendations.push('Consider using Haiku for planning, Sonnet for execution');
  }
  
  if (failedPhases.some(p => p.error?.includes('API'))) {
    analysis.recommendations.push('Add exponential backoff for API retries');
  }
  
  // Compare with previous builds
  const history = loadBuildHistory();
  const previousBuilds = history.builds.filter(b => b.id !== record.id);
  if (previousBuilds.length > 0) {
    const avgCost = previousBuilds.reduce((sum, b) => sum + b.totalCost, 0) / previousBuilds.length;
    const avgCompliance = previousBuilds.reduce((sum, b) => sum + b.prdCompliance, 0) / previousBuilds.length;
    
    analysis.comparison = {
      costVsAverage: record.totalCost - avgCost,
      complianceVsAverage: record.prdCompliance - avgCompliance,
      trend: record.totalCost < avgCost && record.prdCompliance > avgCompliance ? 'improving' : 
             record.totalCost > avgCost ? 'declining' : 'stable'
    };
  }
  
  return analysis;
}

/**
 * Update aggregate stats
 */
function updateAggregateStats(history: BuildHistory): void {
  if (history.builds.length === 0) return;
  
  const totalSpent = history.builds.reduce((sum, b) => sum + b.totalCost, 0);
  const avgCompliance = history.builds.reduce((sum, b) => sum + b.prdCompliance, 0) / history.builds.length;
  
  const mostExpensive = history.builds.reduce((max, b) => b.totalCost > max.totalCost ? b : max);
  const bestCompliance = history.builds.reduce((best, b) => b.prdCompliance > best.prdCompliance ? b : best);
  
  history.aggregateStats = {
    totalSpent,
    averageCostPerBuild: totalSpent / history.builds.length,
    mostExpensiveBuild: mostExpensive.id,
    bestPrdCompliance: bestCompliance.id,
    averagePrdCompliance: avgCompliance
  };
}

/**
 * Get build summary for user
 */
export function getBuildSummary(): string {
  const history = loadBuildHistory();
  const lessons = loadLessons();
  
  if (history.builds.length === 0) {
    return 'No build history yet.';
  }
  
  const recent = history.builds.slice(-3).reverse();
  const stats = history.aggregateStats;
  
  let summary = `## Build History Summary\n\n`;
  summary += `**Total Builds:** ${history.builds.length}\n`;
  summary += `**Total Spent:** $${stats.totalSpent.toFixed(2)}\n`;
  summary += `**Avg Cost/Build:** $${stats.averageCostPerBuild.toFixed(2)}\n`;
  summary += `**Avg PRD Compliance:** ${stats.averagePrdCompliance.toFixed(0)}%\n\n`;
  
  summary += `### Recent Builds\n`;
  recent.forEach(b => {
    const status = b.prdCompliance >= 70 ? '✅' : b.prdCompliance >= 40 ? '⚠️' : '❌';
    summary += `${status} **${b.project}** - $${b.totalCost.toFixed(2)} | ${b.prdCompliance}% compliance\n`;
  });
  
  if (lessons && lessons.nextImprovements.length > 0) {
    summary += `\n### Priority Improvements\n`;
    lessons.nextImprovements.slice(0, 3).forEach(imp => {
      summary += `${imp.priority}. ${imp.improvement}\n`;
    });
  }
  
  return summary;
}

/**
 * Get model selection guidance from lessons
 */
export function getModelGuidance(taskType: string): 'haiku' | 'sonnet' | 'opus' {
  const lessons = loadLessons();
  
  if (!lessons) {
    // Default to Sonnet for safety
    return 'sonnet';
  }
  
  const guidelines = lessons.costOptimization.modelGuidelines;
  
  // Check each model's guidelines
  for (const task of guidelines.haiku || []) {
    if (taskType.toLowerCase().includes(task.toLowerCase())) {
      return 'haiku';
    }
  }
  
  for (const task of guidelines.opus || []) {
    if (taskType.toLowerCase().includes(task.toLowerCase())) {
      return 'opus';
    }
  }
  
  // Default to Sonnet
  return 'sonnet';
}

/**
 * Check if we should use budget-conscious mode
 */
export function shouldUseBudgetMode(): boolean {
  const stats = getSessionStats();
  return stats.totalCost > BUDGET_THRESHOLDS.warning;
}

/**
 * Get current build cost
 */
export function getCurrentBuildCost(): number {
  if (!currentBuildId) return 0;
  const stats = getSessionStats();
  return stats.totalCost - buildStartCost;
}

/**
 * Reset consecutive failures (e.g., after successful user intervention)
 */
export function resetCircuitBreaker(): void {
  consecutiveFailures = 0;
  logger.info('Circuit breaker reset');
}

export interface BuildAnalysis {
  efficiency: 'excellent' | 'good' | 'fair' | 'poor' | 'unknown';
  costPerLine: number;
  newLessons: string[];
  recommendations: string[];
  comparison: {
    costVsAverage: number;
    complianceVsAverage: number;
    trend: 'improving' | 'declining' | 'stable';
  } | null;
}
