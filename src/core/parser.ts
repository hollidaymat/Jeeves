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
import { isPrdTrigger, getExecutionStatus, getActivePlan } from './prd-executor.js';
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
import {
  classifyIntent,
  quickClassify,
  needsLLMClassification,
  type ClassifiedIntent
} from './classifier.js';
import {
  extractEntities,
  isPRDContent,
  hasDestructiveIntent
} from './entities.js';
import {
  applyDisambiguation,
  hasAmbiguousPattern
} from './disambiguation.js';
import { referenceResolver } from './reference-resolver.js';
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

PARSING RULES:
5. "can you X" = command to do X (e.g., "can you check the auth" = command to check auth)
6. "don't X" or "do not X" = command to STOP or PREVENT X
7. "like X" = reference/comparison to X, NOT an action on X
8. "it", "this", "that" = refers to the last mentioned file, project, or task
9. If confidence < 0.6, respond with action "clarify" instead of guessing
10. Never guess on destructive actions - ask for confirmation

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
 * Convert ClassifiedIntent to ParsedIntent
 * Maps classifier categories to parser actions
 */
function classificationToIntent(
  classified: Partial<ClassifiedIntent>,
  originalMessage: string
): ParsedIntent | null {
  const { category, action, target, confidence, isNegation } = classified;
  
  if (!category || !confidence) {
    return null;
  }
  
  // Map categories to actions
  switch (category) {
    case 'prd':
      return {
        action: 'prd_submit',
        prompt: originalMessage,
        target: target || 'prd',
        confidence,
        message: 'PRD detected, ready for processing'
      };
      
    case 'question':
      return {
        action: 'agent_ask',
        prompt: originalMessage,
        confidence,
        message: 'Question detected'
      };
      
    case 'feedback':
      // Feedback often means user is correcting, route to ask for now
      return {
        action: 'agent_ask',
        prompt: originalMessage,
        confidence,
        message: 'Feedback detected'
      };
      
    case 'command':
      // Handle negation commands
      if (isNegation) {
        return {
          action: 'agent_ask',
          prompt: `STOP: ${originalMessage}`,
          confidence,
          message: `Negation command detected: stop ${target}`
        };
      }
      
      // Map common action verbs
      const actionMap: Record<string, string> = {
        'open': 'open_project',
        'load': 'open_project',
        'start': 'agent_start',
        'check': 'agent_ask',
        'explain': 'agent_ask',
        'describe': 'agent_ask',
        'build': 'prd_submit',
        'create': 'prd_submit',
        'fix': 'agent_ask',
        'update': 'agent_ask',
        'deploy': 'agent_ask',
        'run': 'terminal_npm',
        'test': 'terminal_npm',
        'approve': 'prd_approve',
        'stop': 'agent_stop'
      };
      
      const mappedAction = action ? actionMap[action.toLowerCase()] : null;
      
      if (mappedAction) {
        return {
          action: mappedAction as ParsedIntent['action'],
          target,
          prompt: originalMessage,
          confidence,
          message: `Command: ${action} ${target || ''}`
        };
      }
      
      // Default to agent_ask for unknown commands
      return {
        action: 'agent_ask',
        prompt: originalMessage,
        confidence,
        message: `Command detected: ${action}`
      };
      
    case 'unclear':
    default:
      // Low confidence, let it fall through to full LLM parse
      return null;
  }
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
  
  // Learning & history patterns (new)
  builds: /^(builds|build history|past builds|build report|build summary)$/i,
  lessons: /^(lessons|lessons learned|what.*learn|learning|improvements|anti.?patterns)$/i,
  
  // Homelab patterns
  homelabStatus: /^(?:daemon\s+status|homelab\s+status|server\s+status|how is the server|how'?s the (?:server|daemon|box|homelab))$/i,
  homelabContainers: /^(containers|docker ps|list containers|show containers|running containers|what'?s running)$/i,
  homelabResources: /^(resources|ram|cpu|disk|memory|system resources|resource usage|how much (?:ram|memory|disk|cpu))$/i,
  homelabTemps: /^(temps?|temperature|cpu temp|how hot|thermal)$/i,
  homelabServiceControl: /^(start|stop|restart)\s+(.+)$/i,
  homelabLogs: /^(?:logs?|show logs?|get logs?)\s+(.+)$/i,
  homelabUpdate: /^update\s+(.+)$/i,
  homelabUpdateAll: /^update\s+all$/i,
  homelabInstall: /^install\s+(.+)$/i,
  homelabUninstall: /^(?:uninstall|remove)\s+(.+)$/i,
  homelabDiagnose: /^(?:diagnose|debug|troubleshoot|why is .+ down|what'?s wrong with)\s+(.+)$/i,
  homelabStacks: /^(stacks|docker stacks|compose stacks|list stacks|show stacks)$/i,
  homelabHealth: /^(?:daemon\s+health|homelab\s+health|health\s+check|check\s+health|service\s+health)$/i,
  homelabSelfTest: /^(self[- ]?test|run tests|test (?:all|everything|system)|diagnostics)$/i,
  
  // List projects patterns  
  listProjects: /^(list|projects|list projects|show projects|what projects)$/i,
  
  // Agent status patterns
  agentStatus: /^(agent status|ai status|is the agent running|check agent)$/i,
  
  // Agent stop patterns - includes "close", "close project", "close <project-name>"
  agentStop: /^(?:agent stop|stop agent|stop ai|close agent|end session|close(?:\s+(?:the\s+)?(?:project|session|it))?|close\s+.+)$/i,
  
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
  // Continue project patterns - for when user wants to continue work without PRD
  continueProject: /^(?:continue(?: the)?(?: (?:project|building|build|work))?|keep building|finish(?: the)?(?: (?:project|it|build))?|just build(?: it)?|build it|build to completion|finish building|complete the build|build everything)$/i,
  
  // Trust system patterns
  trustStatus: /^(?:trust|trust status|trust level|my trust|autonomy)$/i,
  trustUpgrade: /^(?:upgrade trust|request upgrade|earn trust|level up)$/i,
  trustHistory: /^(?:trust history|trust log)$/i,
  showLearned: /^(?:what have you learned|show learned|learned preferences|my preferences|what do you know about me)$/i,
  
  // Personality/remember patterns
  remember: /^(?:remember|remember that|jeeves remember|note that)[:\s]+(.+)$/i,
  // "you are" pattern for role assignment - exclude negative feedback patterns
  // Must NOT match: "you are wrong", "you are hallucinating", "you are broken", etc.
  youAre: /^(?:you are|you're|your role is)[:\s]+(?!(?:wrong|bad|broken|hallucinating|stupid|incorrect|not|an idiot|dumb|useless|terrible|awful|horrible|failing|confused|mistaken|lying)\b)(.+)$/i,
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
  
  // Create new project pattern
  createProject: /^(?:create|new|init|bootstrap|scaffold)\s+(?:a\s+)?(?:new\s+)?(?:project\s+)?(?:called\s+)?(.+?)(?:\s+project)?$/i,
  
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
  
  // CRITICAL: Apply last response - check FIRST before ANY other parsing
  // This handles "apply", "apply that", "use that code", etc. for manual application
  if (/^(?:apply(?: (?:that|this|last|it|the code|response|changes?))?|use (?:that|this) code|save (?:that|it))$/i.test(lower)) {
    logger.info('Matched apply_last pattern', { input: lower });
    return { action: 'apply_last', confidence: 1.0, resolutionMethod: 'pattern', estimatedCost: 0 };
  }
  
  // Status questions - route to AI as questions, not session starts
  if (/^(?:is it (?:built|done|ready|finished|complete|working)|what'?s the status|how'?s it (?:going|looking))\??$/i.test(lower)) {
    logger.info('Status question detected, routing to AI', { input: lower });
    return { action: 'agent_ask', prompt: message, confidence: 1.0 };
  }
  
  // Status
  if (PATTERNS.status.test(lower)) {
    return { action: 'status', confidence: 1.0, resolutionMethod: 'pattern', estimatedCost: 0 };
  }
  
  // Cost/budget - FREE (no LLM needed)
  if (PATTERNS.cost.test(lower)) {
    return { action: 'show_cost', confidence: 1.0, resolutionMethod: 'pattern', estimatedCost: 0 };
  }
  
  // Build history - FREE (no LLM needed)
  if (PATTERNS.builds.test(lower)) {
    return { action: 'show_builds', confidence: 1.0, resolutionMethod: 'pattern', estimatedCost: 0 };
  }
  
  // Lessons learned - FREE (no LLM needed)
  if (PATTERNS.lessons.test(lower)) {
    return { action: 'show_lessons', confidence: 1.0, resolutionMethod: 'pattern', estimatedCost: 0 };
  }
  
  // ===== HOMELAB COMMANDS (all pattern-matched, FREE) =====
  // Only match if homelab is enabled
  if (config.homelab?.enabled || process.env.HOMELAB_DEV_MODE) {
    // Status (check before general status pattern)
    if (PATTERNS.homelabStatus.test(lower)) {
      return { action: 'homelab_status', confidence: 1.0, resolutionMethod: 'pattern', estimatedCost: 0 };
    }

    // Self-test (check before service control to avoid "test" matching)
    if (PATTERNS.homelabSelfTest.test(lower)) {
      return { action: 'homelab_self_test', confidence: 1.0, resolutionMethod: 'pattern', estimatedCost: 0 };
    }

    // Containers
    if (PATTERNS.homelabContainers.test(lower)) {
      return { action: 'homelab_containers', confidence: 1.0, resolutionMethod: 'pattern', estimatedCost: 0 };
    }

    // Resources
    if (PATTERNS.homelabResources.test(lower)) {
      return { action: 'homelab_resources', confidence: 1.0, resolutionMethod: 'pattern', estimatedCost: 0 };
    }

    // Temperature
    if (PATTERNS.homelabTemps.test(lower)) {
      return { action: 'homelab_temps', confidence: 1.0, resolutionMethod: 'pattern', estimatedCost: 0 };
    }

    // Update all (check before single update)
    if (PATTERNS.homelabUpdateAll.test(lower)) {
      return { action: 'homelab_update_all', confidence: 1.0, resolutionMethod: 'pattern', estimatedCost: 0 };
    }

    // Update single service
    const updateMatch = lower.match(PATTERNS.homelabUpdate);
    if (updateMatch && !PATTERNS.homelabUpdateAll.test(lower)) {
      return { action: 'homelab_update', target: updateMatch[1].trim(), confidence: 1.0, resolutionMethod: 'pattern', estimatedCost: 0 };
    }

    // Service control (start/stop/restart)
    const svcMatch = lower.match(PATTERNS.homelabServiceControl);
    if (svcMatch) {
      const verb = svcMatch[1].toLowerCase();
      const service = svcMatch[2].trim();
      // Don't match "start dev" or "stop agent" - those are existing commands
      if (!['dev', 'agent', 'ai', 'session', 'server', 'process'].includes(service)) {
        const action = `homelab_service_${verb}` as 'homelab_service_start' | 'homelab_service_stop' | 'homelab_service_restart';
        return { action, target: service, confidence: 0.9, resolutionMethod: 'pattern', estimatedCost: 0 };
      }
    }

    // Logs
    const logsMatch = lower.match(PATTERNS.homelabLogs);
    if (logsMatch) {
      return { action: 'homelab_logs', target: logsMatch[1].trim(), confidence: 1.0, resolutionMethod: 'pattern', estimatedCost: 0 };
    }

    // Diagnose
    const diagnoseMatch = lower.match(PATTERNS.homelabDiagnose);
    if (diagnoseMatch) {
      return { action: 'homelab_diagnose', target: diagnoseMatch[1].trim(), confidence: 1.0, resolutionMethod: 'pattern', estimatedCost: 0 };
    }

    // Install
    const installMatch = lower.match(PATTERNS.homelabInstall);
    if (installMatch) {
      // Don't match "install dependencies" or "npm install" - those are terminal commands
      const target = installMatch[1].trim();
      if (!['deps', 'dependencies', 'packages', 'modules'].includes(target)) {
        return { action: 'homelab_install', target, confidence: 0.9, resolutionMethod: 'pattern', estimatedCost: 0 };
      }
    }

    // Uninstall
    const uninstallMatch = lower.match(PATTERNS.homelabUninstall);
    if (uninstallMatch) {
      return { action: 'homelab_uninstall', target: uninstallMatch[1].trim(), confidence: 1.0, resolutionMethod: 'pattern', estimatedCost: 0 };
    }

    // Stacks
    if (PATTERNS.homelabStacks.test(lower)) {
      return { action: 'homelab_stacks', confidence: 1.0, resolutionMethod: 'pattern', estimatedCost: 0 };
    }

    // Health
    if (PATTERNS.homelabHealth.test(lower)) {
      return { action: 'homelab_health', confidence: 1.0, resolutionMethod: 'pattern', estimatedCost: 0 };
    }
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
\`builds\` → View build history & costs
\`lessons\` → View lessons learned & anti-patterns
\`backups <file>\` → List backups
\`restore <file>\` → Restore from backup

**System**:
\`list projects\` \`status\` \`stop\`

**Homelab** (Linux daemon only):
\`daemon status\` → Full system overview
\`containers\` → List all Docker containers
\`resources\` / \`ram\` / \`cpu\` / \`disk\` → System resources
\`temps\` → CPU temperature
\`start|stop|restart <service>\` → Service control
\`logs <service>\` → View container logs
\`update <service>\` → Pull & restart service
\`diagnose <service>\` → Run diagnostics
\`stacks\` → List compose stacks
\`health check\` / \`daemon health\` → Run health checks
\`self-test\` → Run system self-tests`
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
    
    // Check for PRD execution plan awaiting approval FIRST
    const prdPlan = getActivePlan();
    if (prdPlan && prdPlan.status === 'awaiting_approval') {
      logger.info('PRD plan awaiting approval', { planId: prdPlan.id, phases: prdPlan.phases.length });
      return { action: 'prd_approve', confidence: 1.0, requiresAsync: true };
    }
    
    // Check for simple command plan
    const plan = getPendingPlan();
    logger.info('Pending plan check', { hasPlan: !!plan, commands: plan?.commands?.length });
    if (plan) {
      return { action: 'execute_plan', confidence: 1.0, requiresAsync: true };
    }
    
    // No pending plan - check if there are pending code changes
    const agentStatus = getAgentStatus();
    if (agentStatus.pendingChanges && agentStatus.pendingChanges > 0) {
      // Fall through to apply_changes
    } else {
      // No plan and no pending changes - treat "yes" as continuation
      // Send it to the AI as a response to continue the conversation
      logger.info('No plan or changes, treating "yes" as continuation');
      return {
        action: 'agent_ask',
        prompt: 'yes, please proceed',
        confidence: 0.9
      };
    }
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
  
  // Check for natural language patterns BEFORE terminal commands
  // This prevents "ask jeeves..." from being parsed as a terminal command
  const askMatch = trimmed.match(PATTERNS.ask);
  if (askMatch) {
    return {
      action: 'agent_ask',
      prompt: askMatch[1].trim(),
      confidence: 0.9
    };
  }

  // Try to parse as terminal command (npm/git) - only short commands
  // Skip terminal parsing for long messages (likely natural language/PRDs)
  if (trimmed.length < 100) {
    const terminalCmd = parseTerminalRequest(trimmed);
    if (terminalCmd) {
      return {
        action: terminalCmd.type === 'npm' ? 'terminal_npm' : 'terminal_git',
        terminal_command: terminalCmd,
        confidence: 0.95,
        message: `Running: ${terminalCmd.type} ${terminalCmd.args.join(' ')}`
      };
    }
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
  
  // Continue project - AUTONOMOUS BUILD - loops until complete
  if (PATTERNS.continueProject.test(lower)) {
    return {
      action: 'autonomous_build',  // Fully autonomous build loop - no user intervention needed
      confidence: 1.0
    };
  }
  
  // NOTE: apply_last pattern is now checked at the TOP of handleSimpleCommand
  // to ensure it runs before reference resolution can transform "that"
  
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
  
  // Create new project - must check before open to avoid false matches
  const createMatch = trimmed.match(PATTERNS.createProject);
  if (createMatch) {
    const projectName = createMatch[1].trim()
      .replace(/[^a-zA-Z0-9-_]/g, '-')  // Sanitize to valid folder name
      .toLowerCase();
    return {
      action: 'create_project',
      target: projectName,
      confidence: 0.95
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
      message: `Project not found: "${projectName}". Try "list projects" to see available projects, or "create project ${projectName}" to create a new one.`
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
  
  // Ask patterns check moved earlier in the function (before terminal commands)
  
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
  // ==========================================
  // STAGE 0: Critical Commands (check BEFORE reference resolution)
  // ==========================================
  
  // apply_last must be checked on ORIGINAL message before "that" gets resolved to a file
  const originalLower = message.trim().toLowerCase();
  if (/^(?:apply(?: (?:that|this|last|it|the code|response|changes?))?|use (?:that|this) code|save (?:that|it))$/i.test(originalLower)) {
    logger.info('apply_last matched (pre-resolution)', { input: originalLower });
    return { action: 'apply_last', confidence: 1.0, resolutionMethod: 'pattern', estimatedCost: 0 };
  }
  
  // Status questions - route to AI as questions, not session starts
  if (/^(?:is it (?:built|done|ready|finished|complete|working)|what'?s the status|how'?s it (?:going|looking))\??$/i.test(originalLower)) {
    logger.info('Status question detected (pre-resolution), routing to AI', { input: originalLower });
    return { action: 'agent_ask', prompt: message, confidence: 1.0 };
  }
  
  // BUILD COMMANDS - Must check BEFORE reference resolution because "it" would be resolved
  // to a file, breaking the pattern match
  if (/^(?:build it|finish it|continue|build|just build|build everything|build to completion|finish building|complete the build|keep building)$/i.test(originalLower)) {
    logger.info('Autonomous build command detected (pre-resolution)', { input: originalLower });
    return { action: 'autonomous_build', confidence: 1.0, resolutionMethod: 'pattern', estimatedCost: 0 };
  }
  
  // ==========================================
  // STAGE 1: Pre-processing (FREE)
  // ==========================================
  
  // Resolve pronouns (it, this, that) to last mentioned items
  const resolved = referenceResolver.resolve(message);
  const processedMessage = resolved.resolved;
  
  if (resolved.hadPronouns) {
    logger.debug('Resolved pronouns', { 
      original: message, 
      resolved: processedMessage,
      resolutions: resolved.resolutions 
    });
  }
  
  // Extract entities for context
  const entities = extractEntities(processedMessage);
  
  // ==========================================
  // STAGE 2: Disambiguation (FREE)
  // ==========================================
  
  // Apply disambiguation rules for known patterns
  const disambiguated = applyDisambiguation(processedMessage);
  if (disambiguated && disambiguated.confidence && disambiguated.confidence >= 0.85) {
    logger.debug('Disambiguated intent', { disambiguated });
    
    // Convert classification to ParsedIntent
    const intent = classificationToIntent(disambiguated as ClassifiedIntent, processedMessage);
    if (intent) {
      intent.resolutionMethod = 'pattern';
      referenceResolver.update(intent);
      return intent;
    }
  }
  
  // ==========================================
  // STAGE 3: Simple Commands (FREE)
  // ==========================================
  
  // Check for simple commands first
  const simple = handleSimpleCommand(processedMessage);
  if (simple) {
    simple.resolutionMethod = 'pattern';
    referenceResolver.update(simple);
    return simple;
  }
  
  // Try local parsing for simple open commands
  const local = tryLocalParse(processedMessage);
  if (local) {
    local.resolutionMethod = 'pattern';
    referenceResolver.update(local);
    return local;
  }
  
  // ==========================================
  // STAGE 4: Quick Classify (FREE)
  // ==========================================
  
  // Try pattern-based classification (no LLM cost)
  const quickIntent = quickClassify(processedMessage);
  if (quickIntent && quickIntent.confidence >= 0.85) {
    logger.debug('Quick classified intent', { quickIntent });
    
    const intent = classificationToIntent(quickIntent, processedMessage);
    if (intent) {
      intent.resolutionMethod = 'pattern';
      referenceResolver.update(intent);
      return intent;
    }
  }
  
  // ==========================================
  // STAGE 5: LLM Classification (Haiku - cheap)
  // ==========================================
  
  // For complex messages, use LLM classifier first
  if (needsLLMClassification(processedMessage)) {
    try {
      const { intent: classified, cost } = await classifyIntent(processedMessage);
      logger.debug('LLM classified intent', { classified, cost });
      
      // If high confidence, convert to ParsedIntent
      if (classified.confidence >= 0.7) {
        const intent = classificationToIntent(classified, processedMessage);
        if (intent) {
          intent.resolutionMethod = 'llm';
          intent.estimatedCost = cost;
          referenceResolver.update(intent);
          return intent;
        }
      }
    } catch (error) {
      logger.warn('LLM classification failed, falling back', { error });
    }
  }
  
  // ==========================================
  // STAGE 6: Full LLM Parse (Claude - expensive)
  // ==========================================
  
  // Fall back to Claude for complex interpretation
  try {
    logger.debug('Sending to Claude for parsing', { message: processedMessage });
    
    // Use Anthropic provider with model from config
    const { text } = await generateText({
      model: anthropic(config.claude.model),
      system: buildSystemPrompt(),
      prompt: processedMessage,
      maxTokens: config.claude.max_tokens
    });
    
    // Parse JSON response
    const parsed = JSON.parse(text) as ParsedIntent;
    parsed.raw_response = text;
    parsed.resolutionMethod = 'llm';
    
    logger.debug('Claude parsed intent', { action: parsed.action, confidence: parsed.confidence });
    
    // Validate and enhance the parsed intent
    if (parsed.action === 'open_project' && parsed.target && !parsed.resolved_path) {
      const project = findProject(parsed.target);
      if (project) {
        parsed.resolved_path = project.path;
        parsed.command = `cursor "${project.path}"`;
      }
    }
    
    // Update reference resolver with parsed result
    referenceResolver.update(parsed);
    
    return parsed;
    
  } catch (error) {
    const err = error as Record<string, unknown>;
    const errDetail = {
      message: err?.message || String(error),
      statusCode: err?.statusCode || err?.status,
      responseBody: err?.responseBody ? JSON.stringify(err.responseBody).substring(0, 500) : undefined,
      data: err?.data ? JSON.stringify(err.data).substring(0, 500) : undefined,
      url: err?.url,
      cause: err?.cause ? String(err.cause) : undefined,
    };
    logger.error('Error parsing intent', { ...errDetail, input: processedMessage });
    return {
      action: 'unknown',
      confidence: 0,
      message: `Error processing request: ${errDetail.message}`
    };
  }
}
