/**
 * Confidence Scoring System
 * 
 * Scores every request on 4 dimensions before acting:
 * - understanding: Do I understand what's being asked?
 * - capability: Can I actually do this?
 * - correctness: Will my approach work?
 * - safety: Is this safe to do?
 * 
 * The overall score determines action:
 * - >= 0.85: Act autonomously
 * - >= 0.70: Act with notice (state assumptions)
 * - >= 0.50: Ask first
 * - < 0.50: Refuse with explanation
 */

import { generateText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { logger } from '../../utils/logger.js';
import { trackLLMUsage } from '../cost-tracker.js';

// ==========================================
// TYPES
// ==========================================

export interface ConfidenceScore {
  understanding: number;  // 0-1: Do I understand what's being asked?
  capability: number;     // 0-1: Can I actually do this?
  correctness: number;    // 0-1: Will my approach work?
  safety: number;         // 0-1: Is this safe to do?
  overall: number;        // Geometric mean of above
}

export interface ConfidenceContext {
  hasActiveProject: boolean;
  hasRelevantMemory: boolean;
  hasMatchedPattern?: boolean;
  isDestructive: boolean;
  isAmbiguous: boolean;
  complexity: 'trivial' | 'simple' | 'moderate' | 'complex';
  domain: string;
}

export type ConfidenceAction = 'act_autonomous' | 'act_with_notice' | 'ask_first' | 'refuse';

export interface ConfidenceResult {
  score: ConfidenceScore;
  action: ConfidenceAction;
  assumptions: string[];
  concerns: string[];
  suggestedQuestions: string[];
}

// ==========================================
// THRESHOLDS
// ==========================================

export const THRESHOLDS = {
  actAutonomously: 0.85,    // Just do it
  actWithNotice: 0.70,      // Do it, but tell them what you assumed
  askFirst: 0.50,           // Too uncertain, clarify before acting
  refuse: 0.30              // This seems wrong, push back
};

// ==========================================
// CONFIDENCE ACTION TEMPLATES
// ==========================================

export interface ConfidenceActionTemplate {
  action: ConfidenceAction;
  template: string;
  requiresConfirmation: boolean;
}

/**
 * Get user-facing response template based on confidence score
 */
export function getConfidenceActionTemplate(
  score: number, 
  action?: string, 
  target?: string
): ConfidenceActionTemplate {
  if (score >= THRESHOLDS.actAutonomously) {
    return {
      action: 'act_autonomous',
      template: '', // No message needed, just execute
      requiresConfirmation: false
    };
  }
  
  if (score >= THRESHOLDS.actWithNotice) {
    const actionStr = action || 'perform this action';
    const targetStr = target ? ` on "${target}"` : '';
    return {
      action: 'act_with_notice',
      template: `I'll ${actionStr}${targetStr}. Let me know if that's not what you meant.`,
      requiresConfirmation: false
    };
  }
  
  if (score >= THRESHOLDS.askFirst) {
    const actionStr = action || 'do something';
    const targetStr = target || 'this';
    return {
      action: 'ask_first',
      template: `I think you want me to ${actionStr} "${targetStr}". Is that correct?`,
      requiresConfirmation: true
    };
  }
  
  if (score >= THRESHOLDS.refuse) {
    return {
      action: 'ask_first',
      template: `I'm not sure what you mean. Did you want to:\nA) Perform an action\nB) Ask a question\nC) Something else`,
      requiresConfirmation: true
    };
  }
  
  return {
    action: 'refuse',
    template: `I didn't understand that request. Could you rephrase it?`,
    requiresConfirmation: true
  };
}

/**
 * Generate clarification options based on parsed intent possibilities
 */
export function generateClarificationOptions(
  possibilities: Array<{ action: string; target: string; confidence: number }>
): string {
  if (possibilities.length === 0) {
    return "I didn't understand that. Could you rephrase?";
  }
  
  if (possibilities.length === 1) {
    const p = possibilities[0];
    return `Did you mean: ${p.action} "${p.target}"?`;
  }
  
  const options = possibilities
    .slice(0, 3)
    .map((p, i) => `${String.fromCharCode(65 + i)}) ${p.action} "${p.target}"`)
    .join('\n');
  
  return `I'm not sure what you meant. Did you want to:\n${options}\nD) Something else`;
}

/**
 * Format confirmation request for user
 */
export function formatConfirmationRequest(
  action: string,
  target: string,
  isDestructive: boolean = false
): string {
  if (isDestructive) {
    return `⚠️ This will ${action} "${target}". This action may be destructive. Are you sure? (yes/no)`;
  }
  
  return `I'll ${action} "${target}". Proceed? (yes/no)`;
}

// ==========================================
// PATTERNS FOR QUICK SCORING
// ==========================================

const TRIVIAL_PATTERNS = [
  /^(hi|hey|hello|status|help|cost|ping|test)$/i,
  /^(how are you|what's up|you there)$/i,
  /^(list projects|show projects)$/i,
  /\b(what can you do|your (skills|capabilities))\b/i,
  /\b(tell me (about yourself|what you think))\b/i
];

const DESTRUCTIVE_PATTERNS = [
  /\b(delete|remove|drop|truncate|destroy|erase|wipe)\b/i,
  /\b(rm -rf|rm -r|rmdir)\b/i,
  /\b(force push|reset --hard)\b/i
];

const AMBIGUOUS_PATTERNS = [
  /\b(refactor|fix|improve|update|change)\b/i,  // What specifically?
  /\b(it|this|that)\b/i,                        // Vague references
  /\b(the|some|a few)\b/i                       // Unspecified quantities
];

const COMPLEX_PATTERNS = [
  /\b(implement|build|create|develop|architect|design)\b/i,
  /\b(migrate|refactor|restructure|overhaul)\b/i,
  /\b(integrate|connect|sync|merge)\b/i,
  /\b(security|auth|payment|encryption)\b/i
];

// ==========================================
// QUICK SCORING (Pattern-based, no LLM)
// ==========================================

function analyzePatterns(message: string): ConfidenceContext {
  const lower = message.toLowerCase();
  const wordCount = message.split(/\s+/).length;
  
  return {
    hasActiveProject: false,  // Will be set by caller
    hasRelevantMemory: false, // Will be set by caller
    isDestructive: DESTRUCTIVE_PATTERNS.some(p => p.test(lower)),
    isAmbiguous: AMBIGUOUS_PATTERNS.some(p => p.test(lower)) && wordCount < 10,
    complexity: determineComplexity(message),
    domain: extractDomain(message)
  };
}

function determineComplexity(message: string): 'trivial' | 'simple' | 'moderate' | 'complex' {
  const lower = message.toLowerCase();
  const wordCount = message.split(/\s+/).length;
  
  if (TRIVIAL_PATTERNS.some(p => p.test(lower))) {
    return 'trivial';
  }
  
  if (COMPLEX_PATTERNS.some(p => p.test(lower))) {
    return 'complex';
  }
  
  if (wordCount <= 5) return 'simple';
  if (wordCount <= 15) return 'moderate';
  return 'complex';
}

function extractDomain(message: string): string {
  const lower = message.toLowerCase();
  
  const domains: Record<string, RegExp> = {
    'auth': /\b(auth|login|password|session|jwt|oauth)\b/i,
    'database': /\b(database|db|sql|table|migration|schema)\b/i,
    'api': /\b(api|endpoint|route|request|response)\b/i,
    'ui': /\b(component|ui|frontend|css|style|button|form)\b/i,
    'file': /\b(file|read|write|edit|create|delete)\b/i,
    'git': /\b(git|commit|push|pull|branch|merge)\b/i,
    'general': /.*/
  };
  
  for (const [domain, pattern] of Object.entries(domains)) {
    if (pattern.test(lower)) return domain;
  }
  
  return 'general';
}

// ==========================================
// QUICK SCORE (No LLM, pattern-based)
// ==========================================

export function quickScore(message: string, context?: Partial<ConfidenceContext>): ConfidenceResult {
  const analyzedContext = { ...analyzePatterns(message), ...context };
  
  // Start with base scores
  let understanding = 0.8;
  let capability = 0.9;
  let correctness = 0.7;
  let safety = 0.9;
  
  // Adjust based on context
  if (analyzedContext.complexity === 'trivial') {
    understanding = 1.0;
    correctness = 1.0;
  } else if (analyzedContext.complexity === 'complex') {
    understanding *= 0.7;
    correctness *= 0.6;
  }
  
  if (analyzedContext.isAmbiguous) {
    understanding *= 0.6;
    correctness *= 0.7;
  }
  
  if (analyzedContext.isDestructive) {
    safety *= 0.5;
    correctness *= 0.7;
  }
  
  if (analyzedContext.hasActiveProject) {
    understanding *= 1.1;
    capability *= 1.1;
  }
  
  if (analyzedContext.hasRelevantMemory) {
    correctness *= 1.2;
  }
  
  // Boost from matched pattern (6-layer context)
  if (analyzedContext.hasMatchedPattern) {
    correctness *= 1.15;
    capability *= 1.1;
  }
  
  // Clamp to 0-1
  understanding = Math.min(1, Math.max(0, understanding));
  capability = Math.min(1, Math.max(0, capability));
  correctness = Math.min(1, Math.max(0, correctness));
  safety = Math.min(1, Math.max(0, safety));
  
  // Geometric mean
  const overall = Math.pow(understanding * capability * correctness * safety, 0.25);
  
  const score: ConfidenceScore = { understanding, capability, correctness, safety, overall };
  const action = determineAction(overall);
  
  const assumptions: string[] = [];
  const concerns: string[] = [];
  const suggestedQuestions: string[] = [];
  
  if (analyzedContext.isAmbiguous) {
    concerns.push('Request is ambiguous');
    suggestedQuestions.push('Can you be more specific about what you want to change?');
  }
  
  if (analyzedContext.isDestructive) {
    concerns.push('This appears to be a destructive operation');
    suggestedQuestions.push('Are you sure you want to delete/remove this?');
  }
  
  return { score, action, assumptions, concerns, suggestedQuestions };
}

// ==========================================
// DEEP SCORE (LLM-based, for complex requests)
// ==========================================

export async function deepScore(
  message: string, 
  context?: Partial<ConfidenceContext>
): Promise<ConfidenceResult> {
  const analyzedContext = { ...analyzePatterns(message), ...context };
  
  // For trivial requests, use quick scoring
  if (analyzedContext.complexity === 'trivial') {
    return quickScore(message, context);
  }
  
  try {
    const anthropic = createAnthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });
    
    const prompt = `Analyze this request and score your confidence on 4 dimensions (0.0-1.0 each):

REQUEST: "${message}"

CONTEXT:
- Has active project: ${analyzedContext.hasActiveProject}
- Has relevant memory: ${analyzedContext.hasRelevantMemory}
- Appears destructive: ${analyzedContext.isDestructive}
- Appears ambiguous: ${analyzedContext.isAmbiguous}
- Complexity: ${analyzedContext.complexity}
- Domain: ${analyzedContext.domain}

Score each dimension:
1. UNDERSTANDING: How well do you understand what's being asked? (1.0 = perfectly clear, 0.0 = no idea)
2. CAPABILITY: Can you actually do this task? (1.0 = definitely, 0.0 = impossible)
3. CORRECTNESS: Will your approach work? (1.0 = certain, 0.0 = probably wrong)
4. SAFETY: Is this safe to execute? (1.0 = completely safe, 0.0 = dangerous)

Also provide:
- assumptions: List any assumptions you're making
- concerns: List any concerns about this request
- suggestedQuestions: If score is low, what would you ask for clarification?

Respond with ONLY valid JSON:
{
  "understanding": 0.0-1.0,
  "capability": 0.0-1.0,
  "correctness": 0.0-1.0,
  "safety": 0.0-1.0,
  "assumptions": ["..."],
  "concerns": ["..."],
  "suggestedQuestions": ["..."]
}`;

    const result = await generateText({
      model: anthropic('claude-3-5-haiku-20241022'),
      prompt,
      maxTokens: 300
    });
    
    // Track usage
    if (result.usage) {
      trackLLMUsage(
        'confidence_scoring',
        'claude-3-5-haiku-20241022',
        result.usage.promptTokens,
        result.usage.completionTokens,
        false
      );
    }
    
    // Parse response
    const text = result.text.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    
    if (!jsonMatch) {
      logger.warn('Failed to parse confidence score response, using quick score');
      return quickScore(message, context);
    }
    
    const parsed = JSON.parse(jsonMatch[0]);
    
    const score: ConfidenceScore = {
      understanding: Math.min(1, Math.max(0, parsed.understanding || 0.5)),
      capability: Math.min(1, Math.max(0, parsed.capability || 0.5)),
      correctness: Math.min(1, Math.max(0, parsed.correctness || 0.5)),
      safety: Math.min(1, Math.max(0, parsed.safety || 0.5)),
      overall: 0
    };
    
    // Calculate geometric mean
    score.overall = Math.pow(
      score.understanding * score.capability * score.correctness * score.safety,
      0.25
    );
    
    const action = determineAction(score.overall);
    
    logger.debug('Deep confidence score', { 
      message: message.substring(0, 50), 
      score, 
      action 
    });
    
    return {
      score,
      action,
      assumptions: parsed.assumptions || [],
      concerns: parsed.concerns || [],
      suggestedQuestions: parsed.suggestedQuestions || []
    };
    
  } catch (error) {
    logger.error('Deep scoring failed, falling back to quick score', { error: String(error) });
    return quickScore(message, context);
  }
}

// ==========================================
// ACTION DETERMINATION
// ==========================================

function determineAction(overallScore: number): ConfidenceAction {
  if (overallScore >= THRESHOLDS.actAutonomously) {
    return 'act_autonomous';
  }
  if (overallScore >= THRESHOLDS.actWithNotice) {
    return 'act_with_notice';
  }
  if (overallScore >= THRESHOLDS.askFirst) {
    return 'ask_first';
  }
  return 'refuse';
}

// ==========================================
// UTILITY FUNCTIONS
// ==========================================

export function formatConfidenceReport(result: ConfidenceResult): string {
  const { score, action, assumptions, concerns, suggestedQuestions } = result;
  
  const actionLabels: Record<ConfidenceAction, string> = {
    'act_autonomous': 'PROCEED - High confidence',
    'act_with_notice': 'PROCEED WITH NOTICE - Moderate confidence',
    'ask_first': 'ASK FIRST - Low confidence',
    'refuse': 'REFUSE - Too uncertain'
  };
  
  let report = `## Confidence Assessment

**Overall:** ${(score.overall * 100).toFixed(0)}% → ${actionLabels[action]}

| Dimension | Score |
|-----------|-------|
| Understanding | ${(score.understanding * 100).toFixed(0)}% |
| Capability | ${(score.capability * 100).toFixed(0)}% |
| Correctness | ${(score.correctness * 100).toFixed(0)}% |
| Safety | ${(score.safety * 100).toFixed(0)}% |
`;

  if (assumptions.length > 0) {
    report += `\n**Assumptions:**\n${assumptions.map(a => `- ${a}`).join('\n')}\n`;
  }
  
  if (concerns.length > 0) {
    report += `\n**Concerns:**\n${concerns.map(c => `- ${c}`).join('\n')}\n`;
  }
  
  if (suggestedQuestions.length > 0) {
    report += `\n**Clarification needed:**\n${suggestedQuestions.map(q => `- ${q}`).join('\n')}\n`;
  }
  
  return report;
}

/**
 * Determine if a request should bypass confidence scoring
 * (e.g., pattern-matched commands that are always safe)
 */
export function shouldBypassScoring(message: string): boolean {
  const lower = message.toLowerCase().trim();
  
  // Exact match patterns
  const exactBypassPatterns = [
    /^(status|help|cost|ping|list projects|apply|reject|yes|no)$/i,
    /^use (haiku|sonnet|opus|auto)$/i,
    /^compact$/i,
    /^clear\s+(?:conversation\s+)?history$/i,
    // Project loading commands - always safe (allow hyphens, underscores, dots in project names)
    /^(?:open|load|start|switch to|go to|work on)\s+[\w\-_.]+$/i,
    // Project creation commands - always safe
    /^(?:create|new|init|bootstrap|scaffold)\s+(?:a\s+)?(?:new\s+)?(?:project\s+)?\w+/i,
    // Plan/PRD approval patterns - always safe
    /^(?:yes|yep|yeah|go|go ahead|do it|proceed|execute|run it|approved?|confirm|ok|okay|sure|let'?s?\s*go|lgtm|looks good|start building)$/i,
    // PRD/Phase continuation commands - always safe
    /^(?:continue|next|keep going|go on|proceed|next phase|carry on|resume)$/i,
    // Continue building project - always safe
    /^(?:continue(?: the)?(?: (?:project|building|build|work))?|keep building|finish(?: the)?(?: (?:project|it|build))?|just build(?: it)?|build it|build to completion|finish building|complete the build|build everything)$/i,
    // Apply last response - always safe
    /^(?:apply (?:that|this|last|it|the code|response)|use (?:that|this) code|save (?:that|it))$/i
  ];
  
  if (exactBypassPatterns.some(p => p.test(lower))) {
    return true;
  }
  
  // Conversational/introspection patterns - questions about Jeeves itself
  const conversationalPatterns = [
    /\b(what can you|what do you|tell me about yourself|your (skills|capabilities|features))\b/i,
    /\b(how are you|what's new|what did you learn)\b/i,
    /\b(take a look at|check out|review) (your|the new)\b/i,
    /\b(new (skills|capabilities|features))\b/i,
    /\b(what do you think|how do you feel)\b/i,
    /\bhey|hi|hello|greetings\b/i,
    /\b(thanks|thank you|great job|good work|nice)\b/i,
    // Simple status questions - always safe
    /^is it (built|done|ready|finished|complete|working)\??$/i,
    /^(are|is) (we|it|that) (done|ready|finished)\??$/i,
    /^(what'?s|what is) the (status|progress)\??$/i,
    /^how('?s| is) it (going|looking)\??$/i,
    /^did (it|that|you) (work|finish|complete)\??$/i
  ];
  
  if (conversationalPatterns.some(p => p.test(lower))) {
    return true;
  }
  
  return false;
}
