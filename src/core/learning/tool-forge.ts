/**
 * Tool Forge - Self-Extension System
 * 
 * Allows Jeeves to create and manage new tools/workflows:
 * - Template-based tool creation
 * - Workflow automation
 * - Tool validation and testing
 * - Tool versioning and rollback
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

export type ToolType = 'command' | 'workflow' | 'snippet' | 'template' | 'automation';

export interface ToolDefinition {
  id: string;
  name: string;
  description: string;
  type: ToolType;
  version: string;
  createdAt: number;
  updatedAt: number;
  createdBy: 'user' | 'jeeves';
  
  // Implementation
  implementation: ToolImplementation;
  
  // Metadata
  tags: string[];
  usageCount: number;
  successRate: number;
  
  // Validation
  validated: boolean;
  testResults?: TestResult[];
}

export interface ToolImplementation {
  // For commands/workflows
  steps?: ToolStep[];
  
  // For snippets/templates
  code?: string;
  language?: string;
  
  // For automations
  trigger?: AutomationTrigger;
  actions?: AutomationAction[];
  
  // Common
  parameters?: ToolParameter[];
  examples?: ToolExample[];
}

export interface ToolStep {
  id: string;
  action: string;
  description?: string;
  command?: string;
  condition?: string;  // When to execute this step
  errorHandling?: 'continue' | 'stop' | 'retry';
}

export interface ToolParameter {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  required: boolean;
  default?: unknown;
  description?: string;
  validation?: string;  // Regex or condition
}

export interface ToolExample {
  input: Record<string, unknown>;
  expectedOutput?: string;
  description?: string;
}

export interface AutomationTrigger {
  type: 'schedule' | 'event' | 'condition' | 'manual';
  config: Record<string, unknown>;
}

export interface AutomationAction {
  type: 'command' | 'api' | 'notification' | 'file';
  config: Record<string, unknown>;
}

export interface TestResult {
  timestamp: number;
  passed: boolean;
  input: Record<string, unknown>;
  expectedOutput?: string;
  actualOutput?: string;
  error?: string;
  duration: number;
}

// ==========================================
// TOOL TEMPLATES
// ==========================================

const TOOL_TEMPLATES: Record<ToolType, Partial<ToolDefinition>> = {
  command: {
    implementation: {
      steps: [
        { id: 'step1', action: 'validate', description: 'Validate inputs' },
        { id: 'step2', action: 'execute', description: 'Execute main logic' },
        { id: 'step3', action: 'report', description: 'Report results' }
      ],
      parameters: []
    }
  },
  workflow: {
    implementation: {
      steps: [
        { id: 'init', action: 'initialize', description: 'Set up workflow' },
        { id: 'process', action: 'process', description: 'Main processing' },
        { id: 'finalize', action: 'finalize', description: 'Clean up and report' }
      ],
      parameters: []
    }
  },
  snippet: {
    implementation: {
      code: '// Your code here',
      language: 'typescript',
      parameters: []
    }
  },
  template: {
    implementation: {
      code: '// Template with {{placeholders}}',
      language: 'typescript',
      parameters: []
    }
  },
  automation: {
    implementation: {
      trigger: { type: 'manual', config: {} },
      actions: [],
      parameters: []
    }
  }
};

// ==========================================
// TOOL FORGE CLASS
// ==========================================

export class ToolForge {
  private tools: Map<string, ToolDefinition> = new Map();
  private versions: Map<string, ToolDefinition[]> = new Map();  // Version history
  private persistPath: string;
  
  constructor(dataDir: string = '.jeeves') {
    this.persistPath = path.join(dataDir, 'tools.json');
    this.load();
  }
  
  private load(): void {
    try {
      if (fs.existsSync(this.persistPath)) {
        const data = JSON.parse(fs.readFileSync(this.persistPath, 'utf-8'));
        this.tools = new Map(Object.entries(data.tools || {}));
        this.versions = new Map(Object.entries(data.versions || {}));
      }
    } catch (error) {
      logger.debug('Failed to load tools', { error: String(error) });
    }
  }
  
  private persist(): void {
    try {
      const dataDir = path.dirname(this.persistPath);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      
      fs.writeFileSync(this.persistPath, JSON.stringify({
        tools: Object.fromEntries(this.tools),
        versions: Object.fromEntries(this.versions)
      }, null, 2));
    } catch (error) {
      logger.error('Failed to persist tools', { error: String(error) });
    }
  }
  
  // ==========================================
  // TOOL CREATION
  // ==========================================
  
  /**
   * Create a new tool from template
   */
  createTool(
    name: string,
    description: string,
    type: ToolType,
    createdBy: 'user' | 'jeeves' = 'jeeves'
  ): ToolDefinition {
    const template = TOOL_TEMPLATES[type];
    
    const tool: ToolDefinition = {
      id: `tool_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      name,
      description,
      type,
      version: '1.0.0',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      createdBy,
      implementation: { ...template.implementation },
      tags: [type],
      usageCount: 0,
      successRate: 0,
      validated: false
    };
    
    this.tools.set(tool.id, tool);
    this.versions.set(tool.id, [{ ...tool }]);
    this.persist();
    
    logger.debug('Tool created', { id: tool.id, name, type });
    
    return tool;
  }
  
  /**
   * Create tool from natural language description
   */
  async createFromDescription(description: string): Promise<ToolDefinition> {
    try {
      const anthropic = createAnthropic({
        apiKey: process.env.ANTHROPIC_API_KEY
      });
      
      const prompt = `Create a tool definition from this description:

"${description}"

Determine:
1. Tool name (short, descriptive)
2. Tool type: command, workflow, snippet, template, or automation
3. Required parameters
4. Implementation steps or code

Respond with JSON:
{
  "name": "tool-name",
  "type": "command|workflow|snippet|template|automation",
  "description": "What the tool does",
  "parameters": [
    { "name": "param1", "type": "string", "required": true, "description": "..." }
  ],
  "steps": [
    { "action": "action-name", "description": "what it does" }
  ],
  "tags": ["tag1", "tag2"]
}`;

      const result = await generateText({
        model: anthropic('claude-3-5-haiku-20241022'),
        prompt,
        maxTokens: 400
      });
      
      if (result.usage) {
        trackLLMUsage('tool-forge', 'claude-3-5-haiku-20241022',
          result.usage.promptTokens, result.usage.completionTokens, false);
      }
      
      const parsed = JSON.parse(result.text.match(/\{[\s\S]*\}/)?.[0] || '{}');
      
      const tool = this.createTool(
        parsed.name || 'new-tool',
        parsed.description || description,
        parsed.type || 'command',
        'jeeves'
      );
      
      // Apply parsed implementation
      if (parsed.parameters) {
        tool.implementation.parameters = parsed.parameters;
      }
      if (parsed.steps) {
        tool.implementation.steps = parsed.steps.map((s: { action: string; description?: string }, i: number) => ({
          id: `step_${i}`,
          action: s.action,
          description: s.description
        }));
      }
      if (parsed.tags) {
        tool.tags = parsed.tags;
      }
      
      this.tools.set(tool.id, tool);
      this.persist();
      
      return tool;
      
    } catch (error) {
      logger.error('Failed to create tool from description', { error: String(error) });
      
      // Fallback to basic creation
      return this.createTool('custom-tool', description, 'command', 'jeeves');
    }
  }
  
  // ==========================================
  // TOOL MODIFICATION
  // ==========================================
  
  /**
   * Update a tool
   */
  updateTool(
    toolId: string,
    updates: Partial<Pick<ToolDefinition, 'name' | 'description' | 'implementation' | 'tags'>>
  ): ToolDefinition | null {
    const tool = this.tools.get(toolId);
    if (!tool) return null;
    
    // Save current version
    const versions = this.versions.get(toolId) || [];
    versions.push({ ...tool });
    this.versions.set(toolId, versions);
    
    // Apply updates
    Object.assign(tool, updates);
    tool.version = this.incrementVersion(tool.version);
    tool.updatedAt = Date.now();
    tool.validated = false;  // Re-validation needed
    
    this.persist();
    
    logger.debug('Tool updated', { id: toolId, version: tool.version });
    
    return tool;
  }
  
  private incrementVersion(version: string): string {
    const parts = version.split('.').map(Number);
    parts[2]++;  // Increment patch
    return parts.join('.');
  }
  
  /**
   * Add step to a tool
   */
  addStep(toolId: string, step: Omit<ToolStep, 'id'>): ToolStep | null {
    const tool = this.tools.get(toolId);
    if (!tool || !tool.implementation.steps) return null;
    
    const newStep: ToolStep = {
      ...step,
      id: `step_${tool.implementation.steps.length}`
    };
    
    tool.implementation.steps.push(newStep);
    tool.updatedAt = Date.now();
    this.persist();
    
    return newStep;
  }
  
  /**
   * Add parameter to a tool
   */
  addParameter(toolId: string, param: ToolParameter): boolean {
    const tool = this.tools.get(toolId);
    if (!tool) return false;
    
    tool.implementation.parameters = tool.implementation.parameters || [];
    tool.implementation.parameters.push(param);
    tool.updatedAt = Date.now();
    this.persist();
    
    return true;
  }
  
  // ==========================================
  // TOOL VALIDATION
  // ==========================================
  
  /**
   * Validate a tool's implementation
   */
  async validateTool(toolId: string): Promise<TestResult[]> {
    const tool = this.tools.get(toolId);
    if (!tool) return [];
    
    const results: TestResult[] = [];
    const examples = tool.implementation.examples || [];
    
    // Test with provided examples
    for (const example of examples) {
      const result = await this.runTest(tool, example);
      results.push(result);
    }
    
    // If no examples, do basic validation
    if (examples.length === 0) {
      results.push(await this.runBasicValidation(tool));
    }
    
    // Update tool with results
    tool.testResults = results;
    tool.validated = results.every(r => r.passed);
    tool.successRate = results.filter(r => r.passed).length / results.length;
    
    this.persist();
    
    logger.debug('Tool validated', { 
      id: toolId, 
      passed: tool.validated,
      tests: results.length
    });
    
    return results;
  }
  
  private async runTest(tool: ToolDefinition, example: ToolExample): Promise<TestResult> {
    const start = Date.now();
    
    try {
      // Validate parameters
      const params = tool.implementation.parameters || [];
      for (const param of params) {
        if (param.required && !(param.name in example.input)) {
          throw new Error(`Missing required parameter: ${param.name}`);
        }
      }
      
      // For now, just validate structure
      // Real execution would happen through the executor
      
      return {
        timestamp: Date.now(),
        passed: true,
        input: example.input,
        expectedOutput: example.expectedOutput,
        actualOutput: 'Validation passed',
        duration: Date.now() - start
      };
      
    } catch (error) {
      return {
        timestamp: Date.now(),
        passed: false,
        input: example.input,
        error: String(error),
        duration: Date.now() - start
      };
    }
  }
  
  private async runBasicValidation(tool: ToolDefinition): Promise<TestResult> {
    const start = Date.now();
    const errors: string[] = [];
    
    // Check required fields
    if (!tool.name) errors.push('Missing name');
    if (!tool.description) errors.push('Missing description');
    
    // Check implementation
    if (tool.type === 'command' || tool.type === 'workflow') {
      if (!tool.implementation.steps || tool.implementation.steps.length === 0) {
        errors.push('No steps defined');
      }
    }
    
    if (tool.type === 'snippet' || tool.type === 'template') {
      if (!tool.implementation.code) {
        errors.push('No code defined');
      }
    }
    
    return {
      timestamp: Date.now(),
      passed: errors.length === 0,
      input: {},
      actualOutput: errors.length === 0 ? 'Basic validation passed' : errors.join(', '),
      error: errors.length > 0 ? errors.join(', ') : undefined,
      duration: Date.now() - start
    };
  }
  
  // ==========================================
  // TOOL USAGE TRACKING
  // ==========================================
  
  /**
   * Record tool usage
   */
  recordUsage(toolId: string, success: boolean): void {
    const tool = this.tools.get(toolId);
    if (!tool) return;
    
    tool.usageCount++;
    
    // Update success rate (weighted moving average)
    const weight = 0.1;
    const successValue = success ? 1 : 0;
    tool.successRate = tool.successRate * (1 - weight) + successValue * weight;
    
    this.persist();
  }
  
  // ==========================================
  // TOOL QUERIES
  // ==========================================
  
  /**
   * Get tool by ID
   */
  getTool(toolId: string): ToolDefinition | undefined {
    return this.tools.get(toolId);
  }
  
  /**
   * Find tools by name or tag
   */
  findTools(query: string): ToolDefinition[] {
    const queryLower = query.toLowerCase();
    
    return Array.from(this.tools.values())
      .filter(tool => 
        tool.name.toLowerCase().includes(queryLower) ||
        tool.description.toLowerCase().includes(queryLower) ||
        tool.tags.some(t => t.toLowerCase().includes(queryLower))
      );
  }
  
  /**
   * Get tools by type
   */
  getToolsByType(type: ToolType): ToolDefinition[] {
    return Array.from(this.tools.values())
      .filter(tool => tool.type === type);
  }
  
  /**
   * Get most used tools
   */
  getMostUsedTools(limit: number = 10): ToolDefinition[] {
    return Array.from(this.tools.values())
      .sort((a, b) => b.usageCount - a.usageCount)
      .slice(0, limit);
  }
  
  /**
   * Get tool version history
   */
  getVersionHistory(toolId: string): ToolDefinition[] {
    return this.versions.get(toolId) || [];
  }
  
  /**
   * Rollback to previous version
   */
  rollback(toolId: string, version: string): ToolDefinition | null {
    const versions = this.versions.get(toolId);
    if (!versions) return null;
    
    const targetVersion = versions.find(v => v.version === version);
    if (!targetVersion) return null;
    
    // Store current as a version
    const current = this.tools.get(toolId);
    if (current) {
      versions.push({ ...current });
    }
    
    // Restore target
    const restored = { 
      ...targetVersion, 
      version: this.incrementVersion(current?.version || version),
      updatedAt: Date.now()
    };
    
    this.tools.set(toolId, restored);
    this.persist();
    
    return restored;
  }
  
  // ==========================================
  // TOOL EXPORT/IMPORT
  // ==========================================
  
  /**
   * Export tool as JSON
   */
  exportTool(toolId: string): string | null {
    const tool = this.tools.get(toolId);
    if (!tool) return null;
    
    return JSON.stringify(tool, null, 2);
  }
  
  /**
   * Import tool from JSON
   */
  importTool(json: string): ToolDefinition | null {
    try {
      const tool = JSON.parse(json) as ToolDefinition;
      
      // Assign new ID
      tool.id = `tool_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
      tool.createdAt = Date.now();
      tool.updatedAt = Date.now();
      tool.usageCount = 0;
      tool.validated = false;
      
      this.tools.set(tool.id, tool);
      this.versions.set(tool.id, [{ ...tool }]);
      this.persist();
      
      return tool;
      
    } catch (error) {
      logger.error('Failed to import tool', { error: String(error) });
      return null;
    }
  }
  
  // ==========================================
  // STATISTICS
  // ==========================================
  
  /**
   * Get forge statistics
   */
  getStats(): {
    totalTools: number;
    byType: Record<ToolType, number>;
    validated: number;
    totalUsage: number;
    avgSuccessRate: number;
  } {
    const byType: Record<ToolType, number> = {
      command: 0,
      workflow: 0,
      snippet: 0,
      template: 0,
      automation: 0
    };
    
    let validated = 0;
    let totalUsage = 0;
    let successRateSum = 0;
    
    for (const tool of this.tools.values()) {
      byType[tool.type]++;
      if (tool.validated) validated++;
      totalUsage += tool.usageCount;
      successRateSum += tool.successRate;
    }
    
    return {
      totalTools: this.tools.size,
      byType,
      validated,
      totalUsage,
      avgSuccessRate: this.tools.size > 0 ? successRateSum / this.tools.size : 0
    };
  }
}

// ==========================================
// SINGLETON INSTANCE
// ==========================================

let instance: ToolForge | null = null;

export function getToolForge(dataDir?: string): ToolForge {
  if (!instance) {
    instance = new ToolForge(dataDir);
  }
  return instance;
}
