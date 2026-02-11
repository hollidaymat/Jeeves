/**
 * Disambiguation Rules
 * 
 * Handle known misinterpretation patterns BEFORE classifier.
 * Transform ambiguous patterns to structured intents.
 */

import type { ClassifiedIntent, IntentCategory } from './classifier.js';

// ==========================================
// TYPES
// ==========================================

interface DisambiguationRule {
  name: string;
  pattern: RegExp;
  transform: (match: RegExpMatchArray) => Partial<ClassifiedIntent>;
  priority: number;  // Higher = checked first
}

// ==========================================
// DISAMBIGUATION RULES
// ==========================================

const DISAMBIGUATION_RULES: DisambiguationRule[] = [
  // "can you X" / "could you X" / "would you X" = command to do X
  {
    name: 'polite_command',
    pattern: /^(can|could|would|will) you\s+(\w+)\s*(.*?)\.?$/i,
    transform: (match) => ({
      category: 'command' as IntentCategory,
      action: match[2].toLowerCase(),
      target: match[3].trim(),
      confidence: 0.9,
      isNegation: false
    }),
    priority: 100
  },
  
  // "please X" = command to do X
  {
    name: 'please_command',
    pattern: /^please\s+(\w+)\s*(.*?)\.?$/i,
    transform: (match) => ({
      category: 'command' as IntentCategory,
      action: match[1].toLowerCase(),
      target: match[2].trim(),
      confidence: 0.9,
      isNegation: false
    }),
    priority: 95
  },
  
  // "don't X" / "do not X" / "stop X" = negation command
  {
    name: 'negation_command',
    pattern: /^(don'?t|do not|stop|cancel|abort|never)\s+(\w+)\s*(.*?)\.?$/i,
    transform: (match) => ({
      category: 'command' as IntentCategory,
      action: 'stop',
      target: `${match[2]} ${match[3]}`.trim(),
      confidence: 0.95,
      isNegation: true
    }),
    priority: 110
  },
  
  // "this is wrong" / "that's wrong" / "it's broken" = feedback
  {
    name: 'feedback_this_wrong',
    pattern: /^(this|that|it)\s+(is|was|looks)\s+(wrong|bad|broken|incorrect|not right)/i,
    transform: () => ({
      category: 'feedback' as IntentCategory,
      action: 'correction',
      confidence: 0.9,
      isNegation: false
    }),
    priority: 105
  },
  
  // "no, X" / "actually X" / "instead X" = feedback/correction
  {
    name: 'feedback_correction',
    pattern: /^(no,?\s*|actually,?\s*|instead,?\s*|not that,?\s*|wait,?\s*)(.+)$/i,
    transform: (match) => ({
      category: 'feedback' as IntentCategory,
      action: 'correction',
      target: match[2].trim(),
      confidence: 0.85,
      isNegation: false
    }),
    priority: 100
  },
  
  // "like the X" / "similar to X" = reference, NOT action
  {
    name: 'reference_like',
    pattern: /\blike\s+(the\s+)?(\w+(?:\s+\w+)?)/i,
    transform: (match) => ({
      isReference: true,
      referenceTarget: match[2],
      confidence: 0.8
    }),
    priority: 90
  },
  
  // "what about X" = often means "also do X" or "consider X"
  {
    name: 'what_about',
    pattern: /^what about\s+(.+?)\??$/i,
    transform: (match) => ({
      category: 'command' as IntentCategory,
      action: 'consider',
      target: match[1].trim(),
      confidence: 0.7  // Lower confidence - context dependent
    }),
    priority: 80
  },
  
  // REMOVED: approval_yes - was routing "yes"/"go ahead" to prd_approve even when no plan.
  // Now "yes" falls through to handleSimpleCommand which checks getActivePlan/getPendingPlan first.

  // "build me X" / "create X for me" / "I need X" = PRD
  // Note: "create project" is handled by handleSimpleCommand, so exclude it
  {
    name: 'prd_build_request',
    pattern: /^(build me|create|make me|i need|implement)\s+(?!(?:a\s+)?(?:new\s+)?project\b)(a|an|the)?\s*(.+)/i,
    transform: (match) => ({
      category: 'prd' as IntentCategory,
      action: 'build',
      target: match[3].trim(),
      confidence: 0.85
    }),
    priority: 85
  }
];

// Sort by priority (descending)
DISAMBIGUATION_RULES.sort((a, b) => b.priority - a.priority);

// ==========================================
// DISAMBIGUATION FUNCTIONS
// ==========================================

/**
 * Apply disambiguation rules to a message
 * Returns partial intent if a rule matches, null otherwise
 */
export function applyDisambiguation(message: string): Partial<ClassifiedIntent> | null {
  const trimmed = message.trim();
  
  for (const rule of DISAMBIGUATION_RULES) {
    const match = trimmed.match(rule.pattern);
    if (match) {
      const result = rule.transform(match);
      return result;
    }
  }
  
  return null;
}

/**
 * Check if message has ambiguous patterns that need disambiguation
 */
export function hasAmbiguousPattern(message: string): boolean {
  const ambiguousPatterns = [
    /\blike\s+(the\s+)?\w+/i,           // "like X" - reference or command?
    /^what about\b/i,                    // Context dependent
    /\bit\b.*\b(is|was|should|could)/i,  // "it" needs resolution
    /^(this|that)\s+/i                   // Pronoun at start
  ];
  
  return ambiguousPatterns.some(p => p.test(message));
}

/**
 * Get disambiguation suggestions for ambiguous message
 */
export function getDisambiguationOptions(message: string): string[] {
  const options: string[] = [];
  const lower = message.toLowerCase();
  
  if (/\blike\s+(the\s+)?\w+/i.test(message)) {
    const match = message.match(/like\s+(the\s+)?(\w+)/i);
    if (match) {
      options.push(`Make it similar to ${match[2]}`);
      options.push(`Open/show ${match[2]}`);
    }
  }
  
  if (/^what about\b/i.test(message)) {
    const target = message.replace(/^what about\s*/i, '').replace(/\?$/, '');
    options.push(`Also apply this to ${target}`);
    options.push(`Tell me about ${target}`);
  }
  
  if (/\bit\b/i.test(lower)) {
    options.push('Clarify: what does "it" refer to?');
  }
  
  return options;
}

/**
 * Merge disambiguation result with existing intent
 */
export function mergeWithIntent(
  base: ClassifiedIntent,
  disambiguation: Partial<ClassifiedIntent>
): ClassifiedIntent {
  return {
    ...base,
    ...disambiguation,
    // Preserve arrays rather than replacing
    parameters: [
      ...base.parameters,
      ...(disambiguation.parameters || [])
    ]
  };
}
