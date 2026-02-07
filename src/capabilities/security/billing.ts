/**
 * Vercel Billing Alerts
 * 
 * Checks Vercel billing usage against budget thresholds.
 * Pure math — no LLM calls. Returns null gracefully if
 * the billing endpoint is unavailable.
 */

import { logger } from '../../utils/logger.js';

// ============================================================================
// Types
// ============================================================================

export interface BillingStatus {
  currentSpend: number;
  budget: number;
  percentUsed: number;
  projectedMonthly: number;
  alert: 'ok' | 'warning' | 'critical';
  message?: string;
}

// ============================================================================
// Thresholds
// ============================================================================

const WARN_THRESHOLD = 0.80;     // 80% of budget
const CRITICAL_THRESHOLD = 0.95;  // 95% of budget

// ============================================================================
// Billing Check
// ============================================================================

/**
 * Check Vercel billing usage and return alert status.
 * Returns null if the billing API is unavailable or not configured.
 */
export async function checkVercelBilling(): Promise<BillingStatus | null> {
  const token = process.env.VERCEL_API_TOKEN;
  const teamId = process.env.VERCEL_TEAM_ID;

  if (!token) {
    logger.debug('Vercel billing check skipped — no VERCEL_API_TOKEN');
    return null;
  }

  try {
    // Build billing API URL
    const url = new URL('https://api.vercel.com/v1/billing/usage');
    if (teamId) {
      url.searchParams.set('teamId', teamId);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    let res: Response;
    try {
      res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      // Billing endpoint might not exist for all plan types — fail gracefully
      logger.debug('Vercel billing API returned non-OK status', { status: res.status });
      return null;
    }

    const data = await res.json() as Record<string, unknown>;

    // Extract spend and budget from response
    // Vercel billing API shape can vary; try common fields
    const currentSpend = extractNumber(data, 'totalCost') 
                      ?? extractNumber(data, 'cost') 
                      ?? extractNumber(data, 'amount')
                      ?? 0;

    const budget = extractNumber(data, 'budget')
                ?? extractNumber(data, 'limit')
                ?? extractNumber(data, 'spendManagement')
                ?? 0;

    if (budget <= 0) {
      logger.debug('No billing budget set on Vercel account');
      return {
        currentSpend,
        budget: 0,
        percentUsed: 0,
        projectedMonthly: projectMonthlySpend(currentSpend),
        alert: 'ok',
        message: 'No budget limit configured on Vercel',
      };
    }

    // Calculate metrics
    const percentUsed = currentSpend / budget;
    const projectedMonthly = projectMonthlySpend(currentSpend);

    // Determine alert level
    let alert: BillingStatus['alert'] = 'ok';
    let message: string | undefined;

    if (percentUsed >= CRITICAL_THRESHOLD) {
      alert = 'critical';
      message = `CRITICAL: Vercel spend at ${(percentUsed * 100).toFixed(1)}% of budget ($${currentSpend.toFixed(2)} / $${budget.toFixed(2)})`;
      logger.warn(message);
    } else if (percentUsed >= WARN_THRESHOLD) {
      alert = 'warning';
      message = `WARNING: Vercel spend at ${(percentUsed * 100).toFixed(1)}% of budget ($${currentSpend.toFixed(2)} / $${budget.toFixed(2)})`;
      logger.warn(message);
    }

    return {
      currentSpend,
      budget,
      percentUsed: Math.round(percentUsed * 1000) / 10,  // e.g. 82.3
      projectedMonthly,
      alert,
      message,
    };
  } catch (error) {
    // Network errors, timeouts, parse failures — all return null
    logger.debug('Vercel billing check failed gracefully', { error: String(error) });
    return null;
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Safely extract a numeric value from a nested object.
 */
function extractNumber(data: Record<string, unknown>, key: string): number | null {
  const value = data[key];
  if (typeof value === 'number' && !isNaN(value)) return value;
  if (typeof value === 'string') {
    const parsed = parseFloat(value);
    if (!isNaN(parsed)) return parsed;
  }
  return null;
}

/**
 * Project current spend to a full month based on day of month.
 */
function projectMonthlySpend(currentSpend: number): number {
  const now = new Date();
  const dayOfMonth = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();

  if (dayOfMonth === 0) return currentSpend;
  return Math.round((currentSpend / dayOfMonth) * daysInMonth * 100) / 100;
}
