/**
 * Intent Classifier
 * 
 * Two-stage parsing: classify intent first (cheap Haiku), then execute.
 * Categories: command, question, prd, feedback, unclear
 * 
 * This runs BEFORE pattern matching for complex messages to prevent
 * misinterpretation of natural language as terminal commands.
 */

import { generateText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { logger } from '../utils/logger.js';
import { trackLLMUsage } from './cost-tracker.js';

// ==========================================
// TYPES
// ==========================================

export type IntentCategory = 'command' | 'question' | 'prd' | 'feedback' | 'unclear';

export interface ClassifiedIntent {
  category: IntentCategory;
  action: string;
  target: string;
  parameters: string[];
  confidence: number;
  isNegation: boolean;
  isReference: boolean;
  referenceTarget?: string;
}

export interface ClassificationResult {
  intent: ClassifiedIntent;
  raw: string;
  cost: number;
}

// ==========================================
// CLASSIFICATION PROMPT
// ==========================================

const CLASSIFICATION_PROMPT = `Classify this message. Return valid JSON only.

MESSAGE: "{input}"

CATEGORIES:
- command: User wants action taken (open, run, build, deploy, fix, check, create)
- question: User wants information (how, what, why, explain, describe)
- prd: User is providing a spec/requirements (build me, create, implement this, MVP, requirements)
- feedback: User is correcting or commenting (no, wrong, actually, instead, not that)
- unclear: Cannot determine intent

EXTRACT:
- action: The verb (open, build, explain, fix, check, deploy, etc.)
- target: The object (project name, file, concept, feature name)
- parameters: Any modifiers as array (urgent, simple, like X, with Y)
- confidence: 0.0-1.0 based on clarity
- isNegation: true if "don't", "stop", "cancel", "never" present
- isReference: true if "like X" pattern (comparing to something)
- referenceTarget: If isReference, what they're comparing to

DISAMBIGUATION RULES:
- "can you X" = command to do X (confidence 0.9)
- "could you X" = command to do X (confidence 0.9)
- "don't X" = command with isNegation=true
- "like the X" = reference, NOT action on X
- "this is wrong" = feedback
- "it/this/that" with action = command referring to previous item

RESPOND WITH JSON ONLY:
{"category":"","action":"","target":"","parameters":[],"confidence":0.0,"isNegation":false,"isReference":false,"referenceTarget":""}`;

// ==========================================
// CLASSIFIER
// ==========================================

const anthropic = createAnthropic();

/**
 * Classify user intent using Haiku (fast, cheap ~$0.0001)
 */
export async function classifyIntent(message: string): Promise<ClassificationResult> {
  const startTime = Date.now();
  
  try {
    const prompt = CLASSIFICATION_PROMPT.replace('{input}', message.replace(/"/g, '\\"'));
    
    const { text, usage } = await generateText({
      model: anthropic('claude-3-5-haiku-latest'),
      prompt,
      maxTokens: 200,
      temperature: 0
    });
    
    // Track cost
    const cost = trackLLMUsage(
      'classification',
      usage?.promptTokens || 0,
      usage?.completionTokens || 0,
      'claude-3-5-haiku-latest'
    );
    
    // Parse JSON response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn('Classifier returned non-JSON response', { text });
      return {
        intent: getDefaultIntent(),
        raw: text,
        cost
      };
    }
    
    const parsed = JSON.parse(jsonMatch[0]) as Partial<ClassifiedIntent>;
    
    const intent: ClassifiedIntent = {
      category: (parsed.category as IntentCategory) || 'unclear',
      action: parsed.action || '',
      target: parsed.target || '',
      parameters: Array.isArray(parsed.parameters) ? parsed.parameters : [],
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
      isNegation: parsed.isNegation || false,
      isReference: parsed.isReference || false,
      referenceTarget: parsed.referenceTarget
    };
    
    logger.debug('Classified intent', {
      category: intent.category,
      action: intent.action,
      confidence: intent.confidence,
      durationMs: Date.now() - startTime
    });
    
    return { intent, raw: text, cost };
    
  } catch (error) {
    logger.error('Classification failed', { error, message });
    return {
      intent: getDefaultIntent(),
      raw: '',
      cost: 0
    };
  }
}

/**
 * Quick classification using patterns only (FREE, no LLM)
 * For simple commands that don't need LLM classification
 */
export function quickClassify(message: string): ClassifiedIntent | null {
  const lower = message.toLowerCase().trim();
  
  // PRD detection - long messages with spec keywords
  if (message.length > 200 && /\b(requirements?|mvp|spec|features?|implement|build me)\b/i.test(message)) {
    return {
      category: 'prd',
      action: 'submit',
      target: 'prd',
      parameters: [],
      confidence: 0.9,
      isNegation: false,
      isReference: false
    };
  }
  
  // Feedback patterns
  if (/^(no|wrong|actually|not that|instead|that'?s not)/i.test(lower)) {
    return {
      category: 'feedback',
      action: 'correction',
      target: '',
      parameters: [],
      confidence: 0.85,
      isNegation: false,
      isReference: false
    };
  }
  
  // Question patterns
  if (/^(what|how|why|where|when|who|explain|describe|tell me about)\s/i.test(lower)) {
    const match = lower.match(/^(what|how|why|where|when|who|explain|describe|tell me about)\s+(.+)/i);
    return {
      category: 'question',
      action: match?.[1] || 'explain',
      target: match?.[2] || '',
      parameters: [],
      confidence: 0.85,
      isNegation: false,
      isReference: false
    };
  }
  
  // Command patterns - "can you X"
  const canYouMatch = lower.match(/^(can|could|would) you\s+(\w+)\s*(.*)/i);
  if (canYouMatch) {
    return {
      category: 'command',
      action: canYouMatch[2],
      target: canYouMatch[3] || '',
      parameters: [],
      confidence: 0.9,
      isNegation: false,
      isReference: false
    };
  }
  
  // Negation patterns
  if (/^(don'?t|do not|stop|cancel|abort|never)\s/i.test(lower)) {
    const match = lower.match(/^(don'?t|do not|stop|cancel|abort|never)\s+(.+)/i);
    return {
      category: 'command',
      action: 'stop',
      target: match?.[2] || '',
      parameters: [],
      confidence: 0.9,
      isNegation: true,
      isReference: false
    };
  }
  
  // Not enough confidence to classify without LLM
  return null;
}

/**
 * Get default intent for error cases
 */
function getDefaultIntent(): ClassifiedIntent {
  return {
    category: 'unclear',
    action: '',
    target: '',
    parameters: [],
    confidence: 0,
    isNegation: false,
    isReference: false
  };
}

/**
 * Should we use LLM classification for this message?
 * Returns true for complex messages that need LLM understanding
 */
export function needsLLMClassification(message: string): boolean {
  // Short messages can use pattern matching
  if (message.length < 50) {
    return false;
  }
  
  // PRDs and long specs need classification
  if (message.length > 200) {
    return true;
  }
  
  // Complex sentences with multiple clauses
  if ((message.match(/,/g) || []).length >= 2) {
    return true;
  }
  
  // Contains markdown or code blocks
  if (/```|##|^\s*-\s/m.test(message)) {
    return true;
  }
  
  // Ambiguous phrases that need context
  if (/\b(like|similar to|same as|instead of|rather than)\b/i.test(message)) {
    return true;
  }
  
  return false;
}
