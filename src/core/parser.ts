/**
 * Intent Parser
 * Uses Claude via Vercel AI SDK to convert natural language to structured commands
 */

import { generateText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { findProject, listProjects, getProjectIndex } from './project-scanner.js';
import { parseTerminalRequest, getTerminalStatus } from './terminal.js';
import { getFormattedHistory, getFormattedPreferences, getProjectSummary } from './memory.js';
import { getAgentStatus } from './cursor-agent.js';
import { isPrdTrigger, getExecutionStatus } from './prd-executor.js';
import type { ParsedIntent } from '../types/index.js';

// Create Anthropic provider - API key from environment
const anthropic = createAnthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || ''
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
 * Natural language patterns for commands
 */
const PATTERNS = {
  // Status patterns
  status: /^(status|how are you|what'?s your status|system status)$/i,
  
  // Help patterns
  help: /^(help|\?|what can you do|commands|options)$/i,
  
  // List projects patterns  
  listProjects: /^(list|projects|list projects|show projects|what projects)$/i,
  
  // Agent status patterns
  agentStatus: /^(agent status|ai status|is the agent running|check agent)$/i,
  
  // Agent stop patterns
  agentStop: /^(agent stop|stop agent|stop ai|close agent|end session)$/i,
  
  // Apply/reject changes
  apply: /^(apply|yes|confirm|do it|accept|save changes|apply changes)$/i,
  reject: /^(reject|no|cancel|discard|undo|reject changes|nevermind)$/i,
  showDiff: /^(show diff|diff|show changes|what changed|pending changes)$/i,
  
  // Terminal patterns
  terminalStop: /^(stop|kill|cancel|abort)\s*(?:process|command|terminal)?$/i,
  terminalStatus: /^(?:terminal|process)\s*status$/i,
  
  // Memory patterns
  showHistory: /^(?:show\s+)?(?:conversation\s+)?history$/i,
  clearHistory: /^clear\s+(?:conversation\s+)?history$/i,
  showSummary: /^(?:show\s+)?(?:project\s+)?summary$/i,
  showPreferences: /^(?:show\s+)?(?:my\s+)?preferences$/i,
  setPreference: /^set\s+(verbose|auto.?apply|default.?project)\s+(.+)$/i,
  
  // PRD execution patterns
  prdApprove: /^(?:approve|yes|confirm|looks good|go ahead|start building|lgtm)$/i,
  prdPause: /^(?:pause|wait|hold|stop building)$/i,
  prdResume: /^(?:resume|continue|keep going|proceed)$/i,
  prdAbort: /^(?:abort|cancel|stop everything|abandon)$/i,
  prdStatus: /^(?:prd status|build status|execution status|progress)$/i,
  
  // Open in Cursor IDE (explicit)
  openInCursor: /^(?:open in cursor|cursor open|launch|open in ide)\s+(.+)$/i,
  
  // Open/start project patterns - now starts AI session
  openProject: /^(?:open|start|load|switch to|go to|work on|let'?s work on)\s+(?:the\s+)?(?:project\s+)?(.+?)(?:\s+project)?$/i,
  
  // Agent start patterns - flexible
  agentStart: /^(?:agent start|start agent|start ai|analyze|load context for|start working on|let'?s analyze)\s+(.+)$/i,
  
  // Ask patterns - very flexible, captures everything after trigger
  ask: /^(?:ask|tell me|what|how|why|can you|could you|please|explain|describe|summarize|show me|find|where|help me)\s+(.+)$/i,
};

/**
 * Simple commands that don't need Claude
 */
function handleSimpleCommand(message: string): ParsedIntent | null {
  const trimmed = message.trim();
  const lower = trimmed.toLowerCase();
  
  // Status
  if (PATTERNS.status.test(lower)) {
    return { action: 'status', confidence: 1.0 };
  }
  
  // Help
  if (PATTERNS.help.test(lower)) {
    return {
      action: 'help',
      confidence: 1.0,
      message: `## Available Commands

**Load a Project** (starts AI session):
\`sentinel\` \`dive connect\` \`open legends\`

**Ask Questions**:
\`what is the project status\`
\`how does authentication work\`
\`where are the API endpoints\`

**Make Changes**:
\`add a comment to the main function\`
\`fix the bug in auth.ts\`
\`refactor this to use async/await\`

**Review & Apply**:
\`show diff\` → View pending changes
\`apply\` → Write changes to files
\`reject\` → Discard changes

**Terminal Commands**:
\`run dev\` \`run build\` \`run tests\`
\`npm install\` \`npm test\`
\`git status\` \`git pull\` \`git log\`
\`stop\` → Kill running process

**PRD Execution** (autonomous building):
\`build this: <spec>\` → Submit PRD for execution
\`approve\` → Approve execution plan
\`pause\` → Pause execution
\`resume\` → Resume execution
\`prd status\` → Check progress
\`abort\` → Cancel execution

**Memory**:
\`history\` → View conversation history
\`clear history\` → Clear project history
\`summary\` → Project work summary
\`preferences\` → View your settings

**System**:
\`list projects\` \`status\` \`stop\``
    };
  }
  
  // List projects
  if (PATTERNS.listProjects.test(lower)) {
    return {
      action: 'list_projects',
      confidence: 1.0,
      message: listProjects()
    };
  }
  
  // Agent status
  if (PATTERNS.agentStatus.test(lower)) {
    return { action: 'agent_status', confidence: 1.0 };
  }
  
  // Agent stop
  if (PATTERNS.agentStop.test(lower)) {
    return { action: 'agent_stop', confidence: 1.0 };
  }
  
  // Apply changes
  if (PATTERNS.apply.test(lower)) {
    return { action: 'apply_changes', confidence: 1.0 };
  }
  
  // Reject changes
  if (PATTERNS.reject.test(lower)) {
    return { action: 'reject_changes', confidence: 1.0 };
  }
  
  // Show diff
  if (PATTERNS.showDiff.test(lower)) {
    return { action: 'show_diff', confidence: 1.0 };
  }
  
  // Terminal stop
  if (PATTERNS.terminalStop.test(lower)) {
    return { action: 'terminal_stop', confidence: 1.0 };
  }
  
  // Terminal status
  if (PATTERNS.terminalStatus.test(lower)) {
    const status = getTerminalStatus();
    if (status.running) {
      return {
        action: 'status',
        confidence: 1.0,
        message: `Running: ${status.command} (${status.runtime}s)`
      };
    }
    return {
      action: 'status',
      confidence: 1.0,
      message: 'No terminal process running'
    };
  }
  
  // Try to parse as terminal command (npm/git)
  const terminalCmd = parseTerminalRequest(trimmed);
  if (terminalCmd) {
    return {
      action: terminalCmd.type === 'npm' ? 'terminal_npm' : 'terminal_git',
      terminal_command: terminalCmd,
      confidence: 0.95,
      message: `Running: ${terminalCmd.type} ${terminalCmd.args.join(' ')}`
    };
  }
  
  // Memory commands
  if (PATTERNS.showHistory.test(lower)) {
    const agentStatus = getAgentStatus();
    if (!agentStatus.active || !agentStatus.workingDir) {
      return {
        action: 'memory_history',
        confidence: 1.0,
        message: 'No active project. Load a project first to view history.'
      };
    }
    return {
      action: 'memory_history',
      confidence: 1.0,
      message: getFormattedHistory(agentStatus.workingDir)
    };
  }
  
  if (PATTERNS.clearHistory.test(lower)) {
    return { action: 'memory_clear', confidence: 1.0 };
  }
  
  if (PATTERNS.showSummary.test(lower)) {
    const agentStatus = getAgentStatus();
    if (!agentStatus.active || !agentStatus.workingDir) {
      return {
        action: 'memory_summary',
        confidence: 1.0,
        message: 'No active project. Load a project first to view summary.'
      };
    }
    return {
      action: 'memory_summary',
      confidence: 1.0,
      message: getProjectSummary(agentStatus.workingDir)
    };
  }
  
  if (PATTERNS.showPreferences.test(lower)) {
    return {
      action: 'status',
      confidence: 1.0,
      message: getFormattedPreferences()
    };
  }
  
  const prefMatch = trimmed.match(PATTERNS.setPreference);
  if (prefMatch) {
    const key = prefMatch[1].toLowerCase().replace(/\s+/g, '');
    const value = prefMatch[2].trim();
    return {
      action: 'set_preference',
      target: key,
      prompt: value,
      confidence: 0.95
    };
  }
  
  // PRD execution commands
  const executionStatus = getExecutionStatus();
  
  if (PATTERNS.prdApprove.test(lower) && executionStatus.active) {
    return { action: 'prd_approve', confidence: 1.0 };
  }
  
  if (PATTERNS.prdPause.test(lower) && executionStatus.active) {
    return { action: 'prd_pause', confidence: 1.0 };
  }
  
  if (PATTERNS.prdResume.test(lower) && executionStatus.active) {
    return { action: 'prd_resume', confidence: 1.0 };
  }
  
  if (PATTERNS.prdAbort.test(lower) && executionStatus.active) {
    return { action: 'prd_abort', confidence: 1.0 };
  }
  
  if (PATTERNS.prdStatus.test(lower)) {
    if (executionStatus.active) {
      return {
        action: 'prd_status',
        confidence: 1.0,
        message: executionStatus.summary
      };
    }
    return {
      action: 'prd_status',
      confidence: 1.0,
      message: 'No PRD execution in progress.'
    };
  }
  
  // Check if this is a PRD submission (long text with PRD triggers)
  if (isPrdTrigger(trimmed) || (trimmed.length > 200 && isPrdTrigger(trimmed))) {
    return {
      action: 'prd_submit',
      prompt: trimmed,
      confidence: 0.9
    };
  }
  
  // Open in Cursor IDE (explicit) - for when you actually want to open in Cursor
  const openInCursorMatch = trimmed.match(PATTERNS.openInCursor);
  if (openInCursorMatch) {
    const projectName = openInCursorMatch[1].trim();
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
  
  // Agent start - check before open since it's more specific
  const agentStartMatch = trimmed.match(PATTERNS.agentStart);
  if (agentStartMatch) {
    const projectName = agentStartMatch[1].trim();
    const project = findProject(projectName);
    if (project) {
      return {
        action: 'agent_start',
        target: project.name,
        resolved_path: project.path,
        confidence: 0.95
      };
    }
    return {
      action: 'unknown',
      confidence: 0,
      message: `Project not found: "${projectName}". Try "list projects" to see available projects.`
    };
  }
  
  // Open project - now starts AI session by default (more useful)
  const openMatch = trimmed.match(PATTERNS.openProject);
  if (openMatch) {
    const projectName = openMatch[1].trim();
    const project = findProject(projectName);
    if (project) {
      // Start AI session instead of just opening in Cursor
      return {
        action: 'agent_start',
        target: project.name,
        resolved_path: project.path,
        confidence: 0.95
      };
    }
    return {
      action: 'unknown',
      confidence: 0,
      message: `Project not found: "${projectName}". Try "list projects" to see available projects.`
    };
  }
  
  // Just a project name by itself - start AI session for it
  const project = findProject(trimmed);
  if (project && trimmed.split(/\s+/).length <= 3) {
    return {
      action: 'agent_start',
      target: project.name,
      resolved_path: project.path,
      confidence: 0.9
    };
  }
  
  // Ask patterns - capture as AI request
  const askMatch = trimmed.match(PATTERNS.ask);
  if (askMatch) {
    return {
      action: 'agent_ask',
      prompt: askMatch[1].trim(),
      confidence: 0.9
    };
  }
  
  // Edit patterns - "add X", "fix Y", "update Z", etc.
  const editMatch = trimmed.match(/^(add|fix|update|change|modify|create|remove|delete|refactor|implement|write|insert)\s+(.+)$/i);
  if (editMatch) {
    return {
      action: 'agent_ask',
      prompt: trimmed,  // Send the full message as prompt
      confidence: 0.9
    };
  }
  
  return null;
}

/**
 * Try to parse locally without Claude
 * This is a fallback for anything not caught by handleSimpleCommand
 * Route most natural language to AI assistant
 */
function tryLocalParse(message: string): ParsedIntent | null {
  const trimmed = message.trim();
  
  // If it looks like natural language (not a simple keyword), route to AI
  // This catches questions, requests, and conversational input
  const looksLikeNaturalLanguage = 
    trimmed.split(/\s+/).length >= 3 ||  // 3+ words
    /^(the|this|my|our|what|how|can|could|is|are|does|do|should|would|will|where|when|why|please|i need|i want|make|put|get)/i.test(trimmed) ||
    /\?$/.test(trimmed);  // Ends with question mark
  
  if (looksLikeNaturalLanguage) {
    return {
      action: 'agent_ask',
      prompt: trimmed,
      confidence: 0.8
    };
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
    
    // Use Anthropic provider with model from config
    const { text } = await generateText({
      model: anthropic(config.claude.model),
      system: buildSystemPrompt(),
      prompt: message,
      maxTokens: config.claude.max_tokens
    });
    
    // Parse JSON response
    const parsed = JSON.parse(text) as ParsedIntent;
    parsed.raw_response = text;
    
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
