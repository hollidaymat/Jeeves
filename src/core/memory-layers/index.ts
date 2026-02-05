/**
 * Memory Layers Module
 * 
 * Three-tier memory architecture:
 * - L1 Working Memory: Hot context, current conversation (20k tokens)
 * - L2 Episodic Memory: Session summaries, task outcomes (SQLite/JSON)
 * - L3 Semantic Memory: Long-term knowledge, patterns (Vector-indexed)
 */

export {
  WorkingMemory,
  getWorkingMemory,
  resetWorkingMemory,
  type WorkingMemoryItem,
  type WorkingMemoryState,
  type ActiveTask,
  type TaskStep
} from './working-memory.js';

export {
  EpisodicMemory,
  getEpisodicMemory,
  resetEpisodicMemory,
  type SessionSummary,
  type TaskOutcome,
  type ErrorPattern,
  type UserPreference
} from './episodic-memory.js';

export {
  SemanticMemory,
  getSemanticMemory,
  resetSemanticMemory,
  type KnowledgeEntry,
  type ProjectPattern,
  type CodeSolution
} from './semantic-memory.js';
