/**
 * Cost Optimization Advisor
 * 
 * Weekly analysis of all costs across Vercel, API usage, and Cursor agents.
 * Pure math with one optional Haiku summary.
 * Registered as scheduler handler 'cost_review'.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../../utils/logger.js';
import { enforceBudget, recordFeatureUsage, getFeatureMaxTokens } from '../../core/cost-tracker.js';
import { config } from '../../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPORTS_DIR = resolve(__dirname, '..', '..', '..', 'data', 'cost-reports');

if (!existsSync(REPORTS_DIR)) {
  mkdirSync(REPORTS_DIR, { recursive: true });
}

export interface CostReport {
  date: string;
  period: string;  // "week of YYYY-MM-DD"
  
  // API costs
  apiCosts: {
    totalDaily: number;
    byFeature: Record<string, number>;
    topFeature: string;
    trend: 'increasing' | 'stable' | 'decreasing';
  };
  
  // Vercel costs
  vercelCosts: {
    currentSpend: number;
    projectedMonthly: number;
    percentOfBudget: number;
    projectCount: number;
  } | null;
  
  // Cursor usage
  cursorUsage: {
    tasksThisWeek: number;
    avgTaskDuration: number;  // minutes
    refinementRounds: number;
  };
  
  // Recommendations
  recommendations: string[];
  
  // LLM summary (if budget allows)
  summary?: string;
}

/**
 * Gather all cost data and generate recommendations.
 */
async function gatherCostData(): Promise<CostReport> {
  const date = new Date().toISOString().split('T')[0];
  const report: CostReport = {
    date,
    period: `week of ${date}`,
    apiCosts: { totalDaily: 0, byFeature: {}, topFeature: 'none', trend: 'stable' },
    vercelCosts: null,
    cursorUsage: { tasksThisWeek: 0, avgTaskDuration: 0, refinementRounds: 0 },
    recommendations: [],
  };

  // 1. API costs from budget status
  try {
    const { getBudgetStatus } = await import('../../core/cost-tracker.js');
    const budget = getBudgetStatus();
    report.apiCosts.totalDaily = budget.global?.dailyUsed || 0;
    
    if (budget.features) {
      let topCost = 0;
      for (const [feature, data] of Object.entries(budget.features)) {
        const cost = data.costUsed || 0;
        report.apiCosts.byFeature[feature] = cost;
        if (cost > topCost) {
          topCost = cost;
          report.apiCosts.topFeature = feature;
        }
      }
    }
  } catch { /* cost tracker not available */ }

  // 2. Vercel costs
  try {
    const { checkVercelBilling } = await import('../security/billing.js');
    const billing = await checkVercelBilling();
    if (billing) {
      report.vercelCosts = {
        currentSpend: billing.currentSpend,
        projectedMonthly: billing.projectedMonthly,
        percentOfBudget: billing.percentUsed,
        projectCount: 0,
      };
      
      // Get project count from Vercel status
      try {
        const { getVercelStatus } = await import('../../api/vercel.js');
        const status = await getVercelStatus();
        if (status?.projects) {
          report.vercelCosts.projectCount = status.projects.length;
        }
      } catch { /* ok */ }
    }
  } catch { /* billing not available */ }

  // 3. Cursor usage
  try {
    const { getCompletedCursorTasks } = await import('../../integrations/cursor-orchestrator.js');
    const completed = getCompletedCursorTasks(20);
    const weekAgo = Date.now() - 7 * 86400000;
    const thisWeek = completed.filter(t => 
      t.completedAt && new Date(t.completedAt).getTime() > weekAgo
    );
    report.cursorUsage.tasksThisWeek = thisWeek.length;
    
    if (thisWeek.length > 0) {
      const durations = thisWeek
        .filter(t => t.startedAt && t.completedAt)
        .map(t => (new Date(t.completedAt!).getTime() - new Date(t.startedAt).getTime()) / 60000);
      report.cursorUsage.avgTaskDuration = durations.length > 0
        ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
        : 0;
    }
  } catch { /* cursor not available */ }

  // 4. Generate recommendations
  if (report.apiCosts.totalDaily > 3) {
    report.recommendations.push(`API spending ($${report.apiCosts.totalDaily.toFixed(2)}/day) is over 60% of the $5 daily cap. Consider reducing ${report.apiCosts.topFeature} usage.`);
  }
  
  if (report.vercelCosts && report.vercelCosts.percentOfBudget > 80) {
    report.recommendations.push(`Vercel spend is at ${report.vercelCosts.percentOfBudget}% of budget. Review project usage — ${report.vercelCosts.projectCount} projects active.`);
  }

  if (report.cursorUsage.avgTaskDuration > 30) {
    report.recommendations.push(`Average Cursor task takes ${report.cursorUsage.avgTaskDuration}min. Consider breaking large tasks into smaller ones.`);
  }

  if (report.apiCosts.byFeature['conversation'] > 0.05) {
    report.recommendations.push(`Conversation costs ($${report.apiCosts.byFeature['conversation']?.toFixed(3)}/day) could be reduced by lowering max tokens.`);
  }

  if (report.recommendations.length === 0) {
    report.recommendations.push('Costs are within normal ranges. No action needed.');
  }

  return report;
}

/**
 * Run the weekly cost review.
 * This is the scheduled handler function.
 */
export async function runCostReview(): Promise<void> {
  const report = await gatherCostData();

  // Optional Haiku summary
  const budgetCheck = enforceBudget('cost_advisor');
  if (budgetCheck.allowed) {
    try {
      const { generateText } = await import('../../core/llm/traced-llm.js');
      const { createAnthropic } = await import('@ai-sdk/anthropic');
      const provider = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY || '' });

      const { text } = await generateText({
        model: provider(config.claude.haiku_model),
        messages: [{
          role: 'user',
          content: `Write a 2-3 sentence cost optimization summary for this weekly report. Be specific and actionable:\n\nAPI costs: $${report.apiCosts.totalDaily.toFixed(2)}/day (top: ${report.apiCosts.topFeature})\nVercel: ${report.vercelCosts ? `$${report.vercelCosts.currentSpend} (${report.vercelCosts.percentOfBudget}% of budget)` : 'not tracked'}\nCursor tasks: ${report.cursorUsage.tasksThisWeek} this week, avg ${report.cursorUsage.avgTaskDuration}min\nRecommendations: ${report.recommendations.join('; ')}`,
        }],
        maxTokens: getFeatureMaxTokens('cost_advisor'),
      });

      recordFeatureUsage('cost_advisor', 0.001);
      report.summary = text;
    } catch {
      // LLM not available
    }
  }

  // Save report
  const filename = `${report.date}.json`;
  writeFileSync(resolve(REPORTS_DIR, filename), JSON.stringify(report, null, 2));

  logger.info('Cost review complete', {
    apiDaily: report.apiCosts.totalDaily,
    recommendations: report.recommendations.length,
  });
}

/**
 * Get the latest cost report.
 */
export function getLatestReport(): CostReport | null {
  try {
    const files = existsSync(REPORTS_DIR) ? 
      readdirSync(REPORTS_DIR).filter((f: string) => f.endsWith('.json')).sort().reverse() : [];
    if (files.length === 0) return null;
    return JSON.parse(readFileSync(resolve(REPORTS_DIR, files[0]), 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Format a cost report as readable text.
 */
export function formatCostReport(report: CostReport): string {
  const lines = [
    `Cost Report: ${report.period}`,
    '',
    `API: $${report.apiCosts.totalDaily.toFixed(2)}/day (top: ${report.apiCosts.topFeature})`,
  ];

  if (report.vercelCosts) {
    lines.push(`Vercel: $${report.vercelCosts.currentSpend.toFixed(2)} (${report.vercelCosts.percentOfBudget}% of budget, ${report.vercelCosts.projectCount} projects)`);
  }

  lines.push(`Cursor: ${report.cursorUsage.tasksThisWeek} tasks, avg ${report.cursorUsage.avgTaskDuration}min`);
  lines.push('');
  lines.push('Recommendations:');
  report.recommendations.forEach(r => lines.push(`- ${r}`));

  if (report.summary) {
    lines.push('', report.summary);
  }

  return lines.join('\n');
}

/**
 * Register with the scheduler.
 */
export function registerCostAdvisorHandler(): void {
  import('../scheduler/engine.js').then(({ registerHandler }) => {
    registerHandler('cost_review', runCostReview);
  }).catch(() => {});
}
