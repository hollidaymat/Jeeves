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

// Load workflows on module initialization
loadWorkflows().catch(err => logger.warn('Failed to load workflows', { error: String(err) }));

// Compaction check counter (run every N messages)
let messagesSinceCompactionCheck = 0;
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
