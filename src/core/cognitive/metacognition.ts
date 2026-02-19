/**
 * Metacognition - The Thinking About Thinking Layer
 * 
 * This is the master cognitive orchestrator that:
 * 1. Monitors confidence levels before acting
 * 2. Runs pre-execution reasoning (OODA)
 * 3. Manages clarification when needed
 * 4. Simulates impact before execution
 * 5. Decides whether to proceed or pause
 * 
 * The metacognition layer wraps around normal execution to make
 * Jeeves smarter about when to act vs when to ask.
 */

import { logger } from '../../utils/logger.js';
import * as Confidence from './confidence.js';
import * as Reasoning from './reasoning.js';
import * as Clarification from './clarification.js';
import * as Simulation from './simulation.js';
import { assembleContext, formatContextForPrompt, type ContextResult } from '../context/index.js';

// ==========================================
// TYPES
// ==========================================

export interface MetacognitiveInput {
  message: string;
  sender: string;
  context?: {
    projectPath?: string;
    previousMessages?: string[];
    sessionHistory?: string[];
    activeTask?: string;
    action?: string;
    target?: string;
  };
}

export interface MetacognitiveDecision {
  action: 'proceed' | 'clarify' | 'notice' | 'refuse';
  confidence: Confidence.ConfidenceScore;
  reasoning?: Reasoning.ReasoningResult;
  clarification?: Clarification.ClarificationResult;
  simulation?: Simulation.SimulationResult;
  contextResult?: ContextResult;
  
  // What to do
  response?: string;
  plan?: Reasoning.ReasoningPlan;
  questions?: Clarification.ClarificationQuestion[];
  
  // Metadata
  processingTime: number;
  tokensUsed: number;
  bypassedScoring: boolean;
}

export interface MetacognitiveConfig {
  enableDeepScoring: boolean;
  enableSimulation: boolean;
  confidenceThreshold: number;
  maxClarificationQuestions: number;
}

// ==========================================
// DEFAULT CONFIG
// ==========================================

const DEFAULT_CONFIG: MetacognitiveConfig = {
  enableDeepScoring: true,
  enableSimulation: true,
  confidenceThreshold: 0.7,
  maxClarificationQuestions: 3
};

// ==========================================
// MAIN METACOGNITIVE PROCESS
// ==========================================

/**
 * The main metacognitive process - "thinking about thinking"
 * 
 * Flow:
 * 1. Quick bypass check for trivial messages
 * 2. Confidence scoring (quick or deep)
 * 3. If uncertain, run OODA reasoning
 * 4. If needs clarification, generate smart questions
 * 5. If proceeding, optionally simulate impact
 * 6. Return decision with full context
 */
export async function think(
  input: MetacognitiveInput,
  config: Partial<MetacognitiveConfig> = {}
): Promise<MetacognitiveDecision> {
  const startTime = Date.now();
  let tokensUsed = 0;

  try {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const { message, sender, context } = input;
  
  logger.debug('Metacognition starting', { 
    messageLength: message.length,
    sender 
  });
  
  // ==========================================
  // STEP 1: BYPASS CHECK
  // ==========================================
  
  if (Confidence.shouldBypassScoring(message)) {
    logger.debug('Bypassing cognitive processing (trivial message)');
    
    return {
      action: 'proceed',
      confidence: {
        understanding: 1.0,
        capability: 1.0,
        correctness: 1.0,
        safety: 1.0,
        overall: 1.0
      },
      response: undefined,  // Let normal execution handle it
      processingTime: Date.now() - startTime,
      tokensUsed: 0,
      bypassedScoring: true
    };
  }
  
  // ==========================================
  // STEP 1.5: 6-LAYER CONTEXT ASSEMBLY
  // ==========================================
  
  let contextResult: ContextResult | undefined;
  try {
    contextResult = await assembleContext({
      message,
      action: context?.action,
      target: context?.target,
      projectPath: context?.projectPath,
      model: 'haiku' // metacognition uses Haiku; Sonnet used in agent_ask path
    });
    
    if (contextResult.layersIncluded.length > 0) {
      logger.debug('Context assembled for metacognition', {
        layers: contextResult.layersIncluded,
        tokens: contextResult.tokensUsed
      });
    }
  } catch (error) {
    logger.debug('Context assembly skipped', { error: String(error) });
  }
  
  // ==========================================
  // STEP 2: CONFIDENCE SCORING
  // ==========================================
  
  let confidenceResult: Confidence.ConfidenceResult;
  
  const confidenceContext: Partial<Confidence.ConfidenceContext> = {
    hasActiveProject: !!context?.projectPath,
    hasRelevantMemory: (context?.previousMessages?.length || 0) > 0 ||
      (contextResult?.layers.learnings?.length || 0) > 0,
    hasMatchedPattern: !!contextResult?.layers.pattern
  };
  
  if (cfg.enableDeepScoring && !isSimpleRequest(message)) {
    confidenceResult = await Confidence.deepScore(message, confidenceContext);
  } else {
    confidenceResult = Confidence.quickScore(message, confidenceContext);
  }
  
  logger.debug('Confidence scored', { 
    action: confidenceResult.action,
    overall: confidenceResult.score.overall
  });
  
  // ==========================================
  // STEP 3: HANDLE REFUSE ACTION (BE PERMISSIVE)
  // ==========================================
  
  // Only refuse if actually dangerous - check for destructive patterns
  const isDangerous = /\b(rm\s+-rf|force\s+push|drop\s+(table|database)|delete\s+all|format\s+(c:|drive)|truncate)\b/i.test(message);
  
  if (confidenceResult.action === 'refuse' && isDangerous) {
    return {
      action: 'refuse',
      confidence: confidenceResult.score,
      response: confidenceResult.concerns.join('. ') || 'This appears to be a destructive operation. Please confirm.',
      processingTime: Date.now() - startTime,
      tokensUsed,
      bypassedScoring: false
    };
  }
  
  // If confidence said refuse but it's not dangerous, proceed anyway
  if (confidenceResult.action === 'refuse') {
    logger.debug('Confidence wanted to refuse but proceeding (not dangerous)', { 
      message: message.substring(0, 50),
      safety: confidenceResult.score.safety 
    });
    // Don't refuse, fall through to proceed
  }
  
  // ==========================================
  // STEP 4: OODA REASONING (if needed)
  // ==========================================
  
  let reasoningResult: Reasoning.ReasoningResult | undefined;
  
  // Run full reasoning if:
  // - Confidence is below threshold
  // - Action suggests we need to ask first
  // - Request seems complex
  const needsReasoning = 
    confidenceResult.score.overall < cfg.confidenceThreshold ||
    confidenceResult.action === 'ask_first' ||
    isComplexRequest(message);
  
  if (needsReasoning) {
    logger.debug('Running OODA reasoning');
    
    reasoningResult = await Reasoning.reason({
      message,
      hasActiveProject: !!context?.projectPath,
      projectPath: context?.projectPath,
      hasRelevantMemory: (context?.previousMessages?.length || 0) > 0,
      relevantMemories: context?.previousMessages
    });
    
    // If reasoning says we should ask
    if (reasoningResult.shouldAsk && reasoningResult.questions && reasoningResult.questions.length > 0) {
      return {
        action: 'clarify',
        confidence: confidenceResult.score,
        reasoning: reasoningResult,
        questions: reasoningResult.questions.map((q: string, i: number) => ({
          question: q,
          priority: 'critical' as Clarification.QuestionPriority,
          context: 'Identified during OODA reasoning'
        })),
        response: formatClarificationMessage(reasoningResult.questions),
        processingTime: Date.now() - startTime,
        tokensUsed,
        bypassedScoring: false
      };
    }
  }
  
  // ==========================================
  // STEP 5: CLARIFICATION (if low understanding)
  // ==========================================
  
  let clarificationResult: Clarification.ClarificationResult | undefined;
  
  if (confidenceResult.score.understanding < 0.6) {
    logger.debug('Low understanding - generating clarifications');
    
    clarificationResult = await Clarification.generateSmartQuestions({
      message,
      understanding: reasoningResult?.understanding || message,
      concerns: confidenceResult.concerns || [],
      suggestedQuestions: confidenceResult.suggestedQuestions || [],
      hasActiveProject: !!context?.projectPath,
      relevantMemories: context?.previousMessages || []
    });
    
    if (clarificationResult.questions.length > 0) {
      return {
        action: 'clarify',
        confidence: confidenceResult.score,
        reasoning: reasoningResult,
        clarification: clarificationResult,
        questions: clarificationResult.questions,
        response: clarificationResult.metaQuestion || formatClarificationMessage(
          clarificationResult.questions.map(q => q.question)
        ),
        processingTime: Date.now() - startTime,
        tokensUsed,
        bypassedScoring: false
      };
    }
  }
  
  // ==========================================
  // STEP 6: SIMULATION (if proceeding with changes)
  // ==========================================
  
  let simulationResult: Simulation.SimulationResult | undefined;
  
  if (cfg.enableSimulation && 
      reasoningResult?.plan?.steps &&
      hasFileChanges(reasoningResult.plan)) {
    
    logger.debug('Simulating planned changes');
    
    const fileChanges = extractFileChanges(reasoningResult.plan);
    simulationResult = await Simulation.simulateChanges(
      fileChanges,
      context?.projectPath || process.cwd()
    );
    
    // If simulation finds blockers, stop
    if (!simulationResult.shouldProceed) {
      return {
        action: 'refuse',
        confidence: confidenceResult.score,
        reasoning: reasoningResult,
        simulation: simulationResult,
        response: `Cannot proceed:\n${simulationResult.blockers.map(b => `- ${b}`).join('\n')}`,
        processingTime: Date.now() - startTime,
        tokensUsed,
        bypassedScoring: false
      };
    }
    
    // If simulation has warnings, notify
    if (simulationResult.warnings.length > 0) {
      return {
        action: 'notice',
        confidence: confidenceResult.score,
        reasoning: reasoningResult,
        simulation: simulationResult,
        plan: reasoningResult?.plan,
        response: `Proceeding with warnings:\n${simulationResult.warnings.map(w => `- ${w}`).join('\n')}`,
        processingTime: Date.now() - startTime,
        tokensUsed,
        bypassedScoring: false
      };
    }
  }
  
  // ==========================================
  // STEP 7: PROCEED WITH EXECUTION
  // ==========================================
  
  return {
    action: confidenceResult.action === 'act_with_notice' ? 'notice' : 'proceed',
    confidence: confidenceResult.score,
    reasoning: reasoningResult,
    clarification: clarificationResult,
    simulation: simulationResult,
    contextResult,
    plan: reasoningResult?.plan,
    response: confidenceResult.concerns.length > 0 ? confidenceResult.concerns.join('. ') : undefined,
    processingTime: Date.now() - startTime,
    tokensUsed,
    bypassedScoring: false
  };
  } finally {
    const elapsed = Date.now() - startTime;
    Promise.resolve().then(() => import('../profiler/performance-collector.js')).then(({ recordMetric }) => {
      recordMetric({ category: 'response_time', source: 'llm_call', metric_name: 'response_time_ms', value: elapsed, metadata: { call: 'cognitive_think' } });
    }).catch(() => {});
  }
}

// ==========================================
// HELPER FUNCTIONS
// ==========================================

function isSimpleRequest(message: string): boolean {
  const simplePatterns = [
    /^(status|help|version)$/i,
    /^list\s+(projects|files)$/i,
    /^show\s+\w+$/i,
    /^what('s| is)\s+\w+$/i
  ];
  
  return simplePatterns.some(p => p.test(message.trim()));
}

function isComplexRequest(message: string): boolean {
  const complexIndicators = [
    /refactor/i,
    /migrate/i,
    /integrate/i,
    /implement\s+\w+\s+system/i,
    /create\s+(a\s+)?new\s+\w+/i,
    /fix\s+all/i,
    /update\s+every/i,
    /across\s+(all|multiple)/i
  ];
  
  return complexIndicators.some(p => p.test(message)) || message.split(' ').length > 20;
}

function hasFileChanges(plan: Reasoning.ReasoningPlan): boolean {
  return plan.steps.some((step: string) => 
    /create|modify|delete|rename|update|edit|write/i.test(step)
  );
}

function extractFileChanges(plan: Reasoning.ReasoningPlan): Simulation.FileChange[] {
  const changes: Simulation.FileChange[] = [];
  
  for (const step of plan.steps) {
    const stepLower = step.toLowerCase();
    
    // Try to extract file paths from the step description
    const fileMatch = step.match(/['"`]([^'"`]+\.(ts|tsx|js|jsx|json|md|css|html))['"`]/);
    
    if (fileMatch) {
      let changeType: 'create' | 'modify' | 'delete' | 'rename' = 'modify';
      
      if (/create|new|add/i.test(stepLower)) {
        changeType = 'create';
      } else if (/delete|remove/i.test(stepLower)) {
        changeType = 'delete';
      } else if (/rename|move/i.test(stepLower)) {
        changeType = 'rename';
      }
      
      changes.push({
        path: fileMatch[1],
        type: changeType,
        description: step
      });
    }
  }
  
  return changes;
}

function formatClarificationMessage(questions: string[]): string {
  if (questions.length === 1) {
    return questions[0];
  }
  
  return `I have a few questions before proceeding:\n\n${
    questions.map((q, i) => `${i + 1}. ${q}`).join('\n')
  }`;
}

// ==========================================
// QUICK DECISION (for simple cases)
// ==========================================

/**
 * Quick decision for cases where full metacognition is overkill
 */
export function quickDecision(message: string): MetacognitiveDecision | null {
  // Bypass scoring entirely for trivial messages
  if (Confidence.shouldBypassScoring(message)) {
    return {
      action: 'proceed',
      confidence: {
        understanding: 1.0,
        capability: 1.0,
        correctness: 1.0,
        safety: 1.0,
        overall: 1.0
      },
      processingTime: 0,
      tokensUsed: 0,
      bypassedScoring: true
    };
  }
  
  // Quick refuse for obviously dangerous requests
  const dangerousPatterns = [
    /rm\s+-rf\s+\//i,
    /format\s+c:/i,
    /drop\s+database/i,
    /delete\s+all/i
  ];
  
  if (dangerousPatterns.some(p => p.test(message))) {
    return {
      action: 'refuse',
      confidence: {
        understanding: 1.0,
        capability: 0.0,
        correctness: 0.0,
        safety: 0.0,
        overall: 0.0
      },
      response: 'This request appears potentially dangerous. Please be more specific about what you need.',
      processingTime: 0,
      tokensUsed: 0,
      bypassedScoring: false
    };
  }
  
  // Not a quick decision case
  return null;
}

// ==========================================
// EXPORTS
// ==========================================

export { 
  Confidence,
  Reasoning,
  Clarification,
  Simulation
};
