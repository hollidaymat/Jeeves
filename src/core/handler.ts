/**
 * Message Handler
 * Routes messages through cognitive processing, auth, parsing, and execution
 */

import { config } from '../config.js';
import { logger } from '../utils/logger.js';
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
    agent: getAgentStatus()
  };
}

/**
 * Format execution result as response message
 */
function formatResponse(intent: ParsedIntent, result: ExecutionResult): string {
  if (result.success) {
    return result.output || `✓ ${intent.action} completed`;
  } else {
    return `✗ ${result.error || result.output || 'Unknown error'}`;
  }
}

/**
 * Handle an incoming message
 */
export async function handleMessage(message: IncomingMessage): Promise<OutgoingMessage | null> {
  const { sender, content, interface: iface } = message;
  
  logger.debug('Received message', { sender, interface: iface, content: content.substring(0, 50) });
  
  // Authorization check
  if (!isAuthorized(sender)) {
    logger.security.unauthorized(sender);
    
    if (config.security.silent_deny) {
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
  
  // Learn from every message (non-blocking)
  import('../capabilities/self/memory-learner.js')
    .then(({ learnFromMessage }) => learnFromMessage(content))
    .catch(() => {});
  
  try {
    // Try workflow engine first (deterministic, token-efficient)
    const activeProject = getActiveProject();
    const workflowResult = await tryExecuteWorkflow(content, activeProject?.workingDir);
    
    if (workflowResult) {
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

    // 3. Cursor commands: "cursor build X", "cursor tasks", "tell cursor to Y", etc.
    //    Skip cognitive processing — these are explicit and unambiguous
    const cursorFastPath = /^(?:cursor\s+(?:build|code|implement|work\s+on|tasks?|status|agents?|repos|progress|conversation|stop)|send\s+to\s+cursor|tell\s+cursor|have\s+cursor|stop\s+cursor|cancel\s+cursor|show\s+(?:me\s+)?what\s+cursor|what'?s\s+cursor)/i.test(content.trim());
    if (cursorFastPath) {
      logger.info('Cursor fast path — skipping cognitive layer', { content: content.substring(0, 50) });
      const intent = await parseIntent(content);
      if (message.attachments?.length) {
        const imgs = message.attachments.filter(a => a.type === 'image' && a.data).map(a => ({ name: a.name || 'image', data: a.data!, mimeType: a.mimeType }));
        if (imgs.length) intent.attachments = imgs;
      }
      const result = await executeCommand(intent);

      // If the executor created a pending cursor task, set the confirmation flag
      if (intent.action === 'cursor_launch' && result.success) {
        awaitingCursorConfirmation = true;
        logger.info('Cursor plan created — awaiting confirmation');
      }

      stats.lastCommand = { action: intent.action, timestamp: new Date().toISOString(), success: result.success };
      return { recipient: sender, content: formatResponse(intent, result), replyTo: message.id };
    }

    // ==========================================
    // CONVERSATIONAL FAST PATH
    // ==========================================
    // Detect casual conversation, feedback, meta-discussion, compliments, etc.
    // Respond naturally as Jeeves — skip the expensive cognitive layer entirely.
    {
      const trimmed = content.trim();
      const lower = trimmed.toLowerCase();
      const isConversational = (
        // Short messages that aren't commands
        (trimmed.length < 200 && !/^(open|edit|fix|add|create|update|delete|run|deploy|build|push|pull|commit|install|test|scan|check|show|list|get|set|find|search)\s/i.test(trimmed)) &&
        (
          // Feedback / meta-conversation
          /\b(feedback|conversation|your\s+performance|how\s+you|about\s+you|self.?assess|pretty\s+(cool|amazing|good|great|awesome)|well\s+done|good\s+job|nice\s+work|impressed|just\s+for\s+(you|reference)|for\s+your\s+records|more\s+features?\s+for\s+you|added.*for\s+you)\b/i.test(lower) ||
          // Casual chat / greetings
          /^(hey|hi|hello|yo|sup|good\s+(morning|afternoon|evening|night)|thanks?|thank\s+you|cheers|nice|cool|great|awesome|perfect|sweet|dope|sick|brilliant|love\s+it|that'?s?\s+(it|all|great|cool|good|amazing)|no\s*,?\s*that'?s?\s*(it|all|fine|good)|never\s*mind|nah|ok(ay)?|got\s+it|understood|i\s+(see|know|understand|get\s+it)|we'?re?\s+(good|done|all\s+set)|haha|lol|wow|damn)\s*[.!]?$/i.test(lower) ||
          // Opinions / reflections (not commands)
          /^(i\s+(think|feel|believe|love|hate|like|prefer|wish|wonder|just)|that\s+(is|was|looks?|seems?|feels?)|this\s+(is|was)|it'?s?\s+(pretty|really|very|quite|so)|what\s+do\s+you\s+think|how\s+do\s+you\s+feel)/i.test(lower) ||
          // Questions about Jeeves itself
          /\b(are\s+you|do\s+you|can\s+you\s+(feel|think|learn)|what\s+are\s+you|who\s+are\s+you|tell\s+me\s+about\s+yourself)\b/i.test(lower) ||
          // Chat intent — wants to talk, not execute a command
          /\b(just\s+want(ed)?\s+to\s+(chat|talk|say|check\s+in|catch\s+up|hang)|let'?s?\s+(chat|talk|catch\s+up)|how'?s?\s+(it\s+going|everything|things|your\s+day|life)|what'?s?\s+(up|new|good|happening|going\s+on)|how\s+are\s+you|you\s+good|what\s+have\s+you\s+been|been\s+up\s+to|having\s+a\s+good|you\s+there|you\s+around|you\s+busy)\b/i.test(lower) ||
          // Short non-command messages (< 60 chars, no command-like structure)
          (trimmed.length < 60 && !/[.]\s*\w/.test(trimmed) && !/^(status|help|trust|projects?|homelab|security|scout|uptime|cost|changelog|merge|approve|reject|suggest|briefing)/i.test(lower))
        )
      );

      if (isConversational) {
        logger.info('Conversational fast path', { content: trimmed.substring(0, 50) });

        // Budget check
        const { enforceBudget, recordFeatureUsage, recordLLMFailure, getFeatureMaxTokens } = await import('./cost-tracker.js');
        const budgetCheck = enforceBudget('conversation');
        if (!budgetCheck.allowed) {
          logger.debug('Conversational budget blocked', { reason: budgetCheck.reason });
          return { recipient: sender, content: budgetCheck.reason || 'Budget limit reached.', replyTo: message.id };
        }

        try {
          const { generateText } = await import('ai');
          const { createAnthropic } = await import('@ai-sdk/anthropic');
          const provider = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY || '' });

          const { text } = await generateText({
            model: provider(config.claude.haiku_model),
            system: `You are Jeeves — a sharp, dry-witted AI butler and engineering partner. You speak naturally and conversationally, like a trusted colleague who happens to be brilliant.

Personality:
- Confident but not arrogant. Warm but concise.
- British butler sensibility — composed, understated humor, occasionally wry
- You genuinely care about doing good work and your employer's success
- You NEVER use bullet points, numbered lists, or headers in casual conversation
- You NEVER say "Self-Assessment:" or break things into categories when chatting
- You speak in natural paragraphs, like a real person
- Keep responses to 1-3 sentences for casual chat, longer only if asked to elaborate
- You can accept compliments gracefully without being sycophantic
- When given feedback, acknowledge it naturally and briefly

Context: You manage a homelab, build projects, and delegate coding tasks to Cursor Background Agents. Your employer is Matt.`,
            messages: [{ role: 'user', content: trimmed }],
            maxTokens: getFeatureMaxTokens('conversation'),
          });

          recordFeatureUsage('conversation', 0.001); // ~200 tokens Haiku ≈ $0.001
          stats.lastCommand = { action: 'conversation', timestamp: new Date().toISOString(), success: true };
          return { recipient: sender, content: text, replyTo: message.id };
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
      logger.debug('Quick refuse', { reason: quickResult.response });
      return {
        recipient: sender,
        content: quickResult.response || 'Cannot process this request.',
        replyTo: message.id
      };
    }
    
    // Full metacognitive processing for non-trivial requests
    if (!quickResult) {
      const cognitiveResult = await think({
        message: content,
        sender,
        context: {
          projectPath: activeProject?.workingDir,
          previousMessages: [],  // TODO: Connect to session history
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
            return {
              recipient: sender,
              content: cognitiveResult.response || 'Cannot perform this action.',
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
    const response = formatResponse(intent, result);
    
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
      replyTo: message.id
    };
    
  } catch (error) {
    logger.error('Error handling message', { error: String(error) });
    
    return {
      recipient: sender,
      content: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      replyTo: message.id
    };
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
