/**
 * State Manager - Context Switching and State Persistence
 * 
 * Manages Jeeves' execution state across:
 * - Task interruptions and resumptions
 * - Project context switches
 * - Session continuity
 * - Checkpoint/rollback capability
 */

import { logger } from '../../utils/logger.js';
import * as fs from 'fs';
import * as path from 'path';

// ==========================================
// TYPES
// ==========================================

export interface ExecutionState {
  id: string;
  type: 'task' | 'debug' | 'exploration' | 'maintenance';
  name: string;
  status: 'active' | 'paused' | 'interrupted' | 'completed' | 'failed';
  
  // Context
  projectPath?: string;
  workingDirectory?: string;
  openFiles?: string[];
  
  // Progress
  progress: {
    current: number;
    total: number;
    completedSteps: string[];
    pendingSteps: string[];
  };
  
  // Memory snapshot
  memory: {
    context: Record<string, unknown>;
    reasoning: string[];
    decisions: string[];
  };
  
  // Timestamps
  createdAt: number;
  updatedAt: number;
  pausedAt?: number;
  resumedAt?: number;
}

export interface Checkpoint {
  id: string;
  stateId: string;
  name: string;
  snapshot: ExecutionState;
  createdAt: number;
  reason: 'manual' | 'auto' | 'interruption';
}

export interface StateTransition {
  from: ExecutionState['status'];
  to: ExecutionState['status'];
  timestamp: number;
  reason: string;
}

// ==========================================
// STATE MANAGER CLASS
// ==========================================

export class StateManager {
  private states: Map<string, ExecutionState> = new Map();
  private checkpoints: Map<string, Checkpoint[]> = new Map();
  private currentStateId: string | null = null;
  private transitions: StateTransition[] = [];
  private persistPath: string;
  
  constructor(dataDir: string = '.jeeves') {
    this.persistPath = path.join(dataDir, 'state.json');
  }
  
  /**
   * Initialize and load persisted state
   */
  async init(): Promise<void> {
    try {
      if (fs.existsSync(this.persistPath)) {
        const data = JSON.parse(fs.readFileSync(this.persistPath, 'utf-8'));
        
        // Restore states
        for (const [id, state] of Object.entries(data.states || {})) {
          this.states.set(id, state as ExecutionState);
        }
        
        // Restore checkpoints
        for (const [stateId, checkpoints] of Object.entries(data.checkpoints || {})) {
          this.checkpoints.set(stateId, checkpoints as Checkpoint[]);
        }
        
        // Restore current state reference
        if (data.currentStateId && this.states.has(data.currentStateId)) {
          this.currentStateId = data.currentStateId;
        }
        
        logger.debug('State manager initialized', { 
          stateCount: this.states.size,
          currentState: this.currentStateId
        });
      }
    } catch (error) {
      logger.error('Failed to load state', { error: String(error) });
    }
  }
  
  /**
   * Persist state to disk
   */
  private persist(): void {
    try {
      const dataDir = path.dirname(this.persistPath);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      
      const data = {
        states: Object.fromEntries(this.states),
        checkpoints: Object.fromEntries(this.checkpoints),
        currentStateId: this.currentStateId,
        transitions: this.transitions.slice(-100)  // Keep last 100
      };
      
      fs.writeFileSync(this.persistPath, JSON.stringify(data, null, 2));
    } catch (error) {
      logger.error('Failed to persist state', { error: String(error) });
    }
  }
  
  // ==========================================
  // STATE LIFECYCLE
  // ==========================================
  
  /**
   * Create a new execution state
   */
  createState(
    type: ExecutionState['type'],
    name: string,
    context?: Partial<Omit<ExecutionState, 'id' | 'type' | 'name' | 'status' | 'createdAt' | 'updatedAt'>>
  ): ExecutionState {
    const state: ExecutionState = {
      id: `state_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type,
      name,
      status: 'active',
      projectPath: context?.projectPath,
      workingDirectory: context?.workingDirectory,
      openFiles: context?.openFiles || [],
      progress: context?.progress || {
        current: 0,
        total: 0,
        completedSteps: [],
        pendingSteps: []
      },
      memory: context?.memory || {
        context: {},
        reasoning: [],
        decisions: []
      },
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    
    this.states.set(state.id, state);
    this.checkpoints.set(state.id, []);
    
    // Set as current if no active state
    if (!this.currentStateId) {
      this.currentStateId = state.id;
    }
    
    this.persist();
    
    logger.debug('State created', { id: state.id, type, name });
    
    return state;
  }
  
  /**
   * Get current state
   */
  getCurrentState(): ExecutionState | null {
    if (!this.currentStateId) return null;
    return this.states.get(this.currentStateId) || null;
  }
  
  /**
   * Get state by ID
   */
  getState(id: string): ExecutionState | undefined {
    return this.states.get(id);
  }
  
  /**
   * Update current state
   */
  updateState(updates: Partial<ExecutionState>): ExecutionState | null {
    const current = this.getCurrentState();
    if (!current) return null;
    
    // Apply updates
    Object.assign(current, updates, { updatedAt: Date.now() });
    
    this.persist();
    
    return current;
  }
  
  // ==========================================
  // STATE TRANSITIONS
  // ==========================================
  
  /**
   * Pause current state (for interruption)
   */
  pauseState(reason: string = 'User interruption'): ExecutionState | null {
    const current = this.getCurrentState();
    if (!current || current.status !== 'active') return null;
    
    // Create auto checkpoint before pausing
    this.createCheckpoint('Before pause', 'auto');
    
    const oldStatus = current.status;
    current.status = 'paused';
    current.pausedAt = Date.now();
    current.updatedAt = Date.now();
    
    this.recordTransition(oldStatus, 'paused', reason);
    this.persist();
    
    logger.debug('State paused', { id: current.id, reason });
    
    return current;
  }
  
  /**
   * Resume a paused state
   */
  resumeState(stateId?: string): ExecutionState | null {
    const id = stateId || this.currentStateId;
    if (!id) return null;
    
    const state = this.states.get(id);
    if (!state || state.status !== 'paused') return null;
    
    const oldStatus = state.status;
    state.status = 'active';
    state.resumedAt = Date.now();
    state.updatedAt = Date.now();
    
    this.currentStateId = id;
    this.recordTransition(oldStatus, 'active', 'Resumed');
    this.persist();
    
    logger.debug('State resumed', { id });
    
    return state;
  }
  
  /**
   * Complete current state
   */
  completeState(summary?: string): ExecutionState | null {
    const current = this.getCurrentState();
    if (!current) return null;
    
    const oldStatus = current.status;
    current.status = 'completed';
    current.updatedAt = Date.now();
    
    if (summary) {
      current.memory.reasoning.push(`Completion: ${summary}`);
    }
    
    this.recordTransition(oldStatus, 'completed', summary || 'Task completed');
    this.currentStateId = null;
    this.persist();
    
    logger.debug('State completed', { id: current.id });
    
    return current;
  }
  
  /**
   * Mark state as failed
   */
  failState(error: string): ExecutionState | null {
    const current = this.getCurrentState();
    if (!current) return null;
    
    const oldStatus = current.status;
    current.status = 'failed';
    current.updatedAt = Date.now();
    current.memory.reasoning.push(`Failure: ${error}`);
    
    this.recordTransition(oldStatus, 'failed', error);
    this.currentStateId = null;
    this.persist();
    
    logger.debug('State failed', { id: current.id, error });
    
    return current;
  }
  
  private recordTransition(from: ExecutionState['status'], to: ExecutionState['status'], reason: string): void {
    this.transitions.push({
      from,
      to,
      timestamp: Date.now(),
      reason
    });
  }
  
  // ==========================================
  // CHECKPOINTS
  // ==========================================
  
  /**
   * Create a checkpoint of current state
   */
  createCheckpoint(name: string, reason: 'manual' | 'auto' | 'interruption' = 'manual'): Checkpoint | null {
    const current = this.getCurrentState();
    if (!current) return null;
    
    const checkpoint: Checkpoint = {
      id: `cp_${Date.now()}`,
      stateId: current.id,
      name,
      snapshot: JSON.parse(JSON.stringify(current)),  // Deep clone
      createdAt: Date.now(),
      reason
    };
    
    const checkpoints = this.checkpoints.get(current.id) || [];
    checkpoints.push(checkpoint);
    
    // Keep only last 10 checkpoints per state
    if (checkpoints.length > 10) {
      checkpoints.shift();
    }
    
    this.checkpoints.set(current.id, checkpoints);
    this.persist();
    
    logger.debug('Checkpoint created', { checkpointId: checkpoint.id, stateId: current.id });
    
    return checkpoint;
  }
  
  /**
   * Restore state from checkpoint
   */
  restoreCheckpoint(checkpointId: string): ExecutionState | null {
    for (const checkpoints of this.checkpoints.values()) {
      const checkpoint = checkpoints.find(cp => cp.id === checkpointId);
      
      if (checkpoint) {
        const restoredState = { 
          ...checkpoint.snapshot,
          updatedAt: Date.now(),
          status: 'active' as const
        };
        
        this.states.set(restoredState.id, restoredState);
        this.currentStateId = restoredState.id;
        this.persist();
        
        logger.debug('Checkpoint restored', { checkpointId, stateId: restoredState.id });
        
        return restoredState;
      }
    }
    
    return null;
  }
  
  /**
   * Get checkpoints for a state
   */
  getCheckpoints(stateId?: string): Checkpoint[] {
    const id = stateId || this.currentStateId;
    if (!id) return [];
    
    return this.checkpoints.get(id) || [];
  }
  
  // ==========================================
  // CONTEXT SWITCHING
  // ==========================================
  
  /**
   * Switch to a different state
   */
  switchToState(stateId: string): ExecutionState | null {
    const targetState = this.states.get(stateId);
    if (!targetState) return null;
    
    // Pause current state if active
    const current = this.getCurrentState();
    if (current && current.status === 'active') {
      this.pauseState('Context switch');
    }
    
    // Activate target state
    if (targetState.status === 'paused') {
      return this.resumeState(stateId);
    }
    
    this.currentStateId = stateId;
    this.persist();
    
    return targetState;
  }
  
  /**
   * Get all active/paused states
   */
  getActiveStates(): ExecutionState[] {
    return Array.from(this.states.values())
      .filter(s => s.status === 'active' || s.status === 'paused')
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
  
  /**
   * Get recent states
   */
  getRecentStates(limit: number = 10): ExecutionState[] {
    return Array.from(this.states.values())
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
  }
  
  // ==========================================
  // PROGRESS TRACKING
  // ==========================================
  
  /**
   * Update progress on current state
   */
  updateProgress(stepCompleted?: string, stepPending?: string): void {
    const current = this.getCurrentState();
    if (!current) return;
    
    if (stepCompleted) {
      current.progress.completedSteps.push(stepCompleted);
      current.progress.current++;
      
      // Remove from pending if present
      const pendingIdx = current.progress.pendingSteps.indexOf(stepCompleted);
      if (pendingIdx > -1) {
        current.progress.pendingSteps.splice(pendingIdx, 1);
      }
    }
    
    if (stepPending) {
      current.progress.pendingSteps.push(stepPending);
      current.progress.total++;
    }
    
    current.updatedAt = Date.now();
    this.persist();
  }
  
  /**
   * Add context to current state memory
   */
  addMemory(key: string, value: unknown): void {
    const current = this.getCurrentState();
    if (!current) return;
    
    current.memory.context[key] = value;
    current.updatedAt = Date.now();
    this.persist();
  }
  
  /**
   * Add reasoning step to current state
   */
  addReasoning(step: string): void {
    const current = this.getCurrentState();
    if (!current) return;
    
    current.memory.reasoning.push(step);
    current.updatedAt = Date.now();
    this.persist();
  }
  
  /**
   * Record a decision
   */
  recordDecision(decision: string): void {
    const current = this.getCurrentState();
    if (!current) return;
    
    current.memory.decisions.push(`[${new Date().toISOString()}] ${decision}`);
    current.updatedAt = Date.now();
    this.persist();
  }
  
  // ==========================================
  // CLEANUP
  // ==========================================
  
  /**
   * Clean up old completed/failed states
   */
  cleanup(maxAge: number = 7 * 24 * 60 * 60 * 1000): number {
    const cutoff = Date.now() - maxAge;
    let cleaned = 0;
    
    for (const [id, state] of this.states) {
      if ((state.status === 'completed' || state.status === 'failed') &&
          state.updatedAt < cutoff) {
        this.states.delete(id);
        this.checkpoints.delete(id);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      this.persist();
      logger.debug('State cleanup', { cleaned });
    }
    
    return cleaned;
  }
  
  /**
   * Get summary statistics
   */
  getStats(): {
    total: number;
    byStatus: Record<ExecutionState['status'], number>;
    byType: Record<ExecutionState['type'], number>;
  } {
    const byStatus: Record<ExecutionState['status'], number> = {
      active: 0,
      paused: 0,
      interrupted: 0,
      completed: 0,
      failed: 0
    };
    
    const byType: Record<ExecutionState['type'], number> = {
      task: 0,
      debug: 0,
      exploration: 0,
      maintenance: 0
    };
    
    for (const state of this.states.values()) {
      byStatus[state.status]++;
      byType[state.type]++;
    }
    
    return {
      total: this.states.size,
      byStatus,
      byType
    };
  }
}

// ==========================================
// SINGLETON INSTANCE
// ==========================================

let instance: StateManager | null = null;

export async function getStateManager(dataDir?: string): Promise<StateManager> {
  if (!instance) {
    instance = new StateManager(dataDir);
    await instance.init();
  }
  return instance;
}

export function resetStateManager(): void {
  instance = null;
}
