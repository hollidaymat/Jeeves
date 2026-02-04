/**
 * Intent Parser
 * Uses Claude to convert natural language to structured commands
 */

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { findProject, listProjects, getProjectIndex } from './project-scanner.js';
import type { ParsedIntent, ActionType } from '../types/index.js';

// Initialize Anthropic client
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

/**
 * Build the system prompt with current project list
 */
function buildSystemPrompt(): string {
  const projectList = Array.from(getProjectIndex().projects.entries())
    .map(([name, p]) => `- ${name}: ${p.path}`)
    .join('\n');

  return `You are a command interpreter for Cursor IDE. Convert natural language requests into executable commands.

Available actions:
- open_project: Open a project folder in Cursor
- open_file: Open a specific file in Cursor
- goto_line: Navigate to a specific line in a file
- status: Return system status
- help: Return available commands
- list_projects: List all known projects

Known projects:
${projectList || '(No projects scanned yet)'}

RULES:
1. Respond ONLY with valid JSON. No markdown, no explanation.
2. Match project names flexibly (e.g., "basecamp", "base camp", "the basecamp project" all match "basecamp")
3. If a file is mentioned without a project, assume the most recently mentioned or most likely project
4. For goto_line, you need both a file path and a line number

Response format:
{
  "action": "open_project" | "open_file" | "goto_line" | "status" | "help" | "list_projects" | "unknown" | "denied",
  "target": "project or file name",
  "resolved_path": "full path to project/file",
  "command": "cursor <path>",
  "line": 50,
  "confidence": 0.95,
  "message": "optional message for unknown/denied"
}

If you cannot interpret the request, respond with:
{"action": "unknown", "confidence": 0.0, "message": "Could not understand request"}

If the request seems dangerous or outside scope, respond with:
{"action": "denied", "confidence": 1.0, "message": "Request not allowed"}`;
}

/**
 * Simple commands that don't need Claude
 */
function handleSimpleCommand(message: string): ParsedIntent | null {
  const lower = message.toLowerCase().trim();
  
  if (lower === 'status') {
    return {
      action: 'status',
      confidence: 1.0
    };
  }
  
  if (lower === 'help' || lower === '?') {
    return {
      action: 'help',
      confidence: 1.0,
      message: `Available commands:
- "open <project>" - Open a project in Cursor
- "open <file> in <project>" - Open a specific file
- "go to line <n>" - Navigate to a line
- "list projects" - Show all known projects
- "status" - Check system status
- "help" - Show this message`
    };
  }
  
  if (lower === 'list projects' || lower === 'projects' || lower === 'list') {
    return {
      action: 'list_projects',
      confidence: 1.0,
      message: listProjects()
    };
  }
  
  return null;
}

/**
 * Try to parse locally without Claude (for simple open commands)
 */
function tryLocalParse(message: string): ParsedIntent | null {
  const lower = message.toLowerCase().trim();
  
  // Pattern: "open <project>"
  const openMatch = lower.match(/^open\s+(?:the\s+)?(.+?)(?:\s+project)?$/i);
  if (openMatch) {
    const projectName = openMatch[1].trim();
    const project = findProject(projectName);
    
    if (project) {
      return {
        action: 'open_project',
        target: project.name,
        resolved_path: project.path,
        command: `cursor "${project.path}"`,
        confidence: 0.95
      };
    }
  }
  
  return null;
}

/**
 * Parse a message using Claude
 */
export async function parseIntent(message: string): Promise<ParsedIntent> {
  // Check for simple commands first
  const simple = handleSimpleCommand(message);
  if (simple) return simple;
  
  // Try local parsing for simple open commands
  const local = tryLocalParse(message);
  if (local) return local;
  
  // Fall back to Claude for complex interpretation
  try {
    logger.debug('Sending to Claude for parsing', { message });
    
    const response = await anthropic.messages.create({
      model: config.claude.model,
      max_tokens: config.claude.max_tokens,
      system: buildSystemPrompt(),
      messages: [
        { role: 'user', content: message }
      ]
    });
    
    const content = response.content[0];
    if (content.type !== 'text') {
      throw new Error('Unexpected response type from Claude');
    }
    
    // Parse JSON response
    const parsed = JSON.parse(content.text) as ParsedIntent;
    parsed.raw_response = content.text;
    
    logger.debug('Claude parsed intent', { action: parsed.action, confidence: parsed.confidence });
    
    // Validate and enhance the parsed intent
    if (parsed.action === 'open_project' && parsed.target && !parsed.resolved_path) {
      const project = findProject(parsed.target);
      if (project) {
        parsed.resolved_path = project.path;
        parsed.command = `cursor "${project.path}"`;
      }
    }
    
    return parsed;
    
  } catch (error) {
    logger.error('Error parsing intent', { error: String(error), message });
    return {
      action: 'unknown',
      confidence: 0,
      message: `Error processing request: ${error instanceof Error ? error.message : 'Unknown error'}`
    };
  }
}
