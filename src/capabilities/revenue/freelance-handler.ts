/**
 * Freelance Gig Analyzer
 * 
 * Uses a single Haiku call (budget-enforced) to evaluate freelance gig
 * feasibility based on our known stack and templates.
 */

import { generateText } from '../../core/llm/traced-llm.js';
import { createAnthropic } from '@ai-sdk/anthropic';
import { logger } from '../../utils/logger.js';
import { config } from '../../config.js';
import { enforceBudget, recordFeatureUsage, getFeatureMaxTokens } from '../../core/cost-tracker.js';

// ============================================================================
// Types
// ============================================================================

export interface GigAnalysis {
  canBuild: boolean;
  estimatedHours: number;
  estimatedCost: number;
  suggestedPrice: number;
  profitMargin: string;
  risks: string[];
  template: string;
  recommendation: 'TAKE IT' | 'PASS' | 'NEGOTIATE';
}

// ============================================================================
// Prompt
// ============================================================================

const GIG_ANALYSIS_PROMPT = `You are a freelance gig analyzer. Our stack: Next.js, React, Tailwind, Vercel, Supabase. Our templates: DiveConnect SaaS, Portfolio, Dashboard.

Analyze this freelance gig and return JSON only. No prose before or after.

GIG DESCRIPTION:
"{description}"

Return this exact JSON shape:
{
  "canBuild": true/false,
  "estimatedHours": number,
  "estimatedCost": number (our cost in $ to build — hosting, API, time),
  "suggestedPrice": number (what to charge the client in $),
  "risks": ["risk1", "risk2"],
  "template": "closest template or 'custom'",
  "recommendation": "TAKE IT" | "PASS" | "NEGOTIATE"
}

PRICING GUIDELINES:
- Our hourly rate: $75-150/hr depending on complexity
- Always suggest at least 2x our estimated cost
- Factor in revisions (add 20% buffer)
- Consider template reuse savings

RESPOND WITH JSON ONLY.`;

// ============================================================================
// Analyzer
// ============================================================================

const anthropic = createAnthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || '',
});

/**
 * Evaluate a freelance gig description for feasibility and pricing.
 */
export async function evaluateGig(description: string): Promise<GigAnalysis> {
  // Budget check before LLM call
  const budget = enforceBudget('freelance_analysis');
  if (!budget.allowed) {
    logger.warn('Freelance analysis budget exhausted', { reason: budget.reason });
    return getDefaultAnalysis('Budget limit reached');
  }

  const maxTokens = getFeatureMaxTokens('freelance_analysis');

  try {
    const prompt = GIG_ANALYSIS_PROMPT.replace('{description}', description.replace(/"/g, '\\"'));

    const { text, usage } = await generateText({
      model: anthropic(config.claude.haiku_model),
      prompt,
      maxTokens,
      temperature: 0,
    });

    // Calculate cost and record usage
    const inputTokens = usage?.promptTokens || 0;
    const outputTokens = usage?.completionTokens || 0;
    const cost = ((inputTokens / 1_000_000) * 1.00) + ((outputTokens / 1_000_000) * 5.00);
    recordFeatureUsage('freelance_analysis', cost);

    // Parse JSON response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn('Gig analyzer returned non-JSON response', { text: text.substring(0, 200) });
      return getDefaultAnalysis('Failed to parse LLM response');
    }

    const parsed = JSON.parse(jsonMatch[0]) as Partial<GigAnalysis>;

    // Build result with defaults for any missing fields
    const analysis: GigAnalysis = {
      canBuild: parsed.canBuild ?? false,
      estimatedHours: parsed.estimatedHours ?? 0,
      estimatedCost: parsed.estimatedCost ?? 0,
      suggestedPrice: parsed.suggestedPrice ?? 0,
      profitMargin: '',  // calculated below
      risks: parsed.risks ?? [],
      template: parsed.template ?? 'custom',
      recommendation: parsed.recommendation ?? 'PASS',
    };

    // Calculate profit margin from suggestedPrice and estimatedCost
    if (analysis.suggestedPrice > 0 && analysis.estimatedCost > 0) {
      const margin = ((analysis.suggestedPrice - analysis.estimatedCost) / analysis.suggestedPrice) * 100;
      analysis.profitMargin = `${margin.toFixed(1)}%`;
    } else {
      analysis.profitMargin = 'N/A';
    }

    logger.info('Gig analysis complete', {
      canBuild: analysis.canBuild,
      recommendation: analysis.recommendation,
      suggestedPrice: analysis.suggestedPrice,
      profitMargin: analysis.profitMargin,
    });

    return analysis;
  } catch (error) {
    logger.error('Gig analysis failed', { error: String(error) });
    return getDefaultAnalysis('Analysis failed: ' + String(error));
  }
}

// ============================================================================
// Defaults
// ============================================================================

function getDefaultAnalysis(reason: string): GigAnalysis {
  return {
    canBuild: false,
    estimatedHours: 0,
    estimatedCost: 0,
    suggestedPrice: 0,
    profitMargin: 'N/A',
    risks: [reason],
    template: 'none',
    recommendation: 'PASS',
  };
}
