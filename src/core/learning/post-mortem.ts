/**
 * Post-Mortem Learning System
 * 
 * After each significant task, analyzes:
 * - What went well
 * - What could be improved
 * - Root causes of issues
 * - Actionable improvements
 * 
 * Stores learnings for future reference and pattern improvement.
 */

import { logger } from '../../utils/logger.js';
import { generateText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { trackLLMUsage } from '../cost-tracker.js';
import * as fs from 'fs';
import * as path from 'path';

// ==========================================
// TYPES
// ==========================================

export interface TaskRecord {
  id: string;
  description: string;
  startTime: number;
  endTime?: number;
  status: 'success' | 'failure' | 'partial';
  steps: StepRecord[];
  errors: ErrorRecord[];
  userFeedback?: string;
  projectPath?: string;
}

export interface StepRecord {
  action: string;
  outcome: 'success' | 'failure' | 'skipped';
  duration: number;
  notes?: string;
}

export interface ErrorRecord {
  message: string;
  type: string;
  recoveryAttempt?: string;
  recovered: boolean;
  timestamp: number;
}

export interface PostMortem {
  id: string;
  taskId: string;
  timestamp: number;
  
  // Analysis
  wentWell: string[];
  improvements: string[];
  rootCauses: RootCause[];
  
  // Actions
  actionItems: ActionItem[];
  
  // Classification
  category: 'process' | 'technical' | 'communication' | 'tooling';
  severity: 'minor' | 'moderate' | 'major';
  
  // Learning extraction
  patterns: LearnedPattern[];
}

export interface RootCause {
  issue: string;
  cause: string;
  depth: number;  // How many "whys" deep
  preventable: boolean;
}

export interface ActionItem {
  id: string;
  action: string;
  assignee: 'jeeves' | 'user' | 'both';
  priority: 'low' | 'medium' | 'high';
  status: 'pending' | 'in_progress' | 'completed';
  dueDate?: number;
}

export interface LearnedPattern {
  trigger: string;
  response: string;
  confidence: number;
  applicableContexts: string[];
}

// ==========================================
// POST-MORTEM ENGINE
// ==========================================

export class PostMortemEngine {
  private postMortems: Map<string, PostMortem> = new Map();
  private patterns: Map<string, LearnedPattern> = new Map();
  private persistPath: string;
  
  constructor(dataDir: string = '.jeeves') {
    this.persistPath = path.join(dataDir, 'post-mortems.json');
    this.load();
  }
  
  private load(): void {
    try {
      if (fs.existsSync(this.persistPath)) {
        const data = JSON.parse(fs.readFileSync(this.persistPath, 'utf-8'));
        this.postMortems = new Map(Object.entries(data.postMortems || {}));
        this.patterns = new Map(Object.entries(data.patterns || {}));
      }
    } catch (error) {
      logger.debug('Failed to load post-mortems', { error: String(error) });
    }
  }
  
  private persist(): void {
    try {
      const dataDir = path.dirname(this.persistPath);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      
      fs.writeFileSync(this.persistPath, JSON.stringify({
        postMortems: Object.fromEntries(this.postMortems),
        patterns: Object.fromEntries(this.patterns)
      }, null, 2));
    } catch (error) {
      logger.error('Failed to persist post-mortems', { error: String(error) });
    }
  }
  
  // ==========================================
  // POST-MORTEM CREATION
  // ==========================================
  
  /**
   * Analyze a completed task and generate post-mortem
   */
  async analyze(task: TaskRecord): Promise<PostMortem> {
    logger.debug('Analyzing task for post-mortem', { taskId: task.id });
    
    // Quick analysis for simple tasks
    if (task.steps.length <= 3 && task.errors.length === 0) {
      return this.quickAnalysis(task);
    }
    
    // Deep analysis for complex tasks or failures
    return this.deepAnalysis(task);
  }
  
  /**
   * Quick analysis for simple/successful tasks
   */
  private quickAnalysis(task: TaskRecord): PostMortem {
    const pm: PostMortem = {
      id: `pm_${Date.now()}`,
      taskId: task.id,
      timestamp: Date.now(),
      wentWell: [],
      improvements: [],
      rootCauses: [],
      actionItems: [],
      category: 'process',
      severity: 'minor',
      patterns: []
    };
    
    // What went well
    if (task.status === 'success') {
      pm.wentWell.push('Task completed successfully');
    }
    
    const duration = (task.endTime || Date.now()) - task.startTime;
    if (duration < 60000) {  // Less than a minute
      pm.wentWell.push('Quick execution time');
    }
    
    // Store and return
    this.postMortems.set(pm.id, pm);
    this.persist();
    
    return pm;
  }
  
  /**
   * Deep analysis for complex tasks or failures
   */
  private async deepAnalysis(task: TaskRecord): Promise<PostMortem> {
    const pm: PostMortem = {
      id: `pm_${Date.now()}`,
      taskId: task.id,
      timestamp: Date.now(),
      wentWell: [],
      improvements: [],
      rootCauses: [],
      actionItems: [],
      category: 'process',
      severity: task.status === 'failure' ? 'major' : 'moderate',
      patterns: []
    };
    
    // Analyze steps
    const successfulSteps = task.steps.filter(s => s.outcome === 'success');
    const failedSteps = task.steps.filter(s => s.outcome === 'failure');
    
    if (successfulSteps.length > 0) {
      pm.wentWell.push(`${successfulSteps.length}/${task.steps.length} steps succeeded`);
    }
    
    if (failedSteps.length > 0) {
      pm.improvements.push(`Address ${failedSteps.length} failed steps`);
    }
    
    // Analyze errors
    if (task.errors.length > 0) {
      const rootCauses = await this.analyze5Whys(task.errors);
      pm.rootCauses.push(...rootCauses);
      
      // Generate action items from root causes
      for (const rc of rootCauses) {
        if (rc.preventable) {
          pm.actionItems.push({
            id: `action_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
            action: `Prevent: ${rc.issue}`,
            assignee: 'jeeves',
            priority: 'medium',
            status: 'pending'
          });
        }
      }
    }
    
    // Use LLM for deeper insights if there were issues
    if (task.status !== 'success' || task.errors.length > 0) {
      const llmInsights = await this.getLLMInsights(task);
      pm.wentWell.push(...llmInsights.wentWell);
      pm.improvements.push(...llmInsights.improvements);
      pm.patterns.push(...llmInsights.patterns);
    }
    
    // Extract and store patterns
    for (const pattern of pm.patterns) {
      this.patterns.set(pattern.trigger, pattern);
    }
    
    // Store and return
    this.postMortems.set(pm.id, pm);
    this.persist();
    
    logger.debug('Post-mortem completed', { 
      pmId: pm.id, 
      severity: pm.severity,
      actionItems: pm.actionItems.length
    });
    
    return pm;
  }
  
  /**
   * Apply 5 Whys analysis to errors
   */
  private async analyze5Whys(errors: ErrorRecord[]): Promise<RootCause[]> {
    const causes: RootCause[] = [];
    
    for (const error of errors.slice(0, 3)) {  // Limit to 3 errors
      // Simple heuristic root cause analysis
      const cause: RootCause = {
        issue: error.message,
        cause: this.inferCause(error),
        depth: 2,
        preventable: true
      };
      
      causes.push(cause);
    }
    
    return causes;
  }
  
  private inferCause(error: ErrorRecord): string {
    const message = error.message.toLowerCase();
    
    if (message.includes('undefined') || message.includes('null')) {
      return 'Missing null/undefined check before access';
    }
    if (message.includes('type')) {
      return 'Type mismatch - input validation needed';
    }
    if (message.includes('timeout')) {
      return 'Operation took too long - needs optimization or timeout increase';
    }
    if (message.includes('permission') || message.includes('access')) {
      return 'Insufficient permissions or access rights';
    }
    if (message.includes('network') || message.includes('connection')) {
      return 'Network connectivity or service availability issue';
    }
    
    return 'Unknown cause - needs investigation';
  }
  
  /**
   * Get deeper insights from LLM
   */
  private async getLLMInsights(task: TaskRecord): Promise<{
    wentWell: string[];
    improvements: string[];
    patterns: LearnedPattern[];
  }> {
    try {
      const anthropic = createAnthropic({
        apiKey: process.env.ANTHROPIC_API_KEY
      });
      
      const prompt = `Analyze this task execution for learning:

TASK: ${task.description}
STATUS: ${task.status}
STEPS: ${task.steps.map(s => `${s.action}: ${s.outcome}`).join('; ')}
ERRORS: ${task.errors.map(e => e.message).join('; ') || 'None'}
USER FEEDBACK: ${task.userFeedback || 'None'}

Provide:
1. What went well (2-3 points)
2. What could be improved (2-3 points)
3. A pattern to learn for similar future tasks

Respond with JSON:
{
  "wentWell": ["..."],
  "improvements": ["..."],
  "pattern": {
    "trigger": "when X happens",
    "response": "do Y",
    "contexts": ["context1"]
  }
}`;

      const result = await generateText({
        model: anthropic('claude-3-5-haiku-20241022'),
        prompt,
        maxTokens: 300
      });
      
      if (result.usage) {
        trackLLMUsage('post-mortem', 'claude-3-5-haiku-20241022',
          result.usage.promptTokens, result.usage.completionTokens, false);
      }
      
      const parsed = JSON.parse(result.text.match(/\{[\s\S]*\}/)?.[0] || '{}');
      
      const patterns: LearnedPattern[] = [];
      if (parsed.pattern) {
        patterns.push({
          trigger: parsed.pattern.trigger,
          response: parsed.pattern.response,
          confidence: 0.6,
          applicableContexts: parsed.pattern.contexts || []
        });
      }
      
      return {
        wentWell: parsed.wentWell || [],
        improvements: parsed.improvements || [],
        patterns
      };
      
    } catch (error) {
      logger.debug('LLM insights failed', { error: String(error) });
      return { wentWell: [], improvements: [], patterns: [] };
    }
  }
  
  // ==========================================
  // PATTERN APPLICATION
  // ==========================================
  
  /**
   * Find applicable patterns for a situation
   */
  findApplicablePatterns(context: string): LearnedPattern[] {
    const contextLower = context.toLowerCase();
    
    return Array.from(this.patterns.values())
      .filter(p => {
        const triggerLower = p.trigger.toLowerCase();
        return contextLower.includes(triggerLower) || 
               p.applicableContexts.some(c => contextLower.includes(c.toLowerCase()));
      })
      .sort((a, b) => b.confidence - a.confidence);
  }
  
  /**
   * Reinforce a pattern (it worked again)
   */
  reinforcePattern(trigger: string): void {
    const pattern = this.patterns.get(trigger);
    if (pattern) {
      pattern.confidence = Math.min(1, pattern.confidence + 0.1);
      this.persist();
    }
  }
  
  /**
   * Weaken a pattern (it didn't work)
   */
  weakenPattern(trigger: string): void {
    const pattern = this.patterns.get(trigger);
    if (pattern) {
      pattern.confidence = Math.max(0, pattern.confidence - 0.2);
      if (pattern.confidence < 0.2) {
        this.patterns.delete(trigger);
      }
      this.persist();
    }
  }
  
  // ==========================================
  // ACTION ITEM MANAGEMENT
  // ==========================================
  
  /**
   * Get pending action items
   */
  getPendingActions(): ActionItem[] {
    const actions: ActionItem[] = [];
    
    for (const pm of this.postMortems.values()) {
      for (const action of pm.actionItems) {
        if (action.status === 'pending' || action.status === 'in_progress') {
          actions.push(action);
        }
      }
    }
    
    return actions.sort((a, b) => {
      const priorityOrder = { high: 0, medium: 1, low: 2 };
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    });
  }
  
  /**
   * Complete an action item
   */
  completeAction(actionId: string): void {
    for (const pm of this.postMortems.values()) {
      const action = pm.actionItems.find(a => a.id === actionId);
      if (action) {
        action.status = 'completed';
        this.persist();
        return;
      }
    }
  }
  
  // ==========================================
  // REPORTING
  // ==========================================
  
  /**
   * Format post-mortem as markdown
   */
  formatReport(pm: PostMortem): string {
    const lines: string[] = [];
    
    lines.push('# Post-Mortem Report');
    lines.push(`**Task:** ${pm.taskId}`);
    lines.push(`**Category:** ${pm.category}`);
    lines.push(`**Severity:** ${pm.severity}`);
    lines.push('');
    
    if (pm.wentWell.length > 0) {
      lines.push('## What Went Well');
      pm.wentWell.forEach(w => lines.push(`- ✅ ${w}`));
      lines.push('');
    }
    
    if (pm.improvements.length > 0) {
      lines.push('## What Could Be Improved');
      pm.improvements.forEach(i => lines.push(`- 🔧 ${i}`));
      lines.push('');
    }
    
    if (pm.rootCauses.length > 0) {
      lines.push('## Root Causes');
      pm.rootCauses.forEach(rc => {
        lines.push(`- **Issue:** ${rc.issue}`);
        lines.push(`  **Cause:** ${rc.cause}`);
        lines.push(`  **Preventable:** ${rc.preventable ? 'Yes' : 'No'}`);
      });
      lines.push('');
    }
    
    if (pm.actionItems.length > 0) {
      lines.push('## Action Items');
      pm.actionItems.forEach(a => {
        const status = a.status === 'completed' ? '✅' : a.status === 'in_progress' ? '🔄' : '⏳';
        lines.push(`- ${status} [${a.priority}] ${a.action}`);
      });
      lines.push('');
    }
    
    if (pm.patterns.length > 0) {
      lines.push('## Learned Patterns');
      pm.patterns.forEach(p => {
        lines.push(`- When: ${p.trigger}`);
        lines.push(`  Do: ${p.response}`);
      });
    }
    
    return lines.join('\n');
  }
  
  /**
   * Get statistics
   */
  getStats(): {
    totalPostMortems: number;
    bySeverity: Record<string, number>;
    patternCount: number;
    pendingActions: number;
  } {
    const bySeverity: Record<string, number> = {
      minor: 0,
      moderate: 0,
      major: 0
    };
    
    let pendingActions = 0;
    
    for (const pm of this.postMortems.values()) {
      bySeverity[pm.severity]++;
      pendingActions += pm.actionItems.filter(a => a.status === 'pending').length;
    }
    
    return {
      totalPostMortems: this.postMortems.size,
      bySeverity,
      patternCount: this.patterns.size,
      pendingActions
    };
  }
}

// ==========================================
// SINGLETON INSTANCE
// ==========================================

let instance: PostMortemEngine | null = null;

export function getPostMortemEngine(dataDir?: string): PostMortemEngine {
  if (!instance) {
    instance = new PostMortemEngine(dataDir);
  }
  return instance;
}
