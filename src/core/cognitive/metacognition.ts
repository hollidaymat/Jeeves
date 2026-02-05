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
  };
}

export interface MetacognitiveDecision {
  action: 'proceed' | 'clarify' | 'notice' | 'refuse';
  confidence: Confidence.ConfidenceScore;
  reasoning?: Reasoning.ReasoningResult;
  clarification?: Clarification.ClarificationResult;
  simulation?: Simulation.SimulationResult;
  
  // What to do
  response?: string;
  plan?: Reasoning.ExecutionPlan;
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
  // STEP 2: CONFIDENCE SCORING
  // ==========================================
  
  let confidenceResult: Confidence.ConfidenceResult;
  
  const confidenceContext: Partial<Confidence.ConfidenceContext> = {
    projectPath: context?.projectPath,
    previousMessages: context?.previousMessages || [],
    hasActiveTask: !!context?.activeTask
  };
  
  if (cfg.enableDeepScoring && !isSimpleRequest(message)) {
    confidenceResult = await Confidence.deepScore(message, confidenceContext);
    tokensUsed += confidenceResult.tokensUsed || 0;
  } else {
    confidenceResult = Confidence.quickScore(message, confidenceContext);
  }
  
  logger.debug('Confidence scored', { 
    action: confidenceResult.action,
    overall: confidenceResult.score.overall
  });
  
  // ==========================================
  // STEP 3: HANDLE REFUSE ACTION
  // ==========================================
  
  if (confidenceResult.action === 'refuse') {
    return {
      action: 'refuse',
      confidence: confidenceResult.score,
      response: confidenceResult.notice || 'I cannot perform this action for safety reasons.',
      processingTime: Date.now() - startTime,
      tokensUsed,
      bypassedScoring: false
    };
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
      projectContext: context?.projectPath,
      previousActions: context?.sessionHistory,
      userProfile: {
        communicationStyle: 'technical',
        riskTolerance: 'moderate',
        expertise: 'intermediate'
      }
    });
    tokensUsed += reasoningResult.tokensUsed || 0;
    
    // If reasoning says we need clarification
    if (reasoningResult.needsClarification && reasoningResult.clarifications.length > 0) {
      return {
        action: 'clarify',
        confidence: confidenceResult.score,
        reasoning: reasoningResult,
        questions: reasoningResult.clarifications.map((q, i) => ({
          id: `q${i}`,
          question: q,
          priority: 'critical' as const,
          category: 'scope' as const,
          reasoning: 'Identified during OODA reasoning'
        })),
        response: formatClarificationMessage(reasoningResult.clarifications),
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
      confidenceScores: {
        understanding: confidenceResult.score.understanding,
        capability: confidenceResult.score.capability,
        safety: confidenceResult.score.safety
      },
      identifiedAmbiguities: reasoningResult?.ambiguities || [],
      identifiedRisks: reasoningResult?.risks || []
    });
    tokensUsed += clarificationResult.tokensUsed || 0;
    
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
    plan: reasoningResult?.plan,
    response: confidenceResult.notice,
    processingTime: Date.now() - startTime,
    tokensUsed,
    bypassedScoring: false
  };
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

function hasFileChanges(plan: Reasoning.ExecutionPlan): boolean {
  return plan.steps.some(step => 
    /create|modify|delete|rename|update|edit|write/i.test(step.action)
  );
}

function extractFileChanges(plan: Reasoning.ExecutionPlan): Simulation.FileChange[] {
  const changes: Simulation.FileChange[] = [];
  
  for (const step of plan.steps) {
    const actionLower = step.action.toLowerCase();
    
    // Try to extract file paths from the description
    const fileMatch = step.description.match(/['"`]([^'"`]+\.(ts|tsx|js|jsx|json|md|css|html))['"`]/);
    
    if (fileMatch) {
      let changeType: 'create' | 'modify' | 'delete' | 'rename' = 'modify';
      
      if (/create|new|add/i.test(actionLower)) {
        changeType = 'create';
      } else if (/delete|remove/i.test(actionLower)) {
        changeType = 'delete';
      } else if (/rename|move/i.test(actionLower)) {
        changeType = 'rename';
      }
      
      changes.push({
        path: fileMatch[1],
        type: changeType,
        description: step.description
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
