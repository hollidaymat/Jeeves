/**
 * Mock Signal Interface
 * For testing on Windows without signal-cli
 */

import { randomUUID } from 'crypto';
import { logger } from '../utils/logger.js';
import type { IncomingMessage, OutgoingMessage, MessageInterface } from '../types/index.js';

type MessageHandler = (message: IncomingMessage) => Promise<void>;

/**
 * Mock Signal Interface - simulates Signal for development
 */
export class MockSignalInterface implements MessageInterface {
  name = 'mock';
  private messageHandler: MessageHandler | null = null;
  private responses: OutgoingMessage[] = [];
  
  async start(): Promise<void> {
    logger.info('Mock Signal interface started (for testing only)');
  }
  
  async stop(): Promise<void> {
    logger.info('Mock Signal interface stopped');
  }
  
  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }
  
  async send(message: OutgoingMessage): Promise<void> {
    this.responses.push(message);
    logger.debug('Mock Signal would send:', { recipient: message.recipient, content: message.content });
  }
  
  /**
   * Simulate receiving a message (for testing)
   */
  async simulateMessage(content: string, sender: string = 'mock'): Promise<OutgoingMessage | null> {
    if (!this.messageHandler) {
      throw new Error('No message handler registered');
    }
    
    const message: IncomingMessage = {
      id: randomUUID(),
      sender,
      content,
      timestamp: new Date(),
      interface: 'mock'
    };
    
    this.responses = [];
    await this.messageHandler(message);
    
    return this.responses[0] || null;
  }
  
  /**
   * Get last response (for testing)
   */
  getLastResponse(): OutgoingMessage | null {
    return this.responses[this.responses.length - 1] || null;
  }
}

// Singleton instance
export const mockInterface = new MockSignalInterface();
