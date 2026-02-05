/**
 * Intelligence Module
 * 
 * Advanced reasoning and analysis capabilities:
 * - Principled Reasoning: Decision frameworks (MECE, First Principles, etc.)
 * - Proactive Intelligence: Anticipatory suggestions and pattern detection
 * - Decomposition: PRD and complex task breakdown
 */

export {
  PrincipledReasoning,
  getPrincipledReasoning,
  type FrameworkType,
  type DecisionContext,
  type FrameworkAnalysis,
  type PrincipledDecision,
  type Alternative
} from './principled-reasoning.js';

export {
  ProactiveIntelligence,
  getProactiveIntelligence,
  resetProactiveIntelligence,
  type ActionCategory,
  type ActionPriority,
  type ProactiveAction,
  type ProactiveTrigger,
  type ProactiveConfig
} from './proactive-intelligence.js';

export {
  DecompositionEngine,
  getDecompositionEngine,
  type ItemType,
  type Complexity,
  type Priority,
  type DecomposedItem,
  type PRDInput,
  type DecompositionResult
} from './decomposition.js';
