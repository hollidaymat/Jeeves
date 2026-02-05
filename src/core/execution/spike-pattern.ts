/**
 * Spike Pattern - Hypothesis-Driven Execution
 * 
 * For uncertain tasks, run quick experiments ("spikes") to:
 * 1. Validate approach before committing
 * 2. Test feasibility with minimal investment
 * 3. Gather information for better decisions
 * 4. Reduce risk on large changes
 */

import { logger } from '../../utils/logger.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execAsync = promisify(exec);

// ==========================================
// TYPES
// ==========================================

export type SpikeType = 
  | 'feasibility'    // Can this be done?
  | 'performance'    // How fast is this?
  | 'integration'    // Does this work with X?
  | 'compatibility'  // Does this work in environment Y?
  | 'approach'       // Which of these options is better?

export type SpikeStatus = 'planned' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface SpikeHypothesis {
  statement: string;
  successCriteria: string[];
  timeboxMinutes: number;
  riskLevel: 'low' | 'medium' | 'high';
}

export interface SpikeResult {
  hypothesis: SpikeHypothesis;
  validated: boolean;
  evidence: string[];
  learnings: string[];
  recommendation: string;
  timeSpent: number;
}

export interface Spike {
  id: string;
  type: SpikeType;
  name: string;
  description: string;
  hypothesis: SpikeHypothesis;
  status: SpikeStatus;
  
  // Execution
  steps: SpikeStep[];
  currentStep: number;
  
  // Results
  result?: SpikeResult;
  
  // Metadata
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  
  // Cleanup
  artifactsCreated: string[];
  cleanupRequired: boolean;
}

export interface SpikeStep {
  id: string;
  action: string;
  command?: string;
  expectedOutcome: string;
  actualOutcome?: string;
  status: 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
}

// ==========================================
// SPIKE ENGINE CLASS
// ==========================================

export class SpikeEngine {
  private spikes: Map<string, Spike> = new Map();
  private currentSpike: Spike | null = null;
  private workDir: string;
  
  constructor(workDir: string = '.jeeves/spikes') {
    this.workDir = workDir;
  }
  
  /**
   * Create a new spike experiment
   */
  createSpike(
    type: SpikeType,
    name: string,
    hypothesis: SpikeHypothesis,
    steps: Omit<SpikeStep, 'id' | 'status'>[]
  ): Spike {
    const spike: Spike = {
      id: `spike_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      type,
      name,
      description: `${type} spike: ${name}`,
      hypothesis,
      status: 'planned',
      steps: steps.map((s, i) => ({
        ...s,
        id: `step_${i}`,
        status: 'pending' as const
      })),
      currentStep: 0,
      createdAt: Date.now(),
      artifactsCreated: [],
      cleanupRequired: false
    };
    
    this.spikes.set(spike.id, spike);
    
    logger.debug('Spike created', { id: spike.id, type, name });
    
    return spike;
  }
  
  /**
   * Create a feasibility spike
   */
  createFeasibilitySpike(
    question: string,
    successCriteria: string[],
    timeboxMinutes: number = 30
  ): Spike {
    return this.createSpike(
      'feasibility',
      question,
      {
        statement: `It is feasible to: ${question}`,
        successCriteria,
        timeboxMinutes,
        riskLevel: 'low'
      },
      [
        {
          action: 'Initial investigation',
          expectedOutcome: 'Understand the requirements'
        },
        {
          action: 'Prototype minimal implementation',
          expectedOutcome: 'Working proof of concept'
        },
        {
          action: 'Validate against criteria',
          expectedOutcome: 'All criteria checked'
        }
      ]
    );
  }
  
  /**
   * Create an approach comparison spike
   */
  createApproachSpike(
    options: { name: string; description: string }[],
    evaluationCriteria: string[]
  ): Spike {
    const steps: Omit<SpikeStep, 'id' | 'status'>[] = [];
    
    for (const option of options) {
      steps.push({
        action: `Test approach: ${option.name}`,
        expectedOutcome: `Evaluate ${option.name} against criteria`
      });
    }
    
    steps.push({
      action: 'Compare results',
      expectedOutcome: 'Clear winner or trade-off analysis'
    });
    
    return this.createSpike(
      'approach',
      `Compare: ${options.map(o => o.name).join(' vs ')}`,
      {
        statement: `Determine best approach among: ${options.map(o => o.name).join(', ')}`,
        successCriteria: evaluationCriteria,
        timeboxMinutes: 60,
        riskLevel: 'low'
      },
      steps
    );
  }
  
  // ==========================================
  // SPIKE EXECUTION
  // ==========================================
  
  /**
   * Start running a spike
   */
  async startSpike(spikeId: string): Promise<Spike> {
    const spike = this.spikes.get(spikeId);
    if (!spike) {
      throw new Error(`Spike not found: ${spikeId}`);
    }
    
    if (spike.status !== 'planned') {
      throw new Error(`Spike already started: ${spike.status}`);
    }
    
    // Create isolated workspace
    const spikeDir = path.join(this.workDir, spike.id);
    if (!fs.existsSync(spikeDir)) {
      fs.mkdirSync(spikeDir, { recursive: true });
      spike.artifactsCreated.push(spikeDir);
    }
    
    spike.status = 'running';
    spike.startedAt = Date.now();
    this.currentSpike = spike;
    
    logger.debug('Spike started', { id: spike.id });
    
    return spike;
  }
  
  /**
   * Execute the next step in the spike
   */
  async executeStep(outcome?: string): Promise<SpikeStep | null> {
    if (!this.currentSpike) {
      throw new Error('No active spike');
    }
    
    const spike = this.currentSpike;
    
    // Record previous step outcome
    if (spike.currentStep > 0 && outcome) {
      const prevStep = spike.steps[spike.currentStep - 1];
      prevStep.actualOutcome = outcome;
      prevStep.status = this.evaluateStepOutcome(prevStep) ? 'passed' : 'failed';
    }
    
    // Check if done
    if (spike.currentStep >= spike.steps.length) {
      return null;
    }
    
    // Get current step
    const step = spike.steps[spike.currentStep];
    step.status = 'running';
    spike.currentStep++;
    
    // Execute command if present
    if (step.command) {
      try {
        const { stdout, stderr } = await execAsync(step.command, {
          cwd: path.join(this.workDir, spike.id),
          timeout: 60000
        });
        step.actualOutcome = stdout || stderr || 'Command completed';
      } catch (error: unknown) {
        const errorOutput = error && typeof error === 'object' && 'stderr' in error
          ? String((error as { stderr: unknown }).stderr)
          : String(error);
        step.actualOutcome = `Error: ${errorOutput}`;
        step.status = 'failed';
      }
    }
    
    logger.debug('Spike step executed', { 
      spikeId: spike.id, 
      step: step.action,
      status: step.status
    });
    
    return step;
  }
  
  /**
   * Record step outcome manually
   */
  recordStepOutcome(outcome: string, passed: boolean): void {
    if (!this.currentSpike) return;
    
    const step = this.currentSpike.steps[this.currentSpike.currentStep - 1];
    if (step) {
      step.actualOutcome = outcome;
      step.status = passed ? 'passed' : 'failed';
    }
  }
  
  private evaluateStepOutcome(step: SpikeStep): boolean {
    if (!step.actualOutcome) return false;
    
    // Check if actual outcome indicates failure
    const failureIndicators = ['error', 'failed', 'exception', 'cannot', 'unable'];
    const outcomeLower = step.actualOutcome.toLowerCase();
    
    return !failureIndicators.some(indicator => outcomeLower.includes(indicator));
  }
  
  // ==========================================
  // SPIKE COMPLETION
  // ==========================================
  
  /**
   * Complete the spike with analysis
   */
  completeSpike(
    validated: boolean,
    evidence: string[],
    learnings: string[],
    recommendation: string
  ): SpikeResult {
    if (!this.currentSpike) {
      throw new Error('No active spike');
    }
    
    const spike = this.currentSpike;
    const timeSpent = Date.now() - (spike.startedAt || Date.now());
    
    const result: SpikeResult = {
      hypothesis: spike.hypothesis,
      validated,
      evidence,
      learnings,
      recommendation,
      timeSpent
    };
    
    spike.result = result;
    spike.status = 'completed';
    spike.completedAt = Date.now();
    spike.cleanupRequired = true;
    
    this.currentSpike = null;
    
    logger.info('Spike completed', {
      id: spike.id,
      validated,
      timeSpent
    });
    
    return result;
  }
  
  /**
   * Cancel an active spike
   */
  cancelSpike(reason: string): void {
    if (!this.currentSpike) return;
    
    this.currentSpike.status = 'cancelled';
    this.currentSpike.completedAt = Date.now();
    
    // Skip remaining steps
    for (const step of this.currentSpike.steps) {
      if (step.status === 'pending') {
        step.status = 'skipped';
        step.actualOutcome = `Skipped: ${reason}`;
      }
    }
    
    this.currentSpike.cleanupRequired = true;
    
    logger.debug('Spike cancelled', { id: this.currentSpike.id, reason });
    
    this.currentSpike = null;
  }
  
  /**
   * Check if spike exceeded timebox
   */
  isOverTimebox(): boolean {
    if (!this.currentSpike?.startedAt) return false;
    
    const elapsed = Date.now() - this.currentSpike.startedAt;
    const timeboxMs = this.currentSpike.hypothesis.timeboxMinutes * 60 * 1000;
    
    return elapsed > timeboxMs;
  }
  
  // ==========================================
  // CLEANUP
  // ==========================================
  
  /**
   * Clean up spike artifacts
   */
  async cleanup(spikeId: string): Promise<void> {
    const spike = this.spikes.get(spikeId);
    if (!spike || !spike.cleanupRequired) return;
    
    for (const artifact of spike.artifactsCreated) {
      try {
        if (fs.existsSync(artifact)) {
          if (fs.statSync(artifact).isDirectory()) {
            fs.rmSync(artifact, { recursive: true });
          } else {
            fs.unlinkSync(artifact);
          }
        }
      } catch (error) {
        logger.debug('Failed to cleanup artifact', { artifact, error: String(error) });
      }
    }
    
    spike.artifactsCreated = [];
    spike.cleanupRequired = false;
    
    logger.debug('Spike cleaned up', { id: spikeId });
  }
  
  // ==========================================
  // SPIKE QUERIES
  // ==========================================
  
  /**
   * Get current spike
   */
  getCurrentSpike(): Spike | null {
    return this.currentSpike;
  }
  
  /**
   * Get spike by ID
   */
  getSpike(id: string): Spike | undefined {
    return this.spikes.get(id);
  }
  
  /**
   * Get recent spikes
   */
  getRecentSpikes(limit: number = 10): Spike[] {
    return Array.from(this.spikes.values())
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }
  
  /**
   * Get successful spikes for learning
   */
  getSuccessfulSpikes(type?: SpikeType): Spike[] {
    return Array.from(this.spikes.values())
      .filter(s => s.status === 'completed' && s.result?.validated)
      .filter(s => !type || s.type === type);
  }
  
  // ==========================================
  // REPORTING
  // ==========================================
  
  /**
   * Generate spike report
   */
  generateReport(spikeId: string): string {
    const spike = this.spikes.get(spikeId);
    if (!spike) return 'Spike not found';
    
    const lines: string[] = [];
    
    lines.push(`# Spike Report: ${spike.name}`);
    lines.push(`**Type:** ${spike.type}`);
    lines.push(`**Status:** ${spike.status}`);
    lines.push('');
    
    lines.push('## Hypothesis');
    lines.push(spike.hypothesis.statement);
    lines.push('');
    
    lines.push('### Success Criteria');
    for (const criteria of spike.hypothesis.successCriteria) {
      lines.push(`- ${criteria}`);
    }
    lines.push('');
    
    lines.push('## Steps');
    for (const step of spike.steps) {
      const icon = step.status === 'passed' ? '✅' : 
                   step.status === 'failed' ? '❌' :
                   step.status === 'skipped' ? '⏭️' : '⏳';
      lines.push(`${icon} **${step.action}**`);
      if (step.actualOutcome) {
        lines.push(`   → ${step.actualOutcome}`);
      }
    }
    lines.push('');
    
    if (spike.result) {
      lines.push('## Result');
      lines.push(`**Validated:** ${spike.result.validated ? 'Yes ✅' : 'No ❌'}`);
      lines.push(`**Time Spent:** ${Math.round(spike.result.timeSpent / 60000)} minutes`);
      lines.push('');
      
      if (spike.result.evidence.length > 0) {
        lines.push('### Evidence');
        for (const e of spike.result.evidence) {
          lines.push(`- ${e}`);
        }
        lines.push('');
      }
      
      if (spike.result.learnings.length > 0) {
        lines.push('### Learnings');
        for (const l of spike.result.learnings) {
          lines.push(`- ${l}`);
        }
        lines.push('');
      }
      
      lines.push('### Recommendation');
      lines.push(spike.result.recommendation);
    }
    
    return lines.join('\n');
  }
  
  /**
   * Get statistics
   */
  getStats(): {
    total: number;
    byType: Record<SpikeType, number>;
    byStatus: Record<SpikeStatus, number>;
    validationRate: number;
  } {
    const byType: Record<SpikeType, number> = {
      feasibility: 0,
      performance: 0,
      integration: 0,
      compatibility: 0,
      approach: 0
    };
    
    const byStatus: Record<SpikeStatus, number> = {
      planned: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0
    };
    
    let validated = 0;
    let total = 0;
    
    for (const spike of this.spikes.values()) {
      byType[spike.type]++;
      byStatus[spike.status]++;
      
      if (spike.status === 'completed') {
        total++;
        if (spike.result?.validated) validated++;
      }
    }
    
    return {
      total: this.spikes.size,
      byType,
      byStatus,
      validationRate: total > 0 ? validated / total : 0
    };
  }
}

// ==========================================
// SINGLETON INSTANCE
// ==========================================

let instance: SpikeEngine | null = null;

export function getSpikeEngine(workDir?: string): SpikeEngine {
  if (!instance) {
    instance = new SpikeEngine(workDir);
  }
  return instance;
}

export function resetSpikeEngine(): void {
  instance = null;
}
