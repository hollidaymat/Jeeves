/**
 * Message Handler
 * Routes messages through cognitive processing, auth, parsing, and execution
 */

import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { matchCommand, matchResultToParsedIntent } from './command-matcher.js';
import { COMMAND_REGISTRY } from './command-registry.js';
import { fuzzyMatch } from './fuzzy-matcher.js';
import { addAlias } from './alias-store.js';
import { parseIntent } from './parser.js';
import { executeCommand } from './executor.js';
import type { 
  IncomingMessage, 
  OutgoingMessage, 
  MessageInterface,
  SystemStatus,
  ParsedIntent,
  ExecutionResult
} from '../types/index.js';
import { getProjectIndex } from './project-scanner.js';
import { getAgentStatus, getActiveProject } from './cursor-agent.js';
import { tryExecuteWorkflow, loadWorkflows } from './workflow-engine.js';
import { checkAndCompact } from './session-compactor.js';
import { think, quickDecision } from './cognitive/index.js';
import { getDb } from './context/db.js';
import { seedAnnotations } from './context/layers/annotations.js';
import { addGeneralMessage, getGeneralConversations } from './memory.js';
import { recordTrace } from './ooda-logger.js';
import { assembleContext, formatContextForPrompt } from './context/index.js';
import { checkForLoop } from './behavior-tracker.js';
import { handleConversation, isClearQuestionOrStatement } from './conversation-handler.js';
import { PERSONALITY_RULES, sanitizeResponse, getMaxChars, truncateToMaxChars } from './personality.js';

// Brain 2 whitelist: intents that always trigger context assembly (skip status, greeting, feedback, registry)
const BRAIN2_WHITELIST = new Set<string>([
  'agent_ask',
  'homelab_install',
  'homelab_uninstall',
  'homelab_update',
  'homelab_update_all',
  'homelab_service_start',
  'homelab_service_stop',
  'homelab_service_restart',
]);

// Initialize 6-layer context system
try {
  getDb();  // Ensure database is created
  seedAnnotations();  // Seed with known preferences
  logger.info('6-layer context system initialized');
} catch (err) {
  logger.warn('Context system init failed (non-fatal)', { error: String(err) });
}

// Load workflows on module initialization
loadWorkflows().catch(err => logger.warn('Failed to load workflows', { error: String(err) }));

// Compaction check counter (run every N messages)
let messagesSinceCompactionCheck = 0;

// Pending fuzzy confirmation: sender -> { originalPhrase, suggestion, timestamp }
const pendingFuzzyConfirm = new Map<string, { originalPhrase: string; suggestion: string; commandId: string; timestamp: number }>();
const PENDING_FUZZY_TTL_MS = 5 * 60 * 1000;

// Cursor confirmation flag — set when a "cursor build" command produces a pending plan
let awaitingCursorConfirmation = false;

const COMPACTION_CHECK_INTERVAL = 10; // Check every 10 messages

// Track statistics
const stats = {
  startTime: Date.now(),
  messagesToday: 0,
  lastCommand: null as { action: string; timestamp: string; success: boolean } | null
};

// Registered interfaces for sending responses
const interfaces = new Map<string, MessageInterface>();

/**
 * Register a message interface
 */
export function registerInterface(iface: MessageInterface) {
  interfaces.set(iface.name, iface);
  logger.info(`Registered interface: ${iface.name}`);
}

/**
 * Check if sender is authorized
 */
function isAuthorized(sender: string): boolean {
  // Web interface is always authorized (localhost only)
  if (sender === 'web') return true;
  
  // Voice/tablet interface (hold-to-talk, Hey Jeeves from web UI)
  if (sender === 'tablet') return true;
  
  // Mock interface authorized for testing
  if (sender === 'mock') return true;
  
  // Check phone number allowlist
  return config.security.allowed_numbers.includes(sender);
}

/**
 * Get current system status
 */
export function getSystemStatus(): SystemStatus {
  const uptime = Math.floor((Date.now() - stats.startTime) / 1000);
  
  return {
    uptime_seconds: uptime,
    interfaces: {
      signal: interfaces.has('signal') ? 'connected' : 'unavailable',
      web: interfaces.has('web') ? 'connected' : 'disconnected'
    },
    projects_loaded: getProjectIndex().projects.size,
    messages_today: stats.messagesToday,
    last_command: stats.lastCommand || undefined,
    agent: getAgentStatus(),
    voice: config.voice?.enabled ? { enabled: true } : undefined
  };
}

/**
 * Format execution result as response message
 */
function formatResponse(intent: ParsedIntent, result: ExecutionResult): string {
  if (result.success) {
    return result.output || `✓ ${intent.action} completed`;
  }
  const err = result.error || result.output || 'Unknown error';
  return `Failed to execute: ${err}`;
}

/** When response is chained (contains Results section), strip leftover status lines. */
function stripStatusLinesIfChained(response: string): string {
  if (!/\*\*Results:\*\*|Results:\s*\n/i.test(response)) return response;
  return response
    .split('\n')
    .filter((line) => !/^(Executing|Pending plan|Standby|Done executing|Extracted plan)[^\n]*$/i.test(line.trim()))
    .join('\n');
}

/**
 * Handle an incoming message
 */
export async function handleMessage(message: IncomingMessage): Promise<OutgoingMessage | null> {
  const handlerStart = Date.now();
  let handlerSuccess = true;
  const { sender, content: rawContent, interface: iface } = message;
  // Normalize once: strip leading/trailing quotes (voice, paste, or UI may add them) so routing sees "Jeeves, develop: ..."
  let content = rawContent.trim();
  while (content.length > 0 && /^["'\u201c\u2018\u201d\u2019`]/.test(content)) {
    content = content.replace(/^["'\u201c\u2018\u201d\u2019`]+/, '').trim();
  }
  
  logger.debug('Received message', { sender, interface: iface, content: content.substring(0, 50) });
  
  // Authorization check
  if (!isAuthorized(sender)) {
    logger.security.unauthorized(sender);
    
    if (config.security.silent_deny) {
      handlerSuccess = false;
      return null;  // Silent drop
    }
    
    return {
      recipient: sender,
      content: 'Unauthorized',
      replyTo: message.id
    };
  }
  
  logger.security.authorized(sender, 'message');
  stats.messagesToday++;

  // Use first line for command matching (avoids attachment suffixes breaking patterns)
  const primaryCommand = content.split(/\n\n/)[0].trim();
  const isSelfTest = /^(?:(?:run\s+)?self\s*test|selftest|test\s+yourself|run\s+diagnostic|check\s+yourself)$/i.test(primaryCommand);
  const selfTestCmd = COMMAND_REGISTRY.find(c => c.id === 'system.jeeves_self_test');
  const registryMatch = isSelfTest && selfTestCmd
    ? { commandId: selfTestCmd.id, command: selfTestCmd, action: 'jeeves_self_test' as const, params: {} as Record<string, unknown>, confidence: 1 }
    : matchCommand(primaryCommand);

  // Learn from every message (non-blocking)
  import('../capabilities/self/memory-learner.js')
    .then(({ learnFromMessage }) => learnFromMessage(rawContent))
    .catch(() => {});
  
  try {
    // Conversation mode FIRST: meta-questions and capability discussion bypass task routing and loop detection
    const conversationResponse = await handleConversation(primaryCommand, content, sender, message.id);
    if (conversationResponse) {
      recordTrace({ routingPath: 'conversational', rawInput: content, action: 'conversation' });
      return conversationResponse;
    }

    // Fast path: "try again" / "let's try" — no LLM, no meta self-reflection
    if (/^(?:(?:let'?s?\s+)?try(?:\s+again)?|try\s+again|made\s+some\s+changes)\s*[,.]?\s*(?:made\s+some\s+changes)?$/i.test(primaryCommand.trim())) {
      recordTrace({ routingPath: 'registry', rawInput: content, action: 'try_again', success: true });
      return { recipient: sender, content: 'What would you like me to do?', replyTo: message.id };
    }

    // Try workflow engine first (deterministic, token-efficient)
    const activeProject = getActiveProject();
    const workflowResult = await tryExecuteWorkflow(content, activeProject?.workingDir);
    
    if (workflowResult) {
      recordTrace({ routingPath: 'workflow', rawInput: content, action: 'workflow', success: workflowResult.success });
      logger.debug('Workflow executed', { success: workflowResult.success, tokens: workflowResult.tokensUsed });
      
      // Update stats
      stats.lastCommand = {
        action: 'workflow',
        timestamp: new Date().toISOString(),
        success: workflowResult.success
      };
      
      return {
        recipient: sender,
        content: workflowResult.output,
        replyTo: message.id
      };
    }

    // Fast path: check/list/show what's in a directory — run ls and report (no LLM, no fabrication)
    const listDirMatch = primaryCommand.match(
      /(?:check|list|show|what'?s?)\s+(?:what'?s?\s+)?(?:me\s+)?(?:in|at)?\s*(\/[a-zA-Z0-9_./-]+)|^ls\s+(\/[a-zA-Z0-9_./-]+)|^list\s+(\/[a-zA-Z0-9_./-]+)/i
    );
    const dirPath = listDirMatch ? (listDirMatch[1] || listDirMatch[2] || listDirMatch[3] || '').trim() : '';
    if (dirPath) {
      const home = process.env.HOME || '/home/jeeves';
      const { existsSync } = await import('fs');
      const { resolve } = await import('path');
      const abs = resolve(dirPath);
      if (abs === home || abs.startsWith(home + '/')) {
        if (!existsSync(abs)) {
          return { recipient: sender, content: `Error: Path not found: ${abs}`, replyTo: message.id };
        }
        const cmd = `ls -la ${JSON.stringify(abs)}`;
        try {
          const { execSync } = await import('child_process');
          const out = execSync(cmd, { encoding: 'utf8', timeout: 5000 });
          const trimmed = (out ?? '').trim();
          logger.info('[list_dir] Shell command ran', { command: cmd, stdoutBytes: trimmed.length, preview: trimmed.slice(0, 200) });
          recordTrace({ routingPath: 'registry', rawInput: content, action: 'list_dir', success: true });
          stats.lastCommand = { action: 'list_dir', timestamp: new Date().toISOString(), success: true };
          return { recipient: sender, content: trimmed || 'Command ran but returned no output', replyTo: message.id };
        } catch (e: unknown) {
          const err = e as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
          const code = err?.code ?? '';
          const msg = err instanceof Error ? err.message : String(e);
          const stderr = err?.stderr ?? '';
          const combined = `${msg} ${stderr}`.trim();
          let userMsg: string;
          if (code === 'ETIMEDOUT' || err?.killed === true || /timed out/i.test(msg)) {
            userMsg = 'Error: Command timed out';
          } else if (code === 'ENOENT' && /spawn|not found|enoent/i.test(msg)) {
            userMsg = 'Error: Command not found: ls';
          } else if (code === 'EACCES' || /permission denied/i.test(combined)) {
            userMsg = `Error: Permission denied accessing ${abs}`;
          } else if (code === 'ENOENT' || /no such file|not found/i.test(combined)) {
            userMsg = `Error: Path not found: ${abs}`;
          } else {
            userMsg = `Error: Failed to list directory — ${msg}`;
          }
          logger.warn('[list_dir] ls failed', { command: cmd, code, msg });
          recordTrace({ routingPath: 'registry', rawInput: content, action: 'list_dir', success: false });
          return { recipient: sender, content: userMsg, replyTo: message.id };
        }
      }
    }

    // Homelab report — run real report (getDashboardStatus + collectors), not LLM
    const homelabReportPhrase = new RegExp('^(?:(?:give\\s+me\\s+(?:a\\s+)?|run\\s+(?:a\\s+)?)?)?(?:homelab|home\\s+lab)\\s+report|report\\s+(?:on\\s+)?(?:the\\s+)?(?:homelab|home\\s+lab)|what[\\x27]?s\\s+connected|what\\s+needs\\s+setup|what\\s+needs\\s+api\\s+added|(?:homelab|home\\s+lab)\\s+overview$', 'i').test(primaryCommand.trim());
    if (homelabReportPhrase) {
      logger.info('Homelab report fast path');
      const intent: ParsedIntent = { action: 'homelab_report', confidence: 1.0, resolutionMethod: 'pattern', estimatedCost: 0 };
      const result = await executeCommand(intent as ParsedIntent);
      recordTrace({ routingPath: 'registry', rawInput: content, action: 'homelab_report', success: result.success });
      stats.lastCommand = { action: 'homelab_report', timestamp: new Date().toISOString(), success: result.success };
      return { recipient: sender, content: formatResponse(intent as ParsedIntent, result), replyTo: message.id, attachments: result.attachments };
    }
    
    // ==========================================
    // MEDIA DOWNLOAD FROM IMAGE (screenshot/list photo)
    // ==========================================
    const hasImageAttachment = message.attachments?.some(a => a.type === 'image' && (a.path || a.data));
    const downloadFromImageText = /^(?:download|get|grab|add)\s*(these|this|from\s*(?:this|the)\s*(?:list|screenshot|image|photo)?|the\s*list)?\.?$/i.test(primaryCommand.trim())
      || /^(?:download|get|grab|add)\s*$/i.test(primaryCommand.trim())
      || primaryCommand.trim().length === 0;
    if (hasImageAttachment && downloadFromImageText) {
      logger.info('Media download from image — extracting list and downloading');
      const intent: ParsedIntent = {
        action: 'media_download_from_image',
        confidence: 1.0,
        resolutionMethod: 'pattern',
        estimatedCost: 0,
        message: content,
      };
      (intent as ParsedIntent & { attachments?: Array<{ path?: string; data?: string; name?: string; mimeType?: string }> }).attachments = message.attachments!
        .filter(a => a.type === 'image')
        .map(a => ({ path: a.path, data: a.data, name: a.name, mimeType: a.mimeType }));
      const result = await executeCommand(intent as ParsedIntent);
      stats.lastCommand = { action: 'media_download_from_image', timestamp: new Date().toISOString(), success: result.success };
      return { recipient: sender, content: formatResponse(intent as ParsedIntent, result), replyTo: message.id, attachments: result.attachments };
    }

    // ==========================================
    // CURSOR AGENT FAST PATH (skip cognitive layer)
    // ==========================================

    // 1. Cursor confirmation: "go" / "yes" / "do it" when awaiting cursor plan approval
    //    Bypass parseIntent entirely — it would misroute to approvePlan/agent_ask
    if (awaitingCursorConfirmation && /^(go|yes|do\s+it|confirm|launch|execute|send\s+it|approved?)$/i.test(content.trim())) {
      logger.info('Cursor confirm fast path — launching agent');
      awaitingCursorConfirmation = false;
      try {
        const { confirmAndLaunch } = await import('../integrations/cursor-orchestrator.js');
        const result = await confirmAndLaunch();
        stats.lastCommand = { action: 'cursor_confirm', timestamp: new Date().toISOString(), success: result.success };
        return { recipient: sender, content: result.message, replyTo: message.id };
      } catch (err) {
        logger.error('Cursor confirm failed', { error: String(err) });
        return { recipient: sender, content: `Failed to launch Cursor agent: ${err}`, replyTo: message.id };
      }
    }

    // 2. PRD Builder session routing
    //    When an active PRD session exists, ALL messages route through it
    //    (unless they're cursor commands or explicit cancellation)
    {
      const { getActiveSession, addMessage: prdAddMessage, isFinalizationIntent, isCancellationIntent, cancelSession, getAndClearFinalizedPrd } = await import('../integrations/prd-builder.js');
      const prdSession = getActiveSession();

      if (prdSession) {
        // Check for cancellation
        if (isCancellationIntent(content)) {
          const msg = cancelSession();
          stats.lastCommand = { action: 'prd_cancel', timestamp: new Date().toISOString(), success: true };
          return { recipient: sender, content: msg, replyTo: message.id };
        }

        // Check for finalization intent — send it through the builder
        // which will trigger Claude to emit <finalize/>
        if (isFinalizationIntent(content)) {
          logger.info('PRD finalization intent detected');
        }

        // Route through PRD builder
        logger.info('PRD session active — routing message', { session: prdSession.id });
        const response = await prdAddMessage(content);

        // Check if the builder signaled finalization
        if (response === '__PRD_FINALIZED__') {
          const finalized = getAndClearFinalizedPrd();
          if (finalized) {
            try {
              const { createNewProject } = await import('../integrations/cursor-orchestrator.js');
              const result = await createNewProject(finalized.projectName, finalized.prd);
              if (result.success) awaitingCursorConfirmation = true;
              stats.lastCommand = { action: 'new_project', timestamp: new Date().toISOString(), success: result.success };
              return { recipient: sender, content: result.message, replyTo: message.id };
            } catch (err) {
              return { recipient: sender, content: `PRD finalized but failed to create project: ${err}`, replyTo: message.id };
            }
          }
        }

        stats.lastCommand = { action: 'prd_builder', timestamp: new Date().toISOString(), success: true };
        return { recipient: sender, content: response, replyTo: message.id };
      }
    }

    // 2b. New project creation — starts a conversational PRD session
    //     "new project <name>" kicks off the PRD builder
    //     One-shot with inline PRD still supported for pre-written PRDs
    const newProjectMatch = content.trim().match(/^(?:new|create|start|init)\s+project\s+(\S+)(?:\s*\n([\s\S]+))?/i);
    if (newProjectMatch) {
      logger.info('New project — starting PRD session', { content: content.substring(0, 50) });
      const projectName = newProjectMatch[1].trim();
      const inlinePrd = newProjectMatch[2]?.trim();

      // If a full PRD is provided inline (>200 chars), skip the conversation
      if (inlinePrd && inlinePrd.length > 200) {
        try {
          const { createNewProject } = await import('../integrations/cursor-orchestrator.js');
          const result = await createNewProject(projectName, inlinePrd);
          if (result.success) awaitingCursorConfirmation = true;
          stats.lastCommand = { action: 'new_project', timestamp: new Date().toISOString(), success: result.success };
          return { recipient: sender, content: result.message, replyTo: message.id };
        } catch (err) {
          return { recipient: sender, content: `Failed to create project: ${err}`, replyTo: message.id };
        }
      }

      // Start conversational PRD builder
      try {
        const { startSession } = await import('../integrations/prd-builder.js');
        const response = await startSession(projectName, inlinePrd || undefined);
        stats.lastCommand = { action: 'prd_builder_start', timestamp: new Date().toISOString(), success: true };
        return { recipient: sender, content: response, replyTo: message.id };
      } catch (err) {
        return { recipient: sender, content: `Failed to start PRD session: ${err}`, replyTo: message.id };
      }
    }

    // ==========================================
    // CLIENT & REVENUE FAST PATHS
    // ==========================================

    // "new client <name>" — start SaaS builder
    const newClientMatch = content.trim().match(/^(?:new|create|add)\s+client\s+(.+)/i);
    if (newClientMatch) {
      logger.info('New client fast path', { content: content.substring(0, 50) });
      try {
        const { createClientFromInput } = await import('../capabilities/saas-builder/client-template.js');
        const { addClient } = await import('../capabilities/saas-builder/client-registry.js');
        const { deployClientSite } = await import('../capabilities/saas-builder/deploy-pipeline.js');

        // Parse: "new client Pacific Divers, Kona HI, dive shop, courses charters rentals"
        const parts = newClientMatch[1].split(',').map((s: string) => s.trim());
        const businessName = parts[0] || 'Unnamed';
        const location = parts[1] || 'Unknown';
        const businessType = (parts[2]?.toLowerCase().includes('resort') ? 'resort'
          : parts[2]?.toLowerCase().includes('liveaboard') ? 'liveaboard'
          : parts[2]?.toLowerCase().includes('instructor') ? 'instructor'
          : 'dive_shop') as import('../capabilities/saas-builder/client-template.js').BusinessType;
        const services = parts.slice(3).flatMap((s: string) => s.split(/\s+/));

        const client = createClientFromInput(businessName, location, businessType, services.length > 0 ? services : ['diving']);
        addClient(client);

        // Launch deployment pipeline asynchronously
        deployClientSite(client).then(result => {
          logger.info('Client deployment result', { success: result.success, client: client.slug });
        }).catch(err => {
          logger.error('Client deployment failed', { error: String(err), client: client.slug });
        });

        stats.lastCommand = { action: 'new_client', timestamp: new Date().toISOString(), success: true };
        return {
          recipient: sender,
          content: `Client "${businessName}" created.\nRepo: diveconnect-${client.slug}\nSubdomain: ${client.subdomain}\nDeployment pipeline started. I'll keep you posted.`,
          replyTo: message.id
        };
      } catch (err) {
        return { recipient: sender, content: `Failed to create client: ${err}`, replyTo: message.id };
      }
    }

    // "evaluate gig <description>" or "got a gig <description>"
    const gigMatch = content.trim().match(/^(?:evaluate\s+gig|got\s+a?\s*gig|analyze\s+gig|new\s+gig)[:\s]+(.+)/is);
    if (gigMatch) {
      logger.info('Gig evaluation fast path');
      try {
        const { evaluateGig } = await import('../capabilities/revenue/freelance-handler.js');
        const analysis = await evaluateGig(gigMatch[1].trim());
        const response = `Analyzed. ${analysis.canBuild ? 'This is buildable.' : 'Outside our stack.'}\n\n` +
          `Can build: ${analysis.canBuild ? 'Yes' : 'No'}\n` +
          `Template: ${analysis.template}\n` +
          `Estimated time: ~${analysis.estimatedHours}h\n` +
          `API cost: ~$${analysis.estimatedCost.toFixed(2)}\n` +
          `Suggested price: $${analysis.suggestedPrice}\n` +
          `Profit margin: ${analysis.profitMargin}\n` +
          `Risks: ${analysis.risks.join(', ') || 'None identified'}\n\n` +
          `Recommendation: ${analysis.recommendation}\n\n` +
          `Say "build it" and I'll start.`;
        stats.lastCommand = { action: 'evaluate_gig', timestamp: new Date().toISOString(), success: true };
        return { recipient: sender, content: response, replyTo: message.id };
      } catch (err) {
        return { recipient: sender, content: `Failed to evaluate gig: ${err}`, replyTo: message.id };
      }
    }

    // "scout status" / "daily briefing" / "scout digest"
    const scoutMatch = /^(?:scout\s+(?:status|digest|briefing|report)|daily\s+(?:briefing|digest|report)|what'?s?\s+(?:new|the\s+news))/i.test(content.trim());
    if (scoutMatch) {
      logger.info('Scout fast path');
      try {
        const { getDigest } = await import('../capabilities/scout/digest.js');
        const { getScoutStatus } = await import('../capabilities/scout/loop.js');
        const status = getScoutStatus();
        const digest = getDigest();
        const response = digest || 'No findings in the digest queue yet.';
        const footer = `\nSources: ${status.sources} | Last run: ${status.lastLoopRun || 'never'} | Findings: ${status.findings}`;
        stats.lastCommand = { action: 'scout_status', timestamp: new Date().toISOString(), success: true };
        return { recipient: sender, content: response + footer, replyTo: message.id };
      } catch (err) {
        return { recipient: sender, content: `Scout not available: ${err}`, replyTo: message.id };
      }
    }

    // Questions about specific security events: "what's up with v0-sentinel", "why is X critical", "investigate v0-sentinel"
    const securityQuestionMatch = content.trim().match(/(?:what'?s?\s+(?:up|wrong|going\s+on)\s+with|why\s+is|investigate|explain|look\s+(?:at|into))\s+(.+?)(?:\s+(?:critical|error|down|issue|alert).*)?$/i);
    if (securityQuestionMatch) {
      const subject = securityQuestionMatch[1].trim().replace(/[?!.,]+$/, '');
      
      // Check if this matches a known Vercel project or security event
      try {
        const { getSecurityDashboard, getSecurityEvents } = await import('../capabilities/security/monitor.js');
        const dashboard = getSecurityDashboard();
        
        // Find matching project
        const project = dashboard.projects.find(p => 
          p.projectName.toLowerCase().includes(subject.toLowerCase()) ||
          p.projectId.toLowerCase().includes(subject.toLowerCase())
        );
        
        if (project) {
          // Get recent events for this project
          const allEvents = getSecurityEvents(50);
          const projectEvents = allEvents.filter(e => 
            e.projectId === project.projectId || e.projectName === project.projectName
          ).slice(0, 5);
          
          const lines = [
            `${project.projectName}: ${project.status.toUpperCase()}`,
            `Error rate: ${project.errorRate}% | Response time: ${project.responseTime}ms`,
            `Domain: ${project.domain || 'none'}`,
            `Last checked: ${project.lastChecked}`,
          ];
          
          if (project.errorRate > 0) {
            // Explain what the error rate means
            lines.push('');
            if (project.errorRate === 10) {
              lines.push('10% error rate means 1 out of last 10 deployments has status ERROR.');
              lines.push('This is a deployment-level metric, not live traffic errors.');
            } else {
              lines.push(`${project.errorRate}% of recent deployments have ERROR status.`);
            }
          }
          
          if (project.responseTime === 0) {
            lines.push('0ms response time means analytics data is not available for this project (may require Vercel Pro).');
          }
          
          if (projectEvents.length > 0) {
            lines.push('');
            lines.push(`Recent events (${projectEvents.length}):`);
            for (const ev of projectEvents.slice(0, 3)) {
              const time = new Date(ev.timestamp).toLocaleTimeString();
              lines.push(`  [${time}] ${ev.type} — ${ev.message}`);
              if (ev.autoActionsTaken.length > 0) {
                lines.push(`    Actions: ${ev.autoActionsTaken.join(', ')}`);
              }
            }
          }
          
          lines.push('');
          lines.push('Options: "fix it" to create a task, "mute alerts for v0-sentinel" to silence, or "security status" for full dashboard.');
          
          stats.lastCommand = { action: 'security_investigate', timestamp: new Date().toISOString(), success: true };
          return { recipient: sender, content: lines.join('\n'), replyTo: message.id };
        }
      } catch {
        // Security monitor not loaded — fall through to cognitive layer
      }
    }

    // "security status" / "security overview"
    const secStatusMatch = /^(?:security\s+(?:status|overview|dashboard|report)|vercel\s+security)/i.test(content.trim());
    if (secStatusMatch) {
      logger.info('Security status fast path');
      try {
        const { getSecurityDashboard } = await import('../capabilities/security/monitor.js');
        const dashboard = getSecurityDashboard();
        const lines = [
          `Security Overview:`,
          `Projects monitored: ${dashboard.portfolio.totalProjects}`,
          `All healthy: ${dashboard.portfolio.allHealthy ? 'Yes' : 'NO'}`,
          `Blocked today: ${dashboard.portfolio.totalBlocked}`,
          `Incidents (24h): ${dashboard.portfolio.incidents24h}`,
        ];
        if (dashboard.projects.length > 0) {
          lines.push('', 'Per-project:');
          for (const p of dashboard.projects) {
            lines.push(`  ${p.projectName}: ${p.status.toUpperCase()} | ${p.errorRate}% err | ${p.responseTime}ms`);
          }
        }
        stats.lastCommand = { action: 'security_status', timestamp: new Date().toISOString(), success: true };
        return { recipient: sender, content: lines.join('\n'), replyTo: message.id };
      } catch (err) {
        return { recipient: sender, content: `Security monitor not available: ${err}`, replyTo: message.id };
      }
    }

    // ==========================================
    // SELF-IMPROVEMENT FAST PATHS
    // ==========================================

    // "suggest improvements" / "what would you improve" / "improvement proposals" / "pitch me"
    const proposalMatch = /^(?:suggest\s+improvement|improvement\s+proposals?|what\s+would\s+you\s+improve|pitch\s+me|self.?improve|what\s+do\s+you\s+want\s+to\s+(?:build|add|improve)|your\s+ideas)/i.test(content.trim());
    if (proposalMatch) {
      logger.info('Self-improvement proposals fast path');
      try {
        const { generateProposals, getProposalStatus } = await import('../capabilities/self/proposals.js');
        const proposals = await generateProposals();
        const status = getProposalStatus();

        if (proposals.length === 0) {
          stats.lastCommand = { action: 'self_proposals', timestamp: new Date().toISOString(), success: true };
          return { recipient: sender, content: 'No proposals available yet. I\'ll generate some ideas shortly.', replyTo: message.id };
        }

        const lines = [`Here are my 3 improvement proposals for today:\n`];
        proposals.forEach((p, i) => {
          lines.push(`${i + 1}. **${p.title}** [${p.category}/${p.estimatedComplexity}]`);
          lines.push(`   ${p.description}`);
          lines.push(`   _${p.rationale}_\n`);
        });

        if (status.canApprove) {
          lines.push('Reply "approve 1", "approve 2", or "approve 3" to pick one. Max 1 per day.');
        } else {
          lines.push('Already approved one today. New proposals tomorrow.');
        }

        stats.lastCommand = { action: 'self_proposals', timestamp: new Date().toISOString(), success: true };
        return { recipient: sender, content: lines.join('\n'), replyTo: message.id };
      } catch (err) {
        return { recipient: sender, content: `Failed to generate proposals: ${err}`, replyTo: message.id };
      }
    }

    // "approve 1" / "approve 2" / "approve 3" / "approve proposal X"
    const approveMatch = content.trim().match(/^approve\s+(?:proposal\s+)?(\d)/i);
    if (approveMatch) {
      logger.info('Approve proposal fast path');
      try {
        const { approveProposal } = await import('../capabilities/self/proposals.js');
        const result = await approveProposal(parseInt(approveMatch[1], 10));

        if (result.success) {
          // If a Cursor task was created, set the confirmation flag
          const { hasPendingCursorTask } = await import('../integrations/cursor-orchestrator.js');
          if (hasPendingCursorTask()) {
            awaitingCursorConfirmation = true;
          }
        }

        stats.lastCommand = { action: 'approve_proposal', timestamp: new Date().toISOString(), success: result.success };
        return { recipient: sender, content: result.message, replyTo: message.id };
      } catch (err) {
        return { recipient: sender, content: `Failed to approve: ${err}`, replyTo: message.id };
      }
    }

    // "reject 1" / "reject proposal 2" / "pass on all"
    const rejectMatch = content.trim().match(/^(?:reject|pass\s+on)\s+(?:proposal\s+)?(\d|all)/i);
    if (rejectMatch) {
      logger.info('Reject proposal fast path');
      try {
        const { rejectProposal, getCurrentProposals } = await import('../capabilities/self/proposals.js');
        if (rejectMatch[1] === 'all') {
          const proposals = getCurrentProposals();
          proposals.forEach((_, i) => rejectProposal(i + 1));
          stats.lastCommand = { action: 'reject_proposals', timestamp: new Date().toISOString(), success: true };
          return { recipient: sender, content: 'Rejected all proposals. Fresh batch tomorrow.', replyTo: message.id };
        }
        const result = rejectProposal(parseInt(rejectMatch[1], 10));
        stats.lastCommand = { action: 'reject_proposal', timestamp: new Date().toISOString(), success: result.success };
        return { recipient: sender, content: result.message, replyTo: message.id };
      } catch (err) {
        return { recipient: sender, content: `Failed to reject: ${err}`, replyTo: message.id };
      }
    }

    // "update yourself" / "pull and restart" / "self update" / "force update" / "update status"
    const updateMatch = content.trim().match(/^(?:update\s+yourself|self[- ]?update|pull\s+and\s+restart|update\s+jeeves|upgrade\s+yourself|check\s+for\s+updates?|update\s+status|force\s+update|force\s+pull)/i);
    if (updateMatch) {
      logger.info('Self-update fast path');
      try {
        const { checkForUpdates, pullAndRestart, getUpdateStatus } = await import('../capabilities/self/updater.js');

        // If "update status" just show status
        if (/status/i.test(updateMatch[0]) && !/force/i.test(updateMatch[0])) {
          const s = getUpdateStatus();
          const lines = [
            `Self-update status:`,
            `Auto-update: ${s.autoUpdateEnabled ? 'ON' : 'OFF'}`,
            `Last check: ${s.lastCheck || 'never'}`,
            `Local HEAD: ${s.localHead?.substring(0, 8) || 'unknown'}`,
            `Remote HEAD: ${s.remoteHead?.substring(0, 8) || 'unknown'}`,
            `Behind: ${s.behind} commits`,
            s.updateInProgress ? 'UPDATE IN PROGRESS' : '',
            s.lastError ? `Last error: ${s.lastError}` : '',
          ].filter(Boolean);
          stats.lastCommand = { action: 'update_status', timestamp: new Date().toISOString(), success: true };
          return { recipient: sender, content: lines.join('\n'), replyTo: message.id };
        }

        const isForce = /force/i.test(updateMatch[0]);

        // Check for updates first
        const status = await checkForUpdates();
        if (status.behind === 0) {
          stats.lastCommand = { action: 'self_update', timestamp: new Date().toISOString(), success: true };
          return { recipient: sender, content: `Already up to date. HEAD: ${status.localHead.substring(0, 8)}`, replyTo: message.id };
        }

        // Pull and restart (force bypasses local changes + active task checks)
        const result = await pullAndRestart({ force: isForce });
        stats.lastCommand = { action: 'self_update', timestamp: new Date().toISOString(), success: result.success };
        return { recipient: sender, content: result.message, replyTo: message.id };
      } catch (err) {
        return { recipient: sender, content: `Self-update failed: ${err}`, replyTo: message.id };
      }
    }

    // "merge it" / "merge PR" / "merge the PR" — manual PR merge
    const mergeMatch = content.trim().match(/^(?:merge\s+(?:it|the\s+pr|pr|that)|do\s+the\s+merge)(?:\s+(.+))?/i);
    if (mergeMatch) {
      logger.info('Manual merge fast path');
      try {
        const { manualMerge } = await import('../integrations/cursor-refinement.js');
        const target = mergeMatch[1]?.trim() || '';
        
        if (!target) {
          // Try to find the most recent ready-to-merge task
          const { getCompletedCursorTasks } = await import('../integrations/cursor-orchestrator.js');
          const recent = getCompletedCursorTasks(5);
          const withPr = recent.find(t => t.prUrl);
          if (withPr?.prUrl) {
            const result = await manualMerge(withPr.prUrl);
            stats.lastCommand = { action: 'merge_pr', timestamp: new Date().toISOString(), success: result.success };
            return { recipient: sender, content: result.message, replyTo: message.id };
          }
          return { recipient: sender, content: 'No recent PR to merge. Specify a PR URL or task ID.', replyTo: message.id };
        }
        
        const result = await manualMerge(target);
        stats.lastCommand = { action: 'merge_pr', timestamp: new Date().toISOString(), success: result.success };
        return { recipient: sender, content: result.message, replyTo: message.id };
      } catch (err) {
        return { recipient: sender, content: `Merge failed: ${err}`, replyTo: message.id };
      }
    }

    // "cost report" / "cost analysis" / "spending review"
    const costReportMatch = /^(?:cost\s+(?:report|analysis|review|breakdown)|spending\s+(?:report|review)|how\s+much\s+(?:am\s+I|are\s+we)\s+spending)/i.test(content.trim());
    if (costReportMatch) {
      logger.info('Cost report fast path');
      try {
        const { getLatestReport, formatCostReport, runCostReview } = await import('../capabilities/revenue/cost-advisor.js');
        let report = getLatestReport();
        if (!report) {
          await runCostReview();
          report = getLatestReport();
        }
        const text = report ? formatCostReport(report) : 'No cost data available yet.';
        stats.lastCommand = { action: 'cost_report', timestamp: new Date().toISOString(), success: true };
        return { recipient: sender, content: text, replyTo: message.id };
      } catch (err) {
        return { recipient: sender, content: `Cost report unavailable: ${err}`, replyTo: message.id };
      }
    }

    // "uptime" / "site status" / "are sites up"
    const uptimeMatch = /^(?:uptime|site\s+status|are\s+(?:sites?|clients?)\s+(?:up|online|running)|client\s+uptime)/i.test(content.trim());
    if (uptimeMatch) {
      logger.info('Uptime fast path');
      try {
        const { getUptimeStatus } = await import('../capabilities/security/uptime.js');
        const statuses = getUptimeStatus();
        if (statuses.length === 0) {
          return { recipient: sender, content: 'No client sites being monitored yet.', replyTo: message.id };
        }
        const lines = ['Client Site Uptime:'];
        for (const s of statuses) {
          lines.push(`${s.currentlyUp ? 'UP' : 'DOWN'} ${s.clientName} (${s.url}) — ${s.uptime24h}% uptime, ${s.avgResponseTime}ms avg`);
        }
        stats.lastCommand = { action: 'uptime_status', timestamp: new Date().toISOString(), success: true };
        return { recipient: sender, content: lines.join('\n'), replyTo: message.id };
      } catch (err) {
        return { recipient: sender, content: `Uptime data unavailable: ${err}`, replyTo: message.id };
      }
    }

    // "changelog" / "what changed in X"
    const changelogMatch = content.trim().match(/^(?:changelog|what\s+changed\s+(?:in|for|on)\s+(.+)|show\s+changelog\s+(?:for\s+)?(.+))/i);
    if (changelogMatch) {
      logger.info('Changelog fast path');
      try {
        const { getChangelog } = await import('../capabilities/self/changelog.js');
        const project = (changelogMatch[1] || changelogMatch[2] || '').trim().toLowerCase().replace(/\s+/g, '-');
        if (!project) {
          return { recipient: sender, content: 'Which project? Try "changelog for dive-connect"', replyTo: message.id };
        }
        const log = getChangelog(project);
        // Truncate if too long for Signal
        const text = log.length > 3000 ? log.substring(0, 3000) + '\n\n... (truncated)' : log;
        stats.lastCommand = { action: 'changelog', timestamp: new Date().toISOString(), success: true };
        return { recipient: sender, content: text, replyTo: message.id };
      } catch (err) {
        return { recipient: sender, content: `Changelog unavailable: ${err}`, replyTo: message.id };
      }
    }

    const LLM_ROUTED_ACTIONS = ['agent_ask', 'feedback', 'approvePlan', 'rejectPlan', 'showPlan'] as const;

    // 2c. Layer 3: Pending fuzzy confirmation — user said "yes" to "Did you mean X?"
    const pending = pendingFuzzyConfirm.get(sender);
    if (pending && /^(yes|y|yeah|yep|confirm|do it|run it)$/i.test(content.trim())) {
      const age = Date.now() - pending.timestamp;
      if (age < PENDING_FUZZY_TTL_MS) {
        pendingFuzzyConfirm.delete(sender);
        const resolved = matchCommand(pending.suggestion);
        if (resolved && !LLM_ROUTED_ACTIONS.includes(resolved.action as (typeof LLM_ROUTED_ACTIONS)[number])) {
          await addAlias(pending.originalPhrase, pending.commandId);
          logger.info('Fuzzy confirm — executing and learned alias', { phrase: pending.originalPhrase, commandId: pending.commandId });
          const intent = matchResultToParsedIntent(resolved);
          const result = await executeCommand(intent as ParsedIntent);
          stats.lastCommand = { action: resolved.action, timestamp: new Date().toISOString(), success: result.success };
          recordTrace({ routingPath: 'registry', rawInput: content, classification: pending.commandId, confidenceScore: 1, action: String(resolved.action), success: result.success });
          return { recipient: sender, content: formatResponse(intent as ParsedIntent, result), replyTo: message.id, attachments: result.attachments };
        }
      } else {
        pendingFuzzyConfirm.delete(sender);
      }
    }

    // 2d. Layer 2: Command registry — execute if high-confidence match and not LLM-routed
    if (registryMatch && registryMatch.confidence >= 0.9 && !LLM_ROUTED_ACTIONS.includes(registryMatch.action as (typeof LLM_ROUTED_ACTIONS)[number])) {
      logger.info('Registry match — executing', { commandId: registryMatch.commandId, action: registryMatch.action });
      const intent = matchResultToParsedIntent(registryMatch);
      // Override: "find features" (etc.) with active project → agent_ask (codebase search), not media search
      const CODEBASE_SEARCH_TERMS = new Set(['features', 'bugs', 'todos', 'api', 'config', 'handlers', 'routes', 'tests', 'hooks', 'utils', 'types']);
      if (registryMatch.action === 'media_search' && activeProject) {
        const target = String((intent as ParsedIntent).target ?? (registryMatch as { params?: { target?: string } }).params?.target ?? '').trim().toLowerCase();
        const singleWord = target.split(/\s+/)[0];
        if (singleWord && CODEBASE_SEARCH_TERMS.has(singleWord)) {
          logger.info('Media search overridden to agent_ask (active project + codebase term)', { target: singleWord });
          const agentIntent: ParsedIntent = {
            action: 'agent_ask',
            prompt: content,
            confidence: 0.95,
            resolutionMethod: 'pattern',
            estimatedCost: 0,
          };
          if (BRAIN2_WHITELIST.has('agent_ask')) {
            try {
              const ctxResult = await assembleContext({
                message: content,
                action: 'agent_ask',
                target: singleWord,
                projectPath: activeProject.workingDir,
                model: 'sonnet',
              });
              if (ctxResult.layersIncluded.length > 0 || ctxResult.cachedFormatted) {
                agentIntent.assembledContext = ctxResult.cachedFormatted ?? formatContextForPrompt(ctxResult);
              }
            } catch {
              /* optional */
            }
          }
          const result = await executeCommand(agentIntent as ParsedIntent);
          stats.lastCommand = { action: 'agent_ask', timestamp: new Date().toISOString(), success: result.success };
          recordTrace({ routingPath: 'registry', rawInput: content, classification: 'media_search→agent_ask', confidenceScore: 0.95, action: 'agent_ask', success: result.success });
          let response = formatResponse(agentIntent as ParsedIntent, result);
          response = sanitizeResponse(response);
          const maxChars = getMaxChars('agent_ask', false);
          response = truncateToMaxChars(response, maxChars);
          return { recipient: sender, content: response, replyTo: message.id, attachments: result.attachments };
        }
      }
      // Redirect: "download these" / "download this" + image → use list from image, not search for "these"
      const downloadTarget = String((intent as ParsedIntent).target || (registryMatch as { params?: { target?: string } }).params?.target || '').trim();
      const isDemonstrative = /^(these|this|that|them)$/i.test(downloadTarget);
      const hasImage = message.attachments?.some(a => a.type === 'image' && (a.path || a.data));
      if (registryMatch.action === 'media_download' && hasImage && isDemonstrative) {
        logger.info('Media download from image — redirecting (download these/this + image)');
        const imageIntent: ParsedIntent = {
          action: 'media_download_from_image',
          confidence: 1.0,
          resolutionMethod: 'pattern',
          estimatedCost: 0,
          message: content,
        };
        (imageIntent as ParsedIntent & { attachments?: Array<{ path?: string; data?: string; name?: string; mimeType?: string }> }).attachments = message.attachments!
          .filter(a => a.type === 'image')
          .map(a => ({ path: a.path, data: a.data, name: a.name, mimeType: a.mimeType }));
        const result = await executeCommand(imageIntent as ParsedIntent);
        stats.lastCommand = { action: 'media_download_from_image', timestamp: new Date().toISOString(), success: result.success };
        return { recipient: sender, content: formatResponse(imageIntent as ParsedIntent, result), replyTo: message.id, attachments: result.attachments };
      }
      if (registryMatch.action === 'media_download' && !hasImage && isDemonstrative) {
        const help = "Send the list as a photo in the same message as “download these” so I can read it and add the items.";
        return { recipient: sender, content: help, replyTo: message.id };
      }
      if (message.attachments?.length && registryMatch.action === 'cursor_launch') {
        const imgs = message.attachments.filter(a => a.type === 'image' && a.data).map(a => ({ name: a.name || 'image', data: a.data!, mimeType: a.mimeType }));
        if (imgs.length) (intent as ParsedIntent & { attachments?: unknown[] }).attachments = imgs;
      }
      const result = await executeCommand(intent as ParsedIntent);
      if (registryMatch.action === 'cursor_launch' && result.success) {
        awaitingCursorConfirmation = true;
        logger.info('Cursor plan created — awaiting confirmation');
      }
      stats.lastCommand = { action: registryMatch.action, timestamp: new Date().toISOString(), success: result.success };
      recordTrace({ routingPath: 'registry', rawInput: content, classification: registryMatch.commandId, confidenceScore: registryMatch.confidence, action: String(registryMatch.action), success: result.success });
      return { recipient: sender, content: formatResponse(intent as ParsedIntent, result), replyTo: message.id, attachments: result.attachments };
    }

    // 2e. Layer 3: Fuzzy match — only for genuinely ambiguous input; clear questions get direct answers (no "Did you mean?")
    if (!registryMatch) {
      const skipFuzzy = isClearQuestionOrStatement(primaryCommand);
      if (!skipFuzzy) {
        const fuzzy = fuzzyMatch(primaryCommand);
        if (fuzzy) {
          pendingFuzzyConfirm.set(sender, {
            originalPhrase: primaryCommand,
            suggestion: fuzzy.suggestion,
            commandId: fuzzy.commandId,
            timestamp: Date.now(),
          });
          logger.info('Fuzzy match — awaiting confirmation', { phrase: primaryCommand.substring(0, 40), suggestion: fuzzy.suggestion });
          recordTrace({ routingPath: 'fuzzy_pending', rawInput: content, classification: fuzzy.commandId, confidenceScore: fuzzy.confidence, action: 'fuzzy_suggest' });
          return { recipient: sender, content: `Did you mean: ${fuzzy.suggestion}? Reply yes to run.`, replyTo: message.id };
        }
      }
    }

    // ==========================================
    // CONVERSATIONAL FAST PATH
    // ==========================================
    // Commands already consumed by registry/fuzzy. Short casual messages go to conversational LLM.
    {
      const trimmed = content.trim();
      const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
      const casualPattern = /^(hey|hi|hello|yo|sup|thanks|thank\s+you|ok(ay)?|cool|great|nice|cheers|haha|lol|wow|good\s+(morning|afternoon|night)|(how|hwo)\s+are\s+you|what'?s\s+up|got\s+it|understood|love\s+it|never\s*mind|nah)$/i;
      const isConversational = wordCount <= 8 && casualPattern.test(trimmed);

      if (isConversational) {
        logger.info('Conversational fast path', { content: trimmed.substring(0, 50) });

        // Budget check
        const { enforceBudget, recordFeatureUsage, recordLLMFailure, getFeatureMaxTokens } = await import('./cost-tracker.js');
        const budgetCheck = enforceBudget('conversation');
        if (!budgetCheck.allowed) {
          recordTrace({ routingPath: 'conversational', rawInput: trimmed, action: 'refuse', success: false });
          logger.debug('Conversational budget blocked', { reason: budgetCheck.reason });
          return { recipient: sender, content: budgetCheck.reason || 'Budget limit reached.', replyTo: message.id };
        }

        try {
          const { generateText } = await import('ai');
          const { createAnthropic } = await import('@ai-sdk/anthropic');
          const provider = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY || '' });

          const llmStart = Date.now();
          const { text } = await generateText({
            model: provider(config.claude.haiku_model),
            system: `${PERSONALITY_RULES}

Matt's actual setup (ONLY reference these, never invent others):
- Beelink mini-PC, Intel N150, 16GB RAM, Ubuntu 24.04
- 98GB boot drive, 1.8TB data drive
- 23 Docker containers via docker-compose (NO Kubernetes)
- Services: Sonarr, Radarr, Jellyfin, Prowlarr, qBittorrent, Home Assistant, Grafana, Prometheus, Traefik, Pi-hole, Nextcloud, Portainer, Paperless, Vaultwarden, Uptime Kuma, Overseerr, Tautulli, Bazarr, Lidarr, NZBGet, Redis, Postgres
- Jeeves runs as a systemd service on the same box
- Cursor Background Agents handle coding tasks

- Your entire response must be under 1600 characters`,
            messages: [
              // Inject recent conversation history for context
              ...getGeneralConversations(8).map(m => ({
                role: m.role as 'user' | 'assistant',
                content: m.content
              })),
              { role: 'user' as const, content: trimmed }
            ],
            maxTokens: getFeatureMaxTokens('conversation'),
          });
          Promise.resolve().then(() => import('./profiler/performance-collector.js')).then(({ recordMetric }) => {
            recordMetric({ category: 'response_time', source: 'llm_call', metric_name: 'response_time_ms', value: Date.now() - llmStart, metadata: { model: 'haiku', call: 'conversational' } });
          }).catch(() => {});

          recordFeatureUsage('conversation', 0.001); // ~200 tokens Haiku ≈ $0.001
          recordTrace({ routingPath: 'conversational', rawInput: trimmed, action: 'chat', success: true, modelUsed: 'haiku' });
          stats.lastCommand = { action: 'conversation', timestamp: new Date().toISOString(), success: true };
          // Save both sides to conversation history
          addGeneralMessage('user', trimmed);
          addGeneralMessage('assistant', text);
          const out = text.length > 1600 ? text.slice(0, 1597) + '...' : text;
          return { recipient: sender, content: out, replyTo: message.id };
        } catch (err) {
          recordLLMFailure();
          logger.debug('Conversational response failed, falling through', { error: String(err) });
          // Fall through to cognitive layer
        }
      }
    }

    // ==========================================
    // COGNITIVE PROCESSING LAYER
    // ==========================================
    
    // Quick decision for trivial/dangerous requests
    const quickResult = quickDecision(content);
    if (quickResult && quickResult.action === 'refuse') {
      recordTrace({ routingPath: 'cognitive', rawInput: content, action: 'refuse', success: false, modelUsed: 'haiku' });
      logger.debug('Quick refuse', { reason: quickResult.response });
      return {
        recipient: sender,
        content: quickResult.response || 'Cannot process this request.',
        replyTo: message.id
      };
    }

    let cognitiveResult: Awaited<ReturnType<typeof think>> | null = null;

    // Full metacognitive processing for non-trivial requests
    if (!quickResult) {
      cognitiveResult = await think({
        message: content,
        sender,
        context: {
          projectPath: activeProject?.workingDir,
          previousMessages: getGeneralConversations(8).map(m =>
            `${m.role}: ${m.content}`
          ),
          activeTask: undefined  // TODO: Connect to task manager
        }
      });
      
      logger.debug('Cognitive decision', { 
        action: cognitiveResult.action,
        confidence: cognitiveResult.confidence.overall,
        processingTime: cognitiveResult.processingTime,
        tokensUsed: cognitiveResult.tokensUsed
      });
      
      // Handle cognitive decisions - BE PERMISSIVE
      // Only refuse for truly dangerous operations, otherwise proceed
      switch (cognitiveResult.action) {
        case 'refuse':
          // Check if this is actually dangerous (file deletion, force push, etc.)
          const isDangerous = /\b(rm\s+-rf|force\s+push|drop\s+table|delete\s+all|format\s+drive)\b/i.test(content);
          if (isDangerous) {
            recordTrace({
              routingPath: 'cognitive',
              rawInput: content,
              contextLoaded: cognitiveResult.contextResult?.layersIncluded ?? [],
              tokensUsed: cognitiveResult.tokensUsed,
              confidenceScore: cognitiveResult.confidence.overall,
              action: 'refuse',
              success: false,
              totalTime: cognitiveResult.processingTime,
            });
            const refusalMsg = cognitiveResult.response || 'Cannot perform this action.';
            addGeneralMessage('user', content);
            addGeneralMessage('assistant', refusalMsg);
            return {
              recipient: sender,
              content: refusalMsg,
              replyTo: message.id
            };
          }
          // Not actually dangerous - just proceed with a debug note
          logger.debug('Cognitive refused but proceeding (not dangerous)', { content: content.substring(0, 50) });
          break;
          
        case 'clarify':
          // Don't stop to ask - just proceed with best guess
          logger.debug('Skipping clarification, proceeding with intent', { content: content.substring(0, 50) });
          break;
          
        case 'notice':
          // Continue execution but with a notice
          logger.debug('Proceeding with notice', { notice: cognitiveResult.response });
          break;
          
        case 'proceed':
          // Continue to normal execution
          break;
      }
    }
    
    // ==========================================
    // NORMAL EXECUTION PATH
    // ==========================================
    
    // Fall back to intent parsing and execution
    const intent = await parseIntent(content);

    // Brain 2: Assemble context for whitelisted intents (agent_ask, code_review, homelab actions)
    if (BRAIN2_WHITELIST.has(intent.action)) {
      try {
        const ctxResult = await assembleContext({
          message: content,
          action: intent.action,
          target: intent.target,
          projectPath: activeProject?.workingDir,
          model: 'sonnet', // agent_ask/code_review typically use Sonnet
        });
        if (ctxResult.layersIncluded.length > 0 || ctxResult.cachedFormatted) {
          intent.assembledContext = ctxResult.cachedFormatted ?? formatContextForPrompt(ctxResult);
          logger.debug('Brain 2 context assembled', { layers: ctxResult.layersIncluded });
        }
      } catch (err) {
        logger.debug('Context assembly skipped for whitelist intent', { error: String(err) });
      }
    }

    // Attach any image attachments from the message to the intent
    if (message.attachments && message.attachments.length > 0) {
      const imageAttachments = message.attachments
        .filter(a => a.type === 'image' && a.data)
        .map(a => ({
          name: a.name || 'image',
          data: a.data!,
          mimeType: a.mimeType
        }));
      
      if (imageAttachments.length > 0) {
        intent.attachments = imageAttachments;
        logger.debug('Attached images to intent', { count: imageAttachments.length });
      }
    }
    
    // Execute the command
    const result = await executeCommand(intent);

    // Record OODA trace for cognitive or normal path
    if (cognitiveResult) {
      recordTrace({
        routingPath: 'cognitive',
        rawInput: content,
        contextLoaded: cognitiveResult.contextResult?.layersIncluded ?? [],
        tokensUsed: cognitiveResult.tokensUsed,
        classification: String(intent.action),
        confidenceScore: cognitiveResult.confidence.overall,
        action: String(intent.action),
        success: result.success,
        totalTime: cognitiveResult.processingTime,
        modelUsed: 'haiku',
        loopCount: 1,
      });
    } else {
      recordTrace({
        routingPath: 'normal',
        rawInput: content,
        classification: String(intent.action),
        confidenceScore: intent.confidence ?? 0.8,
        action: String(intent.action),
        success: result.success,
      });
    }

    // Record decision for Digital Twin learning
    try {
      const { recordDecision } = await import('../capabilities/twin/decision-recorder.js');
      recordDecision(intent.action, content.substring(0, 200), intent.action, undefined, intent.confidence);
    } catch {
      // Decision recording is optional
    }

    // Update stats
    stats.lastCommand = {
      action: intent.action,
      timestamp: new Date().toISOString(),
      success: result.success
    };
    
    // Format and return response
    let response = formatResponse(intent, result);
    response = stripStatusLinesIfChained(response);

    // Sanitize: log banned phrases (personality injection check)
    response = sanitizeResponse(response);

    // Apply length limit for LLM responses (agent_ask, conversational fallback)
    const maxChars = getMaxChars(intent.action, false);
    response = truncateToMaxChars(response, maxChars);

    // Loop detection: if same response 3+ times in last 5, replace with breaker
    const loopResult = checkForLoop(response);
    if (loopResult.isLoop && loopResult.response) {
      response = loopResult.response;
      try {
        const { recordLearning } = await import('./context/layers/learnings.js');
        recordLearning({
          category: 'loop_detected',
          trigger: content.substring(0, 200),
          rootCause: 'same_response_repeated',
          fix: 'break_loop',
          lesson: 'User received same response 3+ times; breaker fired.',
          appliesTo: 'general',
        });
      } catch {
        /* learnings optional */
      }
    }

    // Save both sides to conversation history
    addGeneralMessage('user', content);
    addGeneralMessage('assistant', response);
    
    // Periodically check for session compaction
    messagesSinceCompactionCheck++;
    if (messagesSinceCompactionCheck >= COMPACTION_CHECK_INTERVAL) {
      messagesSinceCompactionCheck = 0;
      // Run compaction asynchronously (don't block response)
      checkAndCompact().catch(err => 
        logger.debug('Compaction check failed', { error: String(err) })
      );
    }
    
    return {
      recipient: sender,
      content: response,
      replyTo: message.id,
      attachments: result.attachments
    };
    
  } catch (error) {
    logger.error('Error handling message', { error: String(error) });
    
    return {
      recipient: sender,
      content: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      replyTo: message.id
    };
  } finally {
    Promise.resolve().then(() => import('./profiler/performance-collector.js')).then(({ recordMetric }) => {
      recordMetric({ category: 'response_time', source: 'signal_handler', metric_name: 'response_time_ms', value: Date.now() - handlerStart, metadata: { success: handlerSuccess } });
    }).catch(() => {});
  }
}

/**
 * Send a response through the appropriate interface
 */
export async function sendResponse(response: OutgoingMessage, interfaceName: string): Promise<void> {
  const iface = interfaces.get(interfaceName);
  
  if (!iface) {
    logger.warn(`Interface not found: ${interfaceName}`);
    return;
  }
  
  try {
    await iface.send(response);
  } catch (error) {
    logger.error(`Failed to send via ${interfaceName}`, { error: String(error) });
  }
}
