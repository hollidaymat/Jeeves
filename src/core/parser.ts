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
import { 
  getTrustStatus, 
  getTrustHistory, 
  getLearnedPreferences,
  rememberPersonality,
  setPersonalityRole,
  addPersonalityTrait
} from './trust.js';
import {
  browse as browserBrowse,
  takeScreenshot,
  click as browserClick,
  type as browserType,
  closeBrowser,
  getBrowserStatus
} from './browser.js';
import {
  startDevServer,
  stopDevServer,
  openDevPreview,
  getDevServerStatus,
  capturePreview
} from './dev-server.js';
import {
  apiTest,
  getApiHistory,
  formatApiResult
} from './api-tester.js';
import {
  getPendingPlan,
  clearPendingPlan
} from './plan-state.js';
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
  status: /^(status|how are you|what'?s your status|system status|health|ping)$/i,
  
  // Help patterns
  help: /^(help|\?|what can you do|commands|options|usage)$/i,
  
  // Cost/budget patterns (new)
  cost: /^(cost|costs|budget|spending|usage|how much|token usage|tokens used|daily cost)$/i,
  
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
  
  // Session compaction
  compact: /^(compact|compress|summarize\s*(?:session|history|conversation)|cleanup\s*(?:history|memory))$/i,
  showSummary: /^(?:show\s+)?(?:project\s+)?summary$/i,
  showPreferences: /^(?:show\s+)?(?:my\s+)?preferences$/i,
  setPreference: /^set\s+(verbose|auto.?apply|default.?project)\s+(.+)$/i,
  
  // PRD execution patterns
  prdApprove: /^(?:approve|yes|confirm|looks good|go ahead|start building|lgtm)$/i,
  prdPause: /^(?:pause|wait|hold|stop building)$/i,
  prdResume: /^(?:resume|continue|keep going|proceed)$/i,
  prdAbort: /^(?:abort|cancel|stop everything|abandon)$/i,
  prdStatus: /^(?:prd status|build status|execution status|progress)$/i,
  
  // Trust system patterns
  trustStatus: /^(?:trust|trust status|trust level|my trust|autonomy)$/i,
  trustUpgrade: /^(?:upgrade trust|request upgrade|earn trust|level up)$/i,
  trustHistory: /^(?:trust history|trust log)$/i,
  showLearned: /^(?:what have you learned|show learned|learned preferences|my preferences|what do you know about me)$/i,
  
  // Personality/remember patterns
  remember: /^(?:remember|remember that|jeeves remember|note that)[:\s]+(.+)$/i,
  youAre: /^(?:you are|you're|your role is)[:\s]+(.+)$/i,
  beMore: /^(?:be more|be|act more|act)[:\s]+(.+)$/i,
  dontBe: /^(?:don'?t be|stop being|never be)[:\s]+(.+)$/i,
  
  // Browser patterns - accept URLs with or without protocol, stop at punctuation/conjunctions
  browse: /^(?:browse|visit|go to|fetch|read)\s+([^\s,]+)/i,
  browseWithScreenshot: /^(?:browse|visit|look at|show me|screenshot)\s+(.+)\s+(?:and\s+)?(?:take\s+)?(?:a\s+)?screenshot$/i,
  screenshot: /^(?:screenshot|capture|snap)(?:\s+(?:the\s+)?page)?$/i,
  screenshotUrl: /^(?:screenshot|capture)\s+(.+)$/i,
  browserClick: /^click\s+(?:on\s+)?["']?([^"']+)["']?$/i,
  browserType: /^type\s+["']([^"']+)["']\s+(?:in|into)\s+["']?([^"']+)["']?$/i,
  browserStatus: /^(?:browser status|browser|web status)$/i,
  browserClose: /^(?:close browser|close web|stop browsing)$/i,
  
  // Dev server patterns
  devStart: /^(?:start dev|dev start|npm run dev|start server|spin up dev)$/i,
  devStop: /^(?:stop dev|dev stop|stop server|kill dev)$/i,
  devPreview: /^(?:preview|show preview|open preview|dev preview|show me the app|show app)$/i,
  devStatus: /^(?:dev status|server status|dev servers?)$/i,
  
  // Plan approval patterns
  approvePlan: /^(?:yes|yep|yeah|go|go ahead|do it|proceed|execute|run it|approved?|confirm|ok|okay|sure|lets? go)$/i,
  rejectPlan: /^(?:no|nope|cancel|stop|don'?t|abort|nevermind|never mind)$/i,
  showPlan: /^(?:show plan|what'?s the plan|pending plan|current plan)$/i,
  
  // API testing patterns
  apiGet: /^(?:api\s+)?get\s+(https?:\/\/[^\s]+)$/i,
  apiPost: /^(?:api\s+)?post\s+(https?:\/\/[^\s]+)(?:\s+(.+))?$/i,
  apiPut: /^(?:api\s+)?put\s+(https?:\/\/[^\s]+)(?:\s+(.+))?$/i,
  apiDelete: /^(?:api\s+)?delete\s+(https?:\/\/[^\s]+)$/i,
  apiTest: /^(?:test\s+)?api\s+(get|post|put|patch|delete)\s+(https?:\/\/[^\s]+)(?:\s+(.+))?$/i,
  apiHistory: /^(?:api\s+)?(?:history|requests|logs)$/i,
  
  // Model switching patterns
  useModel: /^use\s+(haiku|sonnet|opus)$/i,
  useAuto: /^(?:use auto|auto model|auto)$/i,
  
  // Backup/restore patterns
  listBackups: /^(?:list\s+)?backups(?:\s+(?:for\s+)?(.+))?$/i,
  restoreBackup: /^restore\s+(.+?)(?:\s+(\d+))?$/i,
  
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
    return { action: 'status', confidence: 1.0, resolutionMethod: 'pattern', estimatedCost: 0 };
  }
  
  // Cost/budget - FREE (no LLM needed)
  if (PATTERNS.cost.test(lower)) {
    return { action: 'show_cost', confidence: 1.0, resolutionMethod: 'pattern', estimatedCost: 0 };
  }
  
  // Help
  if (PATTERNS.help.test(lower)) {
    return {
      action: 'help',
      confidence: 1.0,
      resolutionMethod: 'pattern',
      estimatedCost: 0,
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

**Trust & Learning**:
\`trust\` → View current trust level
\`upgrade trust\` → Request trust upgrade
\`trust history\` → View trust changes
\`what have you learned\` → View learned preferences

**Model & Cost**:
\`use haiku\` \`use sonnet\` \`use auto\` → Switch models
\`cost\` → View daily cost report
\`backups <file>\` → List backups
\`restore <file>\` → Restore from backup

**System**:
\`list projects\` \`status\` \`stop\``
    };
  }
  
  // Model switching
  const modelMatch = lower.match(PATTERNS.useModel);
  if (modelMatch) {
    const tier = modelMatch[1].toLowerCase();
    return {
      action: 'set_model',
      confidence: 1.0,
      target: tier,
      resolutionMethod: 'pattern',
      estimatedCost: 0
    };
  }
  
  if (PATTERNS.useAuto.test(lower)) {
    return {
      action: 'set_model',
      confidence: 1.0,
      target: 'auto',
      resolutionMethod: 'pattern',
      estimatedCost: 0
    };
  }
  
  // List backups
  const listBackupsMatch = lower.match(PATTERNS.listBackups);
  if (listBackupsMatch) {
    return {
      action: 'list_backups',
      confidence: 1.0,
      target: listBackupsMatch[1]?.trim() || undefined,
      resolutionMethod: 'pattern',
      estimatedCost: 0
    };
  }
  
  // Restore from backup
  const restoreMatch = lower.match(PATTERNS.restoreBackup);
  if (restoreMatch) {
    return {
      action: 'restore_backup',
      confidence: 1.0,
      target: restoreMatch[1]?.trim(),
      message: restoreMatch[2] || '1',  // Default to most recent backup
      resolutionMethod: 'pattern',
      estimatedCost: 0
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
  
  // Plan approval: Execute pending plan (CHECK THIS FIRST before apply/reject)
  // "yes" should trigger plan execution if there's a pending plan
  if (PATTERNS.approvePlan.test(lower)) {
    logger.info('Approval pattern matched', { input: lower });
    const plan = getPendingPlan();
    logger.info('Pending plan check', { hasPlan: !!plan, commands: plan?.commands?.length });
    if (plan) {
      return { action: 'execute_plan', confidence: 1.0, requiresAsync: true };
    }
    // No pending plan - fall through to apply_changes
  }
  
  // Plan rejection: Cancel pending plan
  if (PATTERNS.rejectPlan.test(lower)) {
    const plan = getPendingPlan();
    if (plan) {
      clearPendingPlan();
      return { action: 'status', confidence: 1.0, message: '❌ Plan cancelled.' };
    }
    // No pending plan - fall through to reject_changes
  }
  
  // Apply changes (for code edits, not plans)
  if (PATTERNS.apply.test(lower)) {
    return { action: 'apply_changes', confidence: 1.0 };
  }
  
  // Reject changes (for code edits, not plans)
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
  
  // Session compaction
  if (PATTERNS.compact.test(lower)) {
    return { 
      action: 'compact_session', 
      confidence: 1.0,
      resolutionMethod: 'pattern',
      estimatedCost: 0  // The compaction uses Haiku internally, very cheap
    };
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
  
  // Trust system commands
  if (PATTERNS.trustStatus.test(lower)) {
    return {
      action: 'trust_status',
      confidence: 1.0,
      message: getTrustStatus()
    };
  }
  
  if (PATTERNS.trustUpgrade.test(lower)) {
    return { action: 'trust_upgrade', confidence: 1.0 };
  }
  
  if (PATTERNS.trustHistory.test(lower)) {
    return {
      action: 'trust_history',
      confidence: 1.0,
      message: getTrustHistory()
    };
  }
  
  if (PATTERNS.showLearned.test(lower)) {
    return {
      action: 'show_learned',
      confidence: 1.0,
      message: getLearnedPreferences()
    };
  }
  
  // Personality: Remember statements
  const rememberMatch = trimmed.match(PATTERNS.remember);
  if (rememberMatch) {
    const statement = rememberMatch[1].trim();
    return {
      action: 'remember',
      confidence: 1.0,
      message: rememberPersonality(statement)
    };
  }
  
  // Personality: "You are" / role definition
  const youAreMatch = trimmed.match(PATTERNS.youAre);
  if (youAreMatch) {
    const role = youAreMatch[1].trim();
    return {
      action: 'set_role',
      confidence: 1.0,
      message: setPersonalityRole(role)
    };
  }
  
  // Personality: "Be more" / add trait
  const beMoreMatch = trimmed.match(PATTERNS.beMore);
  if (beMoreMatch) {
    const trait = beMoreMatch[1].trim();
    return {
      action: 'add_trait',
      confidence: 1.0,
      message: addPersonalityTrait(trait)
    };
  }
  
  // Personality: "Don't be" / negative trait
  const dontBeMatch = trimmed.match(PATTERNS.dontBe);
  if (dontBeMatch) {
    const trait = dontBeMatch[1].trim();
    return {
      action: 'remember',
      confidence: 1.0,
      message: rememberPersonality(`don't be ${trait}`)
    };
  }
  
  // Browser: Status
  if (PATTERNS.browserStatus.test(lower)) {
    return {
      action: 'browse',
      confidence: 1.0,
      message: getBrowserStatus()
    };
  }
  
  // Browser: Close
  if (PATTERNS.browserClose.test(lower)) {
    closeBrowser().catch(() => {});
    return {
      action: 'browser_close',
      confidence: 1.0,
      message: 'Browser closed.'
    };
  }
  
  // Browser: Browse URL with screenshot
  const browseScreenshotMatch = trimmed.match(PATTERNS.browseWithScreenshot);
  if (browseScreenshotMatch) {
    let url = browseScreenshotMatch[1].trim();
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }
    return {
      action: 'browse',
      confidence: 1.0,
      target: url,
      data: { screenshot: true },
      requiresAsync: true
    };
  }
  
  // Browser: Browse URL
  const browseMatch = trimmed.match(PATTERNS.browse);
  if (browseMatch) {
    let url = browseMatch[1].trim();
    // Normalize URL - add https:// if missing
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }
    logger.info('Browse command matched', { url, original: trimmed });
    return {
      action: 'browse',
      confidence: 1.0,
      target: url,
      requiresAsync: true
    };
  }
  
  // Browser: Screenshot current page
  if (PATTERNS.screenshot.test(lower)) {
    return {
      action: 'screenshot',
      confidence: 1.0,
      requiresAsync: true
    };
  }
  
  // Browser: Screenshot URL
  const screenshotUrlMatch = trimmed.match(PATTERNS.screenshotUrl);
  if (screenshotUrlMatch) {
    let url = screenshotUrlMatch[1].trim();
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }
    return {
      action: 'screenshot',
      confidence: 1.0,
      target: url,
      requiresAsync: true
    };
  }
  
  // Browser: Click element
  const clickMatch = trimmed.match(PATTERNS.browserClick);
  if (clickMatch) {
    const selector = clickMatch[1].trim();
    return {
      action: 'browser_click',
      confidence: 1.0,
      target: selector,
      requiresAsync: true
    };
  }
  
  // Browser: Type text
  const typeMatch = trimmed.match(PATTERNS.browserType);
  if (typeMatch) {
    const text = typeMatch[1];
    const selector = typeMatch[2].trim();
    return {
      action: 'browser_type',
      confidence: 1.0,
      target: selector,
      data: { text },
      requiresAsync: true
    };
  }
  
  // Dev Server: Start
  if (PATTERNS.devStart.test(lower)) {
    return {
      action: 'dev_start',
      confidence: 1.0,
      requiresAsync: true
    };
  }
  
  // Dev Server: Stop
  if (PATTERNS.devStop.test(lower)) {
    return {
      action: 'dev_stop',
      confidence: 1.0
    };
  }
  
  // Dev Server: Preview
  if (PATTERNS.devPreview.test(lower)) {
    return {
      action: 'dev_preview',
      confidence: 1.0,
      requiresAsync: true
    };
  }
  
  // Dev Server: Status
  if (PATTERNS.devStatus.test(lower)) {
    return {
      action: 'dev_status',
      confidence: 1.0,
      message: getDevServerStatus()
    };
  }
  
  // API Testing: GET
  const apiGetMatch = trimmed.match(PATTERNS.apiGet);
  if (apiGetMatch) {
    return { action: 'api_get', confidence: 1.0, target: apiGetMatch[1], requiresAsync: true };
  }
  
  // API Testing: POST
  const apiPostMatch = trimmed.match(PATTERNS.apiPost);
  if (apiPostMatch) {
    return { 
      action: 'api_post', 
      confidence: 1.0, 
      target: apiPostMatch[1], 
      data: { body: apiPostMatch[2] },
      requiresAsync: true 
    };
  }
  
  // API Testing: PUT
  const apiPutMatch = trimmed.match(PATTERNS.apiPut);
  if (apiPutMatch) {
    return { 
      action: 'api_put', 
      confidence: 1.0, 
      target: apiPutMatch[1], 
      data: { body: apiPutMatch[2] },
      requiresAsync: true 
    };
  }
  
  // API Testing: DELETE
  const apiDeleteMatch = trimmed.match(PATTERNS.apiDelete);
  if (apiDeleteMatch) {
    return { action: 'api_delete', confidence: 1.0, target: apiDeleteMatch[1], requiresAsync: true };
  }
  
  // API Testing: Generic (test api GET/POST/etc url)
  const apiTestMatch = trimmed.match(PATTERNS.apiTest);
  if (apiTestMatch) {
    const method = apiTestMatch[1].toLowerCase();
    const actionMap: Record<string, 'api_get' | 'api_post' | 'api_put' | 'api_patch' | 'api_delete'> = {
      get: 'api_get',
      post: 'api_post',
      put: 'api_put',
      patch: 'api_patch',
      delete: 'api_delete'
    };
    const action = actionMap[method] || 'api_get';
    return { 
      action, 
      confidence: 1.0, 
      target: apiTestMatch[2],
      data: { body: apiTestMatch[3] },
      requiresAsync: true 
    };
  }
  
  // API Testing: History
  if (PATTERNS.apiHistory.test(lower)) {
    const history = getApiHistory(20);
    const formatted = history.length > 0
      ? history.map(h => `${h.timestamp.toISOString()} ${h.method} ${h.url} → ${h.status || h.error}`).join('\n')
      : 'No API requests yet.';
    return { action: 'api_history', confidence: 1.0, message: `**API Request History**\n${formatted}` };
  }
  
  // Show current plan
  if (PATTERNS.showPlan.test(lower)) {
    const plan = getPendingPlan();
    if (plan) {
      const formatted = plan.commands.map((c, i) => `${i + 1}. ${c}`).join('\n');
      return { 
        action: 'status', 
        confidence: 1.0, 
        message: `**Pending Plan: ${plan.description}**\n${formatted}\n\nSay "yes" to execute or "no" to cancel.`
      };
    }
    return { action: 'status', confidence: 1.0, message: 'No pending plan.' };
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
