/**
 * 6-Layer Context System
 * 
 * Exports the Context Assembler and all layer modules.
 * This is the main entry point for the context system.
 */

export {
  assembleContext,
  formatContextForPrompt,
  recordSuccess,
  recordError,
  type TaskContext,
  type ContextResult,
  type ContextTier,
  type AssembledContext
} from './assembler.js';

export { getDb, closeDb, generateId, estimateTokens } from './db.js';
