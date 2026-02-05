/**
 * Episodic Memory (L2)
 * 
 * SQLite-backed session summaries and task history.
 * Stores:
 * - Session summaries (compressed from working memory)
 * - Task outcomes (success/failure with learnings)
 * - Error patterns encountered
 * - User preferences observed
 */

import { logger } from '../../utils/logger.js';
import * as path from 'path';
import * as fs from 'fs';

// ==========================================
// TYPES
// ==========================================

export interface SessionSummary {
  id: string;
  startTime: number;
  endTime: number;
  taskCount: number;
  successCount: number;
  failureCount: number;
  summary: string;
  keyDecisions: string[];
  projectPath?: string;
}

export interface TaskOutcome {
  id: string;
  sessionId: string;
  description: string;
  status: 'success' | 'failure' | 'partial';
  duration: number;
  stepsCompleted: number;
  totalSteps: number;
  learnings: string[];
  errorPattern?: string;
  timestamp: number;
}

export interface ErrorPattern {
  id: string;
  pattern: string;
  occurrences: number;
  lastSeen: number;
  resolution?: string;
  context: string;
}

export interface UserPreference {
  key: string;
  value: string;
  confidence: number;
  observations: number;
  lastUpdated: number;
}

// ==========================================
// IN-MEMORY STORE (SQLite integration TODO)
// ==========================================

interface EpisodicStore {
  sessions: Map<string, SessionSummary>;
  tasks: Map<string, TaskOutcome>;
  errors: Map<string, ErrorPattern>;
  preferences: Map<string, UserPreference>;
}

// ==========================================
// EPISODIC MEMORY CLASS
// ==========================================

export class EpisodicMemory {
  private store: EpisodicStore;
  private dbPath: string;
  private initialized: boolean = false;
  
  constructor(dataDir: string = '.jeeves') {
    this.dbPath = path.join(dataDir, 'episodic.json');
    this.store = {
      sessions: new Map(),
      tasks: new Map(),
      errors: new Map(),
      preferences: new Map()
    };
  }
  
  /**
   * Initialize the memory store
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    
    try {
      // Ensure data directory exists
      const dataDir = path.dirname(this.dbPath);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      
      // Load existing data
      if (fs.existsSync(this.dbPath)) {
        const data = JSON.parse(fs.readFileSync(this.dbPath, 'utf-8'));
        this.store.sessions = new Map(Object.entries(data.sessions || {}));
        this.store.tasks = new Map(Object.entries(data.tasks || {}));
        this.store.errors = new Map(Object.entries(data.errors || {}));
        this.store.preferences = new Map(Object.entries(data.preferences || {}));
      }
      
      this.initialized = true;
      logger.debug('Episodic memory initialized', { path: this.dbPath });
      
    } catch (error) {
      logger.error('Failed to initialize episodic memory', { error: String(error) });
      this.initialized = true;  // Continue with empty store
    }
  }
  
  /**
   * Persist data to disk
   */
  private persist(): void {
    try {
      const data = {
        sessions: Object.fromEntries(this.store.sessions),
        tasks: Object.fromEntries(this.store.tasks),
        errors: Object.fromEntries(this.store.errors),
        preferences: Object.fromEntries(this.store.preferences)
      };
      
      fs.writeFileSync(this.dbPath, JSON.stringify(data, null, 2));
    } catch (error) {
      logger.error('Failed to persist episodic memory', { error: String(error) });
    }
  }
  
  // ==========================================
  // SESSION MANAGEMENT
  // ==========================================
  
  /**
   * Store a session summary
   */
  saveSession(summary: SessionSummary): void {
    this.store.sessions.set(summary.id, summary);
    this.persist();
    
    logger.debug('Session saved', { 
      id: summary.id, 
      tasks: summary.taskCount,
      success: summary.successCount 
    });
  }
  
  /**
   * Get recent sessions
   */
  getRecentSessions(limit: number = 10): SessionSummary[] {
    const sessions = Array.from(this.store.sessions.values());
    return sessions
      .sort((a, b) => b.endTime - a.endTime)
      .slice(0, limit);
  }
  
  /**
   * Get sessions for a specific project
   */
  getProjectSessions(projectPath: string, limit: number = 5): SessionSummary[] {
    return Array.from(this.store.sessions.values())
      .filter(s => s.projectPath === projectPath)
      .sort((a, b) => b.endTime - a.endTime)
      .slice(0, limit);
  }
  
  // ==========================================
  // TASK OUTCOMES
  // ==========================================
  
  /**
   * Record a task outcome
   */
  recordTaskOutcome(outcome: TaskOutcome): void {
    this.store.tasks.set(outcome.id, outcome);
    
    // Update error patterns if this was a failure
    if (outcome.status === 'failure' && outcome.errorPattern) {
      this.updateErrorPattern(outcome.errorPattern, outcome.description);
    }
    
    this.persist();
    
    logger.debug('Task outcome recorded', { 
      id: outcome.id, 
      status: outcome.status 
    });
  }
  
  /**
   * Get similar past tasks
   */
  findSimilarTasks(description: string, limit: number = 5): TaskOutcome[] {
    // Simple keyword matching (could be enhanced with embeddings)
    const keywords = description.toLowerCase().split(/\s+/);
    
    return Array.from(this.store.tasks.values())
      .map(task => ({
        task,
        score: keywords.filter(kw => 
          task.description.toLowerCase().includes(kw)
        ).length
      }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ task }) => task);
  }
  
  /**
   * Get success rate for similar tasks
   */
  getSuccessRate(taskType: string): { rate: number; sampleSize: number } {
    const similar = this.findSimilarTasks(taskType, 20);
    
    if (similar.length === 0) {
      return { rate: 0.5, sampleSize: 0 };  // No data, assume 50%
    }
    
    const successes = similar.filter(t => t.status === 'success').length;
    return {
      rate: successes / similar.length,
      sampleSize: similar.length
    };
  }
  
  // ==========================================
  // ERROR PATTERNS
  // ==========================================
  
  /**
   * Update or create an error pattern
   */
  private updateErrorPattern(pattern: string, context: string): void {
    const existing = this.store.errors.get(pattern);
    
    if (existing) {
      existing.occurrences++;
      existing.lastSeen = Date.now();
      existing.context = context;
    } else {
      this.store.errors.set(pattern, {
        id: `err_${Date.now()}`,
        pattern,
        occurrences: 1,
        lastSeen: Date.now(),
        context
      });
    }
  }
  
  /**
   * Record a resolution for an error pattern
   */
  recordErrorResolution(pattern: string, resolution: string): void {
    const error = this.store.errors.get(pattern);
    if (error) {
      error.resolution = resolution;
      this.persist();
    }
  }
  
  /**
   * Check if we have a known resolution for an error
   */
  findErrorResolution(errorMessage: string): string | null {
    for (const [pattern, error] of this.store.errors) {
      if (errorMessage.includes(pattern) && error.resolution) {
        return error.resolution;
      }
    }
    return null;
  }
  
  /**
   * Get frequent errors
   */
  getFrequentErrors(limit: number = 10): ErrorPattern[] {
    return Array.from(this.store.errors.values())
      .sort((a, b) => b.occurrences - a.occurrences)
      .slice(0, limit);
  }
  
  // ==========================================
  // USER PREFERENCES
  // ==========================================
  
  /**
   * Observe and update a preference
   */
  observePreference(key: string, value: string): void {
    const existing = this.store.preferences.get(key);
    
    if (existing) {
      if (existing.value === value) {
        // Same value observed again - increase confidence
        existing.confidence = Math.min(1, existing.confidence + 0.1);
        existing.observations++;
      } else {
        // Different value - decrease confidence and maybe update
        existing.confidence *= 0.9;
        if (existing.confidence < 0.5) {
          existing.value = value;
          existing.confidence = 0.6;
        }
      }
      existing.lastUpdated = Date.now();
    } else {
      this.store.preferences.set(key, {
        key,
        value,
        confidence: 0.6,
        observations: 1,
        lastUpdated: Date.now()
      });
    }
    
    this.persist();
  }
  
  /**
   * Get a preference value
   */
  getPreference(key: string): { value: string; confidence: number } | null {
    const pref = this.store.preferences.get(key);
    if (!pref) return null;
    
    return {
      value: pref.value,
      confidence: pref.confidence
    };
  }
  
  /**
   * Get all preferences with high confidence
   */
  getConfidentPreferences(minConfidence: number = 0.7): UserPreference[] {
    return Array.from(this.store.preferences.values())
      .filter(p => p.confidence >= minConfidence);
  }
  
  // ==========================================
  // CONTEXT RETRIEVAL
  // ==========================================
  
  /**
   * Get relevant context for a new task
   */
  getRelevantContext(taskDescription: string, projectPath?: string): {
    similarTasks: TaskOutcome[];
    relevantErrors: ErrorPattern[];
    preferences: UserPreference[];
    successRate: { rate: number; sampleSize: number };
  } {
    return {
      similarTasks: this.findSimilarTasks(taskDescription, 3),
      relevantErrors: this.getFrequentErrors(3),
      preferences: this.getConfidentPreferences(),
      successRate: this.getSuccessRate(taskDescription)
    };
  }
  
  // ==========================================
  // STATISTICS
  // ==========================================
  
  /**
   * Get memory statistics
   */
  getStats(): {
    sessionCount: number;
    taskCount: number;
    errorPatternCount: number;
    preferenceCount: number;
    overallSuccessRate: number;
  } {
    const tasks = Array.from(this.store.tasks.values());
    const successes = tasks.filter(t => t.status === 'success').length;
    
    return {
      sessionCount: this.store.sessions.size,
      taskCount: this.store.tasks.size,
      errorPatternCount: this.store.errors.size,
      preferenceCount: this.store.preferences.size,
      overallSuccessRate: tasks.length > 0 ? successes / tasks.length : 0
    };
  }
  
  /**
   * Clear all episodic memory
   */
  clear(): void {
    this.store = {
      sessions: new Map(),
      tasks: new Map(),
      errors: new Map(),
      preferences: new Map()
    };
    this.persist();
  }
}

// ==========================================
// SINGLETON INSTANCE
// ==========================================

let instance: EpisodicMemory | null = null;

export async function getEpisodicMemory(dataDir?: string): Promise<EpisodicMemory> {
  if (!instance) {
    instance = new EpisodicMemory(dataDir);
    await instance.init();
  }
  return instance;
}

export function resetEpisodicMemory(): void {
  if (instance) {
    instance.clear();
  }
  instance = null;
}
