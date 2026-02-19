/**
 * OODA Trace Logger
 * Records routing decisions and cognitive metadata for every message.
 * Used by jeeves-qa cognitive tests and growth tracking.
 */

import { randomUUID } from 'crypto';

export interface OODATrace {
  requestId: string;
  timestamp: number;
  routingPath: 'workflow' | 'registry' | 'fuzzy_pending' | 'conversational' | 'cognitive' | 'normal';
  observe: {
    rawInput: string;
    contextLoaded: string[];
    tokensUsed: number;
  };
  orient: {
    classification: string;
    confidenceScore: number;
    patternsMatched: string[];
    ambiguityDetected: boolean;
  };
  decide: {
    action: string;
    alternativesConsidered: string[];
    reasoning?: string;
    modelUsed: string;
  };
  act: {
    executionTime: number;
    success: boolean;
    error?: string;
  };
  loop: {
    totalTime: number;
    loopCount: number;
    reloopReason?: string;
  };
}

const TRACE_HISTORY_SIZE = 100;
const traces: OODATrace[] = [];
let lastTrace: OODATrace | null = null;

export interface OODARecordInput {
  routingPath: OODATrace['routingPath'];
  rawInput: string;
  contextLoaded?: string[];
  tokensUsed?: number;
  classification?: string;
  confidenceScore?: number;
  patternsMatched?: string[];
  ambiguityDetected?: boolean;
  action?: string;
  alternativesConsidered?: string[];
  reasoning?: string;
  modelUsed?: string;
  executionTime?: number;
  success?: boolean;
  error?: string;
  totalTime?: number;
  loopCount?: number;
}

/**
 * Record an OODA trace for a message. Call from handler at each routing decision.
 */
export function recordTrace(input: OODARecordInput): OODATrace {
  const now = Date.now();
  const trace: OODATrace = {
    requestId: randomUUID(),
    timestamp: now,
    routingPath: input.routingPath,
    observe: {
      rawInput: input.rawInput.substring(0, 500),
      contextLoaded: input.contextLoaded ?? [],
      tokensUsed: input.tokensUsed ?? 0,
    },
    orient: {
      classification: input.classification ?? input.routingPath,
      confidenceScore: input.confidenceScore ?? (input.routingPath === 'registry' ? 0.9 : 0.5),
      patternsMatched: input.patternsMatched ?? [],
      ambiguityDetected: input.ambiguityDetected ?? false,
    },
    decide: {
      action: input.action ?? input.routingPath,
      alternativesConsidered: input.alternativesConsidered ?? [],
      reasoning: input.reasoning,
      modelUsed: input.modelUsed ?? 'none',
    },
    act: {
      executionTime: input.executionTime ?? 0,
      success: input.success ?? true,
      error: input.error,
    },
    loop: {
      totalTime: input.totalTime ?? 0,
      loopCount: input.loopCount ?? 1,
    },
  };

  lastTrace = trace;
  traces.push(trace);
  if (traces.length > TRACE_HISTORY_SIZE) {
    traces.shift();
  }

  // Persist to growth DB for learning (fire-and-forget)
  import('./growth-tracker.js').then(({ persistTrace }) => persistTrace(trace)).catch(() => {});

  return trace;
}

/**
 * Get the last recorded trace. Used by /api/debug/last-ooda.
 */
export function getLastTrace(): OODATrace | null {
  return lastTrace;
}

/**
 * Get a trace by request ID.
 */
export function getTraceById(requestId: string): OODATrace | null {
  return traces.find((t) => t.requestId === requestId) ?? null;
}

// --- Dev reasoning trace (observe / orient / decide / act per dev task) ---

export interface ReasoningStep {
  phase: 'observe' | 'orient' | 'decide' | 'act';
  timestamp: number;
  thought: string;
  data?: unknown;
  confidence?: number;
  alternatives?: string[];
  duration: number;
}

export interface ReasoningTrace {
  taskId: string;
  taskDescription: string;
  startedAt: number;
  completedAt?: number;
  steps: ReasoningStep[];
  outcome: 'success' | 'failed' | 'escalated' | 'in_progress';
  totalTokensUsed: number;
  totalCost: number;
  modelUsed: string;
}

const reasoningTraceBuffer: ReasoningTrace[] = [];
const MAX_REASONING_TRACES = 50;
let currentReasoningTrace: ReasoningTrace | null = null;

export function startReasoningTrace(taskId: string, description: string): void {
  currentReasoningTrace = {
    taskId,
    taskDescription: description,
    startedAt: Date.now(),
    steps: [],
    outcome: 'in_progress',
    totalTokensUsed: 0,
    totalCost: 0,
    modelUsed: '',
  };
}

export function addReasoningStep(step: Omit<ReasoningStep, 'timestamp'>): void {
  if (!currentReasoningTrace) return;
  currentReasoningTrace.steps.push({
    ...step,
    timestamp: Date.now(),
  });
}

export function completeReasoningTrace(
  outcome: ReasoningTrace['outcome'],
  tokensUsed: number,
  cost: number,
  model: string
): void {
  if (!currentReasoningTrace) return;
  currentReasoningTrace.completedAt = Date.now();
  currentReasoningTrace.outcome = outcome;
  currentReasoningTrace.totalTokensUsed = tokensUsed;
  currentReasoningTrace.totalCost = cost;
  currentReasoningTrace.modelUsed = model;

  reasoningTraceBuffer.push(currentReasoningTrace);
  if (reasoningTraceBuffer.length > MAX_REASONING_TRACES) {
    reasoningTraceBuffer.shift();
  }
  currentReasoningTrace = null;
}

export function getRecentReasoningTraces(limit: number = 20): ReasoningTrace[] {
  return reasoningTraceBuffer.slice(-limit).reverse();
}

export function getReasoningTraceById(taskId: string): ReasoningTrace | undefined {
  return reasoningTraceBuffer.find((t) => t.taskId === taskId);
}

export function getCurrentReasoningTrace(): ReasoningTrace | null {
  return currentReasoningTrace;
}

/**
 * Get aggregate stats from recent traces.
 */
export function getTraceStats(): {
  totalTraces: number;
  byPath: Record<string, number>;
  avgConfidence: number;
  avgTotalTime: number;
  oodaFireRate: number;
} {
  if (traces.length === 0) {
    return { totalTraces: 0, byPath: {}, avgConfidence: 0, avgTotalTime: 0, oodaFireRate: 0 };
  }

  const byPath: Record<string, number> = {};
  let sumConfidence = 0;
  let sumTime = 0;

  for (const t of traces) {
    byPath[t.routingPath] = (byPath[t.routingPath] ?? 0) + 1;
    sumConfidence += t.orient.confidenceScore;
    sumTime += t.loop.totalTime;
  }

  const cognitiveCount = byPath['cognitive'] ?? 0;
  const oodaFireRate = traces.length > 0 ? cognitiveCount / traces.length : 0;

  return {
    totalTraces: traces.length,
    byPath,
    avgConfidence: sumConfidence / traces.length,
    avgTotalTime: sumTime / traces.length,
    oodaFireRate,
  };
}
