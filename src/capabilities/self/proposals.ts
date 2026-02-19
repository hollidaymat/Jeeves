/**
 * Jeeves Self-Improvement Proposals
 * 
 * Once daily, Jeeves analyzes his own usage patterns, error logs,
 * and capability gaps to generate 3 improvement proposals.
 * Matt picks one (or none), and Jeeves creates a Cursor task
 * to implement it on his own repo.
 * 
 * Constraints:
 *   - Max 1 approved proposal per day
 *   - 3 proposals generated per batch (single Haiku call, budget-enforced)
 *   - Matt must explicitly approve — no self-modification without consent
 *   - Proposals target the Jeeves repo (signal-cursor-controller / Jeeves)
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../../utils/logger.js';
import { enforceBudget, recordFeatureUsage, getFeatureMaxTokens } from '../../core/cost-tracker.js';
import { config } from '../../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_FILE = resolve(__dirname, '..', '..', '..', 'data', 'proposals.json');

// ============================================================================
// Types
// ============================================================================

export interface Proposal {
  id: string;
  title: string;
  description: string;
  category: 'performance' | 'feature' | 'reliability' | 'ux' | 'security' | 'cost_savings';
  estimatedComplexity: 'low' | 'medium' | 'high';
  estimatedFiles: number;
  rationale: string;
  status: 'pending' | 'approved' | 'rejected' | 'building' | 'deployed' | 'expired';
  createdAt: string;
  decidedAt?: string;
  taskId?: string;
}

interface ProposalStore {
  currentBatch: Proposal[];
  batchGeneratedAt: string;
  approvalsToday: number;
  lastApprovalDate: string;
  history: Proposal[];
  lastUpdated: string;
}

// ============================================================================
// State
// ============================================================================

let store: ProposalStore | null = null;

function loadStore(): ProposalStore {
  if (store) return store;
  try {
    if (existsSync(DATA_FILE)) {
      store = JSON.parse(readFileSync(DATA_FILE, 'utf-8')) as ProposalStore;
    }
  } catch {
    // Corrupt file, start fresh
  }
  if (!store) {
    store = {
      currentBatch: [],
      batchGeneratedAt: '',
      approvalsToday: 0,
      lastApprovalDate: '',
      history: [],
      lastUpdated: '',
    };
  }
  return store;
}

function saveStore(): void {
  if (!store) return;
  store.lastUpdated = new Date().toISOString();
  try {
    writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
  } catch (err) {
    logger.error('Failed to save proposals store', { error: String(err) });
  }
}

function today(): string {
  return new Date().toISOString().split('T')[0];
}

// ============================================================================
// Generate Proposals
// ============================================================================

/**
 * Generate 3 improvement proposals. Called once daily (or on demand).
 * Uses a single Haiku call, budget-enforced.
 */
export async function generateProposals(): Promise<Proposal[]> {
  const s = loadStore();

  // Check if we already have a fresh batch today
  if (s.batchGeneratedAt && s.batchGeneratedAt.startsWith(today()) && s.currentBatch.length > 0) {
    logger.debug('Proposals already generated today');
    return s.currentBatch;
  }

  // Budget check
  const budgetCheck = enforceBudget('self_proposals');
  if (!budgetCheck.allowed) {
    logger.debug('Proposal generation budget exhausted', { reason: budgetCheck.reason });
    return s.currentBatch;  // Return stale batch if available
  }

  try {
    const { generateText } = await import('ai');
    const { createAnthropic } = await import('@ai-sdk/anthropic');
    const provider = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY || '' });

    // Gather context about current state
    const context = await gatherSelfContext();

    const prompt = `You are Jeeves, an autonomous engineering partner. Analyze your own system and propose exactly 3 improvements you'd like to make to yourself. Matt will pick one (or none) per day.

## Your Current Capabilities
${context.capabilities}

## Recent Errors (last 24h)
${context.recentErrors || 'None logged'}

## Usage Patterns
${context.usagePatterns || 'No data yet'}

## Previously Approved/Built
${context.previouslyBuilt || 'Nothing yet'}

## Do NOT suggest again (already suggested or implemented — choose new ideas)
${context.doNotSuggestAgain}

## Rules
- Propose things that genuinely improve YOUR functionality, not hypothetical features
- Consider: reliability, performance, cost savings, UX improvements, missing capabilities
- Each proposal should be self-contained and implementable in a single Cursor agent session
- Be specific about what files to change and what the improvement does
- Do NOT propose any item from "Do NOT suggest again" — those were already suggested or built; propose 3 different improvements
- Keep proposals realistic for your tech stack (TypeScript, Node.js, Express, Vercel SDK, Anthropic SDK)

Respond with EXACTLY this JSON array format (3 items):
[
  {
    "title": "Short title",
    "description": "What to build, 2-3 sentences",
    "category": "performance|feature|reliability|ux|security|cost_savings",
    "estimatedComplexity": "low|medium|high",
    "estimatedFiles": 3,
    "rationale": "Why this matters, 1 sentence"
  }
]`;

    const maxTokens = getFeatureMaxTokens('self_proposals');

    const { text } = await generateText({
      model: provider(config.claude.haiku_model),
      messages: [{ role: 'user', content: prompt }],
      maxTokens,
    });

    recordFeatureUsage('self_proposals', 0.003);

    // Parse response
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      logger.warn('Could not parse proposals response');
      return s.currentBatch;
    }

    const raw = JSON.parse(jsonMatch[0]) as Array<{
      title: string;
      description: string;
      category: string;
      estimatedComplexity: string;
      estimatedFiles: number;
      rationale: string;
    }>;

    // Expire old batch
    for (const old of s.currentBatch) {
      if (old.status === 'pending') {
        old.status = 'expired';
        s.history.push(old);
      }
    }

    // Create new batch
    s.currentBatch = raw.slice(0, 3).map((p, i) => ({
      id: `prop-${Date.now().toString(36)}-${i}`,
      title: p.title,
      description: p.description,
      category: (p.category || 'feature') as Proposal['category'],
      estimatedComplexity: (p.estimatedComplexity || 'medium') as Proposal['estimatedComplexity'],
      estimatedFiles: p.estimatedFiles || 3,
      rationale: p.rationale,
      status: 'pending' as const,
      createdAt: new Date().toISOString(),
    }));

    s.batchGeneratedAt = new Date().toISOString();

    // Reset daily approval counter if new day
    if (s.lastApprovalDate !== today()) {
      s.approvalsToday = 0;
    }

    saveStore();

    logger.info('Generated improvement proposals', { count: s.currentBatch.length });

    return s.currentBatch;

  } catch (err) {
    logger.error('Failed to generate proposals', { error: String(err) });
    return s.currentBatch;
  }
}

// ============================================================================
// Approve / Reject
// ============================================================================

/**
 * Approve a proposal by number (1, 2, or 3) or ID.
 * Creates a Cursor task to implement it.
 */
export async function approveProposal(selector: string | number): Promise<{
  success: boolean;
  message: string;
  proposal?: Proposal;
}> {
  const s = loadStore();

  // Check daily limit
  if (s.lastApprovalDate === today() && s.approvalsToday >= 1) {
    return { success: false, message: 'Already approved one proposal today. Try again tomorrow.' };
  }

  // Find the proposal
  let proposal: Proposal | undefined;
  if (typeof selector === 'number' || /^\d$/.test(String(selector))) {
    const idx = (typeof selector === 'number' ? selector : parseInt(selector, 10)) - 1;
    proposal = s.currentBatch[idx];
  } else {
    proposal = s.currentBatch.find(p => p.id === selector);
  }

  if (!proposal) {
    return { success: false, message: `Proposal not found. Current batch has ${s.currentBatch.length} proposals.` };
  }

  if (proposal.status !== 'pending') {
    return { success: false, message: `Proposal "${proposal.title}" is already ${proposal.status}.` };
  }

  // Mark approved
  proposal.status = 'approved';
  proposal.decidedAt = new Date().toISOString();
  s.approvalsToday++;
  s.lastApprovalDate = today();

  // Create a Cursor task for it
  try {
    const { createTask, confirmAndLaunch } = await import('../../integrations/cursor-orchestrator.js');

    const prdText = buildSelfImprovementPRD(proposal);

    const task = createTask(
      `Self-improvement: ${proposal.title}`,
      'jeeves',
      {
        type: 'feature',
        requirements: [proposal.description],
        complexity: proposal.estimatedComplexity,
      }
    );

    if (task) {
      proposal.taskId = task.id;
      proposal.status = 'building';

      // Auto-launch (no confirmation needed for approved self-improvements)
      // Actually — let's still require confirmation to keep Matt in the loop
      saveStore();

      return {
        success: true,
        message: `Approved "${proposal.title}". Cursor task created.\n\n${prdText}\n\nSend "go" to launch the Cursor agent.`,
        proposal,
      };
    } else {
      saveStore();
      return {
        success: true,
        message: `Approved "${proposal.title}" but couldn't create Cursor task (repo not found). The improvement spec is logged.`,
        proposal,
      };
    }
  } catch (err) {
    saveStore();
    return {
      success: false,
      message: `Approved but failed to create task: ${err}`,
      proposal,
    };
  }
}

/**
 * Reject a proposal (just marks it, doesn't do anything else).
 */
export function rejectProposal(selector: string | number): { success: boolean; message: string } {
  const s = loadStore();

  let proposal: Proposal | undefined;
  if (typeof selector === 'number' || /^\d$/.test(String(selector))) {
    const idx = (typeof selector === 'number' ? selector : parseInt(selector, 10)) - 1;
    proposal = s.currentBatch[idx];
  } else {
    proposal = s.currentBatch.find(p => p.id === selector);
  }

  if (!proposal) {
    return { success: false, message: 'Proposal not found.' };
  }

  proposal.status = 'rejected';
  proposal.decidedAt = new Date().toISOString();
  s.history.push(proposal);
  saveStore();

  return { success: true, message: `Rejected "${proposal.title}".` };
}

// ============================================================================
// Query
// ============================================================================

export function getCurrentProposals(): Proposal[] {
  return loadStore().currentBatch;
}

export function getProposalHistory(limit = 20): Proposal[] {
  return loadStore().history.slice(0, limit);
}

export function getProposalStatus(): {
  currentBatch: Proposal[];
  batchDate: string;
  approvalsToday: number;
  canApprove: boolean;
  historyCount: number;
} {
  const s = loadStore();
  return {
    currentBatch: s.currentBatch,
    batchDate: s.batchGeneratedAt,
    approvalsToday: s.lastApprovalDate === today() ? s.approvalsToday : 0,
    canApprove: s.lastApprovalDate !== today() || s.approvalsToday < 1,
    historyCount: s.history.length,
  };
}

// ============================================================================
// PRD Generator
// ============================================================================

function buildSelfImprovementPRD(proposal: Proposal): string {
  return `## Self-Improvement: ${proposal.title}

### Category: ${proposal.category}
### Complexity: ${proposal.estimatedComplexity}
### Estimated files: ~${proposal.estimatedFiles}

### Description
${proposal.description}

### Rationale
${proposal.rationale}

### Constraints
- This is Jeeves modifying his own codebase
- Follow existing patterns in src/
- All imports use .js extension (ESM)
- Budget-enforce any new LLM calls via cost-tracker.ts
- Don't break existing functionality
- Add logging via the existing logger utility
- TypeScript strict mode — no any types unless necessary
- Create tests if a test framework is in place

### On Completion
- Create a PR to main
- Title: [jeeves-self] ${proposal.title}
- The PR will be auto-reviewed by the refinement loop before merging`;
}

// ============================================================================
// Context Gathering
// ============================================================================

async function gatherSelfContext(): Promise<{
  capabilities: string;
  recentErrors: string;
  usagePatterns: string;
  previouslyBuilt: string;
  doNotSuggestAgain: string;
}> {
  const s = loadStore();

  // List current capabilities from directory structure
  let capabilities = 'Core: handler, parser, executor, memory, trust\n';
  capabilities += 'Integrations: Cursor Background Agents, GitHub, Vercel, Signal\n';
  capabilities += 'Capabilities: Scout (intel), Security (monitoring), SaaS Builder, Revenue, Decisions\n';
  capabilities += 'Self: updater (git pull/build/restart), proposals (this system)\n';
  capabilities += 'Web UI: dashboard with Console, Homelab, Activity, Projects, Sites, Costs, Scout, Security, Clients tabs';

  // Recent errors from activity log
  let recentErrors = '';
  try {
    const activityPath = resolve(__dirname, '..', '..', '..', 'data', 'activity.json');
    if (existsSync(activityPath)) {
      const activity = JSON.parse(readFileSync(activityPath, 'utf-8'));
      const errors = (activity.entries || [])
        .filter((e: { success?: boolean; timestamp?: string }) => !e.success)
        .slice(0, 5);
      recentErrors = errors.length > 0
        ? errors.map((e: { action?: string; error?: string }) => `- ${e.action}: ${e.error || 'unknown'}`).join('\n')
        : 'None';
    }
  } catch {
    recentErrors = 'Could not read activity log';
  }

  // Usage patterns from cost tracker
  let usagePatterns = '';
  try {
    const costPath = resolve(__dirname, '..', '..', '..', 'data', 'cost-log.json');
    if (existsSync(costPath)) {
      const costData = JSON.parse(readFileSync(costPath, 'utf-8'));
      const totalCost = costData.totalCost || 0;
      const entries = costData.entries?.length || 0;
      usagePatterns = `Total API cost: $${totalCost.toFixed(4)}, ${entries} LLM calls logged`;
    }
  } catch {
    usagePatterns = 'No cost data available';
  }

  // Previously approved proposals
  const approved = s.history.filter(p => p.status === 'approved' || p.status === 'deployed');
  const previouslyBuilt = approved.length > 0
    ? approved.map(p => `- ${p.title} (${p.status})`).join('\n')
    : 'Nothing yet';

  // All titles ever suggested (any status) — so we can ask the LLM not to repeat them
  const allTitles = new Set<string>();
  for (const p of s.history) allTitles.add(p.title);
  for (const p of s.currentBatch) allTitles.add(p.title);
  const doNotSuggestAgain = allTitles.size > 0
    ? Array.from(allTitles).join(', ')
    : 'None';

  return { capabilities, recentErrors, usagePatterns, previouslyBuilt, doNotSuggestAgain };
}
