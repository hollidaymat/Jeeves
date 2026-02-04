/**
 * Message Handler
 * Routes messages through auth, parsing, and execution
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
    last_command: stats.lastCommand || undefined
  };
}

/**
 * Format execution result as response message
 */
function formatResponse(intent: ParsedIntent, result: ExecutionResult): string {
  if (result.success) {
    return result.output || `✓ ${intent.action} completed`;
  } else {
    return `✗ ${result.error || 'Unknown error'}`;
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
    // Parse the intent
    const intent = await parseIntent(content);
    
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
