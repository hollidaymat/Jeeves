/**
 * Signal CLI Interface
 * Connects to signal-cli daemon for real Signal messaging
 * 
 * PHASE 2: This requires Linux with signal-cli installed
 * For now, use the mock interface or web UI for testing
 */

import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import type { IncomingMessage, OutgoingMessage, MessageInterface } from '../types/index.js';

type MessageHandler = (message: IncomingMessage) => Promise<void>;

/**
 * Signal CLI Interface
 * Connects via Unix socket or JSON-RPC to signal-cli daemon
 */
export class SignalInterface implements MessageInterface {
  name = 'signal';
  private messageHandler: MessageHandler | null = null;
  private connected = false;
  
  async start(): Promise<void> {
    // Check if we're on Linux
    if (process.platform === 'win32') {
      logger.warn('Signal interface not available on Windows');
      logger.info('Use the web UI at http://127.0.0.1:3847 for testing');
      logger.info('Signal interface will be enabled on Linux');
      return;
    }
    
    // TODO: Phase 2 - Connect to signal-cli daemon
    // Options:
    // 1. Unix socket: /tmp/signal-cli.sock
    // 2. TCP JSON-RPC: localhost:7583
    // 3. DBus interface
    
    logger.info('Signal interface starting...');
    logger.info(`Configured for number: ${config.signal.number}`);
    logger.info(`Socket path: ${config.signal.socket}`);
    
    // For now, just mark as not connected
    // Full implementation in Phase 2
    this.connected = false;
    
    logger.warn('Signal interface not yet implemented (Phase 2)');
    logger.info('To enable Signal integration:');
    logger.info('  1. Install signal-cli: https://github.com/AsamK/signal-cli');
    logger.info('  2. Link your Signal account: signal-cli link -n "Cursor Controller"');
    logger.info('  3. Start the daemon: signal-cli daemon --socket /tmp/signal-cli.sock');
  }
  
  async stop(): Promise<void> {
    if (this.connected) {
      logger.info('Signal interface stopping...');
      this.connected = false;
    }
  }
  
  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }
  
  async send(message: OutgoingMessage): Promise<void> {
    if (!this.connected) {
      logger.warn('Cannot send via Signal: not connected');
      return;
    }
    
    // TODO: Phase 2 - Send via signal-cli
    // signal-cli -u <number> send -m "<message>" <recipient>
    
    logger.info('Would send via Signal:', { 
      recipient: message.recipient, 
      content: message.content.substring(0, 50) 
    });
  }
  
  /**
   * Check if Signal interface is available
   */
  isAvailable(): boolean {
    return this.connected;
  }
}

// Singleton instance
export const signalInterface = new SignalInterface();

/**
 * Example signal-cli setup commands (for reference):
 * 
 * # Install signal-cli (Linux)
 * wget https://github.com/AsamK/signal-cli/releases/latest/download/signal-cli-0.13.0.tar.gz
 * tar xf signal-cli-0.13.0.tar.gz
 * sudo mv signal-cli-0.13.0 /opt/signal-cli
 * sudo ln -s /opt/signal-cli/bin/signal-cli /usr/local/bin/
 * 
 * # Link to existing Signal account (recommended)
 * signal-cli link -n "Cursor Controller"
 * # Scan QR code with Signal app > Settings > Linked Devices
 * 
 * # Or register a new number
 * signal-cli -u +1YOURPHONE register
 * signal-cli -u +1YOURPHONE verify <CODE>
 * 
 * # Start daemon
 * signal-cli -u +1YOURPHONE daemon --socket /tmp/signal-cli.sock
 * 
 * # Test sending
 * signal-cli -u +1YOURPHONE send -m "Hello from Cursor Controller!" +1TARGETPHONE
 */
