/**
 * Behavior Engine
 * 
 * Manages Jeeves' behavioral preferences using weighted rules.
 * Preferences are organized by category and can be adjusted based on:
 * - User feedback
 * - Task outcomes
 * - Learned patterns
 */

import { logger } from '../../utils/logger.js';
import * as fs from 'fs';
import * as path from 'path';

// ==========================================
// TYPES
// ==========================================

export type BehaviorCategory = 
  | 'communication'
  | 'execution'
  | 'safety'
  | 'learning'
  | 'autonomy';

export interface BehaviorPreference {
  id: string;
  category: BehaviorCategory;
  name: string;
  description: string;
  weight: number;  // -1 to 1, where -1 is "avoid", 0 is "neutral", 1 is "prefer"
  adjustable: boolean;  // Can this be changed by learning?
  examples: {
    positive: string;
    negative: string;
  };
}

export interface BehaviorProfile {
  preferences: Map<string, BehaviorPreference>;
  lastUpdated: number;
  version: number;
}

export interface BehaviorDecision {
  action: string;
  score: number;
  reasoning: string;
  applicablePreferences: string[];
}

// ==========================================
// DEFAULT PREFERENCES
// ==========================================

const DEFAULT_PREFERENCES: BehaviorPreference[] = [
  // Communication
  {
    id: 'comm_concise',
    category: 'communication',
    name: 'Prefer Concise Responses',
    description: 'Keep responses brief and to the point',
    weight: 0.7,
    adjustable: true,
    examples: {
      positive: 'Done. Created 3 files.',
      negative: 'I have successfully completed the task by creating the following three files...'
    }
  },
  {
    id: 'comm_explain',
    category: 'communication',
    name: 'Explain Reasoning',
    description: 'Provide brief explanations for decisions',
    weight: 0.5,
    adjustable: true,
    examples: {
      positive: 'Using async/await here for cleaner error handling.',
      negative: 'Just implementing this way.'
    }
  },
  {
    id: 'comm_progress',
    category: 'communication',
    name: 'Report Progress',
    description: 'Keep user informed during long tasks',
    weight: 0.8,
    adjustable: true,
    examples: {
      positive: 'Step 2/5: Installing dependencies...',
      negative: '[5 minutes of silence]'
    }
  },
  {
    id: 'comm_ask_first',
    category: 'communication',
    name: 'Ask Before Destructive Actions',
    description: 'Confirm before deleting or overwriting',
    weight: 0.9,
    adjustable: false,
    examples: {
      positive: 'This will delete 50 files. Proceed?',
      negative: '[Deletes files without asking]'
    }
  },
  
  // Execution
  {
    id: 'exec_incremental',
    category: 'execution',
    name: 'Incremental Changes',
    description: 'Make small, testable changes rather than big rewrites',
    weight: 0.8,
    adjustable: true,
    examples: {
      positive: 'Updating one function at a time, testing between each.',
      negative: 'Rewriting the entire module at once.'
    }
  },
  {
    id: 'exec_verify',
    category: 'execution',
    name: 'Verify After Changes',
    description: 'Run tests/builds after making changes',
    weight: 0.9,
    adjustable: true,
    examples: {
      positive: 'Running npm test to verify changes...',
      negative: 'Changes made, moving on.'
    }
  },
  {
    id: 'exec_backup',
    category: 'execution',
    name: 'Create Backups',
    description: 'Back up files before modifying',
    weight: 0.6,
    adjustable: true,
    examples: {
      positive: 'Creating backup before modification...',
      negative: 'Modifying file directly.'
    }
  },
  
  // Safety
  {
    id: 'safe_no_secrets',
    category: 'safety',
    name: 'Never Expose Secrets',
    description: 'Protect API keys, passwords, and sensitive data',
    weight: 1.0,
    adjustable: false,
    examples: {
      positive: 'Skipping .env file from commit.',
      negative: 'Logging the API key for debugging.'
    }
  },
  {
    id: 'safe_reversible',
    category: 'safety',
    name: 'Prefer Reversible Actions',
    description: 'Choose actions that can be undone',
    weight: 0.8,
    adjustable: false,
    examples: {
      positive: 'Using git to track changes.',
      negative: 'Permanently deleting without backup.'
    }
  },
  {
    id: 'safe_scope',
    category: 'safety',
    name: 'Stay In Scope',
    description: 'Only modify files relevant to the task',
    weight: 0.9,
    adjustable: true,
    examples: {
      positive: 'Only updating the requested component.',
      negative: 'Refactoring unrelated code while fixing a bug.'
    }
  },
  
  // Learning
  {
    id: 'learn_patterns',
    category: 'learning',
    name: 'Learn From Outcomes',
    description: 'Remember what worked and what didn\'t',
    weight: 0.7,
    adjustable: true,
    examples: {
      positive: 'Noting that this approach fixed the issue.',
      negative: 'Making the same mistake repeatedly.'
    }
  },
  {
    id: 'learn_preferences',
    category: 'learning',
    name: 'Adapt to User Style',
    description: 'Adjust to user\'s preferences over time',
    weight: 0.6,
    adjustable: true,
    examples: {
      positive: 'User prefers TypeScript, defaulting to it.',
      negative: 'Ignoring past user choices.'
    }
  },
  
  // Autonomy
  {
    id: 'auto_simple',
    category: 'autonomy',
    name: 'Act Autonomously on Simple Tasks',
    description: 'Execute clear, low-risk tasks without asking',
    weight: 0.7,
    adjustable: true,
    examples: {
      positive: 'Formatting code as requested.',
      negative: 'Asking confirmation for trivial rename.'
    }
  },
  {
    id: 'auto_complex_ask',
    category: 'autonomy',
    name: 'Clarify Complex Tasks',
    description: 'Ask questions when task is ambiguous',
    weight: 0.8,
    adjustable: true,
    examples: {
      positive: 'Which database should I use for this feature?',
      negative: 'Guessing and implementing the wrong thing.'
    }
  }
];

// ==========================================
// BEHAVIOR ENGINE CLASS
// ==========================================

export class BehaviorEngine {
  private profile: BehaviorProfile;
  private configPath: string;
  
  constructor(dataDir: string = '.jeeves') {
    this.configPath = path.join(dataDir, 'behavior.json');
    this.profile = {
      preferences: new Map(),
      lastUpdated: Date.now(),
      version: 1
    };
  }
  
  /**
   * Initialize with defaults and load any saved preferences
   */
  async init(): Promise<void> {
    // Load defaults
    for (const pref of DEFAULT_PREFERENCES) {
      this.profile.preferences.set(pref.id, { ...pref });
    }
    
    // Load saved adjustments
    try {
      if (fs.existsSync(this.configPath)) {
        const saved = JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));
        
        for (const [id, weight] of Object.entries(saved.weights || {})) {
          const pref = this.profile.preferences.get(id);
          if (pref && pref.adjustable) {
            pref.weight = weight as number;
          }
        }
        
        this.profile.lastUpdated = saved.lastUpdated || Date.now();
      }
    } catch (error) {
      logger.debug('Failed to load behavior config', { error: String(error) });
    }
    
    logger.debug('Behavior engine initialized', { 
      preferenceCount: this.profile.preferences.size 
    });
  }
  
  /**
   * Save preference weights
   */
  private save(): void {
    try {
      const dataDir = path.dirname(this.configPath);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      
      const weights: Record<string, number> = {};
      for (const [id, pref] of this.profile.preferences) {
        if (pref.adjustable) {
          weights[id] = pref.weight;
        }
      }
      
      fs.writeFileSync(this.configPath, JSON.stringify({
        weights,
        lastUpdated: this.profile.lastUpdated,
        version: this.profile.version
      }, null, 2));
    } catch (error) {
      logger.error('Failed to save behavior config', { error: String(error) });
    }
  }
  
  // ==========================================
  // PREFERENCE MANAGEMENT
  // ==========================================
  
  /**
   * Get a specific preference
   */
  getPreference(id: string): BehaviorPreference | undefined {
    return this.profile.preferences.get(id);
  }
  
  /**
   * Get all preferences in a category
   */
  getCategoryPreferences(category: BehaviorCategory): BehaviorPreference[] {
    return Array.from(this.profile.preferences.values())
      .filter(p => p.category === category);
  }
  
  /**
   * Adjust a preference weight
   */
  adjustPreference(id: string, delta: number): boolean {
    const pref = this.profile.preferences.get(id);
    
    if (!pref || !pref.adjustable) {
      logger.debug('Cannot adjust preference', { id, adjustable: pref?.adjustable });
      return false;
    }
    
    pref.weight = Math.max(-1, Math.min(1, pref.weight + delta));
    this.profile.lastUpdated = Date.now();
    this.save();
    
    logger.debug('Preference adjusted', { id, newWeight: pref.weight });
    return true;
  }
  
  /**
   * Set a preference weight directly
   */
  setPreference(id: string, weight: number): boolean {
    const pref = this.profile.preferences.get(id);
    
    if (!pref || !pref.adjustable) {
      return false;
    }
    
    pref.weight = Math.max(-1, Math.min(1, weight));
    this.profile.lastUpdated = Date.now();
    this.save();
    
    return true;
  }
  
  // ==========================================
  // BEHAVIOR DECISIONS
  // ==========================================
  
  /**
   * Evaluate an action against preferences
   */
  evaluateAction(action: string, context: {
    category?: BehaviorCategory;
    tags?: string[];
  } = {}): BehaviorDecision {
    let score = 0;
    const applicablePreferences: string[] = [];
    const reasons: string[] = [];
    
    // Get relevant preferences
    let relevantPrefs = Array.from(this.profile.preferences.values());
    
    if (context.category) {
      relevantPrefs = relevantPrefs.filter(p => p.category === context.category);
    }
    
    // Check action against each preference
    const actionLower = action.toLowerCase();
    
    for (const pref of relevantPrefs) {
      let applies = false;
      let alignment = 0;  // Positive if aligns with preference, negative if opposes
      
      // Check if action aligns with or opposes this preference
      if (pref.id === 'comm_concise') {
        applies = actionLower.includes('response') || actionLower.includes('output');
        if (applies) {
          alignment = actionLower.includes('brief') || actionLower.includes('short') ? 1 : -0.5;
        }
      }
      
      if (pref.id === 'exec_incremental') {
        applies = actionLower.includes('change') || actionLower.includes('modify');
        if (applies) {
          alignment = actionLower.includes('all') || actionLower.includes('entire') ? -1 : 0.5;
        }
      }
      
      if (pref.id === 'safe_no_secrets') {
        applies = actionLower.includes('key') || actionLower.includes('secret') || actionLower.includes('password');
        if (applies) {
          alignment = actionLower.includes('log') || actionLower.includes('print') || actionLower.includes('expose') ? -1 : 0.5;
        }
      }
      
      if (pref.id === 'exec_verify') {
        applies = actionLower.includes('change') || actionLower.includes('modify') || actionLower.includes('update');
        if (applies) {
          alignment = actionLower.includes('test') || actionLower.includes('verify') ? 1 : -0.3;
        }
      }
      
      if (applies) {
        applicablePreferences.push(pref.id);
        const contribution = alignment * pref.weight;
        score += contribution;
        
        if (Math.abs(contribution) > 0.3) {
          reasons.push(`${pref.name}: ${contribution > 0 ? 'aligned' : 'opposed'}`);
        }
      }
    }
    
    // Normalize score to -1 to 1 range
    if (applicablePreferences.length > 0) {
      score = score / applicablePreferences.length;
    }
    
    return {
      action,
      score,
      reasoning: reasons.join('; ') || 'No strong preferences apply',
      applicablePreferences
    };
  }
  
  /**
   * Get behavioral guidance for a task type
   */
  getGuidance(taskType: string): string[] {
    const guidance: string[] = [];
    
    const highWeightPrefs = Array.from(this.profile.preferences.values())
      .filter(p => p.weight >= 0.7)
      .sort((a, b) => b.weight - a.weight);
    
    for (const pref of highWeightPrefs.slice(0, 5)) {
      guidance.push(`${pref.name}: ${pref.description}`);
    }
    
    return guidance;
  }
  
  /**
   * Should we ask before proceeding?
   */
  shouldAskFirst(action: string, riskLevel: 'low' | 'medium' | 'high'): boolean {
    const askFirstPref = this.profile.preferences.get('comm_ask_first');
    const autoSimplePref = this.profile.preferences.get('auto_simple');
    
    // High risk actions always ask
    if (riskLevel === 'high') return true;
    
    // Check preference weights
    const askThreshold = askFirstPref?.weight || 0.9;
    const autoThreshold = autoSimplePref?.weight || 0.7;
    
    if (riskLevel === 'low' && autoThreshold > 0.5) {
      return false;  // Proceed autonomously
    }
    
    if (riskLevel === 'medium') {
      return askThreshold > 0.7;
    }
    
    return true;
  }
  
  // ==========================================
  // LEARNING FROM FEEDBACK
  // ==========================================
  
  /**
   * Adjust preferences based on user feedback
   */
  learnFromFeedback(preferenceId: string, wasPositive: boolean): void {
    const delta = wasPositive ? 0.05 : -0.1;
    this.adjustPreference(preferenceId, delta);
  }
  
  /**
   * Infer preference adjustments from task outcome
   */
  learnFromOutcome(
    taskContext: { 
      action: string; 
      preferences: string[] 
    },
    success: boolean
  ): void {
    // Adjust preferences that were applied
    for (const prefId of taskContext.preferences) {
      const pref = this.profile.preferences.get(prefId);
      if (pref && pref.adjustable) {
        // Reinforce or weaken based on outcome
        const delta = success ? 0.02 : -0.05;
        pref.weight = Math.max(-1, Math.min(1, pref.weight + delta));
      }
    }
    
    this.profile.lastUpdated = Date.now();
    this.save();
  }
  
  // ==========================================
  // PROFILE EXPORT/IMPORT
  // ==========================================
  
  /**
   * Export current profile
   */
  exportProfile(): Record<string, number> {
    const profile: Record<string, number> = {};
    
    for (const [id, pref] of this.profile.preferences) {
      profile[id] = pref.weight;
    }
    
    return profile;
  }
  
  /**
   * Get profile summary
   */
  getSummary(): {
    totalPreferences: number;
    byCategory: Record<BehaviorCategory, number>;
    topPreferences: Array<{ name: string; weight: number }>;
  } {
    const byCategory: Record<BehaviorCategory, number> = {
      communication: 0,
      execution: 0,
      safety: 0,
      learning: 0,
      autonomy: 0
    };
    
    const sorted = Array.from(this.profile.preferences.values())
      .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
    
    for (const pref of this.profile.preferences.values()) {
      byCategory[pref.category]++;
    }
    
    return {
      totalPreferences: this.profile.preferences.size,
      byCategory,
      topPreferences: sorted.slice(0, 5).map(p => ({ 
        name: p.name, 
        weight: p.weight 
      }))
    };
  }
}

// ==========================================
// SINGLETON INSTANCE
// ==========================================

let instance: BehaviorEngine | null = null;

export async function getBehaviorEngine(dataDir?: string): Promise<BehaviorEngine> {
  if (!instance) {
    instance = new BehaviorEngine(dataDir);
    await instance.init();
  }
  return instance;
}

export function resetBehaviorEngine(): void {
  instance = null;
}
