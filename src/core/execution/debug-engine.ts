/**
 * Debug Engine - Scientific Method Approach
 * 
 * Systematic debugging following the scientific method:
 * 1. OBSERVE: Gather evidence (logs, errors, behavior)
 * 2. HYPOTHESIZE: Form testable explanations
 * 3. EXPERIMENT: Design and run tests
 * 4. ANALYZE: Evaluate results
 * 5. CONCLUDE: Accept/reject hypothesis, iterate
 */

import { logger } from '../../utils/logger.js';
import { generateText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { trackLLMUsage } from '../cost-tracker.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// ==========================================
// TYPES
// ==========================================

export type DebugPhase = 'observe' | 'hypothesize' | 'experiment' | 'analyze' | 'conclude';

export interface BugReport {
  id: string;
  description: string;
  errorMessage?: string;
  stackTrace?: string;
  reproSteps?: string[];
  expectedBehavior?: string;
  actualBehavior?: string;
  environment?: Record<string, string>;
  affectedFiles?: string[];
  timestamp: number;
}

export interface Hypothesis {
  id: string;
  description: string;
  confidence: number;  // 0-1
  category: 'logic' | 'state' | 'data' | 'async' | 'dependency' | 'config' | 'environment';
  testable: boolean;
  testPlan?: string;
  evidence: {
    supporting: string[];
    contradicting: string[];
  };
  status: 'pending' | 'testing' | 'confirmed' | 'rejected';
}

export interface Experiment {
  id: string;
  hypothesisId: string;
  type: 'log_injection' | 'unit_test' | 'breakpoint' | 'comparison' | 'isolation' | 'bisect';
  description: string;
  code?: string;
  command?: string;
  expectedResult: string;
  actualResult?: string;
  conclusion?: 'supports' | 'contradicts' | 'inconclusive';
}

export interface DebugSession {
  id: string;
  bug: BugReport;
  phase: DebugPhase;
  observations: string[];
  hypotheses: Hypothesis[];
  experiments: Experiment[];
  resolution?: {
    rootCause: string;
    fix: string;
    preventionStrategy?: string;
  };
  startTime: number;
  endTime?: number;
}

// ==========================================
// DEBUG ENGINE CLASS
// ==========================================

export class DebugEngine {
  private sessions: Map<string, DebugSession> = new Map();
  private currentSession: DebugSession | null = null;
  
  /**
   * Start a new debug session
   */
  startSession(bug: BugReport): DebugSession {
    const session: DebugSession = {
      id: `debug_${Date.now()}`,
      bug,
      phase: 'observe',
      observations: [],
      hypotheses: [],
      experiments: [],
      startTime: Date.now()
    };
    
    this.sessions.set(session.id, session);
    this.currentSession = session;
    
    logger.debug('Debug session started', { sessionId: session.id });
    
    return session;
  }
  
  // ==========================================
  // PHASE 1: OBSERVE
  // ==========================================
  
  /**
   * Gather observations about the bug
   */
  async observe(additionalContext?: string): Promise<string[]> {
    if (!this.currentSession) {
      throw new Error('No active debug session');
    }
    
    const observations: string[] = [];
    const bug = this.currentSession.bug;
    
    // Parse error message
    if (bug.errorMessage) {
      observations.push(`Error: ${bug.errorMessage}`);
      
      // Extract key info from common error types
      if (bug.errorMessage.includes('undefined')) {
        observations.push('Observation: Something is undefined when accessed');
      }
      if (bug.errorMessage.includes('null')) {
        observations.push('Observation: Null value encountered unexpectedly');
      }
      if (bug.errorMessage.includes('type')) {
        observations.push('Observation: Type mismatch detected');
      }
      if (bug.errorMessage.includes('network') || bug.errorMessage.includes('fetch')) {
        observations.push('Observation: Network-related error');
      }
    }
    
    // Parse stack trace
    if (bug.stackTrace) {
      const lines = bug.stackTrace.split('\n').slice(0, 5);
      observations.push(`Stack trace (top ${lines.length} frames):`);
      
      for (const line of lines) {
        const match = line.match(/at\s+(\S+)\s+\(([^:]+):(\d+)/);
        if (match) {
          observations.push(`  - ${match[1]} at ${match[2]}:${match[3]}`);
        }
      }
    }
    
    // Reproduction pattern
    if (bug.reproSteps && bug.reproSteps.length > 0) {
      observations.push(`Reproduction steps: ${bug.reproSteps.length} steps identified`);
      observations.push(`First step: ${bug.reproSteps[0]}`);
      observations.push(`Final step: ${bug.reproSteps[bug.reproSteps.length - 1]}`);
    }
    
    // Additional context
    if (additionalContext) {
      observations.push(`Additional context: ${additionalContext}`);
    }
    
    this.currentSession.observations.push(...observations);
    this.currentSession.phase = 'hypothesize';
    
    logger.debug('Observations gathered', { count: observations.length });
    
    return observations;
  }
  
  // ==========================================
  // PHASE 2: HYPOTHESIZE
  // ==========================================
  
  /**
   * Generate hypotheses based on observations
   */
  async hypothesize(): Promise<Hypothesis[]> {
    if (!this.currentSession) {
      throw new Error('No active debug session');
    }
    
    const hypotheses: Hypothesis[] = [];
    const bug = this.currentSession.bug;
    const observations = this.currentSession.observations;
    
    // Quick pattern-based hypotheses
    hypotheses.push(...this.generateQuickHypotheses(bug, observations));
    
    // LLM-based deeper analysis
    if (hypotheses.length < 3) {
      const llmHypotheses = await this.generateLLMHypotheses(bug, observations);
      hypotheses.push(...llmHypotheses);
    }
    
    // Sort by confidence
    hypotheses.sort((a, b) => b.confidence - a.confidence);
    
    this.currentSession.hypotheses = hypotheses;
    this.currentSession.phase = 'experiment';
    
    logger.debug('Hypotheses generated', { count: hypotheses.length });
    
    return hypotheses;
  }
  
  private generateQuickHypotheses(bug: BugReport, observations: string[]): Hypothesis[] {
    const hypotheses: Hypothesis[] = [];
    const errorLower = (bug.errorMessage || '').toLowerCase();
    
    // Undefined/null access patterns
    if (errorLower.includes('undefined') || errorLower.includes('null')) {
      hypotheses.push({
        id: `hyp_null_${Date.now()}`,
        description: 'A variable is being accessed before initialization or after being set to null',
        confidence: 0.7,
        category: 'state',
        testable: true,
        testPlan: 'Add null checks and logging before the error line',
        evidence: { supporting: ['Error mentions undefined/null'], contradicting: [] },
        status: 'pending'
      });
    }
    
    // Async timing issues
    if (errorLower.includes('promise') || errorLower.includes('async') || 
        observations.some(o => o.includes('await') || o.includes('async'))) {
      hypotheses.push({
        id: `hyp_async_${Date.now()}`,
        description: 'Async operation completing in unexpected order or not being awaited',
        confidence: 0.6,
        category: 'async',
        testable: true,
        testPlan: 'Add logging with timestamps around async operations',
        evidence: { supporting: ['Async patterns detected'], contradicting: [] },
        status: 'pending'
      });
    }
    
    // Type errors
    if (errorLower.includes('type') || errorLower.includes('cannot read property')) {
      hypotheses.push({
        id: `hyp_type_${Date.now()}`,
        description: 'Type mismatch - receiving different type than expected',
        confidence: 0.65,
        category: 'data',
        testable: true,
        testPlan: 'Log typeof at key points to verify actual types',
        evidence: { supporting: ['Type error in message'], contradicting: [] },
        status: 'pending'
      });
    }
    
    // Import/dependency issues
    if (errorLower.includes('module') || errorLower.includes('import') || 
        errorLower.includes('require')) {
      hypotheses.push({
        id: `hyp_dep_${Date.now()}`,
        description: 'Module import or dependency resolution failing',
        confidence: 0.75,
        category: 'dependency',
        testable: true,
        testPlan: 'Check import paths and package installation',
        evidence: { supporting: ['Module-related error'], contradicting: [] },
        status: 'pending'
      });
    }
    
    return hypotheses;
  }
  
  private async generateLLMHypotheses(bug: BugReport, observations: string[]): Promise<Hypothesis[]> {
    try {
      const anthropic = createAnthropic({
        apiKey: process.env.ANTHROPIC_API_KEY
      });
      
      const prompt = `Analyze this bug and generate hypotheses:

BUG DESCRIPTION: ${bug.description}
ERROR: ${bug.errorMessage || 'None'}
STACK TRACE: ${bug.stackTrace?.slice(0, 500) || 'None'}
OBSERVATIONS:
${observations.map(o => `- ${o}`).join('\n')}

Generate 2-3 testable hypotheses about the root cause.
For each, provide:
1. Description of potential cause
2. Category: logic|state|data|async|dependency|config|environment
3. Confidence level (0-1)
4. A specific test to validate/invalidate it

Respond with JSON:
{
  "hypotheses": [
    {
      "description": "...",
      "category": "...",
      "confidence": 0.7,
      "testPlan": "..."
    }
  ]
}`;

      const result = await generateText({
        model: anthropic('claude-3-5-haiku-20241022'),
        prompt,
        maxTokens: 400
      });
      
      if (result.usage) {
        trackLLMUsage('debug-hypothesize', 'claude-3-5-haiku-20241022',
          result.usage.promptTokens, result.usage.completionTokens, false);
      }
      
      const parsed = JSON.parse(result.text.match(/\{[\s\S]*\}/)?.[0] || '{}');
      
      return (parsed.hypotheses || []).map((h: Partial<Hypothesis>, i: number) => ({
        id: `hyp_llm_${Date.now()}_${i}`,
        description: h.description || 'Unknown',
        confidence: h.confidence || 0.5,
        category: h.category || 'logic',
        testable: true,
        testPlan: h.testPlan,
        evidence: { supporting: [], contradicting: [] },
        status: 'pending' as const
      }));
      
    } catch (error) {
      logger.debug('LLM hypothesis generation failed', { error: String(error) });
      return [];
    }
  }
  
  // ==========================================
  // PHASE 3: EXPERIMENT
  // ==========================================
  
  /**
   * Design an experiment to test a hypothesis
   */
  designExperiment(hypothesisId: string): Experiment | null {
    if (!this.currentSession) return null;
    
    const hypothesis = this.currentSession.hypotheses.find(h => h.id === hypothesisId);
    if (!hypothesis) return null;
    
    const experiment: Experiment = {
      id: `exp_${Date.now()}`,
      hypothesisId,
      type: this.selectExperimentType(hypothesis),
      description: `Test: ${hypothesis.description}`,
      expectedResult: hypothesis.testPlan || 'Observe behavior change'
    };
    
    // Generate experiment code/command based on type
    switch (experiment.type) {
      case 'log_injection':
        experiment.code = this.generateLoggingCode(hypothesis);
        break;
      case 'isolation':
        experiment.code = this.generateIsolationTest(hypothesis);
        break;
      case 'comparison':
        experiment.description += ' (Compare working vs broken state)';
        break;
    }
    
    this.currentSession.experiments.push(experiment);
    hypothesis.status = 'testing';
    
    return experiment;
  }
  
  private selectExperimentType(hypothesis: Hypothesis): Experiment['type'] {
    switch (hypothesis.category) {
      case 'state':
      case 'data':
        return 'log_injection';
      case 'async':
        return 'log_injection';
      case 'dependency':
        return 'isolation';
      case 'logic':
        return 'unit_test';
      default:
        return 'comparison';
    }
  }
  
  private generateLoggingCode(hypothesis: Hypothesis): string {
    return `// Debug logging for: ${hypothesis.description}
console.log('[DEBUG] Entering function');
console.log('[DEBUG] Variable state:', JSON.stringify({
  // Add relevant variables here
}, null, 2));
console.log('[DEBUG] Timestamp:', Date.now());`;
  }
  
  private generateIsolationTest(hypothesis: Hypothesis): string {
    return `// Isolation test for: ${hypothesis.description}
describe('Isolation Test', () => {
  it('should work in isolated environment', async () => {
    // Mock dependencies
    const mockDep = jest.fn();
    
    // Run isolated
    const result = await functionUnderTest(mockDep);
    
    expect(result).toBeDefined();
  });
});`;
  }
  
  /**
   * Run an experiment
   */
  async runExperiment(experimentId: string, command?: string): Promise<Experiment> {
    if (!this.currentSession) {
      throw new Error('No active debug session');
    }
    
    const experiment = this.currentSession.experiments.find(e => e.id === experimentId);
    if (!experiment) {
      throw new Error('Experiment not found');
    }
    
    const cmd = command || experiment.command;
    if (cmd) {
      try {
        const { stdout, stderr } = await execAsync(cmd, { timeout: 30000 });
        experiment.actualResult = stdout || stderr || 'No output';
      } catch (error: unknown) {
        const errorOutput = error && typeof error === 'object' && 'stderr' in error
          ? String((error as { stderr: unknown }).stderr)
          : String(error);
        experiment.actualResult = `Error: ${errorOutput}`;
      }
    }
    
    return experiment;
  }
  
  // ==========================================
  // PHASE 4: ANALYZE
  // ==========================================
  
  /**
   * Analyze experiment results
   */
  analyzeResult(experimentId: string, actualResult: string): 'supports' | 'contradicts' | 'inconclusive' {
    if (!this.currentSession) {
      throw new Error('No active debug session');
    }
    
    const experiment = this.currentSession.experiments.find(e => e.id === experimentId);
    if (!experiment) {
      throw new Error('Experiment not found');
    }
    
    experiment.actualResult = actualResult;
    
    // Simple heuristic analysis
    const expected = experiment.expectedResult.toLowerCase();
    const actual = actualResult.toLowerCase();
    
    // Check for explicit success/failure
    if (actual.includes('pass') || actual.includes('success') || 
        actual.includes('confirmed') || actual.includes('expected')) {
      experiment.conclusion = 'supports';
    } else if (actual.includes('fail') || actual.includes('error') || 
               actual.includes('unexpected') || actual.includes('different')) {
      experiment.conclusion = 'contradicts';
    } else {
      experiment.conclusion = 'inconclusive';
    }
    
    // Update hypothesis
    const hypothesis = this.currentSession.hypotheses.find(h => h.id === experiment.hypothesisId);
    if (hypothesis) {
      if (experiment.conclusion === 'supports') {
        hypothesis.evidence.supporting.push(actualResult);
        hypothesis.confidence = Math.min(1, hypothesis.confidence + 0.15);
      } else if (experiment.conclusion === 'contradicts') {
        hypothesis.evidence.contradicting.push(actualResult);
        hypothesis.confidence = Math.max(0, hypothesis.confidence - 0.3);
      }
    }
    
    this.currentSession.phase = 'analyze';
    
    return experiment.conclusion;
  }
  
  // ==========================================
  // PHASE 5: CONCLUDE
  // ==========================================
  
  /**
   * Conclude the debug session with a resolution
   */
  conclude(rootCause: string, fix: string, preventionStrategy?: string): DebugSession {
    if (!this.currentSession) {
      throw new Error('No active debug session');
    }
    
    // Mark winning hypothesis
    const confirmedHypothesis = this.currentSession.hypotheses
      .sort((a, b) => b.confidence - a.confidence)[0];
    
    if (confirmedHypothesis) {
      confirmedHypothesis.status = 'confirmed';
    }
    
    this.currentSession.resolution = {
      rootCause,
      fix,
      preventionStrategy
    };
    
    this.currentSession.phase = 'conclude';
    this.currentSession.endTime = Date.now();
    
    logger.info('Debug session concluded', {
      sessionId: this.currentSession.id,
      duration: this.currentSession.endTime - this.currentSession.startTime,
      hypothesesTested: this.currentSession.experiments.length
    });
    
    const session = this.currentSession;
    this.currentSession = null;
    
    return session;
  }
  
  // ==========================================
  // SESSION MANAGEMENT
  // ==========================================
  
  /**
   * Get current session
   */
  getCurrentSession(): DebugSession | null {
    return this.currentSession;
  }
  
  /**
   * Get session by ID
   */
  getSession(id: string): DebugSession | undefined {
    return this.sessions.get(id);
  }
  
  /**
   * Generate a debug report
   */
  generateReport(sessionId?: string): string {
    const session = sessionId 
      ? this.sessions.get(sessionId) 
      : this.currentSession;
    
    if (!session) {
      return 'No debug session found';
    }
    
    const lines: string[] = [];
    
    lines.push('# Debug Session Report');
    lines.push(`**Session ID:** ${session.id}`);
    lines.push(`**Phase:** ${session.phase}`);
    lines.push(`**Duration:** ${session.endTime ? session.endTime - session.startTime : Date.now() - session.startTime}ms`);
    lines.push('');
    
    lines.push('## Bug Description');
    lines.push(session.bug.description);
    if (session.bug.errorMessage) {
      lines.push(`\n**Error:** ${session.bug.errorMessage}`);
    }
    lines.push('');
    
    lines.push('## Observations');
    for (const obs of session.observations) {
      lines.push(`- ${obs}`);
    }
    lines.push('');
    
    lines.push('## Hypotheses');
    for (const hyp of session.hypotheses) {
      const status = hyp.status === 'confirmed' ? '✅' : hyp.status === 'rejected' ? '❌' : '🔍';
      lines.push(`- ${status} [${(hyp.confidence * 100).toFixed(0)}%] ${hyp.description}`);
    }
    lines.push('');
    
    if (session.experiments.length > 0) {
      lines.push('## Experiments');
      for (const exp of session.experiments) {
        const result = exp.conclusion === 'supports' ? '✅' : exp.conclusion === 'contradicts' ? '❌' : '❓';
        lines.push(`- ${result} ${exp.description}`);
      }
      lines.push('');
    }
    
    if (session.resolution) {
      lines.push('## Resolution');
      lines.push(`**Root Cause:** ${session.resolution.rootCause}`);
      lines.push(`**Fix:** ${session.resolution.fix}`);
      if (session.resolution.preventionStrategy) {
        lines.push(`**Prevention:** ${session.resolution.preventionStrategy}`);
      }
    }
    
    return lines.join('\n');
  }
}

// ==========================================
// SINGLETON INSTANCE
// ==========================================

let instance: DebugEngine | null = null;

export function getDebugEngine(): DebugEngine {
  if (!instance) {
    instance = new DebugEngine();
  }
  return instance;
}
