/**
 * Clarification Manager (3-Question Rule)
 * 
 * Intelligent question filtering:
 * - CRITICAL: Must ask (destructive ops, security, conflicts)
 * - IMPORTANT: Should ask (multiple approaches, scope ambiguity)
 * - MINOR: Can assume (established patterns)
 * - TRIVIAL: Never ask (figure it out)
 * 
 * Max 3 questions per clarification. If more needed, ask 1 meta-question.
 */

import { generateText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { logger } from '../../utils/logger.js';
import { trackLLMUsage } from '../cost-tracker.js';

// ==========================================
// TYPES
// ==========================================

export type QuestionPriority = 'critical' | 'important' | 'minor' | 'trivial';

export interface ClarificationQuestion {
  question: string;
  priority: QuestionPriority;
  context: string;
  defaultAnswer?: string;
}

export interface ClarificationResult {
  needsClarification: boolean;
  questions: ClarificationQuestion[];
  assumptions: string[];
  metaQuestion?: string;  // If too many questions, ask this instead
}

export interface ClarificationContext {
  message: string;
  understanding: string;
  concerns: string[];
  suggestedQuestions: string[];
  hasActiveProject: boolean;
  relevantMemories: string[];
}

// ==========================================
// PRIORITY DEFINITIONS
// ==========================================

const PRIORITY_TRIGGERS: Record<QuestionPriority, RegExp[]> = {
  critical: [
    // Destructive operations with ambiguous scope
    /\b(delete|remove|drop|truncate|destroy|erase|wipe)\s+(all|everything|the)\b/i,
    // Security-sensitive changes without clear requirements
    /\b(auth|password|secret|token|key|credential)\b.*\b(change|update|modify)\b/i,
    /\b(permission|role|access)\s+(change|modify|update)\b/i,
    // Production/deployment
    /\b(deploy|production|prod|live)\b/i
  ],
  important: [
    // Multiple valid approaches
    /\b(refactor|restructure|reorganize|redesign)\b/i,
    // Scope ambiguity
    /\b(some|a few|several|multiple|various)\b/i,
    // Integration points
    /\b(integrate|connect|sync|merge)\s+with\b/i,
    // Database changes
    /\b(migration|schema|table)\s+(change|update|modify)\b/i
  ],
  minor: [
    // Style preferences
    /\b(style|format|naming|convention)\b/i,
    // File organization
    /\b(organize|structure|layout)\b/i,
    // Error handling
    /\b(error|exception|catch)\b/i
  ],
  trivial: [
    // Basic implementation
    /\b(add|create|make|build)\s+a?\s*(simple|basic)?\s*(function|component|file)\b/i,
    // Standard patterns
    /\b(crud|rest|api)\b/i
  ]
};

// ==========================================
// QUESTION TEMPLATES
// ==========================================

const QUESTION_TEMPLATES: Record<string, string[]> = {
  destructive: [
    'This will delete/remove data. Which specific items should be affected?',
    'Are you sure you want to delete this? This action may not be reversible.',
    'Should I create a backup before making this change?'
  ],
  scope: [
    'Could you be more specific about which files/components this should affect?',
    'Should this apply to all instances, or just specific ones?',
    'What\'s the boundary of this change?'
  ],
  approach: [
    'There are multiple ways to do this. Would you prefer X or Y?',
    'Should I prioritize speed, maintainability, or flexibility?',
    'Do you have a preference for the implementation approach?'
  ],
  integration: [
    'How should this interact with the existing system?',
    'Should this replace the existing implementation or work alongside it?',
    'What data/state needs to be shared between systems?'
  ],
  auth: [
    'What authentication method should be used?',
    'Who should have access to this functionality?',
    'How should unauthorized access be handled?'
  ]
};

// ==========================================
// MAIN FUNCTIONS
// ==========================================

/**
 * Analyze a request and determine what clarifications are needed
 */
export async function analyzeClarificationNeeds(
  context: ClarificationContext
): Promise<ClarificationResult> {
  const { message, concerns, suggestedQuestions = [] } = context;
  
  // Collect potential questions
  const allQuestions: ClarificationQuestion[] = [];
  
  // 1. Add suggested questions from confidence scoring
  const questions = Array.isArray(suggestedQuestions) ? suggestedQuestions : [];
  for (const q of questions) {
    const priority = determinePriority(q, message);
    allQuestions.push({
      question: q,
      priority,
      context: 'From confidence assessment'
    });
  }
  
  // 2. Check pattern triggers
  const patternQuestions = checkPatternTriggers(message);
  allQuestions.push(...patternQuestions);
  
  // 3. Check for ambiguity
  const ambiguityQuestions = checkAmbiguity(message);
  allQuestions.push(...ambiguityQuestions);
  
  // Sort by priority
  const sorted = sortByPriority(allQuestions);
  
  // Filter to unique questions
  const unique = deduplicateQuestions(sorted);
  
  // Apply 3-question rule
  return apply3QuestionRule(unique, context);
}

/**
 * Generate clarifying questions using LLM for complex cases
 * NOTE: LLM call disabled due to consistent failures - using heuristics directly
 * This saves API calls and latency while still providing good results
 */
export async function generateSmartQuestions(
  context: ClarificationContext
): Promise<ClarificationResult> {
  // Skip LLM call - heuristics work well enough and are faster
  // The LLM call was failing consistently ("other side closed" errors)
  return analyzeClarificationNeeds(context);
  
  /* DISABLED - LLM-based question generation
  try {
    const anthropic = createAnthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });*/
    
    const prompt = `Analyze this request and determine what clarifications are needed.

REQUEST: "${context.message}"

UNDERSTANDING: ${context.understanding}
CONCERNS: ${context.concerns.join(', ') || 'None'}
HAS PROJECT: ${context.hasActiveProject}
${context.relevantMemories.length > 0 ? `MEMORIES: ${context.relevantMemories.join('; ')}` : ''}

Categorize needed clarifications:
- CRITICAL: Cannot proceed safely without answer
- IMPORTANT: Better results with answer, but can make reasonable assumption
- MINOR: Can assume based on patterns
- TRIVIAL: Figure it out yourself

Rules:
1. Maximum 3 questions total
2. If more than 3 are critical, ask ONE meta-question instead
3. For MINOR/TRIVIAL, don't ask - state the assumption

Respond with ONLY JSON:
{
  "questions": [
    {"question": "...", "priority": "critical|important|minor|trivial", "context": "why this matters"}
  ],
  "assumptions": ["For X, I'll assume Y because Z"],
  "needsMetaQuestion": false,
  "metaQuestion": null
}`;

    const result = await generateText({
      model: anthropic('claude-3-5-haiku-20241022'),
      prompt,
      maxTokens: 350
    });
    
    if (result.usage) {
      trackLLMUsage('clarification', 'claude-3-5-haiku-20241022',
        result.usage.promptTokens, result.usage.completionTokens, false);
    }
    
    const parsed = JSON.parse(result.text.match(/\{[\s\S]*\}/)?.[0] || '{}');
    
    const questions: ClarificationQuestion[] = (parsed.questions || [])
      .filter((q: { priority: string }) => q.priority === 'critical' || q.priority === 'important')
      .slice(0, 3)
      .map((q: { question: string; priority: string; context: string }) => ({
        question: q.question,
        priority: q.priority as QuestionPriority,
        context: q.context
      }));
    
    return {
      needsClarification: questions.length > 0 || parsed.needsMetaQuestion,
      questions,
      assumptions: parsed.assumptions || [],
      metaQuestion: parsed.needsMetaQuestion ? parsed.metaQuestion : undefined
    };
    
  /* DISABLED - catch block for LLM-based generation
  } catch (error) {
    logger.warn('Smart question generation failed, using heuristics', { error: String(error) });
    return analyzeClarificationNeeds(context);
  }
  */
}

// ==========================================
// HELPER FUNCTIONS
// ==========================================

function determinePriority(question: string, message: string): QuestionPriority {
  const combined = `${question} ${message}`.toLowerCase();
  
  for (const [priority, patterns] of Object.entries(PRIORITY_TRIGGERS)) {
    if (patterns.some(p => p.test(combined))) {
      return priority as QuestionPriority;
    }
  }
  
  return 'minor';
}

function checkPatternTriggers(message: string): ClarificationQuestion[] {
  const questions: ClarificationQuestion[] = [];
  const lower = message.toLowerCase();
  
  // Check for destructive operations
  if (/\b(delete|remove|drop|truncate)\b/i.test(lower)) {
    if (!/\b(specific|this|the)\s+\w+\s+(file|item|record)\b/i.test(lower)) {
      questions.push({
        question: QUESTION_TEMPLATES.destructive[0],
        priority: 'critical',
        context: 'Destructive operation without clear scope'
      });
    }
  }
  
  // Check for auth changes
  if (/\b(auth|login|password|permission)\b/i.test(lower)) {
    if (/\b(change|update|modify)\b/i.test(lower)) {
      questions.push({
        question: QUESTION_TEMPLATES.auth[0],
        priority: 'important',
        context: 'Authentication change needs clear requirements'
      });
    }
  }
  
  // Check for integration
  if (/\b(integrate|connect)\b/i.test(lower)) {
    questions.push({
      question: QUESTION_TEMPLATES.integration[0],
      priority: 'important',
      context: 'Integration requires understanding of interaction points'
    });
  }
  
  return questions;
}

function checkAmbiguity(message: string): ClarificationQuestion[] {
  const questions: ClarificationQuestion[] = [];
  const words = message.split(/\s+/);
  
  // Very short messages are often ambiguous
  if (words.length <= 3) {
    questions.push({
      question: 'Could you provide more details about what you want to accomplish?',
      priority: 'important',
      context: 'Request is very brief'
    });
  }
  
  // Check for vague references
  const vaguePatterns = [
    /\bfix (it|this|that)\b/i,
    /\bchange (it|this|that)\b/i,
    /\bupdate (it|this|that)\b/i
  ];
  
  if (vaguePatterns.some(p => p.test(message))) {
    questions.push({
      question: 'What specifically should I fix/change/update?',
      priority: 'important',
      context: 'Vague reference without clear target'
    });
  }
  
  return questions;
}

function sortByPriority(questions: ClarificationQuestion[]): ClarificationQuestion[] {
  const priorityOrder: Record<QuestionPriority, number> = {
    critical: 0,
    important: 1,
    minor: 2,
    trivial: 3
  };
  
  return [...questions].sort((a, b) => 
    priorityOrder[a.priority] - priorityOrder[b.priority]
  );
}

function deduplicateQuestions(questions: ClarificationQuestion[]): ClarificationQuestion[] {
  const seen = new Set<string>();
  return questions.filter(q => {
    const key = q.question.toLowerCase().substring(0, 50);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function apply3QuestionRule(
  questions: ClarificationQuestion[],
  context: ClarificationContext
): ClarificationResult {
  // Filter to only critical and important
  const significant = questions.filter(q => 
    q.priority === 'critical' || q.priority === 'important'
  );
  
  // Extract assumptions from minor/trivial
  const assumptions = questions
    .filter(q => q.priority === 'minor' || q.priority === 'trivial')
    .map(q => `For "${q.context}", I'll proceed with default behavior`);
  
  // If more than 3 critical questions, we need a meta-question
  const critical = significant.filter(q => q.priority === 'critical');
  
  if (critical.length > 3) {
    return {
      needsClarification: true,
      questions: [],
      assumptions,
      metaQuestion: generateMetaQuestion(context)
    };
  }
  
  // Return top 3 questions
  return {
    needsClarification: significant.length > 0,
    questions: significant.slice(0, 3),
    assumptions
  };
}

function generateMetaQuestion(context: ClarificationContext): string {
  return `This is a complex request and I have several questions. ` +
    `Can you walk me through the most important requirement first? ` +
    `I'll ask more specific questions once I understand the core goal.`;
}

// ==========================================
// FORMATTING
// ==========================================

export function formatClarificationRequest(result: ClarificationResult): string {
  if (!result.needsClarification) {
    return '';
  }
  
  let output = '';
  
  if (result.metaQuestion) {
    output = result.metaQuestion;
  } else {
    const questionCount = result.questions.length;
    
    if (questionCount === 1) {
      output = `Before I proceed, one question:\n\n${result.questions[0].question}`;
    } else {
      output = `Before I proceed, ${questionCount} questions:\n\n`;
      output += result.questions
        .map((q, i) => `${i + 1}. ${q.question}`)
        .join('\n');
    }
  }
  
  if (result.assumptions.length > 0) {
    output += `\n\nI'll assume:\n${result.assumptions.map(a => `- ${a}`).join('\n')}`;
  }
  
  return output;
}

/**
 * Check if a response answers the clarification questions
 */
export function didAnswerQuestions(
  response: string, 
  questions: ClarificationQuestion[]
): boolean {
  // Simple heuristic: if response is longer than 10 chars and not just "ok/yes/no"
  const trimmed = response.trim().toLowerCase();
  
  if (trimmed.length < 10) {
    return /^(yes|no|ok|okay|sure|yep|nope|correct|right)$/i.test(trimmed);
  }
  
  return true;  // Assume longer responses are answers
}
