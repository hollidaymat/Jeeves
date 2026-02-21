/**
 * Conversational PRD Builder
 * 
 * Multi-turn stateful conversation that takes a rough project concept,
 * asks refining questions, researches (web + codebase), and iteratively
 * produces a production-quality PRD. Hands off to createNewProject when finalized.
 * 
 * Flow: concept → discovery questions → research → drafting → refinement → finalize
 */

import { generateText } from '../core/llm/traced-llm.js';
import { createAnthropic } from '@ai-sdk/anthropic';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';

// ============================================================================
// Types
// ============================================================================

export type PrdPhase = 'discovery' | 'drafting' | 'finalized';

export interface PrdSession {
  id: string;
  projectName: string;
  phase: PrdPhase;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  currentDraft: string;
  research: { web: string[]; codebase: string[] };
  startedAt: number;
  lastActivity: number;
  turnCount: number;
}

// ============================================================================
// Constants
// ============================================================================

const SESSION_TIMEOUT_MS = 30 * 60 * 1000;  // 30 minutes
const MAX_TURNS = 15;  // Cost circuit breaker

const SYSTEM_PROMPT = `You are Jeeves, an AI product manager helping design a PRD (Product Requirements Document) for a software project. You are sharp, concise, and opinionated — like a senior PM at a top startup.

## Your Process

### Discovery Phase (first 2-3 turns)
Ask 2-3 focused, specific questions per turn. Cover:
- Core purpose and target user
- Tech stack preferences (or recommend based on scope)
- Key features (must-have vs nice-to-have)
- Design/aesthetic preferences
- Constraints (no backend, single page, budget, etc.)

### Drafting Phase (when you have enough info)
Present a complete PRD using this structure:

<prd_draft>
# {Project Name}

## Overview
{1-2 sentence summary}

## Requirements

### Data Model
{entities, fields, storage approach}

### UI Components
{numbered list of components with brief descriptions}

### Design Requirements
{aesthetic, responsive, accessibility}

### Constraints
{technical limitations, scope boundaries}

## Success Criteria
{checkboxes for what "done" looks like}
</prd_draft>

After showing the draft, ask: "Want me to change anything, or shall I build it?"

### Refinement
If the user wants changes, update the draft and show it again.

### Finalization
When the user approves (says "looks good", "ship it", "build it", "go", etc.), respond with EXACTLY:
<finalize/>

## Rules
- Be concise — no fluff, no filler
- Ask at most 3 questions per turn
- Don't repeat questions already answered
- If the user gives a one-word answer, infer reasonable defaults
- Use research context when provided to make informed suggestions
- Reference the user's existing projects when relevant
- Always wrap PRD drafts in <prd_draft> tags
- When the user approves, respond ONLY with <finalize/>`;

// ============================================================================
// PrdBuilder
// ============================================================================

let activeSession: PrdSession | null = null;

const anthropic = createAnthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || ''
});

/**
 * Start a new PRD builder session
 */
export async function startSession(
  projectName: string,
  initialConcept?: string
): Promise<string> {
  // Clean up any expired session
  if (activeSession && isExpired(activeSession)) {
    activeSession = null;
  }

  if (activeSession) {
    return `There's already an active PRD session for "${activeSession.projectName}". Say "cancel prd" to cancel it first.`;
  }

  activeSession = {
    id: `prd-${Date.now().toString(36)}`,
    projectName,
    phase: 'discovery',
    messages: [],
    currentDraft: '',
    research: { web: [], codebase: [] },
    startedAt: Date.now(),
    lastActivity: Date.now(),
    turnCount: 0,
  };

  logger.info('PRD builder session started', { projectName, sessionId: activeSession.id });

  // Do initial codebase research in parallel
  try {
    const conventions = await scanUserConventions();
    if (conventions) {
      activeSession.research.codebase.push(conventions);
    }
  } catch {
    // Non-fatal
  }

  // Build the initial user message
  let userMsg = `I want to build a new project called "${projectName}".`;
  if (initialConcept) {
    userMsg += `\n\nHere's the concept:\n${initialConcept}`;
  }

  return await addMessage(userMsg);
}

/**
 * Add a user message and get the next response
 */
export async function addMessage(content: string): Promise<string> {
  if (!activeSession) {
    return 'No active PRD session. Say "new project <name>" to start one.';
  }

  if (isExpired(activeSession)) {
    activeSession = null;
    return 'PRD session expired (30 min timeout). Say "new project <name>" to start a new one.';
  }

  if (activeSession.turnCount >= MAX_TURNS) {
    const draft = activeSession.currentDraft;
    activeSession = null;
    return `Max turns reached. ${draft ? 'Here\'s the last draft:\n\n' + draft : 'Session ended.'}`;
  }

  activeSession.lastActivity = Date.now();
  activeSession.turnCount++;

  // Add user message
  activeSession.messages.push({ role: 'user', content });

  // Try web research if the message mentions competitors, tools, or asks "what's the best..."
  if (shouldResearch(content)) {
    try {
      const { researchTopic } = await import('./web-researcher.js');
      const results = await researchTopic(extractResearchQuery(content));
      if (results) {
        activeSession.research.web.push(results);
      }
    } catch {
      // Web research failed, non-fatal
    }
  }

  // Build context for Claude
  const systemWithContext = buildSystemPrompt();

  try {
    const { text } = await generateText({
      model: anthropic(config.claude.model),
      system: systemWithContext,
      messages: activeSession.messages.map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
      maxTokens: 2000,
    });

    // Track cost
    logger.info('[COST] prd_builder', {
      model: config.claude.model,
      turn: activeSession.turnCount,
    });

    // Check for finalization signal
    if (text.includes('<finalize/>') || text.includes('<finalize>')) {
      return handleFinalization();
    }

    // Extract and store draft if present
    const draftMatch = text.match(/<prd_draft>([\s\S]*?)<\/prd_draft>/);
    if (draftMatch) {
      activeSession.currentDraft = draftMatch[1].trim();
      activeSession.phase = 'drafting';
    }

    // Store assistant response (clean version without XML tags for display)
    const cleanResponse = text
      .replace(/<prd_draft>/g, '')
      .replace(/<\/prd_draft>/g, '')
      .trim();
    activeSession.messages.push({ role: 'assistant', content: cleanResponse });

    return cleanResponse;
  } catch (error) {
    logger.error('PRD builder Claude call failed', { error: String(error) });
    return `Error generating response: ${error}. Try again or say "cancel prd".`;
  }
}

/**
 * Finalize the session and return the PRD
 */
function handleFinalization(): string {
  if (!activeSession) return 'No active session.';

  const result = {
    projectName: activeSession.projectName,
    prd: activeSession.currentDraft,
  };

  if (!result.prd) {
    return 'No PRD draft to finalize. Let\'s keep refining.';
  }

  // Store for pickup by handler
  lastFinalizedPrd = result;
  activeSession.phase = 'finalized';
  const session = activeSession;
  activeSession = null;

  logger.info('PRD finalized', {
    projectName: session.projectName,
    turns: session.turnCount,
    draftLength: result.prd.length,
  });

  return `__PRD_FINALIZED__`;  // Signal to handler to trigger createNewProject
}

/**
 * Get the finalized PRD (called by handler after finalization)
 */
let lastFinalizedPrd: { projectName: string; prd: string } | null = null;

export function getAndClearFinalizedPrd(): { projectName: string; prd: string } | null {
  const result = lastFinalizedPrd;
  lastFinalizedPrd = null;
  return result;
}

/**
 * Check if there's an active session
 */
export function getActiveSession(): PrdSession | null {
  if (activeSession && isExpired(activeSession)) {
    activeSession = null;
  }
  return activeSession;
}

/**
 * Cancel the active session
 */
export function cancelSession(): string {
  if (!activeSession) return 'No active PRD session to cancel.';
  const name = activeSession.projectName;
  activeSession = null;
  return `PRD session for "${name}" cancelled.`;
}

// ============================================================================
// Helpers
// ============================================================================

function isExpired(session: PrdSession): boolean {
  return (Date.now() - session.lastActivity) > SESSION_TIMEOUT_MS;
}

function buildSystemPrompt(): string {
  if (!activeSession) return SYSTEM_PROMPT;

  let context = SYSTEM_PROMPT;

  // Add research context
  if (activeSession.research.codebase.length > 0) {
    context += '\n\n## User\'s Existing Project Conventions\n';
    context += activeSession.research.codebase.join('\n');
  }

  if (activeSession.research.web.length > 0) {
    context += '\n\n## Research Results\n';
    context += activeSession.research.web.join('\n---\n');
  }

  // Add current draft context
  if (activeSession.currentDraft) {
    context += '\n\n## Current PRD Draft\n';
    context += activeSession.currentDraft;
  }

  return context;
}

function shouldResearch(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    /\b(like|similar to|competitor|alternative|compare|best\s+(way|practice|approach|tool|library|framework))\b/.test(lower) ||
    /\b(what\s+(should|would|could)\s+i\s+use|recommend|suggestion)\b/.test(lower)
  );
}

function extractResearchQuery(message: string): string {
  // Extract the core topic from the message for search
  return message
    .replace(/^(i\s+want|can\s+you|should\s+i|what'?s\s+the\s+best)\s*/i, '')
    .substring(0, 100);
}

/**
 * Scan user's existing projects for tech conventions
 */
async function scanUserConventions(): Promise<string | null> {
  try {
    const { scanForConventions } = await import('../core/project-scanner.js');
    return scanForConventions();
  } catch {
    return null;
  }
}

/**
 * Check if user message is a finalization intent
 */
export function isFinalizationIntent(message: string): boolean {
  const lower = message.trim().toLowerCase();
  return /^(ship\s+it|build\s+it|looks?\s+good|perfect|lgtm|approved?|go\s+ahead|do\s+it|let'?s?\s+go|make\s+it|create\s+it|yes\s*,?\s*(build|ship|create|go)|that'?s?\s+(good|great|perfect))$/i.test(lower);
}

/**
 * Check if user message is a cancellation intent
 */
export function isCancellationIntent(message: string): boolean {
  const lower = message.trim().toLowerCase();
  return /^(cancel\s*(prd|project|session)?|nevermind|never\s*mind|stop\s*(prd|project|session)?|abort|forget\s+it|nah)$/i.test(lower);
}
