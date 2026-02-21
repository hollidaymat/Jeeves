/**
 * 6-Layer Context System
 * 
 * Exports the Context Assembler and all layer modules.
 * This is the main entry point for the context system.
 */

export {
  assembleContext,
  assembleContextWithFallback,
  formatContextForPrompt,
  recordSuccess,
  recordError,
  type TaskContext,
  type ContextResult,
  type ContextTier,
  type AssembledContext
} from './assembler.js';

export {
  agenticRetrieve,
  type AgenticRetrieveInput,
  type AgenticRetrieveResult
} from './agentic-retriever.js';

export { getDb, closeDb, generateId, estimateTokens } from './db.js';
