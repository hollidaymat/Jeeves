/**
 * Execution Module
 * 
 * Manages task execution with:
 * - Debug Engine: Scientific method debugging
 * - State Manager: Context switching and persistence
 * - Spike Pattern: Hypothesis-driven experimentation
 */

export {
  DebugEngine,
  getDebugEngine,
  type DebugPhase,
  type BugReport,
  type Hypothesis,
  type Experiment,
  type DebugSession
} from './debug-engine.js';

export {
  StateManager,
  getStateManager,
  resetStateManager,
  type ExecutionState,
  type Checkpoint,
  type StateTransition
} from './state-manager.js';

export {
  SpikeEngine,
  getSpikeEngine,
  resetSpikeEngine,
  type Spike,
  type SpikeType,
  type SpikeStatus,
  type SpikeHypothesis,
  type SpikeResult,
  type SpikeStep
} from './spike-pattern.js';
