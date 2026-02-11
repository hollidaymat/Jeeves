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

// Lazy-loaded Cursor orchestrator check (avoids circular imports)
let _pendingCursorCheck: (() => boolean) | null = null;
function pendingCursorCheck(): boolean {
  if (!_pendingCursorCheck) {
    try {
      // Dynamic require at first call only
      import('../integrations/cursor-orchestrator.js').then(m => {
        _pendingCursorCheck = m.hasPendingCursorTask;
      }).catch(() => {
        _pendingCursorCheck = () => false;
      });
      return false;  // First call won't have it yet, that's OK
    } catch {
      return false;
    }
  }
  return _pendingCursorCheck();
}

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
      
      let mappedAction = action ? actionMap[action.toLowerCase()] : null;
      
      // Never route to prd_approve unless there's actually a plan — otherwise agent_ask so LLM can continue
      if (mappedAction === 'prd_approve') {
        const prdPlan = getActivePlan();
        const plan = getPendingPlan();
        if ((!prdPlan?.status || prdPlan.status !== 'awaiting_approval') && !plan) {
          return {
            action: 'agent_ask',
            prompt: 'yes, please proceed',
            confidence: 0.9,
            message: 'Approval with no pending plan — continue conversation'
          };
        }
      }
      
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
  homelabReport: /^(?:(?:give\s+me\s+(?:a\s+)?|run\s+(?:a\s+)?)?homelab\s+report|report\s+(?:on\s+)?(?:the\s+)?homelab|what'?s\s+connected|what\s+needs\s+setup|what\s+needs\s+api\s+added|homelab\s+overview)$/i,
  homelabSystemReview: /^(?:system\s+review|review\s+(?:your\s+)?system|do\s+a\s+system\s+review|learn\s+(?:your\s+)?system|what\s+do\s+you\s+have|review\s+system\s+and\s+remember|system\s+review\s+and\s+remember|remember\s+what\s+you\s+have)(?:\s+and\s+remember)?$/i,
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
  homelabSecurityStatus: /^(?:security\s+status|security\s+report|security|show\s+security)$/i,
  homelabFirewallStatus: /^(?:firewall\s+status|firewall|show\s+firewall|ufw\s+status)$/i,
  homelabFirewallAllow: /^firewall\s+allow\s+(\d+)(?:\/(tcp|udp))?$/i,
  homelabFirewallDeny: /^firewall\s+deny\s+(\d+)$/i,

  // Media commands
  // Feedback / discussion (not a command -- user is providing input, not requesting action)
  feedback: /^(?:I think|you should|the .+ should|change the|instead of|don't|do not|stop|maybe|how about|what if|consider|note that|remember that|keep in mind|fyi|heads up|one thing|also,? |actually,? |correction|btw|by the way|can you not|please don't|feedback|my preference|i prefer|i'd rather|i want you to|when you|next time|going forward|in the future|from now on)/i,

  // Backup commands
  backupRun: /^backup\s*(?:now|full|run)?$/i,
  backupPostgres: /^backup\s+(?:postgres|pg|database|db)$/i,
  backupVolumes: /^backup\s+volumes?$/i,
  backupStatus: /^backup\s+(?:status|health|check)$/i,
  backupList: /^(?:backup\s+list|backups|list\s+backups)$/i,
  backupRestore: /^(?:restore|backup\s+restore)\s+(.+)/i,
  backupSchedule: /^backup\s+schedule(?:\s+(.+))?$/i,

  mediaSearch: /^(?:search|find|look\s*up|search\s+for)\s+(.+)/i,
  mediaDownload: /^(?:download|get|grab|add|queue)\s+(.+)/i,
  mediaSelect: /^([1-9]\d?)$/,  // Just a number (1-99) when pending media results exist
  mediaMore: /^(?:more|next|next\s+results|more\s+results|show\s+more|next\s+page)$/i,
  mediaStatus: /^(?:(?:download(?:s|ing)?|queue|what'?s downloading|download status|download queue|media status|media queue)|(?:check|get|show|what'?s?)\s+(?:downloads?|queue|download\s+(?:status|queue)|media\s+(?:status|queue))|(?:what(?:'?s)?\s+)?(?:are\s+)?(?:my\s+)?downloads?)$/i,
  
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
  // Preference statements: "my favorite X is Y", "I like X", etc.
  preferenceStatement: /^(?:my\s+favorite\s+.+\s+is\s+.+|I\s+(?:really\s+)?(?:like|love)\s+.+)$/i,
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
  
  // Vercel commands
  vercelUrl: /^(?:(?:can you\s+)?(?:check\s+)?vercel\s+(?:and\s+)?find\s+the\s+url\s+for\s+|vercel\s+url|vercel\s+link|url\s+(?:for|of)\s+|(?:get|send|give|show)\s+(?:me\s+)?(?:the\s+)?(?:vercel\s+)?(?:url|link)\s+(?:for|of)\s+|what'?s\s+the\s+(?:vercel\s+)?(?:url|link)\s+(?:for|of)\s+|(?:find|get)\s+(?:the\s+)?(?:vercel\s+)?(?:url|link)\s+for\s+)(.+?)$/i,
  vercelDeploy: /^(?:deploy|vercel deploy|deploy\s+to\s+vercel|push\s+to\s+vercel|deploy\s+that\s+(?:repo|project)|ship)\s+(.+?)(?:\s+(?:to|on)\s+vercel)?$/i,
  vercelProjects: /^(?:vercel\s+projects|list\s+vercel|show\s+vercel|my\s+vercel|vercel\s+status|vercel)$/i,
  
  // ===== NEW SYSTEM MONITORING =====
  diskHealth: /^(?:disk\s+health|smart|smart\s+status|drive\s+health|disk\s+check|check\s+disks?)$/i,
  dockerCleanup: /^(?:docker\s+clean(?:up)?|prune|docker\s+prune|clean(?:up)?\s+docker|reclaim\s+space)$/i,
  logErrors: /^(?:errors?|log\s+errors?|container\s+errors?|show\s+errors?|recent\s+errors?)$/i,
  piholeStats: /^(?:pihole|pi-?hole|dns|ad\s*block|ads?\s+blocked|blocked\s+queries)$/i,
  speedTest: /^(?:speed\s*test|internet\s+speed|bandwidth\s+test|test\s+speed|how\s+fast|connection\s+speed)$/i,
  imageUpdates: /^(?:image\s+updates?|container\s+updates?|check\s+updates?|available\s+updates?|outdated\s+(?:images?|containers?))$/i,
  sslCheck: /^(?:ssl|ssl\s+check|cert(?:s|ificates?)?|ssl\s+status|tls|cert\s+expiry|check\s+certs?)$/i,
  serviceDeps: /^(?:dep(?:s|endenc(?:y|ies))\s+(?:for\s+)?(.+)|what\s+depends\s+on\s+(.+)|(.+)\s+dependencies|if\s+(.+)\s+(?:goes?\s+down|dies|crashes))$/i,

  // ===== INTEGRATIONS =====
  homeAssistant: /^(?:ha|home\s*assistant)\s+(.+)$/i,
  lightsControl: /^(?:(?:turn\s+)?(?:on|off)\s+(?:the\s+)?(.+?)\s*(?:lights?)?|(?:lights?)\s+(?:on|off))$/i,
  haTemperature: /^(?:(?:indoor?\s+)?temp(?:erature)?s?\s*(?:inside)?|how\s+(?:hot|cold|warm)\s+is\s+it\s+inside|what'?s\s+the\s+temp(?:erature)?\s+inside)$/i,
  tailscaleStatus: /^(?:tailscale|vpn|vpn\s+status|tailscale\s+status|who'?s\s+connected|connected\s+devices)$/i,
  nextcloudStatus: /^(?:nextcloud|nextcloud\s+status|nextcloud\s+storage|cloud\s+storage)$/i,
  grafanaDashboards: /^(?:grafana|grafana\s+(?:dashboards?|status)|show\s+grafana)$/i,
  grafanaSnapshot: /^(?:grafana\s+(?:snapshot|graph|chart|render)\s+(.+)|show\s+(?:me\s+)?(?:the\s+)?(?:cpu|memory|disk|network)\s+graph)$/i,
  uptimeKuma: /^(?:uptime(?:\s+kuma)?|monitors?|uptime\s+status|service\s+uptime|is\s+.+\s+up\??)$/i,
  bandwidthStats: /^(?:bandwidth|network\s+usage|net\s+usage|who'?s\s+(?:using|eating)\s+bandwidth)$/i,
  qbittorrentStatus: /^(?:qbittorrent|qbit|qbit\s+status|torrent\s+status|qbit\s+torrents|qbit\s+list)$/i,
  qbittorrentAdd: /^(?:add\s+torrent|add\s+to\s+qbit|qbit\s+add)\s+(.+)$/i,
  deployGluetun: /^(?:deploy\s+gluetun|set\s+up\s+vpn\s+for\s+downloads|gluetun\s+deploy|install\s+gluetun)$/i,

  // ===== PRODUCTIVITY =====
  noteAdd: /^(?:(?:note|save|jot|write\s+down)|add\s+(?:a\s+)?note(?:\s+that)?|remember\s+that|write\s+(?:a\s+)?note|take\s+(?:a\s+)?note|make\s+(?:a\s+)?note|record(?:\s+that)?|jeeves\s+note)\s*[:\s]+(.+)$/i,
  noteSearch: /^(?:find\s+note|search\s+notes?|notes?\s+about|notes?\s+for|look\s+up\s+note|what(?:\'s|\s+did)\s+(?:I\s+)?(?:save|write)\s+about|what\'?s\s+my\s+note\s+on)\s+(.+)$/i,
  noteList: /^(?:notes?|my\s+notes?|show\s+notes?|list\s+notes?|all\s+notes?|what\s+notes?\s+(?:do\s+I\s+have|have\s+I\s+saved))$/i,
  reminderSet: /^(?:remind\s+me|reminder|set\s+(?:a\s+)?reminder)\s+(.+?)(?:\s+to\s+(.+))?$/i,
  reminderList: /^(?:reminders?|my\s+reminders?|pending\s+reminders?|show\s+reminders?|list\s+reminders?)$/i,
  scheduleCreate: /^(?:every\s+.+)$/i,
  scheduleList: /^(?:schedules?|my\s+schedules?|scheduled\s+tasks?|show\s+schedules?|custom\s+schedules?|list\s+schedules?)$/i,
  scheduleDelete: /^(?:delete|remove|cancel)\s+schedule\s+(.+)$/i,
  timeline: /^(?:timeline|what\s+happened\s+(?:today|yesterday|recently)|event\s+log|events|activity\s+log|what'?s\s+been\s+happening)$/i,
  quietHours: /^(?:quiet\s+hours?|notification\s+(?:settings?|prefs?)|do\s+not\s+disturb|dnd)$/i,
  quietHoursSet: /^(?:quiet\s+hours?\s+(\d{1,2}(?::\d{2})?)\s*(?:to|-)\s*(\d{1,2}(?::\d{2})?)|(?:don'?t|do\s+not)\s+(?:message|notify|bother)\s+me\s+(?:between|from)\s+(\d{1,2}(?::\d{2})?(?:\s*(?:am|pm))?)\s*(?:to|and|-)\s*(\d{1,2}(?::\d{2})?(?:\s*(?:am|pm))?))/i,
  quietHoursOff: /^(?:(?:disable|turn\s+off|stop)\s+quiet\s+hours?|notifications?\s+on|dnd\s+off)$/i,
  fileShare: /^(?:send\s+(?:me\s+)?(?:the\s+)?(?:file\s+)?|share\s+(?:file\s+)?)(.+?)(?:\s+file)?$/i,

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
 * Simple commands not in the registry (terminal, backup, browse, PRD, etc.).
 * Registry matches are handled first in parseIntent; this is fallback for parseIntent callers.
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
  
  // ===== VERCEL COMMANDS (all pattern-matched, FREE) =====
  
  // Vercel project URL lookup
  const vercelUrlMatch = trimmed.match(PATTERNS.vercelUrl);
  if (vercelUrlMatch) {
    return { action: 'vercel_url', target: vercelUrlMatch[1].trim(), confidence: 1.0, resolutionMethod: 'pattern', estimatedCost: 0 };
  }
  
  // Vercel deploy
  const vercelDeployMatch = trimmed.match(PATTERNS.vercelDeploy);
  if (vercelDeployMatch) {
    return { action: 'vercel_deploy', target: vercelDeployMatch[1].trim(), confidence: 1.0, resolutionMethod: 'pattern', estimatedCost: 0 };
  }
  
  // Vercel projects list / status
  if (PATTERNS.vercelProjects.test(lower)) {
    return { action: 'vercel_projects', confidence: 1.0, resolutionMethod: 'pattern', estimatedCost: 0 };
  }

  // ===== HOMELAB COMMANDS (all pattern-matched, FREE) =====
  // Only match if homelab is enabled
  if (config.homelab?.enabled || process.env.HOMELAB_DEV_MODE) {
    // System review and store to memory (check before status)
    if (PATTERNS.homelabSystemReview.test(lower)) {
      return { action: 'homelab_system_review', confidence: 1.0, resolutionMethod: 'pattern', estimatedCost: 0 };
    }
    // Homelab report (connected / needs setup / needs API)
    if (PATTERNS.homelabReport.test(lower)) {
      return { action: 'homelab_report', confidence: 1.0, resolutionMethod: 'pattern', estimatedCost: 0 };
    }
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

    // Security status
    if (PATTERNS.homelabSecurityStatus.test(lower)) {
      return { action: 'homelab_security_status', confidence: 1.0, resolutionMethod: 'pattern', estimatedCost: 0 };
    }

    // Backup: run full
    if (PATTERNS.backupRun.test(lower)) {
      return { action: 'homelab_backup', confidence: 1.0, data: { mode: 'full' }, resolutionMethod: 'pattern', estimatedCost: 0 };
    }

    // Backup: postgres only
    if (PATTERNS.backupPostgres.test(lower)) {
      return { action: 'homelab_backup', confidence: 1.0, data: { mode: 'postgres' }, resolutionMethod: 'pattern', estimatedCost: 0 };
    }

    // Backup: volumes only
    if (PATTERNS.backupVolumes.test(lower)) {
      return { action: 'homelab_backup', confidence: 1.0, data: { mode: 'volumes' }, resolutionMethod: 'pattern', estimatedCost: 0 };
    }

    // Backup: status
    if (PATTERNS.backupStatus.test(lower)) {
      return { action: 'homelab_backup_status', confidence: 1.0, resolutionMethod: 'pattern', estimatedCost: 0 };
    }

    // Backup: list
    if (PATTERNS.backupList.test(lower)) {
      return { action: 'homelab_backup_list', confidence: 1.0, resolutionMethod: 'pattern', estimatedCost: 0 };
    }

    // Backup: restore
    const restoreMatch = lower.match(PATTERNS.backupRestore);
    if (restoreMatch) {
      return { action: 'homelab_backup_restore', target: restoreMatch[1].trim(), confidence: 1.0, resolutionMethod: 'pattern', estimatedCost: 0 };
    }

    // Backup: schedule
    if (PATTERNS.backupSchedule.test(lower)) {
      return { action: 'homelab_backup_schedule', confidence: 1.0, resolutionMethod: 'pattern', estimatedCost: 0 };
    }

    // Firewall status
    if (PATTERNS.homelabFirewallStatus.test(lower)) {
      return { action: 'homelab_firewall', confidence: 1.0, data: { subcommand: 'status' }, resolutionMethod: 'pattern', estimatedCost: 0 };
    }

    // Firewall allow
    const fwAllowMatch = lower.match(PATTERNS.homelabFirewallAllow);
    if (fwAllowMatch) {
      return { action: 'homelab_firewall', confidence: 1.0, data: { subcommand: 'allow', port: parseInt(fwAllowMatch[1], 10), proto: fwAllowMatch[2] || 'tcp' }, resolutionMethod: 'pattern', estimatedCost: 0 };
    }

    // Firewall deny
    const fwDenyMatch = lower.match(PATTERNS.homelabFirewallDeny);
    if (fwDenyMatch) {
      return { action: 'homelab_firewall', confidence: 1.0, data: { subcommand: 'deny', port: parseInt(fwDenyMatch[1], 10) }, resolutionMethod: 'pattern', estimatedCost: 0 };
    }

    // Media: select from pending results (just a number)
    const selectMatch = lower.match(PATTERNS.mediaSelect);
    if (selectMatch) {
      // Return media_select -- the router will check if there are actually pending results
      return { action: 'media_select', target: selectMatch[1], confidence: 0.8, resolutionMethod: 'pattern', estimatedCost: 0 };
    }

    // Media: next page of results
    if (PATTERNS.mediaMore.test(lower)) {
      return { action: 'media_more', confidence: 0.9, resolutionMethod: 'pattern', estimatedCost: 0 };
    }

    // Media: download status / queue (check before download verb to avoid "downloads" matching)
    if (PATTERNS.mediaStatus.test(lower)) {
      return { action: 'media_status', confidence: 1.0, resolutionMethod: 'pattern', estimatedCost: 0 };
    }

    // Media: download / get / add (check BEFORE search so "download X" triggers add, not just search)
    const downloadMatch = lower.match(PATTERNS.mediaDownload);
    if (downloadMatch) {
      const target = downloadMatch[1].trim();
      // Exclude generic service names so "install qbittorrent" doesn't trigger media download
      if (!['deps', 'dependencies', 'packages', 'modules'].includes(target)) {
        return { action: 'media_download', target, confidence: 0.9, resolutionMethod: 'pattern', estimatedCost: 0 };
      }
    }

    // Media: search / find / look up
    const searchMatch = lower.match(PATTERNS.mediaSearch);
    if (searchMatch) {
      return { action: 'media_search', target: searchMatch[1].trim(), confidence: 0.9, resolutionMethod: 'pattern', estimatedCost: 0 };
    }

    // ===== SYSTEM MONITORING COMMANDS =====

    // Disk health / SMART
    if (PATTERNS.diskHealth.test(lower)) {
      return { action: 'disk_health', confidence: 1.0, resolutionMethod: 'pattern', estimatedCost: 0 };
    }

    // Docker cleanup
    if (PATTERNS.dockerCleanup.test(lower)) {
      return { action: 'docker_cleanup', confidence: 1.0, resolutionMethod: 'pattern', estimatedCost: 0 };
    }

    // Log errors
    if (PATTERNS.logErrors.test(lower)) {
      return { action: 'log_errors', confidence: 1.0, resolutionMethod: 'pattern', estimatedCost: 0 };
    }

    // Pi-hole stats
    if (PATTERNS.piholeStats.test(lower)) {
      return { action: 'pihole_stats', confidence: 1.0, resolutionMethod: 'pattern', estimatedCost: 0 };
    }

    // Speed test
    if (PATTERNS.speedTest.test(lower)) {
      return { action: 'speed_test', confidence: 1.0, resolutionMethod: 'pattern', estimatedCost: 0 };
    }

    // Image updates
    if (PATTERNS.imageUpdates.test(lower)) {
      return { action: 'image_updates', confidence: 1.0, resolutionMethod: 'pattern', estimatedCost: 0 };
    }

    // SSL check
    if (PATTERNS.sslCheck.test(lower)) {
      return { action: 'ssl_check', confidence: 1.0, resolutionMethod: 'pattern', estimatedCost: 0 };
    }

    // Service dependencies
    const depsMatch = trimmed.match(PATTERNS.serviceDeps);
    if (depsMatch) {
      const target = (depsMatch[1] || depsMatch[2] || depsMatch[3] || depsMatch[4] || '').trim();
      return { action: 'service_deps', target, confidence: 0.9, resolutionMethod: 'pattern', estimatedCost: 0 };
    }

    // ===== INTEGRATION COMMANDS =====

    // HA temperature (check before general HA)
    if (PATTERNS.haTemperature.test(lower)) {
      return { action: 'home_assistant', target: 'temperature', confidence: 1.0, resolutionMethod: 'pattern', estimatedCost: 0 };
    }

    // Lights control
    const lightsMatch = lower.match(PATTERNS.lightsControl);
    if (lightsMatch) {
      return { action: 'home_assistant', target: trimmed, confidence: 0.9, resolutionMethod: 'pattern', estimatedCost: 0 };
    }

    // Home Assistant commands
    const haMatch = trimmed.match(PATTERNS.homeAssistant);
    if (haMatch) {
      return { action: 'home_assistant', target: haMatch[1].trim(), confidence: 0.9, resolutionMethod: 'pattern', estimatedCost: 0 };
    }

    // Tailscale
    if (PATTERNS.tailscaleStatus.test(lower)) {
      return { action: 'tailscale_status', confidence: 1.0, resolutionMethod: 'pattern', estimatedCost: 0 };
    }

    // Nextcloud
    if (PATTERNS.nextcloudStatus.test(lower)) {
      return { action: 'nextcloud_status', confidence: 1.0, resolutionMethod: 'pattern', estimatedCost: 0 };
    }

    // Grafana snapshot (before dashboards list)
    const grafSnapMatch = trimmed.match(PATTERNS.grafanaSnapshot);
    if (grafSnapMatch) {
      return { action: 'grafana_snapshot', target: (grafSnapMatch[1] || '').trim(), confidence: 0.9, resolutionMethod: 'pattern', estimatedCost: 0 };
    }

    // Grafana dashboards
    if (PATTERNS.grafanaDashboards.test(lower)) {
      return { action: 'grafana_dashboards', confidence: 1.0, resolutionMethod: 'pattern', estimatedCost: 0 };
    }

    // Uptime Kuma
    if (PATTERNS.uptimeKuma.test(lower)) {
      return { action: 'uptime_kuma', confidence: 1.0, resolutionMethod: 'pattern', estimatedCost: 0 };
    }

    // Bandwidth
    if (PATTERNS.bandwidthStats.test(lower)) {
      return { action: 'bandwidth', confidence: 1.0, resolutionMethod: 'pattern', estimatedCost: 0 };
    }

    // qBittorrent
    if (PATTERNS.deployGluetun.test(lower)) {
      return { action: 'deploy_gluetun_stack', confidence: 1.0, resolutionMethod: 'pattern', estimatedCost: 0 };
    }
    if (PATTERNS.qbittorrentStatus.test(lower)) {
      return { action: 'qbittorrent_status', confidence: 1.0, resolutionMethod: 'pattern', estimatedCost: 0 };
    }
    const qbitAddMatch = trimmed.match(PATTERNS.qbittorrentAdd);
    if (qbitAddMatch) {
      const target = qbitAddMatch[1].trim();
      if (target.startsWith('magnet:') || target.startsWith('http://') || target.startsWith('https://')) {
        return { action: 'qbittorrent_add', target, confidence: 1.0, resolutionMethod: 'pattern', estimatedCost: 0 };
      }
    }
    // Bare magnet link or torrent URL pasted directly
    if (trimmed.startsWith('magnet:') || /^https?:\/\/.+\/(.+)\.torrent(\?|$)/i.test(trimmed)) {
      return { action: 'qbittorrent_add', target: trimmed, confidence: 0.95, resolutionMethod: 'pattern', estimatedCost: 0 };
    }

    // ===== PRODUCTIVITY COMMANDS =====

    // Note add
    const noteAddMatch = trimmed.match(PATTERNS.noteAdd);
    if (noteAddMatch) {
      return { action: 'note_add', target: noteAddMatch[1].trim(), confidence: 1.0, resolutionMethod: 'pattern', estimatedCost: 0 };
    }

    // Note search
    const noteSearchMatch = trimmed.match(PATTERNS.noteSearch);
    if (noteSearchMatch) {
      return { action: 'note_search', target: noteSearchMatch[1].trim(), confidence: 0.9, resolutionMethod: 'pattern', estimatedCost: 0 };
    }

    // Note list
    if (PATTERNS.noteList.test(lower)) {
      return { action: 'note_list', confidence: 1.0, resolutionMethod: 'pattern', estimatedCost: 0 };
    }

    // Reminder set (before reminder list)
    const reminderMatch = trimmed.match(PATTERNS.reminderSet);
    if (reminderMatch) {
      return { action: 'reminder_set', target: reminderMatch[0], confidence: 0.9, resolutionMethod: 'pattern', estimatedCost: 0 };
    }

    // Reminder list
    if (PATTERNS.reminderList.test(lower)) {
      return { action: 'reminder_list', confidence: 1.0, resolutionMethod: 'pattern', estimatedCost: 0 };
    }

    // Schedule delete (before create)
    const schedDeleteMatch = lower.match(PATTERNS.scheduleDelete);
    if (schedDeleteMatch) {
      return { action: 'schedule_delete', target: schedDeleteMatch[1].trim(), confidence: 0.9, resolutionMethod: 'pattern', estimatedCost: 0 };
    }

    // Schedule list
    if (PATTERNS.scheduleList.test(lower)) {
      return { action: 'schedule_list', confidence: 1.0, resolutionMethod: 'pattern', estimatedCost: 0 };
    }

    // Schedule create ("every friday at 5pm ...")
    if (PATTERNS.scheduleCreate.test(lower)) {
      return { action: 'schedule_create', target: trimmed, confidence: 0.8, resolutionMethod: 'pattern', estimatedCost: 0 };
    }

    // Timeline
    if (PATTERNS.timeline.test(lower)) {
      return { action: 'timeline', confidence: 1.0, resolutionMethod: 'pattern', estimatedCost: 0 };
    }

    // Mute notifications for today (accept "notifications today" or "notifications for today")
    if (/^(?:no more notifications? (?:for today|until tomorrow|today)|mute (?:all )?notifications? (?:for today|until tomorrow|today)|stop (?:all )?notifications? (?:for today|until tomorrow|today)|that'?s enough (?:for today|notifications?|today)|no (?:more )?alerts? (?:for today|until tomorrow|today))$/i.test(lower)) {
      return { action: 'mute_notifications', confidence: 1.0, resolutionMethod: 'pattern', estimatedCost: 0 };
    }

    // Quiet hours off
    if (PATTERNS.quietHoursOff.test(lower)) {
      return { action: 'quiet_hours_set', target: 'off', confidence: 1.0, resolutionMethod: 'pattern', estimatedCost: 0 };
    }

    // Quiet hours set
    const qhSetMatch = trimmed.match(PATTERNS.quietHoursSet);
    if (qhSetMatch) {
      const start = (qhSetMatch[1] || qhSetMatch[3] || '23:00').trim();
      const end = (qhSetMatch[2] || qhSetMatch[4] || '07:00').trim();
      return { action: 'quiet_hours_set', target: `${start}-${end}`, confidence: 0.9, resolutionMethod: 'pattern', estimatedCost: 0 };
    }

    // Quiet hours status
    if (PATTERNS.quietHours.test(lower)) {
      return { action: 'quiet_hours', confidence: 1.0, resolutionMethod: 'pattern', estimatedCost: 0 };
    }

    // File share (check late to avoid false positives)
    const fileShareMatch = trimmed.match(PATTERNS.fileShare);
    if (fileShareMatch) {
      const target = fileShareMatch[1].trim();
      // Only match if it looks like a file path
      if (target.includes('/') || target.includes('.')) {
        return { action: 'file_share', target, confidence: 0.8, resolutionMethod: 'pattern', estimatedCost: 0 };
      }
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
\`update all\` → Update all running services
\`install <service>\` → Deploy a new service
\`uninstall <service>\` → Remove a service (keeps data)
\`diagnose <service>\` → Run diagnostics
\`stacks\` → List compose stacks
\`health check\` / \`daemon health\` → Run health checks
\`self-test\` → Run system self-tests
\`security status\` → Security overview (firewall, SSH, SSL)
\`firewall status\` → Show firewall rules
\`firewall allow <port>\` → Open a port
\`firewall deny <port>\` → Close a port

**Media** (requires Sonarr/Radarr API keys):
\`search <title>\` → Search for movies/shows
\`download <title>\` → Add to library and download
\`download <title> season 2\` → Download specific season
\`downloads\` / \`queue\` → View download queue

**System Monitoring**:
\`disk health\` / \`smart\` → SMART disk health check
\`errors\` → Scan container logs for errors
\`docker cleanup\` / \`prune\` → Clean unused Docker resources
\`speed test\` → Run internet speed test
\`image updates\` → Check for container image updates
\`ssl check\` / \`certs\` → Check SSL certificate expiry
\`pihole\` → Pi-hole DNS blocking stats
\`bandwidth\` → Per-container network usage
\`deps <service>\` → Service dependency map

**Integrations**:
\`tailscale\` / \`vpn\` → VPN status and connected devices
\`grafana\` → List Grafana dashboards
\`uptime\` / \`monitors\` → Uptime Kuma status
\`nextcloud\` → Nextcloud storage info
\`ha <command>\` → Home Assistant control
\`lights on/off\` → Control lights

**Productivity**:
\`note: <text>\` / \`add a note that <text>\` / \`remember that <text>\` → Save a note
\`notes\` / \`my notes\` → List all notes
\`find note <query>\` / \`search notes <query>\` → Search notes
\`remind me in 2h to ...\` → Set a reminder
\`reminders\` → List pending reminders
\`every friday at 5pm ...\` → Create scheduled task
\`schedules\` → List custom schedules
\`timeline\` / \`what happened today\` → Event timeline
\`quiet hours 23:00-07:00\` → Set notification quiet hours
\`send me /path/to/file\` → Send a file via Signal`
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
  
  // ===== SPECIFIC PATTERNS (check before the broad "ask" catch-all) =====

  // Cursor commands — "what's cursor working on", "show me what cursor did", etc.
  if (/^(cursor\s+(tasks?|status|agents?)|what'?s\s+cursor\s+(working(\s+on)?|doing)|show\s+cursor\s+tasks?)$/i.test(lower)) {
    return { action: 'cursor_status', confidence: 1.0 };
  }
  if (/^(show\s+(me\s+)?what\s+cursor\s+did|cursor\s+(progress|conversation|output|log)|what\s+did\s+cursor\s+do)$/i.test(lower)) {
    return { action: 'cursor_conversation', confidence: 1.0 };
  }

  // Learned preferences — "what have you learned", "show learned", etc.
  if (PATTERNS.showLearned.test(lower)) {
    return {
      action: 'show_learned',
      confidence: 1.0,
      message: getLearnedPreferences()
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
  
  // Short conversational replies that don't match any specific context
  // These should NOT be shipped to the AI agent with 120KB of project context.
  // Catch them here and respond cheaply instead of falling through to agent_ask.
  if (/^(?:ok|okay|sure|yep|yup|yeah|yes|no|nah|nope|thanks|thank you|got it|sounds good|perfect|nice|cool|great|good|right|understood|acknowledged|roger|copy|k|kk)\.?!?$/i.test(lower)) {
    return {
      action: 'status',
      confidence: 0.8,
      resolutionMethod: 'pattern',
      estimatedCost: 0,
      message: 'Acknowledged. What would you like me to do next?'
    };
  }

  // Short numbered replies like "1 and 2", "1, 2, and 3" when no media pending
  if (/^\d[\d,\s]+(?:and\s+\d+)?\.?$/.test(lower) && lower.length < 20) {
    return {
      action: 'status',
      confidence: 0.7,
      resolutionMethod: 'pattern',
      estimatedCost: 0,
      message: `Got it: "${trimmed}". What should I do with that? (No active selection context)`
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
  
  // Personality: Preference statements ("my favorite language is Rust", "I like TypeScript")
  if (PATTERNS.preferenceStatement.test(trimmed)) {
    return {
      action: 'remember',
      confidence: 1.0,
      message: rememberPersonality(trimmed)
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
  
  // Feedback / discussion -- user is providing input, not a command
  // MUST be checked BEFORE edit patterns so "change the backup to X" 
  // doesn't immediately trigger code changes
  if (PATTERNS.feedback.test(trimmed)) {
    return {
      action: 'feedback',
      prompt: trimmed,
      confidence: 0.85,
      resolutionMethod: 'pattern',
      estimatedCost: 0,
      message: trimmed
    };
  }

  // ===== CURSOR BACKGROUND AGENT COMMANDS =====

  // Cursor task status - "cursor tasks", "what's cursor working on", "cursor status"
  if (/^(cursor\s+(tasks?|status|agents?)|what'?s\s+cursor\s+(working(\s+on)?|doing)|show\s+cursor\s+tasks?)$/i.test(lower)) {
    return { action: 'cursor_status', confidence: 1.0 };
  }

  // Cursor repos - "cursor repos", "list repos"
  if (/^(cursor\s+repos|list\s+repos|available\s+repos|show\s+repos)$/i.test(lower)) {
    return { action: 'cursor_repos', confidence: 1.0 };
  }

  // Cursor stop - "stop cursor", "stop that task", "cancel cursor agent"
  if (/^(stop|cancel|kill|abort)\s+(cursor|the?\s*cursor\s*(task|agent)|that\s+(cursor\s+)?task)$/i.test(lower)) {
    return { action: 'cursor_stop', confidence: 1.0 };
  }

  // Cursor conversation - "show me what cursor did", "cursor progress", "cursor conversation"
  if (/^(show\s+(me\s+)?what\s+cursor\s+did|cursor\s+(progress|conversation|output|log)|what\s+did\s+cursor\s+do)$/i.test(lower)) {
    return { action: 'cursor_conversation', confidence: 1.0 };
  }

  // Cursor follow-up - "tell cursor to X", "also tell cursor X", "cursor: X"
  const cursorFollowup = trimmed.match(/^(tell\s+cursor\s+(?:to\s+)?|also\s+(?:tell\s+)?cursor\s+(?:to\s+)?|cursor:\s*)(.+)$/i);
  if (cursorFollowup) {
    return {
      action: 'cursor_followup',
      prompt: cursorFollowup[2],
      confidence: 0.95
    };
  }

  // Cursor launch - "cursor build X for Y", "send to cursor: X", "have cursor X on Y"
  const cursorLaunch = trimmed.match(/^(?:cursor\s+(?:build|code|implement|work\s+on)|send\s+to\s+cursor:?\s*|have\s+cursor\s+(?:build|code|implement|work\s+on))\s+(.+)$/i);
  if (cursorLaunch) {
    return {
      action: 'cursor_launch',
      prompt: cursorLaunch[1],
      confidence: 0.95,
      requiresAsync: true
    };
  }

  // Check for pending Cursor task confirmation
  if (pendingCursorCheck() && /^(go|yes|do\s+it|confirm|launch|execute|send\s+it|approved?)$/i.test(lower)) {
    return { action: 'cursor_confirm', confidence: 1.0, requiresAsync: true };
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
  // This catches questions, requests, conversational input, and greetings
  const isGreeting = /^(hey|hi|hello|yo|sup|what'?s up|howdy|hiya|greetings)\b/i.test(trimmed);
  const looksLikeNaturalLanguage = 
    isGreeting ||                        // Greetings with any extra words
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
  
  // STAGE 0.5 removed: vercel, notes, reminders, timeline, quiet, schedule — now handled by command registry (STAGE 3)

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
  
  // Try command registry first (single source of truth)
  const { matchCommand, matchResultToParsedIntent } = await import('./command-matcher.js');
  const registryMatch = matchCommand(processedMessage);
  if (registryMatch) {
    const simple = matchResultToParsedIntent(registryMatch);
    referenceResolver.update(simple);
    return simple as ParsedIntent;
  }

  // Fallback: handleSimpleCommand for terminal/git/npm/backup and other patterns not in registry
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
    
    // Parse JSON response - strip markdown code fences if present
    const cleanedText = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
    const parsed = JSON.parse(cleanedText) as ParsedIntent;
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
