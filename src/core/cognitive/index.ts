/**
 * Cognitive Architecture Module
 * 
 * Exports the complete cognitive processing system:
 * - Metacognition: The master orchestrator ("thinking about thinking")
 * - Confidence: Scoring system for understanding/capability/safety
 * - Reasoning: OODA loop for complex decision making
 * - Clarification: Smart question generation with 3-question rule
 * - Simulation: Pre-execution impact analysis
 */

// Main orchestrator
export { 
  think, 
  quickDecision,
  type MetacognitiveInput,
  type MetacognitiveDecision,
  type MetacognitiveConfig
} from './metacognition.js';

// Individual modules (for direct access when needed)
export * as Confidence from './confidence.js';
export * as Reasoning from './reasoning.js';
export * as Clarification from './clarification.js';
export * as Simulation from './simulation.js';

// Re-export key types for convenience
export type { ConfidenceScore, ConfidenceAction, ConfidenceResult } from './confidence.js';
export type { ReasoningResult, ExecutionPlan, PlanStep } from './reasoning.js';
export type { ClarificationQuestion, ClarificationResult, QuestionPriority } from './clarification.js';
export type { FileChange, SimulationResult, BreakageRisk } from './simulation.js';
