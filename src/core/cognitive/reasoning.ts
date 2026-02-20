/**
 * Pre-Execution Reasoning Engine
 * 
 * Implements OODA loop before every non-trivial action:
 * - OBSERVE: Parse request, retrieve relevant memory
 * - ORIENT: Apply principles, identify risks
 * - DECIDE: Act / Ask / Refuse
 * - ACT: Execute with checkpoints
 */

import { generateText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';
import { trackLLMUsage } from '../cost-tracker.js';
import { 
  ConfidenceResult, 
  ConfidenceAction,
  deepScore,
  quickScore,
  shouldBypassScoring
} from './confidence.js';

// ==========================================
// TYPES
// ==========================================

export interface ReasoningInput {
  message: string;
  hasActiveProject: boolean;
  projectPath?: string;
  hasRelevantMemory: boolean;
  relevantMemories?: string[];
}

export interface ReasoningStep {
  phase: 'observe' | 'orient' | 'decide' | 'act';
  thinking: string;
  timestamp: number;
}

export interface ReasoningPlan {
  approach: string;
  steps: string[];
  checkpoints: string[];
  successCriteria: string[];
  risks: string[];
  mitigations: string[];
}

export interface ReasoningResult {
  shouldProceed: boolean;
  shouldAsk: boolean;
  shouldRefuse: boolean;
  
  confidence: ConfidenceResult;
  action: ConfidenceAction;
  
  // OBSERVE
  understanding: string;
  implicitContext: string[];
  assumptions: string[];
  
  // ORIENT
  approaches: string[];
  selectedApproach: string;
  risks: string[];
  
  // DECIDE
  decision: 'proceed' | 'ask' | 'refuse';
  rationale: string;
  
  // ACT (if proceeding)
  plan?: ReasoningPlan;
  
  // If asking
  questions?: string[];
  
  // If refusing
  refusalReason?: string;
  
  // Trace
  steps: ReasoningStep[];
}

// ==========================================
// OODA LOOP IMPLEMENTATION
// ==========================================

/**
 * Full reasoning cycle for complex requests
 * Uses LLM for deep analysis
 */
export async function reason(input: ReasoningInput): Promise<ReasoningResult> {
  const steps: ReasoningStep[] = [];
  const startTime = Date.now();
  
  // Quick bypass for trivial requests
  if (shouldBypassScoring(input.message)) {
    return createTrivialResult(input, steps);
  }
  
  // PHASE 1: OBSERVE
  const observeResult = await observe(input);
  steps.push({
    phase: 'observe',
    thinking: observeResult.summary,
    timestamp: Date.now() - startTime
  });
  
  // PHASE 2: ORIENT (includes confidence scoring)
  const orientResult = await orient(input, observeResult);
  steps.push({
    phase: 'orient',
    thinking: orientResult.summary,
    timestamp: Date.now() - startTime
  });
  
  // PHASE 3: DECIDE
  const decideResult = await decide(input, observeResult, orientResult);
  steps.push({
    phase: 'decide',
    thinking: decideResult.summary,
    timestamp: Date.now() - startTime
  });
  
  // PHASE 4: PLAN (if proceeding)
  let plan: ReasoningPlan | undefined;
  if (decideResult.decision === 'proceed') {
    plan = await createPlan(input, observeResult, orientResult);
    steps.push({
      phase: 'act',
      thinking: `Plan: ${plan.steps.length} steps, ${plan.checkpoints.length} checkpoints`,
      timestamp: Date.now() - startTime
    });
  }
  
  logger.debug('Reasoning complete', {
    message: input.message.substring(0, 50),
    decision: decideResult.decision,
    confidence: orientResult.confidence.score.overall,
    steps: steps.length
  });
  
  return {
    shouldProceed: decideResult.decision === 'proceed',
    shouldAsk: decideResult.decision === 'ask',
    shouldRefuse: decideResult.decision === 'refuse',
    
    confidence: orientResult.confidence,
    action: orientResult.confidence.action,
    
    // OBSERVE
    understanding: observeResult.understanding,
    implicitContext: observeResult.implicitContext,
    assumptions: observeResult.assumptions,
    
    // ORIENT
    approaches: orientResult.approaches,
    selectedApproach: orientResult.selectedApproach,
    risks: orientResult.risks,
    
    // DECIDE
    decision: decideResult.decision,
    rationale: decideResult.rationale,
    
    // ACT
    plan,
    
    // If asking
    questions: decideResult.decision === 'ask' ? decideResult.questions : undefined,
    
    // If refusing
    refusalReason: decideResult.decision === 'refuse' ? decideResult.refusalReason : undefined,
    
    steps
  };
}

// ==========================================
// OBSERVE PHASE
// ==========================================

interface ObserveResult {
  understanding: string;
  implicitContext: string[];
  assumptions: string[];
  summary: string;
}

async function observe(input: ReasoningInput): Promise<ObserveResult> {
  // For simple requests, use heuristic analysis
  const wordCount = input.message.split(/\s+/).length;
  
  if (wordCount <= 10) {
    // Simple heuristic observation
    return {
      understanding: input.message,
      implicitContext: [],
      assumptions: input.hasActiveProject ? ['Using currently active project'] : [],
      summary: `Direct request: "${input.message}"`
    };
  }
  
  // For complex requests, use LLM
  try {
    const anthropic = createAnthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });
    
    const prompt = `OBSERVE PHASE: Analyze this request.

REQUEST: "${input.message}"

CONTEXT:
- Active project: ${input.hasActiveProject ? 'Yes' : 'No'}
- Project path: ${input.projectPath || 'None'}
- Has relevant memories: ${input.hasRelevantMemory}
${input.relevantMemories?.length ? `- Memories: ${input.relevantMemories.join('; ')}` : ''}

Analyze:
1. What is actually being asked? (restate in your own words)
2. What's the implicit context? (what aren't they saying?)
3. What assumptions are you making?

Respond with ONLY JSON:
{
  "understanding": "...",
  "implicitContext": ["..."],
  "assumptions": ["..."]
}`;

    const result = await generateText({
      model: anthropic(config.claude.haiku_model),
      prompt,
      maxTokens: 250
    });
    
    if (result.usage) {
      trackLLMUsage('reasoning_observe', config.claude.haiku_model, 
        result.usage.promptTokens, result.usage.completionTokens, false);
    }
    
    const parsed = JSON.parse(result.text.match(/\{[\s\S]*\}/)?.[0] || '{}');
    
    return {
      understanding: parsed.understanding || input.message,
      implicitContext: parsed.implicitContext || [],
      assumptions: parsed.assumptions || [],
      summary: `Understood: ${parsed.understanding?.substring(0, 50) || input.message}`
    };
    
  } catch (error) {
    logger.debug('Observe phase fallback to heuristic', { error: String(error) });
    return {
      understanding: input.message,
      implicitContext: [],
      assumptions: [],
      summary: `Direct interpretation of request`
    };
  }
}

// ==========================================
// ORIENT PHASE
// ==========================================

interface OrientResult {
  confidence: ConfidenceResult;
  approaches: string[];
  selectedApproach: string;
  risks: string[];
  summary: string;
}

async function orient(input: ReasoningInput, observe: ObserveResult): Promise<OrientResult> {
  // Get confidence score
  const confidence = await deepScore(input.message, {
    hasActiveProject: input.hasActiveProject,
    hasRelevantMemory: input.hasRelevantMemory
  });
  
  // For high-confidence simple tasks, use heuristics
  if (confidence.score.overall >= 0.85) {
    return {
      confidence,
      approaches: ['Direct execution'],
      selectedApproach: 'Direct execution - high confidence',
      risks: confidence.concerns,
      summary: `High confidence (${(confidence.score.overall * 100).toFixed(0)}%), direct approach`
    };
  }
  
  // For complex or uncertain tasks, use LLM
  try {
    const anthropic = createAnthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });
    
    const prompt = `ORIENT PHASE: Evaluate approaches.

UNDERSTANDING: ${observe.understanding}
ASSUMPTIONS: ${observe.assumptions.join(', ') || 'None'}
CONFIDENCE: ${(confidence.score.overall * 100).toFixed(0)}%
CONCERNS: ${confidence.concerns.join(', ') || 'None'}

Consider:
1. What are 2-3 ways you could approach this?
2. Which approach is best and why?
3. What could go wrong?

Respond with ONLY JSON:
{
  "approaches": ["approach 1", "approach 2"],
  "selectedApproach": "The best approach because...",
  "risks": ["risk 1", "risk 2"]
}`;

    const result = await generateText({
      model: anthropic(config.claude.haiku_model),
      prompt,
      maxTokens: 250
    });
    
    if (result.usage) {
      trackLLMUsage('reasoning_orient', config.claude.haiku_model,
        result.usage.promptTokens, result.usage.completionTokens, false);
    }
    
    const parsed = JSON.parse(result.text.match(/\{[\s\S]*\}/)?.[0] || '{}');
    
    return {
      confidence,
      approaches: parsed.approaches || ['Direct approach'],
      selectedApproach: parsed.selectedApproach || 'Direct approach',
      risks: [...(confidence.concerns || []), ...(parsed.risks || [])],
      summary: `Confidence ${(confidence.score.overall * 100).toFixed(0)}%, ${parsed.approaches?.length || 1} approaches considered`
    };
    
  } catch (error) {
    logger.debug('Orient phase fallback', { error: String(error) });
    return {
      confidence,
      approaches: ['Direct approach'],
      selectedApproach: 'Direct approach (fallback)',
      risks: confidence.concerns,
      summary: `Confidence ${(confidence.score.overall * 100).toFixed(0)}%`
    };
  }
}

// ==========================================
// DECIDE PHASE
// ==========================================

interface DecideResult {
  decision: 'proceed' | 'ask' | 'refuse';
  rationale: string;
  questions?: string[];
  refusalReason?: string;
  summary: string;
}

async function decide(
  input: ReasoningInput, 
  observe: ObserveResult, 
  orient: OrientResult
): Promise<DecideResult> {
  const confidence = orient.confidence;
  
  // High confidence → proceed
  if (confidence.action === 'act_autonomous') {
    return {
      decision: 'proceed',
      rationale: `High confidence (${(confidence.score.overall * 100).toFixed(0)}%). Proceeding with: ${orient.selectedApproach}`,
      summary: 'PROCEED - autonomous'
    };
  }
  
  // Moderate confidence → proceed with notice
  if (confidence.action === 'act_with_notice') {
    return {
      decision: 'proceed',
      rationale: `Moderate confidence (${(confidence.score.overall * 100).toFixed(0)}%). Proceeding with assumptions: ${observe.assumptions.join(', ') || 'none stated'}`,
      summary: 'PROCEED - with notice'
    };
  }
  
  // Low confidence → ask first
  if (confidence.action === 'ask_first') {
    const questions = confidence.suggestedQuestions.length > 0
      ? confidence.suggestedQuestions.slice(0, 3)  // Max 3 questions
      : generateDefaultQuestions(observe, orient);
    
    return {
      decision: 'ask',
      rationale: `Low confidence (${(confidence.score.overall * 100).toFixed(0)}%). Need clarification before proceeding.`,
      questions,
      summary: 'ASK - need clarification'
    };
  }
  
  // Very low confidence → refuse
  return {
    decision: 'refuse',
    rationale: `Very low confidence (${(confidence.score.overall * 100).toFixed(0)}%). Cannot proceed safely.`,
    refusalReason: generateRefusalReason(confidence, orient),
    summary: 'REFUSE - too uncertain'
  };
}

function generateDefaultQuestions(observe: ObserveResult, orient: OrientResult): string[] {
  const questions: string[] = [];
  
  if (observe.assumptions.length > 0) {
    questions.push(`I'm assuming ${observe.assumptions[0]}. Is that correct?`);
  }
  
  if (orient.approaches.length > 1) {
    questions.push(`Would you prefer: ${orient.approaches.slice(0, 2).join(' or ')}?`);
  }
  
  if (orient.risks.length > 0) {
    questions.push(`This involves ${orient.risks[0].toLowerCase()}. Should I proceed?`);
  }
  
  if (questions.length === 0) {
    questions.push('Can you provide more details about what you want?');
  }
  
  return questions.slice(0, 3);
}

function generateRefusalReason(confidence: ConfidenceResult, orient: OrientResult): string {
  const score = confidence.score;
  const issues: string[] = [];
  
  if (score.understanding < 0.5) {
    issues.push("I don't fully understand what's being asked");
  }
  if (score.capability < 0.5) {
    issues.push("I'm not sure I can do this");
  }
  if (score.safety < 0.5) {
    issues.push("This seems risky");
  }
  
  if (issues.length === 0) {
    issues.push("I'm not confident I can do this correctly");
  }
  
  return issues.join('. ') + '. ' + 
    (orient.risks.length > 0 ? `Concerns: ${orient.risks.join(', ')}.` : '');
}

// ==========================================
// PLAN PHASE
// ==========================================

async function createPlan(
  input: ReasoningInput,
  observe: ObserveResult,
  orient: OrientResult
): Promise<ReasoningPlan> {
  // For simple requests, create minimal plan
  const wordCount = input.message.split(/\s+/).length;
  
  if (wordCount <= 10 && orient.confidence.score.overall >= 0.85) {
    return {
      approach: orient.selectedApproach,
      steps: ['Execute request directly'],
      checkpoints: [],
      successCriteria: ['Request completed'],
      risks: orient.risks,
      mitigations: []
    };
  }
  
  try {
    const anthropic = createAnthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });
    
    const prompt = `CREATE EXECUTION PLAN

TASK: ${observe.understanding}
APPROACH: ${orient.selectedApproach}
RISKS: ${orient.risks.join(', ') || 'None identified'}

Create a step-by-step plan with:
1. Concrete steps (3-7)
2. Checkpoints (points to verify progress)
3. Success criteria (how do we know it's done?)
4. Risk mitigations

Respond with ONLY JSON:
{
  "steps": ["step 1", "step 2", ...],
  "checkpoints": ["after step X, verify Y"],
  "successCriteria": ["criterion 1"],
  "mitigations": ["for risk X, do Y"]
}`;

    const result = await generateText({
      model: anthropic(config.claude.haiku_model),
      prompt,
      maxTokens: 300
    });
    
    if (result.usage) {
      trackLLMUsage('reasoning_plan', config.claude.haiku_model,
        result.usage.promptTokens, result.usage.completionTokens, false);
    }
    
    const parsed = JSON.parse(result.text.match(/\{[\s\S]*\}/)?.[0] || '{}');
    
    return {
      approach: orient.selectedApproach,
      steps: parsed.steps || ['Execute request'],
      checkpoints: parsed.checkpoints || [],
      successCriteria: parsed.successCriteria || ['Completed successfully'],
      risks: orient.risks,
      mitigations: parsed.mitigations || []
    };
    
  } catch (error) {
    logger.debug('Plan creation fallback', { error: String(error) });
    return {
      approach: orient.selectedApproach,
      steps: ['Execute request directly'],
      checkpoints: [],
      successCriteria: ['Request completed'],
      risks: orient.risks,
      mitigations: []
    };
  }
}

// ==========================================
// TRIVIAL REQUEST HANDLER
// ==========================================

function createTrivialResult(input: ReasoningInput, steps: ReasoningStep[]): ReasoningResult {
  const confidence = quickScore(input.message, {
    hasActiveProject: input.hasActiveProject,
    hasRelevantMemory: input.hasRelevantMemory
  });
  
  steps.push({
    phase: 'decide',
    thinking: 'Trivial request - bypassing full reasoning',
    timestamp: 0
  });
  
  return {
    shouldProceed: true,
    shouldAsk: false,
    shouldRefuse: false,
    
    confidence,
    action: 'act_autonomous',
    
    understanding: input.message,
    implicitContext: [],
    assumptions: [],
    
    approaches: ['Direct execution'],
    selectedApproach: 'Direct execution',
    risks: [],
    
    decision: 'proceed',
    rationale: 'Trivial request with high confidence',
    
    plan: {
      approach: 'Direct execution',
      steps: ['Execute'],
      checkpoints: [],
      successCriteria: ['Done'],
      risks: [],
      mitigations: []
    },
    
    steps
  };
}

// ==========================================
// UTILITY FUNCTIONS
// ==========================================

export function formatReasoningReport(result: ReasoningResult): string {
  let report = `## Reasoning Report

**Decision:** ${result.decision.toUpperCase()}
**Confidence:** ${(result.confidence.score.overall * 100).toFixed(0)}%

### Understanding
${result.understanding}
`;

  if (result.assumptions.length > 0) {
    report += `\n**Assumptions:**\n${result.assumptions.map(a => `- ${a}`).join('\n')}\n`;
  }

  if (result.approaches.length > 1) {
    report += `\n**Approaches considered:**\n${result.approaches.map(a => `- ${a}`).join('\n')}\n`;
  }

  report += `\n**Selected:** ${result.selectedApproach}\n`;

  if (result.risks.length > 0) {
    report += `\n**Risks:**\n${result.risks.map(r => `- ${r}`).join('\n')}\n`;
  }

  if (result.plan) {
    report += `\n**Plan:**\n${result.plan.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n`;
  }

  if (result.questions && result.questions.length > 0) {
    report += `\n**Questions:**\n${result.questions.map(q => `- ${q}`).join('\n')}\n`;
  }

  if (result.refusalReason) {
    report += `\n**Reason for refusal:** ${result.refusalReason}\n`;
  }

  return report;
}
