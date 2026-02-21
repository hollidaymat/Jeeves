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
import type { ProjectContext } from './layers/project-context.js';

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
  /** Model in use (haiku/sonnet) — determines token budget. Sonnet gets 4000–6000, Haiku 2000. */
  model?: string;
  /** Project path for code-review / agent_ask context */
  projectPath?: string;
}

export interface AssembledContext {
  schema?: Partial<SchemaSnapshot>;
  annotations?: AnnotationSet;
  pattern?: MatchedPattern;
  docs?: DocResult[];
  learnings?: Learning[];
  runtime?: RuntimeSnapshot;
  project?: ProjectContext;
}

export interface ContextResult {
  layers: AssembledContext;
  tokensUsed: number;
  tokenBudget: number;
  layersIncluded: string[];
  /** Set when result came from session cache; use this instead of formatContextForPrompt. */
  cachedFormatted?: string;
}

// ==========================================
// TOKEN BUDGETS (tied to model: Haiku simple, Sonnet complex)
// ==========================================

const TIER_BUDGETS: Record<ContextTier, number> = {
  minimal: 500,
  standard: 2000,
  full: 8000
};

function getTokenBudget(tier: ContextTier, model?: string): number {
  const base = TIER_BUDGETS[tier];
  const isSonnet = /sonnet/i.test(model || '');
  if (isSonnet && tier !== 'minimal') {
    return Math.min(base * 2, 6000);
  }
  return Math.min(base, 2000);
}

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
    'media_search', 'media_download', 'media_select', 'media_more', 'media_status',
    'qbittorrent_status', 'qbittorrent_add'
  ];

  if (task.action && systemActions.includes(task.action)) return true;

  return /\b(install|deploy|docker|container|service|restart|backup|firewall)\b/i.test(task.message);
}

// ==========================================
// MINIMAL ASSEMBLY (fallback: annotations + patterns only)
// ==========================================

/**
 * Assemble minimal context (annotations + patterns only). Used as fallback when full assembly fails.
 */
async function assembleMinimalContext(task: TaskContext): Promise<ContextResult> {
  const context: AssembledContext = {};
  const layersIncluded: string[] = [];
  let tokensUsed = 0;
  const entities = extractEntities(task.message);
  const service = task.service || entities[0];

  try {
    const [annMod, patMod] = await Promise.all([getAnnotations(), getPatterns()]);
    const [annotations, pattern] = await Promise.all([
      Promise.resolve(annMod.getRelevantAnnotations(task.message, entities)),
      Promise.resolve(patMod.findMatchingPattern(task.message, task.action)),
    ]);
    if (annotations) {
      context.annotations = annotations;
      tokensUsed += estimateTokens(annotations);
      layersIncluded.push('annotations');
    }
    if (pattern) {
      context.pattern = pattern;
      tokensUsed += estimateTokens(pattern);
      layersIncluded.push('patterns');
    }
  } catch (e) {
    logger.debug('Minimal context assembly failed', { error: String(e) });
  }

  const layers: AssembledContext = context;
  const result: ContextResult = { layers, tokensUsed, tokenBudget: 2000, layersIncluded };
  const formatted = formatContextForPrompt(result);
  return { ...result, cachedFormatted: formatted.length > 0 ? formatted : undefined };
}

// ==========================================
// MAIN ASSEMBLER
// ==========================================

/**
 * Assemble context from all 6 layers for a given task.
 * Respects token budget and only includes relevant context.
 * Uses session cache when the message topic matches a recent assembly (5 min TTL).
 */
export async function assembleContext(task: TaskContext): Promise<ContextResult> {
  const { getCachedSession, cacheSession } = await import('./session-cache.js');
  const cached = getCachedSession(task.message, { projectPath: task.projectPath, action: task.action });
  if (cached) {
    logger.debug('Context session cache hit', { hitCount: cached.hitCount, topic: cached.topic.slice(0, 40) });
    return {
      layers: {},
      tokensUsed: cached.tokensUsed,
      tokenBudget: 0,
      layersIncluded: cached.layersLoaded,
      cachedFormatted: cached.assembledContext,
    };
  }

  const startTime = Date.now();
  const tier = determineTier(task);
  const tokenBudget = getTokenBudget(tier, task.model);
  const context: AssembledContext = {};
  const layersIncluded: string[] = [];
  let tokensUsed = 0;

  const entities = extractEntities(task.message);
  const service = task.service || entities[0];
  const isSystem = touchesSystem(task);
  const needsProject = task.projectPath && (task.action === 'agent_ask' || task.action === 'code_review');
  const needsDocs = task.needsDocs || tier === 'full';

  const LAYER_TIMEOUT_MS = 3000;

  async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
    return Promise.race([
      p,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))
    ]);
  }

  try {
    // Fetch all layers in parallel with per-layer timeout (including project context when needed)
    const projectPromise = needsProject && task.projectPath
      ? (async () => {
          const { getProjectContext } = await import('./layers/project-context.js');
          return getProjectContext(task.projectPath!);
        })()
      : Promise.resolve(null);

    const [schemaMod, annMod, patMod, docsMod, learnMod, runtimeMod] = await Promise.all([
      getSchema(),
      getAnnotations(),
      getPatterns(),
      needsDocs ? getDocs() : Promise.resolve(null),
      getLearnings(),
      isSystem ? getRuntime() : Promise.resolve(null),
    ]);

    const [schema, annotations, pattern, docsRaw, learningsRaw, runtime, project] = await Promise.all([
      withTimeout(schemaMod.getRelevantSchema(entities), LAYER_TIMEOUT_MS),
      withTimeout(Promise.resolve(annMod.getRelevantAnnotations(task.message, entities)), LAYER_TIMEOUT_MS),
      withTimeout(Promise.resolve(patMod.findMatchingPattern(task.message, task.action)), LAYER_TIMEOUT_MS),
      docsMod ? withTimeout(Promise.resolve(docsMod.searchDocs(task.message, 3)), LAYER_TIMEOUT_MS) : Promise.resolve([]),
      withTimeout(Promise.resolve(learnMod.findRelevantLearnings(task.message, service)), LAYER_TIMEOUT_MS),
      runtimeMod ? withTimeout(runtimeMod.getRuntimeSnapshot(), LAYER_TIMEOUT_MS) : Promise.resolve(null),
      withTimeout(projectPromise, LAYER_TIMEOUT_MS),
    ]);
    const docs = Array.isArray(docsRaw) ? docsRaw : [];
    const learnings = Array.isArray(learningsRaw) ? learningsRaw : [];

    // Apply layers in priority order, respecting token budget
    if (schema) {
      const schemaTokens = estimateTokens(schema);
      if (tokensUsed + schemaTokens <= tokenBudget) {
        context.schema = schema;
        tokensUsed += schemaTokens;
        layersIncluded.push('schema');
      }
    }
    if (annotations) {
      const annTokens = estimateTokens(annotations);
      if (tokensUsed + annTokens <= tokenBudget) {
        context.annotations = annotations;
        tokensUsed += annTokens;
        layersIncluded.push('annotations');
      }
    }
    if (pattern) {
      const patTokens = estimateTokens(pattern);
      if (tokensUsed + patTokens <= tokenBudget) {
        context.pattern = pattern;
        tokensUsed += patTokens;
        layersIncluded.push('patterns');
      }
    }
    if (docs && docs.length > 0 && tokensUsed < tokenBudget * 0.6) {
      const docTokens = estimateTokens(docs);
      if (tokensUsed + docTokens <= tokenBudget) {
        context.docs = docs;
        tokensUsed += docTokens;
        layersIncluded.push('docs');
      }
    }
    if (learnings.length > 0) {
      const learnTokens = estimateTokens(learnings);
      if (tokensUsed + learnTokens <= tokenBudget) {
        context.learnings = learnings;
        tokensUsed += learnTokens;
        layersIncluded.push('learnings');
      }
    }
    if (runtime) {
      const rtTokens = estimateTokens(runtime);
      if (tokensUsed + rtTokens <= tokenBudget) {
        context.runtime = runtime;
        tokensUsed += rtTokens;
        layersIncluded.push('runtime');
      }
    }

    if (project) {
      const parts = [project.files, project.dependencies, project.recentChanges, project.workingTree].filter(Boolean);
      const projectText = parts.join('\n\n');
      const projTokens = estimateTokens(projectText);
      if (tokensUsed + projTokens <= tokenBudget) {
        context.project = project;
        tokensUsed += projTokens;
        layersIncluded.push('project');
      }
    }
  } catch (error) {
    logger.error('Context assembly error', { error: String(error) });
  }

  const elapsed = Date.now() - startTime;
  const result: ContextResult = { layers: context, tokensUsed, tokenBudget, layersIncluded };
  const formatted = formatContextForPrompt(result);
  if (formatted.length > 0) {
    cacheSession(task.message, formatted, layersIncluded, tokensUsed, { projectPath: task.projectPath, action: task.action });
  }

  logger.debug('Context assembled', {
    tier,
    tokensUsed,
    tokenBudget,
    layers: layersIncluded,
    elapsed
  });

  return result;
}

/**
 * Assemble context with fallback: primary = full 6-layer; fallback = minimal (annotations + patterns).
 * Returns { result, fallbackUsed } for OODA trace logging.
 */
export async function assembleContextWithFallback(
  task: TaskContext
): Promise<{ result: ContextResult; fallbackUsed?: string }> {
  const { runWithFallback } = await import('../fallback.js');
  const { result, stepUsed } = await runWithFallback({
    primary: () => assembleContext(task),
    fallbacks: [{ name: 'minimal', fn: () => assembleMinimalContext(task) }],
    onAllFailed: (errors) => {
      logger.warn('Context assembly failed, using empty', { errors: errors.map((e) => e.message) });
      return {
        layers: {},
        tokensUsed: 0,
        tokenBudget: 0,
        layersIncluded: [],
        cachedFormatted: 'Context unavailable. Proceeding with message only.',
      } as ContextResult;
    },
  });
  return { result, fallbackUsed: stepUsed !== 'primary' ? stepUsed : undefined };
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

  if (result.layers.project) {
    const p = result.layers.project;
    const projectParts = [p.files, p.dependencies, p.recentChanges, p.workingTree].filter(Boolean);
    if (projectParts.length > 0) {
      parts.push(`## Project Context\n${projectParts.join('\n\n')}`);
    }
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
