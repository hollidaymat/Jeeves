/**
 * Workflow Engine
 * Executes YAML-defined workflows for deterministic, token-efficient task processing
 */

import { readFile, readdir, mkdir, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, basename } from 'path';
import { parse as parseYaml } from 'yaml';
import { exec } from 'child_process';
import { promisify } from 'util';
import { logger } from '../utils/logger.js';
import { generateText } from './llm/traced-llm.js';
import { createAnthropic } from '@ai-sdk/anthropic';
import { trackLLMUsage } from './cost-tracker.js';
import { config } from '../config.js';

const execAsync = promisify(exec);

// ==========================================
// WORKFLOW TYPES
// ==========================================

interface WorkflowStep {
  name: string;
  type: 'llm' | 'exec' | 'template' | 'condition';
  model?: 'haiku' | 'sonnet' | 'opus';
  max_tokens?: number;
  prompt?: string;
  command?: string;
  template?: string;
  condition?: string;
  on_true?: string;
  on_false?: string;
}

interface Workflow {
  name: string;
  description: string;
  trigger_patterns: string[];
  steps: WorkflowStep[];
}

interface WorkflowContext {
  message: string;
  projectPath?: string;
  [key: string]: unknown;
}

interface WorkflowResult {
  success: boolean;
  output: string;
  stepResults: Record<string, unknown>;
  tokensUsed: number;
  cost: number;
}

// Model ID mapping (uses config for haiku/sonnet; opus fallback)
const MODEL_IDS: Record<string, string> = {
  'haiku': config.claude.haiku_model,
  'sonnet': config.claude.model,
  'opus': 'claude-opus-4-6'
};

// Loaded workflows cache
const workflows: Map<string, Workflow> = new Map();

// ==========================================
// WORKFLOW LOADING
// ==========================================

/**
 * Load all workflows from the workflows directory
 */
export async function loadWorkflows(workflowsDir?: string): Promise<void> {
  const dir = workflowsDir || join(process.cwd(), 'workflows');
  
  // Create workflows directory if it doesn't exist
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
    logger.info(`Created workflows directory: ${dir}`);
    return;
  }
  
  try {
    const files = await readdir(dir);
    const yamlFiles = files.filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
    
    for (const file of yamlFiles) {
      const content = await readFile(join(dir, file), 'utf-8');
      const workflow = parseYaml(content) as Workflow;
      
      if (workflow.name && workflow.steps) {
        workflows.set(workflow.name, workflow);
        logger.debug(`Loaded workflow: ${workflow.name}`);
      }
    }
    
    logger.info(`Loaded ${workflows.size} workflows`);
  } catch (error) {
    logger.error('Failed to load workflows', { error: String(error) });
  }
}

/**
 * Get a workflow by name
 */
export function getWorkflow(name: string): Workflow | undefined {
  return workflows.get(name);
}

/**
 * List all available workflows
 */
export function listWorkflows(): string[] {
  return Array.from(workflows.keys());
}

// ==========================================
// PATTERN MATCHING
// ==========================================

/**
 * Find a workflow that matches the given message
 */
export function matchWorkflow(message: string): { workflow: Workflow; match: RegExpMatchArray } | null {
  const lower = message.toLowerCase();
  
  for (const workflow of workflows.values()) {
    for (const pattern of workflow.trigger_patterns) {
      // Convert pattern to regex (supports simple patterns)
      const regex = new RegExp(pattern, 'i');
      const match = lower.match(regex);
      
      if (match) {
        logger.debug(`Matched workflow "${workflow.name}" with pattern "${pattern}"`);
        return { workflow, match };
      }
    }
  }
  
  return null;
}

// ==========================================
// TEMPLATE INTERPOLATION
// ==========================================

/**
 * Interpolate template variables in a string
 * Supports: {{variable}}, {{step.output}}, {{step.field}}
 */
function interpolate(template: string, context: WorkflowContext, stepResults: Record<string, unknown>): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (match, path) => {
    const trimmed = path.trim();
    
    // Check step results first (e.g., {{extract-params.name}})
    if (trimmed.includes('.')) {
      const [stepName, ...fieldPath] = trimmed.split('.');
      const stepResult = stepResults[stepName];
      
      if (stepResult !== undefined) {
        // Navigate nested path
        let value = stepResult;
        for (const field of fieldPath) {
          if (typeof value === 'object' && value !== null) {
            value = (value as Record<string, unknown>)[field] as {} | null;
          } else {
            return match; // Keep original if path doesn't exist
          }
        }
        return String(value ?? match);
      }
    }
    
    // Check context
    if (trimmed in context) {
      return String(context[trimmed]);
    }
    
    return match; // Keep original if not found
  });
}

// ==========================================
// STEP EXECUTION
// ==========================================

/**
 * Execute an LLM step
 */
async function executeLLMStep(
  step: WorkflowStep,
  context: WorkflowContext,
  stepResults: Record<string, unknown>
): Promise<{ output: unknown; tokens: number; cost: number }> {
  const modelTier = step.model || 'haiku';
  const modelId = MODEL_IDS[modelTier];
  const prompt = interpolate(step.prompt || '', context, stepResults);
  const maxTokens = step.max_tokens || 500;
  
  logger.debug(`Executing LLM step "${step.name}" with ${modelTier}`);
  
  const anthropic = createAnthropic({
    apiKey: process.env.ANTHROPIC_API_KEY
  });
  
  const result = await generateText({
    model: anthropic(modelId),
    prompt: prompt,
    maxTokens: maxTokens
  });
  
  const usage = result.usage;
  const inputTokens = usage?.promptTokens || 0;
  const outputTokens = usage?.completionTokens || 0;
  
  // Track LLM usage
  trackLLMUsage(`workflow:${step.name}`, modelId, inputTokens, outputTokens, false);
  
  // Try to parse as JSON if it looks like JSON
  let output: unknown = result.text;
  const text = result.text.trim();
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      output = JSON.parse(text);
    } catch {
      // Keep as string
    }
  }
  
  // Calculate cost
  const pricing: Record<string, { input: number; output: number }> = {
    'haiku': { input: 1.00, output: 5.00 },
    'sonnet': { input: 3.00, output: 15.00 },
    'opus': { input: 15.00, output: 75.00 }
  };
  const p = pricing[modelTier];
  const cost = (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
  
  return {
    output,
    tokens: inputTokens + outputTokens,
    cost
  };
}

/**
 * Execute a shell command step
 */
async function executeExecStep(
  step: WorkflowStep,
  context: WorkflowContext,
  stepResults: Record<string, unknown>
): Promise<{ output: string }> {
  const command = interpolate(step.command || '', context, stepResults);
  const cwd = context.projectPath || process.cwd();
  
  logger.debug(`Executing command step "${step.name}": ${command.substring(0, 50)}...`);
  
  try {
    const { stdout, stderr } = await execAsync(command, { cwd });
    return { output: stdout || stderr };
  } catch (error) {
    const err = error as { message?: string };
    throw new Error(`Command failed: ${err.message || 'Unknown error'}`);
  }
}

/**
 * Execute a template step (just interpolation, no LLM)
 */
function executeTemplateStep(
  step: WorkflowStep,
  context: WorkflowContext,
  stepResults: Record<string, unknown>
): { output: string } {
  const output = interpolate(step.template || '', context, stepResults);
  return { output };
}

// ==========================================
// WORKFLOW EXECUTION
// ==========================================

/**
 * Execute a workflow
 */
export async function executeWorkflow(
  workflow: Workflow,
  context: WorkflowContext
): Promise<WorkflowResult> {
  logger.info(`Executing workflow: ${workflow.name}`);
  
  const stepResults: Record<string, unknown> = {};
  let totalTokens = 0;
  let totalCost = 0;
  let lastOutput = '';
  
  for (const step of workflow.steps) {
    try {
      logger.debug(`Step: ${step.name} (${step.type})`);
      
      switch (step.type) {
        case 'llm': {
          const result = await executeLLMStep(step, context, stepResults);
          stepResults[step.name] = result.output;
          totalTokens += result.tokens;
          totalCost += result.cost;
          lastOutput = typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
          break;
        }
        
        case 'exec': {
          const result = await executeExecStep(step, context, stepResults);
          stepResults[step.name] = result.output;
          lastOutput = result.output;
          break;
        }
        
        case 'template': {
          const result = executeTemplateStep(step, context, stepResults);
          stepResults[step.name] = result.output;
          lastOutput = result.output;
          break;
        }
        
        case 'condition': {
          // Evaluate condition and choose next step
          const conditionResult = interpolate(step.condition || '', context, stepResults);
          const isTruthy = conditionResult && conditionResult !== 'false' && conditionResult !== '0';
          stepResults[step.name] = { result: isTruthy, nextStep: isTruthy ? step.on_true : step.on_false };
          break;
        }
        
        default:
          logger.warn(`Unknown step type: ${step.type}`);
      }
    } catch (error) {
      logger.error(`Workflow step "${step.name}" failed`, { error: String(error) });
      return {
        success: false,
        output: `Workflow failed at step "${step.name}": ${error instanceof Error ? error.message : 'Unknown error'}`,
        stepResults,
        tokensUsed: totalTokens,
        cost: totalCost
      };
    }
  }
  
  logger.info(`Workflow "${workflow.name}" completed`, { tokens: totalTokens, cost: totalCost.toFixed(4) });
  
  return {
    success: true,
    output: lastOutput,
    stepResults,
    tokensUsed: totalTokens,
    cost: totalCost
  };
}

/**
 * Try to execute a workflow for a given message
 * Returns null if no workflow matches
 */
export async function tryExecuteWorkflow(
  message: string,
  projectPath?: string
): Promise<WorkflowResult | null> {
  const matched = matchWorkflow(message);
  
  if (!matched) {
    return null;
  }
  
  const context: WorkflowContext = {
    message,
    projectPath
  };
  
  return executeWorkflow(matched.workflow, context);
}
