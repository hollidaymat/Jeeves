/**
 * Vercel Security Guardian — Automated Response Playbook
 *
 * When the monitor detects a threshold breach it hands the SecurityEvent to
 * `executePlaybook`.  Each event type maps to a set of:
 *   1. Auto-actions — free API calls to Vercel (enable attack mode, etc.)
 *   2. Optional LLM triage — a short Haiku message (budget-enforced at 300 tokens)
 *   3. Notification priority
 *
 * If the LLM budget for `security_triage` is exhausted a static template
 * string is used instead.
 */

import { logger } from '../../utils/logger.js';
import { enforceBudget, recordFeatureUsage, getFeatureMaxTokens } from '../../core/cost-tracker.js';
import { setAttackMode, getDeployments } from './vercel-security.js';
import type { SecurityEvent, ResponseAction } from './types.js';

// ============================================================================
// Playbook Entry Point
// ============================================================================

/**
 * Execute the automated response playbook for a security event.
 *
 * Returns a human-readable summary of actions taken (suitable for
 * notification messages).
 */
export async function executePlaybook(event: SecurityEvent): Promise<string> {
  logger.debug(`[security-response] Executing playbook for ${event.type}`, {
    project: event.projectName,
    severity: event.severity,
  });

  let summary: string;

  switch (event.type) {
    case 'traffic_spike':
      summary = await handleTrafficSpike(event);
      break;
    case 'error_spike':
      summary = await handleErrorSpike(event);
      break;
    case 'ssl_expiry':
      summary = await handleSSLExpiry(event);
      break;
    case 'deploy_failed':
      summary = await handleDeployFailed(event);
      break;
    case 'bot_traffic':
      summary = await handleBotTraffic(event);
      break;
    default: {
      const _exhaustive: never = event.type;
      summary = `Unknown event type: ${_exhaustive}`;
    }
  }

  // Append optional LLM triage message
  const triageMessage = await generateTriageMessage(event);
  if (triageMessage) {
    summary += `\n\nTriage: ${triageMessage}`;
  }

  logger.debug(`[security-response] Playbook complete: ${event.type}`, { summary });
  return summary;
}

// ============================================================================
// Per-type Handlers
// ============================================================================

async function handleTrafficSpike(event: SecurityEvent): Promise<string> {
  const actions: string[] = [];

  // Auto-action: enable attack challenge mode
  logger.debug(`[security-response] Traffic spike detected for ${event.projectName} — enabling attack mode`);
  const result = await setAttackMode(event.projectId, true);
  if (result) {
    actions.push('Enabled Vercel Attack Challenge Mode');
    event.autoActionsTaken.push('attack_mode_enabled');
  } else {
    actions.push('Attempted to enable Attack Challenge Mode (endpoint unavailable)');
    event.autoActionsTaken.push('attack_mode_attempted');
  }

  actions.push(`Alert: ${event.message}`);
  return actions.join('\n');
}

async function handleErrorSpike(event: SecurityEvent): Promise<string> {
  const actions: string[] = [];

  // Auto-action: compare to previous deployment
  logger.debug(`[security-response] Error spike detected for ${event.projectName}`);
  const deploys = await getDeployments(event.projectId, 5);

  if (deploys && deploys.length >= 2) {
    const recent = deploys as Array<Record<string, unknown>>;
    const current = recent[0];
    const previous = recent[1];

    const currentStatus = (current?.readyState as string) || 'UNKNOWN';
    const previousStatus = (previous?.readyState as string) || 'UNKNOWN';
    const currentCommit = ((current?.meta as Record<string, unknown>)?.githubCommitMessage as string) || 'unknown';

    actions.push(`Current deploy: ${currentStatus} — "${currentCommit}"`);
    actions.push(`Previous deploy: ${previousStatus}`);

    if (currentStatus === 'ERROR' && previousStatus === 'READY') {
      actions.push('Recommendation: Consider rolling back to previous deployment');
      event.autoActionsTaken.push('rollback_suggested');
    }
  } else {
    actions.push('Could not fetch deployment history for comparison');
  }

  actions.push(`Alert: ${event.message}`);
  return actions.join('\n');
}

async function handleSSLExpiry(event: SecurityEvent): Promise<string> {
  const actions: string[] = [];

  logger.debug(`[security-response] SSL expiry warning for ${event.projectName}`);

  // Vercel auto-renews Let's Encrypt certs, so this mainly fires for
  // custom / manually-uploaded certificates.
  actions.push('Vercel auto-renews Let\'s Encrypt certificates by default');
  actions.push('If using a custom certificate, manual renewal is required');
  actions.push(`Alert: ${event.message}`);
  event.autoActionsTaken.push('ssl_check_logged');

  return actions.join('\n');
}

async function handleDeployFailed(event: SecurityEvent): Promise<string> {
  const actions: string[] = [];

  logger.debug(`[security-response] Deploy failure detected for ${event.projectName}`);

  // Fetch recent deployments to identify the error pattern
  const deploys = await getDeployments(event.projectId, 5);
  if (deploys && deploys.length > 0) {
    const recent = deploys as Array<Record<string, unknown>>;
    const failedDeploys = recent.filter(d => d.readyState === 'ERROR');

    actions.push(`${failedDeploys.length} of last ${recent.length} deployments failed`);

    // Extract commit messages to help identify the breaking change
    for (const deploy of failedDeploys.slice(0, 3)) {
      const commit = ((deploy.meta as Record<string, unknown>)?.githubCommitMessage as string) || 'no commit message';
      const created = deploy.created ? new Date(deploy.created as number).toISOString() : 'unknown';
      actions.push(`  Failed: "${commit.substring(0, 60)}" at ${created}`);
    }

    event.autoActionsTaken.push('build_logs_summarized');
  } else {
    actions.push('Could not fetch deployment history');
  }

  actions.push(`Alert: ${event.message}`);
  return actions.join('\n');
}

async function handleBotTraffic(event: SecurityEvent): Promise<string> {
  const actions: string[] = [];

  logger.debug(`[security-response] Bot traffic pattern detected for ${event.projectName}`);

  actions.push('Suspicious bot traffic pattern detected');
  actions.push('Recommendation: Review WAF rules and consider adding rate limiting');
  actions.push(`Alert: ${event.message}`);
  event.autoActionsTaken.push('bot_pattern_logged');

  return actions.join('\n');
}

// ============================================================================
// LLM Triage (Budget-enforced, Haiku, 300 tokens max)
// ============================================================================

/**
 * Generate a short, human-readable triage alert using Haiku.
 *
 * Budget-enforced under the `security_triage` feature.  When the budget is
 * exhausted a static template string is returned instead of calling the LLM.
 */
async function generateTriageMessage(event: SecurityEvent): Promise<string | null> {
  // Check budget before making any LLM call
  const budget = enforceBudget('security_triage');
  if (!budget.allowed) {
    logger.debug('[security-response] Security triage budget exhausted — using template', {
      reason: budget.reason,
    });
    return getTemplateTriage(event);
  }

  const maxTokens = Math.min(getFeatureMaxTokens('security_triage'), 300);

  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      logger.debug('[security-response] No ANTHROPIC_API_KEY — using template triage');
      return getTemplateTriage(event);
    }

    const prompt = buildTriagePrompt(event);

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) {
      logger.warn('[security-response] Haiku triage call failed', { status: res.status });
      return getTemplateTriage(event);
    }

    const data = (await res.json()) as Record<string, unknown>;
    const content = data.content as Array<Record<string, unknown>>;
    const text = (content?.[0]?.text as string) || '';

    // Record usage for budget tracking
    const usage = data.usage as Record<string, number> | undefined;
    if (usage) {
      const inputTokens = usage.input_tokens || 0;
      const outputTokens = usage.output_tokens || 0;
      // Rough cost estimate: Haiku pricing
      const cost = (inputTokens / 1_000_000) * 1.0 + (outputTokens / 1_000_000) * 5.0;
      recordFeatureUsage('security_triage', cost);
    }

    return text.trim() || getTemplateTriage(event);
  } catch (error) {
    logger.error('[security-response] Triage generation failed', { error: String(error) });
    return getTemplateTriage(event);
  }
}

// ============================================================================
// Helpers
// ============================================================================

function buildTriagePrompt(event: SecurityEvent): string {
  return [
    'You are a DevOps security assistant. Summarize this security event in 1-2 concise sentences.',
    'Include: what happened, severity, and recommended next step.',
    '',
    `Project: ${event.projectName}`,
    `Event: ${event.type}`,
    `Severity: ${event.severity}`,
    `Message: ${event.message}`,
    `Actions taken: ${event.autoActionsTaken.join(', ') || 'none'}`,
  ].join('\n');
}

function getTemplateTriage(event: SecurityEvent): string {
  const templates: Record<ResponseAction, string> = {
    traffic_spike: `Traffic spike detected on ${event.projectName}. Monitor traffic patterns and consider enabling rate limiting if the spike persists.`,
    error_spike: `Elevated error rate on ${event.projectName}. Review recent deployments and consider rolling back if errors correlate with a new deploy.`,
    ssl_expiry: `SSL certificate for ${event.projectName} is nearing expiration. Verify auto-renewal status or renew manually if using a custom certificate.`,
    deploy_failed: `Multiple consecutive deploy failures on ${event.projectName}. Check build logs for the root cause and consider reverting the breaking commit.`,
    bot_traffic: `Suspicious bot traffic detected on ${event.projectName}. Review access logs and consider adding WAF rules to block malicious patterns.`,
  };
  return templates[event.type] || `Security event on ${event.projectName}: ${event.message}`;
}
