/**
 * Context Assembler
 * 
 * The central hub of the 6-layer context system.
 * Sits between the parser and the OODA loop, assembling
 * relevant context from all layers for each task.
 * 
 * Manages a token budget to keep context injection efficient.
 */

import { logger } from '../../utils/logger.js';
import { estimateTokens } from './db.js';

// Layer imports (lazy to avoid circular deps on Windows)
import type { SchemaSnapshot } from './layers/schema.js';
import type { AnnotationSet } from './layers/annotations.js';
import type { MatchedPattern } from './layers/patterns.js';
import type { DocResult } from './layers/docs.js';
import type { Learning } from './layers/learnings.js';
import type { RuntimeSnapshot } from './layers/runtime.js';

// ==========================================
// TYPES
// ==========================================

export type ContextTier = 'minimal' | 'standard' | 'full';

export interface TaskContext {
  message: string;
  action?: string;
  target?: string;
  service?: string;
  tier?: ContextTier;
  touchesSystem?: boolean;
  needsDocs?: boolean;
}

export interface AssembledContext {
  schema?: Partial<SchemaSnapshot>;
  annotations?: AnnotationSet;
  pattern?: MatchedPattern;
  docs?: DocResult[];
  learnings?: Learning[];
  runtime?: RuntimeSnapshot;
}

export interface ContextResult {
  layers: AssembledContext;
  tokensUsed: number;
  tokenBudget: number;
  layersIncluded: string[];
}

// ==========================================
// TOKEN BUDGETS
// ==========================================

const TOKEN_BUDGETS: Record<ContextTier, number> = {
  minimal: 500,
  standard: 2000,
  full: 8000
};

// ==========================================
// LAZY LAYER LOADERS
// ==========================================

let _schema: typeof import('./layers/schema.js') | null = null;
let _annotations: typeof import('./layers/annotations.js') | null = null;
let _patterns: typeof import('./layers/patterns.js') | null = null;
let _docs: typeof import('./layers/docs.js') | null = null;
let _learnings: typeof import('./layers/learnings.js') | null = null;
let _runtime: typeof import('./layers/runtime.js') | null = null;

async function getSchema() {
  if (!_schema) _schema = await import('./layers/schema.js');
  return _schema;
}
async function getAnnotations() {
  if (!_annotations) _annotations = await import('./layers/annotations.js');
  return _annotations;
}
async function getPatterns() {
  if (!_patterns) _patterns = await import('./layers/patterns.js');
  return _patterns;
}
async function getDocs() {
  if (!_docs) _docs = await import('./layers/docs.js');
  return _docs;
}
async function getLearnings() {
  if (!_learnings) _learnings = await import('./layers/learnings.js');
  return _learnings;
}
async function getRuntime() {
  if (!_runtime) _runtime = await import('./layers/runtime.js');
  return _runtime;
}

// ==========================================
// ENTITY EXTRACTION
// ==========================================

const SERVICE_NAMES = new Set([
  'jellyfin', 'radarr', 'sonarr', 'lidarr', 'prowlarr', 'bazarr',
  'qbittorrent', 'nzbget', 'tautulli', 'overseerr', 'jellyseerr',
  'traefik', 'pihole', 'postgres', 'redis', 'grafana', 'prometheus',
  'node-exporter', 'uptime-kuma', 'portainer', 'nextcloud', 'vaultwarden',
  'paperless', 'home-assistant', 'tailscale'
]);

/**
 * Extract entity names (services, paths, etc.) from a task description.
 */
function extractEntities(message: string): string[] {
  const lower = message.toLowerCase();
  const found: string[] = [];

  for (const name of SERVICE_NAMES) {
    if (lower.includes(name)) {
      found.push(name);
    }
  }

  return found;
}

/**
 * Determine the context tier based on the task.
 */
function determineTier(task: TaskContext): ContextTier {
  if (task.tier) return task.tier;

  const msg = task.message.toLowerCase();

  // Status checks, simple queries
  if (/^(status|help|ping|cost|version|downloads?|queue)$/i.test(msg.trim())) {
    return 'minimal';
  }

  // Complex operations
  if (/\b(implement|build|migrate|refactor|deploy all|create.*system)\b/i.test(msg)) {
    return 'full';
  }

  return 'standard';
}

/**
 * Determine if a task touches the system (homelab/docker/network).
 */
function touchesSystem(task: TaskContext): boolean {
  if (task.touchesSystem !== undefined) return task.touchesSystem;

  const systemActions = [
    'homelab_install', 'homelab_uninstall', 'homelab_update',
    'homelab_status', 'homelab_health', 'homelab_firewall',
    'media_search', 'media_download', 'media_select', 'media_more', 'media_status'
  ];

  if (task.action && systemActions.includes(task.action)) return true;

  return /\b(install|deploy|docker|container|service|restart|backup|firewall)\b/i.test(task.message);
}

// ==========================================
// MAIN ASSEMBLER
// ==========================================

/**
 * Assemble context from all 6 layers for a given task.
 * Respects token budget and only includes relevant context.
 */
export async function assembleContext(task: TaskContext): Promise<ContextResult> {
  const startTime = Date.now();
  const tier = determineTier(task);
  const tokenBudget = TOKEN_BUDGETS[tier];
  const context: AssembledContext = {};
  const layersIncluded: string[] = [];
  let tokensUsed = 0;

  const entities = extractEntities(task.message);
  const service = task.service || entities[0];
  const isSystem = touchesSystem(task);

  try {
    // Layer 1: Schema (always, cheap -- only relevant services)
    const schemaModule = await getSchema();
    const schema = schemaModule.getRelevantSchema(entities);
    if (schema) {
      const schemaTokens = estimateTokens(schema);
      if (tokensUsed + schemaTokens <= tokenBudget) {
        context.schema = schema;
        tokensUsed += schemaTokens;
        layersIncluded.push('schema');
      }
    }

    // Layer 2: Annotations (always, cheap -- only applicable rules)
    const annotationsModule = await getAnnotations();
    const annotations = annotationsModule.getRelevantAnnotations(task.message, entities);
    if (annotations) {
      const annTokens = estimateTokens(annotations);
      if (tokensUsed + annTokens <= tokenBudget) {
        context.annotations = annotations;
        tokensUsed += annTokens;
        layersIncluded.push('annotations');
      }
    }

    // Layer 3: Patterns (if similar task exists)
    const patternsModule = await getPatterns();
    const pattern = patternsModule.findMatchingPattern(task.message, task.action);
    if (pattern) {
      const patTokens = estimateTokens(pattern);
      if (tokensUsed + patTokens <= tokenBudget) {
        context.pattern = pattern;
        tokensUsed += patTokens;
        layersIncluded.push('patterns');
      }
    }

    // Layer 4: Docs (only if budget allows and task might need docs)
    if (tokensUsed < tokenBudget * 0.6 && (task.needsDocs || tier === 'full')) {
      const docsModule = await getDocs();
      const docs = docsModule.searchDocs(task.message, 3);
      if (docs.length > 0) {
        const docTokens = estimateTokens(docs);
        if (tokensUsed + docTokens <= tokenBudget) {
          context.docs = docs;
          tokensUsed += docTokens;
          layersIncluded.push('docs');
        }
      }
    }

    // Layer 5: Learnings (if relevant errors/fixes exist)
    const learningsModule = await getLearnings();
    const learnings = learningsModule.findRelevantLearnings(task.message, service);
    if (learnings.length > 0) {
      const learnTokens = estimateTokens(learnings);
      if (tokensUsed + learnTokens <= tokenBudget) {
        context.learnings = learnings;
        tokensUsed += learnTokens;
        layersIncluded.push('learnings');
      }
    }

    // Layer 6: Runtime (only for system operations)
    if (isSystem) {
      const runtimeModule = await getRuntime();
      const runtime = await runtimeModule.getRuntimeSnapshot();
      if (runtime) {
        const rtTokens = estimateTokens(runtime);
        if (tokensUsed + rtTokens <= tokenBudget) {
          context.runtime = runtime;
          tokensUsed += rtTokens;
          layersIncluded.push('runtime');
        }
      }
    }
  } catch (error) {
    logger.error('Context assembly error', { error: String(error) });
  }

  const elapsed = Date.now() - startTime;
  logger.debug('Context assembled', {
    tier,
    tokensUsed,
    tokenBudget,
    layers: layersIncluded,
    elapsed
  });

  return { layers: context, tokensUsed, tokenBudget, layersIncluded };
}

// ==========================================
// PROMPT FORMATTING
// ==========================================

/**
 * Format assembled context into a string for injection into the LLM prompt.
 */
export function formatContextForPrompt(result: ContextResult): string {
  const parts: string[] = [];

  if (result.layers.schema) {
    parts.push(`## Infrastructure\n${JSON.stringify(result.layers.schema, null, 2)}`);
  }

  if (result.layers.annotations) {
    parts.push(`## Owner Rules\n${JSON.stringify(result.layers.annotations, null, 2)}`);
  }

  if (result.layers.pattern) {
    const p = result.layers.pattern;
    parts.push(`## Known Pattern\nThis task matches a proven pattern "${p.description}" (${p.successCount} successes):\n${JSON.stringify(p.steps, null, 2)}`);
  }

  if (result.layers.docs && result.layers.docs.length > 0) {
    const docText = result.layers.docs.map(d => `### ${d.section || d.sourceFile}\n${d.content}`).join('\n\n');
    parts.push(`## Relevant Documentation\n${docText}`);
  }

  if (result.layers.learnings && result.layers.learnings.length > 0) {
    const lessonText = result.layers.learnings
      .map(l => `- ${l.lesson} (confidence: ${l.confidence.toFixed(2)})`)
      .join('\n');
    parts.push(`## Past Learnings\n${lessonText}`);
  }

  if (result.layers.runtime) {
    const rt = result.layers.runtime;
    parts.push(`## Current System State\nRAM: ${rt.ramAvailableMB}MB free\nCPU: ${rt.cpuPercent}%\nContainers: ${rt.containerCount} running\nTemp: ${rt.tempCelsius}°C`);
  }

  if (parts.length === 0) return '';

  return parts.join('\n\n---\n\n');
}

// ==========================================
// POST-EXECUTION HOOKS
// ==========================================

/**
 * Record a successful task completion (may create a pattern).
 */
export async function recordSuccess(
  task: TaskContext,
  steps: string[],
  contextUsed?: ContextResult
): Promise<void> {
  try {
    const patternsModule = await getPatterns();
    await patternsModule.maybeRecordPattern(task.message, task.action || 'unknown', steps);

    // Reinforce any learnings that were used
    if (contextUsed?.layers.learnings) {
      const learningsModule = await getLearnings();
      for (const learning of contextUsed.layers.learnings) {
        learningsModule.reinforceLearning(learning.id);
      }
    }
  } catch (error) {
    logger.debug('Failed to record success', { error: String(error) });
  }
}

/**
 * Record an error and the fix that resolved it.
 */
export async function recordError(
  error: string,
  fix: string,
  category: string,
  service?: string,
  contextUsed?: ContextResult
): Promise<void> {
  try {
    const learningsModule = await getLearnings();
    learningsModule.recordLearning({
      category,
      trigger: error,
      fix,
      lesson: `When "${error}" occurs, fix by: ${fix}`,
      appliesTo: service
    });

    // Weaken any learnings that didn't prevent this error
    if (contextUsed?.layers.learnings) {
      for (const learning of contextUsed.layers.learnings) {
        learningsModule.weakenLearning(learning.id);
      }
    }
  } catch (err) {
    logger.debug('Failed to record error', { error: String(err) });
  }
}
