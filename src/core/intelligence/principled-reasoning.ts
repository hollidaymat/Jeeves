/**
 * Principled Reasoning - Decision Frameworks
 * 
 * Apply structured decision-making frameworks:
 * - MECE (Mutually Exclusive, Collectively Exhaustive)
 * - First Principles Thinking
 * - Inversion (What could go wrong?)
 * - Second-Order Effects
 * - Reversibility Assessment
 */

import { logger } from '../../utils/logger.js';
import { generateText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { trackLLMUsage } from '../cost-tracker.js';

// ==========================================
// TYPES
// ==========================================

export type FrameworkType = 
  | 'mece'
  | 'first_principles'
  | 'inversion'
  | 'second_order'
  | 'reversibility';

export interface DecisionContext {
  question: string;
  constraints: string[];
  stakeholders?: string[];
  timeframe?: string;
  riskTolerance?: 'low' | 'medium' | 'high';
}

export interface FrameworkAnalysis {
  framework: FrameworkType;
  insights: string[];
  recommendations: string[];
  warnings: string[];
}

export interface PrincipledDecision {
  context: DecisionContext;
  analyses: FrameworkAnalysis[];
  recommendation: string;
  confidence: number;
  reasoning: string;
  alternatives: Alternative[];
}

export interface Alternative {
  description: string;
  pros: string[];
  cons: string[];
  risk: 'low' | 'medium' | 'high';
  reversibility: 'easy' | 'moderate' | 'difficult';
}

// ==========================================
// FRAMEWORK IMPLEMENTATIONS
// ==========================================

/**
 * MECE Analysis - Break down options mutually exclusively and collectively exhaustively
 */
function applyMECE(context: DecisionContext): FrameworkAnalysis {
  const insights: string[] = [];
  const recommendations: string[] = [];
  const warnings: string[] = [];
  
  // Ensure options don't overlap
  insights.push('Breaking down the problem into non-overlapping categories');
  
  // Ensure all possibilities are covered
  insights.push('Verifying all possible solutions are considered');
  
  // Common MECE categories for tech decisions
  const categories = [
    'Build vs Buy',
    'Now vs Later',
    'Simple vs Complex',
    'Incremental vs Big Bang'
  ];
  
  recommendations.push(`Consider these MECE categories: ${categories.join(', ')}`);
  recommendations.push('Ensure each option is distinct (no overlap)');
  recommendations.push('Verify together they cover all possibilities');
  
  if (context.constraints.length > 3) {
    warnings.push('Many constraints may indicate options are too constrained');
  }
  
  return {
    framework: 'mece',
    insights,
    recommendations,
    warnings
  };
}

/**
 * First Principles Thinking - Break down to fundamental truths
 */
function applyFirstPrinciples(context: DecisionContext): FrameworkAnalysis {
  const insights: string[] = [];
  const recommendations: string[] = [];
  const warnings: string[] = [];
  
  insights.push('Stripping away assumptions to find core truths');
  insights.push('Questioning "why" until reaching fundamental requirements');
  
  recommendations.push('Ask: What is the actual problem being solved?');
  recommendations.push('Ask: What are the immutable constraints vs assumed ones?');
  recommendations.push('Ask: What would the ideal solution look like with no constraints?');
  
  // Check for assumption-laden constraints
  const assumptionIndicators = ['always', 'never', 'must', 'should'];
  const potentialAssumptions = context.constraints.filter(c =>
    assumptionIndicators.some(i => c.toLowerCase().includes(i))
  );
  
  if (potentialAssumptions.length > 0) {
    warnings.push(`Challenge these potential assumptions: ${potentialAssumptions.join('; ')}`);
  }
  
  return {
    framework: 'first_principles',
    insights,
    recommendations,
    warnings
  };
}

/**
 * Inversion - What could go wrong?
 */
function applyInversion(context: DecisionContext): FrameworkAnalysis {
  const insights: string[] = [];
  const recommendations: string[] = [];
  const warnings: string[] = [];
  
  insights.push('Inverting the problem: What would cause failure?');
  insights.push('Identifying anti-goals to avoid');
  
  recommendations.push('List all ways this could fail');
  recommendations.push('Identify the most likely failure modes');
  recommendations.push('Create mitigations for top 3 risks');
  
  // Common failure modes in software
  const commonFailures = [
    'Data loss or corruption',
    'Performance degradation',
    'Security vulnerabilities',
    'Breaking backward compatibility',
    'Technical debt accumulation'
  ];
  
  recommendations.push(`Consider common failures: ${commonFailures.join(', ')}`);
  
  if (context.riskTolerance === 'low') {
    warnings.push('Low risk tolerance: prioritize reversible approaches');
  }
  
  return {
    framework: 'inversion',
    insights,
    recommendations,
    warnings
  };
}

/**
 * Second-Order Effects - What happens after the immediate result?
 */
function applySecondOrder(context: DecisionContext): FrameworkAnalysis {
  const insights: string[] = [];
  const recommendations: string[] = [];
  const warnings: string[] = [];
  
  insights.push('Looking beyond immediate effects to downstream consequences');
  insights.push('Considering how the ecosystem will react');
  
  recommendations.push('Map out: Immediate effect → Secondary effects → Tertiary effects');
  recommendations.push('Consider impact on: Users, Team, System, Business');
  
  if (context.stakeholders && context.stakeholders.length > 0) {
    recommendations.push(`Analyze impact on each stakeholder: ${context.stakeholders.join(', ')}`);
  }
  
  // Time-based second order effects
  if (context.timeframe) {
    recommendations.push(`Project effects at: 1 week, 1 month, 3 months after ${context.timeframe}`);
  }
  
  warnings.push('Beware of unintended consequences from system interactions');
  
  return {
    framework: 'second_order',
    insights,
    recommendations,
    warnings
  };
}

/**
 * Reversibility Assessment - Can we undo this?
 */
function applyReversibility(context: DecisionContext): FrameworkAnalysis {
  const insights: string[] = [];
  const recommendations: string[] = [];
  const warnings: string[] = [];
  
  insights.push('Evaluating how easily each option can be undone');
  insights.push('Categorizing decisions as one-way or two-way doors');
  
  recommendations.push('Prefer reversible (two-way door) decisions');
  recommendations.push('For irreversible decisions, invest more in analysis');
  recommendations.push('Create rollback plans for risky changes');
  
  // Irreversibility indicators
  const irreversibleIndicators = [
    'delete', 'remove', 'migrate', 'schema change', 
    'public API', 'launch', 'deprecate'
  ];
  
  const questionLower = context.question.toLowerCase();
  const irreversibleMatches = irreversibleIndicators.filter(i => 
    questionLower.includes(i)
  );
  
  if (irreversibleMatches.length > 0) {
    warnings.push(`Potentially irreversible elements detected: ${irreversibleMatches.join(', ')}`);
    warnings.push('Consider phased rollout or feature flags');
  }
  
  return {
    framework: 'reversibility',
    insights,
    recommendations,
    warnings
  };
}

// ==========================================
// PRINCIPLED REASONING ENGINE
// ==========================================

export class PrincipledReasoning {
  private frameworks: Map<FrameworkType, (ctx: DecisionContext) => FrameworkAnalysis>;
  
  constructor() {
    this.frameworks = new Map([
      ['mece', applyMECE],
      ['first_principles', applyFirstPrinciples],
      ['inversion', applyInversion],
      ['second_order', applySecondOrder],
      ['reversibility', applyReversibility]
    ]);
  }
  
  /**
   * Analyze a decision using all frameworks
   */
  async analyze(context: DecisionContext): Promise<PrincipledDecision> {
    const analyses: FrameworkAnalysis[] = [];
    
    // Apply each framework
    for (const [type, applyFn] of this.frameworks) {
      const analysis = applyFn(context);
      analyses.push(analysis);
    }
    
    // Synthesize recommendation
    const synthesis = await this.synthesize(context, analyses);
    
    return {
      context,
      analyses,
      recommendation: synthesis.recommendation,
      confidence: synthesis.confidence,
      reasoning: synthesis.reasoning,
      alternatives: synthesis.alternatives
    };
  }
  
  /**
   * Analyze using specific frameworks
   */
  analyzeWith(
    context: DecisionContext,
    frameworks: FrameworkType[]
  ): FrameworkAnalysis[] {
    const analyses: FrameworkAnalysis[] = [];
    
    for (const type of frameworks) {
      const applyFn = this.frameworks.get(type);
      if (applyFn) {
        analyses.push(applyFn(context));
      }
    }
    
    return analyses;
  }
  
  /**
   * Synthesize analyses into a recommendation
   */
  private async synthesize(
    context: DecisionContext,
    analyses: FrameworkAnalysis[]
  ): Promise<{
    recommendation: string;
    confidence: number;
    reasoning: string;
    alternatives: Alternative[];
  }> {
    // Collect all insights and warnings
    const allInsights = analyses.flatMap(a => a.insights);
    const allWarnings = analyses.flatMap(a => a.warnings);
    const allRecommendations = analyses.flatMap(a => a.recommendations);
    
    // Use LLM for final synthesis
    try {
      const anthropic = createAnthropic({
        apiKey: process.env.ANTHROPIC_API_KEY
      });
      
      const prompt = `Synthesize a decision recommendation:

QUESTION: ${context.question}
CONSTRAINTS: ${context.constraints.join(', ')}

FRAMEWORK INSIGHTS:
${allInsights.map(i => `- ${i}`).join('\n')}

WARNINGS TO CONSIDER:
${allWarnings.map(w => `- ${w}`).join('\n')}

Provide:
1. A clear recommendation (1-2 sentences)
2. Confidence level (0-1)
3. Brief reasoning (2-3 sentences)
4. One alternative approach with pros/cons

Respond with JSON:
{
  "recommendation": "...",
  "confidence": 0.8,
  "reasoning": "...",
  "alternative": {
    "description": "...",
    "pros": ["..."],
    "cons": ["..."],
    "risk": "low|medium|high",
    "reversibility": "easy|moderate|difficult"
  }
}`;

      const result = await generateText({
        model: anthropic('claude-3-5-haiku-20241022'),
        prompt,
        maxTokens: 400
      });
      
      if (result.usage) {
        trackLLMUsage('principled-reasoning', 'claude-3-5-haiku-20241022',
          result.usage.promptTokens, result.usage.completionTokens, false);
      }
      
      const parsed = JSON.parse(result.text.match(/\{[\s\S]*\}/)?.[0] || '{}');
      
      return {
        recommendation: parsed.recommendation || 'Unable to synthesize recommendation',
        confidence: parsed.confidence || 0.5,
        reasoning: parsed.reasoning || 'Analysis inconclusive',
        alternatives: parsed.alternative ? [{
          description: parsed.alternative.description,
          pros: parsed.alternative.pros || [],
          cons: parsed.alternative.cons || [],
          risk: parsed.alternative.risk || 'medium',
          reversibility: parsed.alternative.reversibility || 'moderate'
        }] : []
      };
      
    } catch (error) {
      logger.debug('LLM synthesis failed, using heuristic', { error: String(error) });
      
      // Fallback heuristic synthesis
      return {
        recommendation: allRecommendations[0] || 'Proceed with caution',
        confidence: allWarnings.length > 3 ? 0.4 : 0.6,
        reasoning: `Based on ${analyses.length} frameworks. ${allWarnings.length} warnings noted.`,
        alternatives: []
      };
    }
  }
  
  /**
   * Quick principle check for a decision
   */
  quickCheck(question: string): string[] {
    const checks: string[] = [];
    const questionLower = question.toLowerCase();
    
    // Reversibility check
    if (questionLower.includes('delete') || questionLower.includes('remove')) {
      checks.push('⚠️ Irreversible action - ensure backups exist');
    }
    
    // Scope check
    if (questionLower.includes('all') || questionLower.includes('every')) {
      checks.push('⚠️ Broad scope - consider incremental approach');
    }
    
    // Complexity check
    if (question.split(' ').length > 20) {
      checks.push('⚠️ Complex request - break down into smaller decisions');
    }
    
    // Risk check
    if (questionLower.includes('production') || questionLower.includes('live')) {
      checks.push('⚠️ Production impact - test in staging first');
    }
    
    return checks;
  }
  
  /**
   * Generate a decision template
   */
  generateTemplate(decisionType: string): string {
    return `# Decision: ${decisionType}

## Context
- What is the problem?
- What constraints exist?
- Who are the stakeholders?

## Options
1. Option A: [description]
   - Pros: 
   - Cons:
   - Reversibility: Easy/Moderate/Difficult

2. Option B: [description]
   - Pros:
   - Cons:
   - Reversibility: Easy/Moderate/Difficult

## Analysis
- First Principles: What is the core need?
- Inversion: What could go wrong?
- Second-Order: What are downstream effects?

## Recommendation
[Your recommendation and reasoning]

## Rollback Plan
[How to undo if needed]`;
  }
}

// ==========================================
// SINGLETON INSTANCE
// ==========================================

let instance: PrincipledReasoning | null = null;

export function getPrincipledReasoning(): PrincipledReasoning {
  if (!instance) {
    instance = new PrincipledReasoning();
  }
  return instance;
}
