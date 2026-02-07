/**
 * Knowledge Scout - Relevance Scoring Engine
 * Scores each finding 0-100 using rules-based logic (free),
 * falling back to a single Haiku LLM call when no rule matches.
 */

import { logger } from '../../utils/logger.js';
import { config } from '../../config.js';
import { enforceBudget, recordFeatureUsage, getFeatureMaxTokens } from '../../core/cost-tracker.js';
import type { ScoutFinding } from './sources.js';

// ============================================================================
// Context interface for scoring
// ============================================================================

export interface RelevanceContext {
  /** Names of services currently running (e.g. 'jellyfin', 'radarr') */
  runningServices: string[];
  /** Names of active project dependencies (e.g. 'next', 'tailwindcss') */
  activeProjects: string[];
}

// ============================================================================
// Rules-based scoring (FREE — no LLM call)
// ============================================================================

/**
 * Known service name aliases — maps source names / repo slugs to
 * the short service names used in runningServices.
 */
const SERVICE_ALIASES: Record<string, string[]> = {
  jellyfin: ['jellyfin'],
  radarr: ['radarr'],
  sonarr: ['sonarr'],
  prowlarr: ['prowlarr'],
  nextcloud: ['nextcloud'],
  'pi-hole': ['pihole', 'pi-hole'],
};

/**
 * Known tech-stack aliases — maps repo slugs to dependency package names.
 */
const TECH_ALIASES: Record<string, string[]> = {
  'next.js': ['next', 'next.js', 'nextjs'],
  tailwind: ['tailwindcss', 'tailwind'],
};

function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function matchesAny(needle: string, haystack: string[], aliases: Record<string, string[]>): boolean {
  const n = normalise(needle);
  const normHaystack = haystack.map(normalise);

  // Direct match
  if (normHaystack.includes(n)) return true;

  // Check aliases
  for (const [, alts] of Object.entries(aliases)) {
    if (alts.map(normalise).includes(n)) {
      // needle is a known alias — check if any alt matches haystack
      for (const alt of alts) {
        if (normHaystack.includes(normalise(alt))) return true;
      }
    }
  }

  // Substring match (e.g. 'jellyfin' in 'jellyfin releases')
  for (const h of normHaystack) {
    if (n.includes(h) || h.includes(n)) return true;
  }

  return false;
}

/**
 * Try to score with deterministic rules. Returns null if no rule matched.
 */
function ruleBasedScore(finding: ScoutFinding, context: RelevanceContext): number | null {
  const titleNorm = normalise(finding.title);

  // 1. Security finding affecting a running service → 100
  if (finding.type === 'security') {
    for (const svc of context.runningServices) {
      if (matchesAny(svc, [finding.title, finding.summary, finding.sourceId], SERVICE_ALIASES)) {
        logger.debug('Relevance rule: security + running service', { finding: finding.title, service: svc });
        return 100;
      }
    }
    // Security finding not matching a running service still scores high
    return 85;
  }

  // 2. New release for a running service → 80
  if (finding.type === 'release') {
    for (const svc of context.runningServices) {
      if (matchesAny(svc, [finding.title, finding.sourceId], SERVICE_ALIASES)) {
        logger.debug('Relevance rule: release + running service', { finding: finding.title, service: svc });
        return 80;
      }
    }
  }

  // 3. Tech stack update for active project dependency → 60
  if (finding.type === 'tech') {
    for (const dep of context.activeProjects) {
      if (matchesAny(dep, [finding.title, finding.sourceId], TECH_ALIASES)) {
        logger.debug('Relevance rule: tech update + active dep', { finding: finding.title, dep });
        return 60;
      }
    }
  }

  // 4. Business intel → 70
  if (finding.type === 'business') {
    return 70;
  }

  // 5. Release for a service we don't recognise — still somewhat relevant
  if (finding.type === 'release') {
    return 40;
  }

  // No rule matched
  return null;
}

// ============================================================================
// LLM fallback scoring (capped Haiku call)
// ============================================================================

async function llmScore(finding: ScoutFinding, context: RelevanceContext): Promise<number> {
  // Budget check
  const budget = enforceBudget('scout_relevance');
  if (!budget.allowed) {
    logger.warn('Scout relevance LLM blocked by budget', { reason: budget.reason });
    return 30; // Default medium-low when budget exhausted
  }

  const maxTokens = getFeatureMaxTokens('scout_relevance');
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logger.warn('No ANTHROPIC_API_KEY — falling back to default score');
    return 30;
  }

  const model = config.claude.haiku_model;

  const prompt = `Rate relevance 0-100 for a homelab/dev user.
Finding: ${finding.type} — "${finding.title}": ${finding.summary}
Running services: ${context.runningServices.join(', ') || 'none'}
Active deps: ${context.activeProjects.join(', ') || 'none'}
Reply with ONLY a number 0-100.`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      logger.error('Haiku relevance call failed', { status: res.status, body: errBody });
      return 30;
    }

    const data = await res.json() as {
      content: Array<{ type: string; text: string }>;
      usage?: { input_tokens: number; output_tokens: number };
    };

    // Record cost
    const inputTokens = data.usage?.input_tokens ?? 0;
    const outputTokens = data.usage?.output_tokens ?? 0;
    const costPerMInput = 1.00; // Haiku input $/1M
    const costPerMOutput = 5.00; // Haiku output $/1M
    const cost = (inputTokens / 1_000_000) * costPerMInput + (outputTokens / 1_000_000) * costPerMOutput;
    recordFeatureUsage('scout_relevance', cost);

    const text = data.content?.[0]?.text?.trim() ?? '';
    const score = parseInt(text, 10);

    if (isNaN(score) || score < 0 || score > 100) {
      logger.warn('Haiku returned non-numeric relevance', { text });
      return 30;
    }

    logger.debug('LLM relevance score', { finding: finding.title, score, cost: cost.toFixed(4) });
    return score;
  } catch (error) {
    logger.error('Scout relevance LLM error', { error: String(error) });
    return 30;
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Score a finding's relevance 0-100.
 * Uses free rules-based scoring first; falls back to a single capped Haiku call.
 */
export async function scoreRelevance(
  finding: ScoutFinding,
  context: { runningServices: string[]; activeProjects: string[] },
): Promise<number> {
  // Try rules first (free)
  const ruleScore = ruleBasedScore(finding, context);
  if (ruleScore !== null) {
    return ruleScore;
  }

  // Fallback to LLM
  return llmScore(finding, context);
}
