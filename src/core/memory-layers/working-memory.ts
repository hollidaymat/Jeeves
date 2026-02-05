/**
 * Working Memory (L1)
 * 
 * Hot context with 20k token limit for current conversation.
 * Maintains:
 * - Active task state
 * - Recent messages (last N)
 * - Current reasoning chain
 * - Pending clarifications
 */

import { logger } from '../../utils/logger.js';

// ==========================================
// TYPES
// ==========================================

export interface WorkingMemoryItem {
  id: string;
  type: 'message' | 'task' | 'reasoning' | 'clarification' | 'context';
  content: string;
  timestamp: number;
  tokenCount: number;
  priority: number;  // Higher = more important to keep
  metadata?: Record<string, unknown>;
}

export interface ActiveTask {
  id: string;
  description: string;
  status: 'pending' | 'in_progress' | 'blocked' | 'completed';
  steps: TaskStep[];
  currentStep: number;
  startedAt: number;
  context: Record<string, unknown>;
}

export interface TaskStep {
  id: string;
  action: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  result?: string;
}

export interface WorkingMemoryState {
  items: WorkingMemoryItem[];
  activeTask: ActiveTask | null;
  totalTokens: number;
  sessionId: string;
}

// ==========================================
// CONFIGURATION
// ==========================================

const MAX_TOKENS = 20000;
const MAX_MESSAGES = 50;
const MESSAGE_PRIORITY = 5;
const TASK_PRIORITY = 10;
const REASONING_PRIORITY = 8;
const CONTEXT_PRIORITY = 3;

// ==========================================
// WORKING MEMORY CLASS
// ==========================================

export class WorkingMemory {
  private state: WorkingMemoryState;
  
  constructor(sessionId: string) {
    this.state = {
      items: [],
      activeTask: null,
      totalTokens: 0,
      sessionId
    };
    
    logger.debug('Working memory initialized', { sessionId });
  }
  
  // ==========================================
  // MESSAGE MANAGEMENT
  // ==========================================
  
  /**
   * Add a message to working memory
   */
  addMessage(role: 'user' | 'assistant', content: string, metadata?: Record<string, unknown>): void {
    const tokenCount = this.estimateTokens(content);
    
    const item: WorkingMemoryItem = {
      id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type: 'message',
      content: `[${role}] ${content}`,
      timestamp: Date.now(),
      tokenCount,
      priority: MESSAGE_PRIORITY,
      metadata: { role, ...metadata }
    };
    
    this.addItem(item);
  }
  
  /**
   * Get recent messages for context
   */
  getRecentMessages(limit: number = 10): string[] {
    return this.state.items
      .filter(item => item.type === 'message')
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit)
      .reverse()  // Chronological order
      .map(item => item.content);
  }
  
  // ==========================================
  // TASK MANAGEMENT
  // ==========================================
  
  /**
   * Start a new active task
   */
  startTask(description: string, steps: string[]): ActiveTask {
    const task: ActiveTask = {
      id: `task_${Date.now()}`,
      description,
      status: 'in_progress',
      steps: steps.map((action, i) => ({
        id: `step_${i}`,
        action,
        status: 'pending'
      })),
      currentStep: 0,
      startedAt: Date.now(),
      context: {}
    };
    
    this.state.activeTask = task;
    
    // Add task to items for context
    this.addItem({
      id: task.id,
      type: 'task',
      content: `Active Task: ${description}\nSteps: ${steps.join(', ')}`,
      timestamp: Date.now(),
      tokenCount: this.estimateTokens(description + steps.join(' ')),
      priority: TASK_PRIORITY
    });
    
    logger.debug('Task started', { taskId: task.id, stepCount: steps.length });
    
    return task;
  }
  
  /**
   * Update current step status
   */
  updateStep(status: 'in_progress' | 'completed' | 'failed', result?: string): void {
    if (!this.state.activeTask) return;
    
    const step = this.state.activeTask.steps[this.state.activeTask.currentStep];
    if (step) {
      step.status = status;
      step.result = result;
      
      if (status === 'completed') {
        this.state.activeTask.currentStep++;
        
        // Check if all steps completed
        if (this.state.activeTask.currentStep >= this.state.activeTask.steps.length) {
          this.state.activeTask.status = 'completed';
          logger.debug('Task completed', { taskId: this.state.activeTask.id });
        }
      } else if (status === 'failed') {
        this.state.activeTask.status = 'blocked';
      }
    }
  }
  
  /**
   * Get active task summary
   */
  getActiveTask(): ActiveTask | null {
    return this.state.activeTask;
  }
  
  /**
   * Clear active task
   */
  clearTask(): void {
    if (this.state.activeTask) {
      // Remove task item
      this.state.items = this.state.items.filter(
        item => item.id !== this.state.activeTask?.id
      );
      this.state.activeTask = null;
      this.recalculateTokens();
    }
  }
  
  // ==========================================
  // REASONING CHAIN
  // ==========================================
  
  /**
   * Add reasoning step to memory
   */
  addReasoning(phase: string, content: string): void {
    this.addItem({
      id: `reason_${Date.now()}`,
      type: 'reasoning',
      content: `[${phase}] ${content}`,
      timestamp: Date.now(),
      tokenCount: this.estimateTokens(content),
      priority: REASONING_PRIORITY,
      metadata: { phase }
    });
  }
  
  /**
   * Get current reasoning chain
   */
  getReasoningChain(): string[] {
    return this.state.items
      .filter(item => item.type === 'reasoning')
      .sort((a, b) => a.timestamp - b.timestamp)
      .map(item => item.content);
  }
  
  /**
   * Clear reasoning chain (after task completion)
   */
  clearReasoning(): void {
    this.state.items = this.state.items.filter(item => item.type !== 'reasoning');
    this.recalculateTokens();
  }
  
  // ==========================================
  // CONTEXT MANAGEMENT
  // ==========================================
  
  /**
   * Add contextual information
   */
  addContext(key: string, content: string, priority: number = CONTEXT_PRIORITY): void {
    // Remove existing context with same key
    this.state.items = this.state.items.filter(
      item => !(item.type === 'context' && item.metadata?.key === key)
    );
    
    this.addItem({
      id: `ctx_${key}`,
      type: 'context',
      content,
      timestamp: Date.now(),
      tokenCount: this.estimateTokens(content),
      priority,
      metadata: { key }
    });
  }
  
  /**
   * Get all context items
   */
  getContext(): Map<string, string> {
    const context = new Map<string, string>();
    
    for (const item of this.state.items) {
      if (item.type === 'context' && item.metadata?.key) {
        context.set(item.metadata.key as string, item.content);
      }
    }
    
    return context;
  }
  
  // ==========================================
  // MEMORY MANAGEMENT
  // ==========================================
  
  /**
   * Add item with automatic eviction if needed
   */
  private addItem(item: WorkingMemoryItem): void {
    this.state.items.push(item);
    this.state.totalTokens += item.tokenCount;
    
    // Evict if over limit
    while (this.state.totalTokens > MAX_TOKENS) {
      this.evictLowestPriority();
    }
    
    // Also enforce message count limit
    const messageCount = this.state.items.filter(i => i.type === 'message').length;
    if (messageCount > MAX_MESSAGES) {
      this.evictOldestMessages(messageCount - MAX_MESSAGES);
    }
  }
  
  /**
   * Evict lowest priority item
   */
  private evictLowestPriority(): void {
    if (this.state.items.length === 0) return;
    
    // Sort by priority (ascending) then by age (oldest first)
    const sorted = [...this.state.items].sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.timestamp - b.timestamp;
    });
    
    const toEvict = sorted[0];
    this.state.items = this.state.items.filter(i => i.id !== toEvict.id);
    this.state.totalTokens -= toEvict.tokenCount;
    
    logger.debug('Evicted item from working memory', { 
      id: toEvict.id, 
      type: toEvict.type,
      tokens: toEvict.tokenCount 
    });
  }
  
  /**
   * Evict oldest messages
   */
  private evictOldestMessages(count: number): void {
    const messages = this.state.items
      .filter(i => i.type === 'message')
      .sort((a, b) => a.timestamp - b.timestamp);
    
    const toEvict = messages.slice(0, count);
    const evictIds = new Set(toEvict.map(m => m.id));
    
    this.state.items = this.state.items.filter(i => !evictIds.has(i.id));
    this.recalculateTokens();
  }
  
  /**
   * Recalculate total tokens
   */
  private recalculateTokens(): void {
    this.state.totalTokens = this.state.items.reduce((sum, item) => sum + item.tokenCount, 0);
  }
  
  /**
   * Estimate token count (rough approximation)
   */
  private estimateTokens(text: string): number {
    // Rough estimate: ~4 chars per token for English
    return Math.ceil(text.length / 4);
  }
  
  // ==========================================
  // SERIALIZATION
  // ==========================================
  
  /**
   * Get full context for LLM
   */
  getFullContext(): string {
    const sections: string[] = [];
    
    // Active task
    if (this.state.activeTask) {
      const task = this.state.activeTask;
      const completedSteps = task.steps.filter(s => s.status === 'completed').length;
      sections.push(`## Active Task\n${task.description}\nProgress: ${completedSteps}/${task.steps.length} steps`);
    }
    
    // Context items
    const contextItems = this.state.items.filter(i => i.type === 'context');
    if (contextItems.length > 0) {
      sections.push(`## Context\n${contextItems.map(c => c.content).join('\n')}`);
    }
    
    // Reasoning chain
    const reasoning = this.getReasoningChain();
    if (reasoning.length > 0) {
      sections.push(`## Reasoning\n${reasoning.join('\n')}`);
    }
    
    // Recent messages
    const messages = this.getRecentMessages(10);
    if (messages.length > 0) {
      sections.push(`## Recent Messages\n${messages.join('\n')}`);
    }
    
    return sections.join('\n\n');
  }
  
  /**
   * Export state for persistence
   */
  export(): WorkingMemoryState {
    return { ...this.state };
  }
  
  /**
   * Import state from persistence
   */
  import(state: WorkingMemoryState): void {
    this.state = { ...state };
  }
  
  /**
   * Get statistics
   */
  getStats(): { itemCount: number; tokenCount: number; tokenLimit: number } {
    return {
      itemCount: this.state.items.length,
      tokenCount: this.state.totalTokens,
      tokenLimit: MAX_TOKENS
    };
  }
  
  /**
   * Clear all memory
   */
  clear(): void {
    this.state = {
      items: [],
      activeTask: null,
      totalTokens: 0,
      sessionId: this.state.sessionId
    };
  }
}

// ==========================================
// SINGLETON INSTANCE
// ==========================================

let instance: WorkingMemory | null = null;

export function getWorkingMemory(sessionId?: string): WorkingMemory {
  if (!instance && sessionId) {
    instance = new WorkingMemory(sessionId);
  }
  if (!instance) {
    instance = new WorkingMemory('default');
  }
  return instance;
}

export function resetWorkingMemory(): void {
  if (instance) {
    instance.clear();
  }
  instance = null;
}
