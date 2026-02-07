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
