/**
 * Proactive Intelligence - Anticipatory Actions
 * 
 * Identifies opportunities to help before being asked:
 * - Pattern detection in user behavior
 * - Predictive suggestions
 * - Automated maintenance tasks
 * - Risk detection and early warning
 */

import { logger } from '../../utils/logger.js';

// ==========================================
// TYPES
// ==========================================

export type ActionCategory = 
  | 'optimization'
  | 'maintenance'
  | 'security'
  | 'quality'
  | 'productivity'
  | 'learning';

export type ActionPriority = 'low' | 'medium' | 'high' | 'critical';

export interface ProactiveAction {
  id: string;
  category: ActionCategory;
  priority: ActionPriority;
  title: string;
  description: string;
  reasoning: string;
  trigger: ProactiveTrigger;
  suggestedCommand?: string;
  autoExecutable: boolean;
  estimatedImpact: string;
  estimatedEffort: 'trivial' | 'small' | 'medium' | 'large';
  expiresAt?: number;
}

export interface ProactiveTrigger {
  type: 'pattern' | 'schedule' | 'threshold' | 'event';
  condition: string;
  observedAt: number;
  confidence: number;
}

export interface PatternObservation {
  pattern: string;
  occurrences: number;
  lastSeen: number;
  context: string[];
}

export interface ProactiveConfig {
  enabled: boolean;
  categories: ActionCategory[];
  minConfidence: number;
  maxSuggestionsPerSession: number;
  autoExecuteThreshold: number;  // Only auto-execute if confidence >= this
}

// ==========================================
// PATTERN DEFINITIONS
// ==========================================

interface PatternDefinition {
  id: string;
  category: ActionCategory;
  pattern: RegExp | ((context: PatternContext) => boolean);
  action: Omit<ProactiveAction, 'id' | 'trigger'>;
}

interface PatternContext {
  recentMessages: string[];
  currentProject?: string;
  currentFile?: string;
  errorHistory: string[];
  taskHistory: string[];
}

const PATTERNS: PatternDefinition[] = [
  // Optimization patterns
  {
    id: 'repeated_similar_task',
    category: 'optimization',
    pattern: (ctx) => {
      // Detect if user is doing similar tasks repeatedly
      const recent = ctx.taskHistory.slice(-5);
      if (recent.length < 3) return false;
      
      // Simple similarity check
      const uniqueTasks = new Set(recent.map(t => t.split(' ')[0]));
      return uniqueTasks.size <= 2;
    },
    action: {
      category: 'optimization',
      priority: 'medium',
      title: 'Create Automation Workflow',
      description: 'You seem to be doing similar tasks repeatedly. Want me to create a workflow to automate this?',
      reasoning: 'Detected repetitive task pattern',
      autoExecutable: false,
      estimatedImpact: 'Reduce manual repetition',
      estimatedEffort: 'small'
    }
  },
  
  // Maintenance patterns
  {
    id: 'outdated_dependencies',
    category: 'maintenance',
    pattern: /dependencies.*outdated|npm.*update|security.*vulnerabilities/i,
    action: {
      category: 'maintenance',
      priority: 'medium',
      title: 'Update Dependencies',
      description: 'Some dependencies may be outdated. Run a dependency audit?',
      reasoning: 'Detected discussion about outdated packages',
      suggestedCommand: 'npm audit && npm outdated',
      autoExecutable: false,
      estimatedImpact: 'Improved security and compatibility',
      estimatedEffort: 'small'
    }
  },
  
  // Security patterns
  {
    id: 'exposed_secret',
    category: 'security',
    pattern: /api[_-]?key|secret|password|token.*=.*['"][^'"]+['"]/i,
    action: {
      category: 'security',
      priority: 'critical',
      title: 'Potential Secret Exposure',
      description: 'Detected what looks like a hardcoded secret. Move to environment variables?',
      reasoning: 'Pattern matched potential secret in code',
      autoExecutable: false,
      estimatedImpact: 'Security risk prevention',
      estimatedEffort: 'trivial'
    }
  },
  
  // Quality patterns
  {
    id: 'missing_error_handling',
    category: 'quality',
    pattern: /catch\s*\(\s*\w*\s*\)\s*\{\s*\}/,
    action: {
      category: 'quality',
      priority: 'medium',
      title: 'Empty Catch Block',
      description: 'Empty catch block detected. Add proper error handling?',
      reasoning: 'Empty catch blocks hide errors',
      autoExecutable: false,
      estimatedImpact: 'Better error visibility',
      estimatedEffort: 'trivial'
    }
  },
  
  // Productivity patterns
  {
    id: 'frequent_file_switching',
    category: 'productivity',
    pattern: (ctx) => {
      // If user is switching between same files repeatedly
      const recentFiles = ctx.recentMessages
        .filter(m => m.includes('.ts') || m.includes('.tsx'))
        .slice(-10);
      
      const uniqueFiles = new Set(recentFiles);
      return recentFiles.length >= 6 && uniqueFiles.size <= 3;
    },
    action: {
      category: 'productivity',
      priority: 'low',
      title: 'Split View Suggestion',
      description: 'You\'re switching between the same files often. Consider using split view?',
      reasoning: 'Frequent file switching detected',
      autoExecutable: false,
      estimatedImpact: 'Faster navigation',
      estimatedEffort: 'trivial'
    }
  },
  
  // Error patterns
  {
    id: 'repeated_same_error',
    category: 'quality',
    pattern: (ctx) => {
      if (ctx.errorHistory.length < 3) return false;
      
      const recent = ctx.errorHistory.slice(-5);
      const firstError = recent[0]?.substring(0, 50);
      
      return recent.filter(e => e.startsWith(firstError)).length >= 3;
    },
    action: {
      category: 'quality',
      priority: 'high',
      title: 'Recurring Error Detected',
      description: 'The same error keeps appearing. Want me to analyze the root cause?',
      reasoning: 'Same error occurred 3+ times recently',
      autoExecutable: false,
      estimatedImpact: 'Fix persistent issue',
      estimatedEffort: 'medium'
    }
  }
];

// ==========================================
// PROACTIVE INTELLIGENCE CLASS
// ==========================================

export class ProactiveIntelligence {
  private observations: Map<string, PatternObservation> = new Map();
  private pendingActions: Map<string, ProactiveAction> = new Map();
  private suppressedPatterns: Set<string> = new Set();
  private config: ProactiveConfig;
  private suggestionsThisSession: number = 0;
  
  constructor(config?: Partial<ProactiveConfig>) {
    this.config = {
      enabled: true,
      categories: ['optimization', 'maintenance', 'security', 'quality', 'productivity', 'learning'],
      minConfidence: 0.6,
      maxSuggestionsPerSession: 5,
      autoExecuteThreshold: 0.95,
      ...config
    };
  }
  
  /**
   * Observe context and detect patterns
   */
  observe(context: PatternContext): ProactiveAction[] {
    if (!this.config.enabled) return [];
    
    const detected: ProactiveAction[] = [];
    
    for (const patternDef of PATTERNS) {
      // Skip suppressed patterns
      if (this.suppressedPatterns.has(patternDef.id)) continue;
      
      // Skip disabled categories
      if (!this.config.categories.includes(patternDef.category)) continue;
      
      // Check pattern match
      let matched = false;
      let confidence = 0.7;  // Base confidence
      
      if (typeof patternDef.pattern === 'function') {
        matched = patternDef.pattern(context);
      } else {
        // Regex pattern - check recent messages
        matched = context.recentMessages.some(m => {
          if (patternDef.pattern instanceof RegExp) {
            return patternDef.pattern.test(m);
          }
          return false;
        });
      }
      
      if (!matched) continue;
      
      // Skip if below confidence threshold
      if (confidence < this.config.minConfidence) continue;
      
      // Track observation
      const existing = this.observations.get(patternDef.id);
      if (existing) {
        existing.occurrences++;
        existing.lastSeen = Date.now();
        confidence = Math.min(0.95, confidence + (existing.occurrences * 0.05));
      } else {
        this.observations.set(patternDef.id, {
          pattern: patternDef.id,
          occurrences: 1,
          lastSeen: Date.now(),
          context: context.recentMessages.slice(-3)
        });
      }
      
      // Create action
      const action: ProactiveAction = {
        id: `proactive_${patternDef.id}_${Date.now()}`,
        ...patternDef.action,
        trigger: {
          type: 'pattern',
          condition: patternDef.id,
          observedAt: Date.now(),
          confidence
        }
      };
      
      this.pendingActions.set(action.id, action);
      detected.push(action);
    }
    
    // Sort by priority
    detected.sort((a, b) => {
      const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    });
    
    return detected;
  }
  
  /**
   * Get pending suggestions (respecting session limit)
   */
  getSuggestions(limit?: number): ProactiveAction[] {
    const remaining = this.config.maxSuggestionsPerSession - this.suggestionsThisSession;
    const maxToReturn = Math.min(limit || 3, remaining);
    
    if (maxToReturn <= 0) return [];
    
    const actions = Array.from(this.pendingActions.values())
      .filter(a => !a.expiresAt || a.expiresAt > Date.now())
      .sort((a, b) => {
        const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
        return priorityOrder[a.priority] - priorityOrder[b.priority];
      })
      .slice(0, maxToReturn);
    
    return actions;
  }
  
  /**
   * Mark a suggestion as shown (counts against session limit)
   */
  markShown(actionId: string): void {
    this.suggestionsThisSession++;
    this.pendingActions.delete(actionId);
  }
  
  /**
   * Accept a suggestion (user said yes)
   */
  accept(actionId: string): ProactiveAction | undefined {
    const action = this.pendingActions.get(actionId);
    this.pendingActions.delete(actionId);
    
    logger.debug('Proactive action accepted', { actionId });
    
    return action;
  }
  
  /**
   * Dismiss a suggestion (user said no)
   */
  dismiss(actionId: string, suppressPattern: boolean = false): void {
    const action = this.pendingActions.get(actionId);
    this.pendingActions.delete(actionId);
    
    if (suppressPattern && action) {
      this.suppressedPatterns.add(action.trigger.condition);
      logger.debug('Pattern suppressed', { pattern: action.trigger.condition });
    }
  }
  
  /**
   * Get auto-executable actions (high confidence, safe actions)
   */
  getAutoExecutable(): ProactiveAction[] {
    return Array.from(this.pendingActions.values())
      .filter(a => 
        a.autoExecutable && 
        a.trigger.confidence >= this.config.autoExecuteThreshold
      );
  }
  
  /**
   * Suppress a pattern permanently
   */
  suppressPattern(patternId: string): void {
    this.suppressedPatterns.add(patternId);
  }
  
  /**
   * Reset session (for new conversation)
   */
  resetSession(): void {
    this.suggestionsThisSession = 0;
    this.pendingActions.clear();
  }
  
  /**
   * Format suggestion for display
   */
  formatSuggestion(action: ProactiveAction): string {
    const priorityEmoji = {
      critical: '🚨',
      high: '⚠️',
      medium: '💡',
      low: '📝'
    };
    
    return `${priorityEmoji[action.priority]} **${action.title}**

${action.description}

_Reason: ${action.reasoning}_
_Impact: ${action.estimatedImpact}_
_Effort: ${action.estimatedEffort}_

${action.suggestedCommand ? `\`\`\`\n${action.suggestedCommand}\n\`\`\`` : ''}`;
  }
  
  /**
   * Get statistics
   */
  getStats(): {
    observationCount: number;
    pendingCount: number;
    suppressedCount: number;
    suggestionsThisSession: number;
  } {
    return {
      observationCount: this.observations.size,
      pendingCount: this.pendingActions.size,
      suppressedCount: this.suppressedPatterns.size,
      suggestionsThisSession: this.suggestionsThisSession
    };
  }
}

// ==========================================
// SINGLETON INSTANCE
// ==========================================

let instance: ProactiveIntelligence | null = null;

export function getProactiveIntelligence(config?: Partial<ProactiveConfig>): ProactiveIntelligence {
  if (!instance) {
    instance = new ProactiveIntelligence(config);
  }
  return instance;
}

export function resetProactiveIntelligence(): void {
  if (instance) {
    instance.resetSession();
  }
  instance = null;
}
