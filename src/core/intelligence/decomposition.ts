/**
 * Decomposition Skill - PRD and Task Breakdown
 * 
 * Breaks down complex requirements into:
 * - Epics → Features → Tasks → Subtasks
 * - Identifies dependencies
 * - Estimates complexity
 * - Suggests implementation order
 */

import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';
import { generateText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { trackLLMUsage } from '../cost-tracker.js';

// ==========================================
// TYPES
// ==========================================

export type ItemType = 'epic' | 'feature' | 'task' | 'subtask';
export type Complexity = 'trivial' | 'simple' | 'moderate' | 'complex' | 'very_complex';
export type Priority = 'p0_critical' | 'p1_high' | 'p2_medium' | 'p3_low';

export interface DecomposedItem {
  id: string;
  type: ItemType;
  title: string;
  description: string;
  acceptanceCriteria?: string[];
  complexity: Complexity;
  estimatedHours?: number;
  priority: Priority;
  dependencies: string[];  // IDs of items this depends on
  children: DecomposedItem[];
  tags: string[];
  implementationNotes?: string;
}

export interface PRDInput {
  title: string;
  overview: string;
  requirements: string[];
  constraints?: string[];
  nonGoals?: string[];
  successMetrics?: string[];
}

export interface DecompositionResult {
  prd: PRDInput;
  items: DecomposedItem[];
  summary: {
    totalItems: number;
    byType: Record<ItemType, number>;
    byComplexity: Record<Complexity, number>;
    estimatedTotalHours: number;
    criticalPath: string[];
  };
  suggestedOrder: string[];  // Item IDs in suggested implementation order
}

// ==========================================
// COMPLEXITY ESTIMATION
// ==========================================

const COMPLEXITY_HOURS: Record<Complexity, number> = {
  trivial: 0.5,
  simple: 2,
  moderate: 4,
  complex: 8,
  very_complex: 16
};

function estimateComplexity(description: string, tags: string[]): Complexity {
  const indicators = {
    trivial: ['rename', 'typo', 'comment', 'log', 'format'],
    simple: ['add', 'update', 'modify', 'change', 'fix'],
    moderate: ['create', 'implement', 'integrate', 'refactor'],
    complex: ['design', 'architect', 'migrate', 'optimize', 'secure'],
    very_complex: ['rewrite', 'overhaul', 'system', 'platform', 'framework']
  };
  
  const descLower = description.toLowerCase();
  const allText = [descLower, ...tags.map(t => t.toLowerCase())].join(' ');
  
  // Count matches for each complexity level
  let maxScore = 0;
  let result: Complexity = 'moderate';
  
  for (const [complexity, keywords] of Object.entries(indicators)) {
    const score = keywords.filter(kw => allText.includes(kw)).length;
    if (score > maxScore) {
      maxScore = score;
      result = complexity as Complexity;
    }
  }
  
  // Adjust based on description length (longer = more complex)
  if (description.length > 200 && result !== 'very_complex') {
    const complexityOrder: Complexity[] = ['trivial', 'simple', 'moderate', 'complex', 'very_complex'];
    const currentIdx = complexityOrder.indexOf(result);
    if (currentIdx < complexityOrder.length - 1) {
      result = complexityOrder[currentIdx + 1];
    }
  }
  
  return result;
}

// ==========================================
// DECOMPOSITION ENGINE
// ==========================================

export class DecompositionEngine {
  private idCounter: number = 0;
  
  private generateId(type: ItemType): string {
    this.idCounter++;
    const prefix = {
      epic: 'E',
      feature: 'F',
      task: 'T',
      subtask: 'S'
    };
    return `${prefix[type]}${this.idCounter.toString().padStart(3, '0')}`;
  }
  
  /**
   * Decompose a PRD into structured items
   */
  async decomposePRD(prd: PRDInput): Promise<DecompositionResult> {
    logger.debug('Decomposing PRD', { title: prd.title });
    
    this.idCounter = 0;
    const items: DecomposedItem[] = [];
    
    // Create main epic
    const epic = this.createEpic(prd);
    items.push(epic);
    
    // Break down requirements into features
    for (const requirement of prd.requirements) {
      const feature = await this.requirementToFeature(requirement, epic.id);
      epic.children.push(feature);
      items.push(feature);
      
      // Break down features into tasks
      const tasks = await this.featureToTasks(feature, prd);
      feature.children.push(...tasks);
      items.push(...tasks);
      
      // Break down complex tasks into subtasks
      for (const task of tasks) {
        if (task.complexity === 'complex' || task.complexity === 'very_complex') {
          const subtasks = this.taskToSubtasks(task);
          task.children.push(...subtasks);
          items.push(...subtasks);
        }
      }
    }
    
    // Calculate dependencies
    this.inferDependencies(items);
    
    // Calculate summary
    const summary = this.calculateSummary(items);
    
    // Determine implementation order
    const suggestedOrder = this.topologicalSort(items);
    
    return {
      prd,
      items,
      summary,
      suggestedOrder
    };
  }
  
  /**
   * Create epic from PRD
   */
  private createEpic(prd: PRDInput): DecomposedItem {
    return {
      id: this.generateId('epic'),
      type: 'epic',
      title: prd.title,
      description: prd.overview,
      acceptanceCriteria: prd.successMetrics,
      complexity: 'very_complex',
      priority: 'p1_high',
      dependencies: [],
      children: [],
      tags: ['epic']
    };
  }
  
  /**
   * Convert requirement to feature
   */
  private async requirementToFeature(
    requirement: string,
    parentId: string
  ): Promise<DecomposedItem> {
    // Extract key info from requirement
    const titleMatch = requirement.match(/^([^:.\n]+)/);
    const title = titleMatch ? titleMatch[1].trim() : requirement.substring(0, 50);
    
    const complexity = estimateComplexity(requirement, []);
    
    return {
      id: this.generateId('feature'),
      type: 'feature',
      title,
      description: requirement,
      complexity,
      estimatedHours: COMPLEXITY_HOURS[complexity] * 2,  // Features are roughly 2x task estimate
      priority: 'p2_medium',
      dependencies: [parentId],
      children: [],
      tags: this.extractTags(requirement)
    };
  }
  
  /**
   * Break feature into tasks
   */
  private async featureToTasks(
    feature: DecomposedItem,
    prd: PRDInput
  ): Promise<DecomposedItem[]> {
    const tasks: DecomposedItem[] = [];
    
    // Use LLM for intelligent breakdown
    try {
      const anthropic = createAnthropic({
        apiKey: process.env.ANTHROPIC_API_KEY
      });
      
      const prompt = `Break down this feature into implementation tasks:

FEATURE: ${feature.title}
DESCRIPTION: ${feature.description}
CONSTRAINTS: ${prd.constraints?.join(', ') || 'None'}

Provide 3-6 concrete, actionable tasks.
Each task should be completable in 1-8 hours.

Respond with JSON:
{
  "tasks": [
    {
      "title": "Task title",
      "description": "What to do",
      "estimatedHours": 4,
      "tags": ["tag1", "tag2"]
    }
  ]
}`;

      const result = await generateText({
        model: anthropic(config.claude.haiku_model),
        prompt,
        maxTokens: 500
      });
      
      if (result.usage) {
        trackLLMUsage('decomposition', config.claude.haiku_model,
          result.usage.promptTokens, result.usage.completionTokens, false);
      }
      
      const parsed = JSON.parse(result.text.match(/\{[\s\S]*\}/)?.[0] || '{}');
      
      for (const t of parsed.tasks || []) {
        const complexity = this.hoursToComplexity(t.estimatedHours || 4);
        
        tasks.push({
          id: this.generateId('task'),
          type: 'task',
          title: t.title,
          description: t.description || '',
          complexity,
          estimatedHours: t.estimatedHours || COMPLEXITY_HOURS[complexity],
          priority: 'p2_medium',
          dependencies: [feature.id],
          children: [],
          tags: t.tags || []
        });
      }
      
    } catch (error) {
      logger.debug('LLM task breakdown failed, using heuristic', { error: String(error) });
      
      // Fallback: create generic tasks
      tasks.push(
        {
          id: this.generateId('task'),
          type: 'task',
          title: `Design ${feature.title}`,
          description: `Plan the implementation of ${feature.title}`,
          complexity: 'simple',
          estimatedHours: 2,
          priority: 'p2_medium',
          dependencies: [feature.id],
          children: [],
          tags: ['design']
        },
        {
          id: this.generateId('task'),
          type: 'task',
          title: `Implement ${feature.title}`,
          description: `Build the core functionality for ${feature.title}`,
          complexity: feature.complexity,
          estimatedHours: COMPLEXITY_HOURS[feature.complexity],
          priority: 'p2_medium',
          dependencies: [feature.id],
          children: [],
          tags: ['implementation']
        },
        {
          id: this.generateId('task'),
          type: 'task',
          title: `Test ${feature.title}`,
          description: `Write tests and verify ${feature.title}`,
          complexity: 'simple',
          estimatedHours: 2,
          priority: 'p2_medium',
          dependencies: [feature.id],
          children: [],
          tags: ['testing']
        }
      );
    }
    
    return tasks;
  }
  
  /**
   * Break complex task into subtasks
   */
  private taskToSubtasks(task: DecomposedItem): DecomposedItem[] {
    const subtasks: DecomposedItem[] = [];
    const baseHours = task.estimatedHours || COMPLEXITY_HOURS[task.complexity];
    
    // Create 2-4 subtasks
    const subtaskCount = task.complexity === 'very_complex' ? 4 : 3;
    const hoursPerSubtask = baseHours / subtaskCount;
    
    const subtaskTemplates = [
      { title: 'Setup and preparation', tag: 'setup' },
      { title: 'Core implementation', tag: 'implementation' },
      { title: 'Edge cases and error handling', tag: 'edge-cases' },
      { title: 'Testing and validation', tag: 'testing' }
    ];
    
    for (let i = 0; i < subtaskCount; i++) {
      const template = subtaskTemplates[i];
      const complexity = this.hoursToComplexity(hoursPerSubtask);
      
      subtasks.push({
        id: this.generateId('subtask'),
        type: 'subtask',
        title: `${template.title}: ${task.title}`,
        description: `Subtask for ${task.title}`,
        complexity,
        estimatedHours: hoursPerSubtask,
        priority: task.priority,
        dependencies: i > 0 ? [subtasks[i - 1].id] : [task.id],
        children: [],
        tags: [template.tag, ...task.tags]
      });
    }
    
    return subtasks;
  }
  
  /**
   * Infer dependencies between items
   */
  private inferDependencies(items: DecomposedItem[]): void {
    // Look for keyword-based dependencies
    const keywordDependencies: Record<string, string[]> = {
      'test': ['implement', 'create', 'build'],
      'deploy': ['test', 'build'],
      'document': ['implement'],
      'integrate': ['implement', 'create'],
      'optimize': ['implement', 'test']
    };
    
    for (const item of items) {
      const titleLower = item.title.toLowerCase();
      
      for (const [keyword, dependsOn] of Object.entries(keywordDependencies)) {
        if (titleLower.includes(keyword)) {
          // Find items that match dependency keywords
          for (const other of items) {
            if (other.id === item.id) continue;
            if (item.dependencies.includes(other.id)) continue;
            
            const otherLower = other.title.toLowerCase();
            if (dependsOn.some(dep => otherLower.includes(dep))) {
              // Only add if in same feature tree
              if (this.shareParent(item, other, items)) {
                item.dependencies.push(other.id);
              }
            }
          }
        }
      }
    }
  }
  
  private shareParent(a: DecomposedItem, b: DecomposedItem, all: DecomposedItem[]): boolean {
    // Check if items share a parent
    const aParents = new Set(a.dependencies);
    const bParents = new Set(b.dependencies);
    
    for (const parent of aParents) {
      if (bParents.has(parent)) return true;
    }
    
    return false;
  }
  
  /**
   * Topological sort for implementation order
   */
  private topologicalSort(items: DecomposedItem[]): string[] {
    const result: string[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();
    
    const itemMap = new Map(items.map(i => [i.id, i]));
    
    const visit = (id: string) => {
      if (visited.has(id)) return;
      if (visiting.has(id)) {
        logger.debug('Circular dependency detected', { id });
        return;
      }
      
      visiting.add(id);
      
      const item = itemMap.get(id);
      if (item) {
        for (const depId of item.dependencies) {
          visit(depId);
        }
      }
      
      visiting.delete(id);
      visited.add(id);
      result.push(id);
    };
    
    for (const item of items) {
      visit(item.id);
    }
    
    return result;
  }
  
  /**
   * Calculate summary statistics
   */
  private calculateSummary(items: DecomposedItem[]): DecompositionResult['summary'] {
    const byType: Record<ItemType, number> = {
      epic: 0,
      feature: 0,
      task: 0,
      subtask: 0
    };
    
    const byComplexity: Record<Complexity, number> = {
      trivial: 0,
      simple: 0,
      moderate: 0,
      complex: 0,
      very_complex: 0
    };
    
    let totalHours = 0;
    
    for (const item of items) {
      byType[item.type]++;
      byComplexity[item.complexity]++;
      
      // Only count leaf items for hours (avoid double counting)
      if (item.children.length === 0 && item.estimatedHours) {
        totalHours += item.estimatedHours;
      }
    }
    
    // Find critical path (longest dependency chain)
    const criticalPath = this.findCriticalPath(items);
    
    return {
      totalItems: items.length,
      byType,
      byComplexity,
      estimatedTotalHours: totalHours,
      criticalPath
    };
  }
  
  private findCriticalPath(items: DecomposedItem[]): string[] {
    const itemMap = new Map(items.map(i => [i.id, i]));
    let longestPath: string[] = [];
    
    const findPath = (id: string, currentPath: string[]): void => {
      currentPath.push(id);
      
      if (currentPath.length > longestPath.length) {
        longestPath = [...currentPath];
      }
      
      // Find items that depend on this one
      for (const item of items) {
        if (item.dependencies.includes(id)) {
          findPath(item.id, currentPath);
        }
      }
      
      currentPath.pop();
    };
    
    // Start from items with no dependencies
    for (const item of items) {
      if (item.dependencies.length === 0 || 
          item.dependencies.every(d => !itemMap.has(d))) {
        findPath(item.id, []);
      }
    }
    
    return longestPath;
  }
  
  // ==========================================
  // UTILITY FUNCTIONS
  // ==========================================
  
  private extractTags(text: string): string[] {
    const tags: string[] = [];
    const keywords = [
      'api', 'ui', 'database', 'auth', 'security', 'performance',
      'testing', 'documentation', 'deployment', 'integration'
    ];
    
    const textLower = text.toLowerCase();
    for (const kw of keywords) {
      if (textLower.includes(kw)) {
        tags.push(kw);
      }
    }
    
    return tags;
  }
  
  private hoursToComplexity(hours: number): Complexity {
    if (hours <= 1) return 'trivial';
    if (hours <= 3) return 'simple';
    if (hours <= 6) return 'moderate';
    if (hours <= 12) return 'complex';
    return 'very_complex';
  }
  
  /**
   * Format decomposition as markdown
   */
  formatAsMarkdown(result: DecompositionResult): string {
    const lines: string[] = [];
    
    lines.push(`# ${result.prd.title}`);
    lines.push('');
    lines.push(`## Summary`);
    lines.push(`- Total Items: ${result.summary.totalItems}`);
    lines.push(`- Estimated Hours: ${result.summary.estimatedTotalHours}`);
    lines.push(`- Tasks: ${result.summary.byType.task}`);
    lines.push(`- Subtasks: ${result.summary.byType.subtask}`);
    lines.push('');
    
    lines.push(`## Breakdown`);
    
    const renderItem = (item: DecomposedItem, indent: number) => {
      const prefix = '  '.repeat(indent);
      const complexity = `[${item.complexity}]`;
      const hours = item.estimatedHours ? `(${item.estimatedHours}h)` : '';
      
      lines.push(`${prefix}- **${item.id}**: ${item.title} ${complexity} ${hours}`);
      
      if (item.description && indent > 0) {
        lines.push(`${prefix}  _${item.description.substring(0, 100)}${item.description.length > 100 ? '...' : ''}_`);
      }
      
      for (const child of item.children) {
        renderItem(child, indent + 1);
      }
    };
    
    for (const item of result.items) {
      if (item.type === 'epic') {
        renderItem(item, 0);
      }
    }
    
    lines.push('');
    lines.push(`## Suggested Order`);
    for (let i = 0; i < Math.min(10, result.suggestedOrder.length); i++) {
      lines.push(`${i + 1}. ${result.suggestedOrder[i]}`);
    }
    
    return lines.join('\n');
  }
}

// ==========================================
// SINGLETON INSTANCE
// ==========================================

let instance: DecompositionEngine | null = null;

export function getDecompositionEngine(): DecompositionEngine {
  if (!instance) {
    instance = new DecompositionEngine();
  }
  return instance;
}
