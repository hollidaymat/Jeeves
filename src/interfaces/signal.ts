/**
 * Signal CLI Interface
 * Connects to signal-cli daemon via JSON-RPC for real Signal messaging
 * 
 * Requires Linux with signal-cli installed and running as daemon
 */

import { createConnection, Socket } from 'net';
import { randomUUID } from 'crypto';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import type { IncomingMessage, OutgoingMessage, MessageInterface } from '../types/index.js';

type MessageHandler = (message: IncomingMessage) => Promise<void>;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
  id?: string;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  result?: unknown;
  error?: { code: number; message: string };
  id?: string;
}

interface SignalMessage {
  envelope: {
    source: string;
    sourceDevice: number;
    timestamp: number;
    dataMessage?: {
      message: string;
      timestamp: number;
      groupInfo?: { groupId: string };
      attachments?: Array<{
        contentType: string;
        filename?: string;
        id?: string;
        size: number;
      }>;
    };
    syncMessage?: {
      sentMessage?: {
        message: string;
        destination: string;
      };
    };
  };
}

/**
 * Signal CLI Interface
 * Connects via Unix socket to signal-cli daemon using JSON-RPC
 */
export class SignalInterface implements MessageInterface {
  name = 'signal';
  private messageHandler: MessageHandler | null = null;
  private socket: Socket | null = null;
  private connected = false;
  private buffer = '';
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  
  async start(): Promise<void> {
    // Check if we're on Linux
    if (process.platform === 'win32') {
      logger.warn('Signal interface not available on Windows - use web UI');
      return;
    }
    
    logger.info('Starting Signal interface...');
    logger.info(`Signal number: ${config.signal.number}`);
    logger.info(`Socket path: ${config.signal.socket}`);
    
    await this.connect();
  }
  
  private async connect(): Promise<void> {
    return new Promise((resolve) => {
      try {
        this.socket = createConnection(config.signal.socket);
        
        this.socket.on('connect', () => {
          this.connected = true;
          this.reconnectAttempts = 0;
          logger.info('Connected to signal-cli daemon');
          
          // Subscribe to receive messages
          this.subscribeToMessages();
          resolve();
        });
        
        this.socket.on('data', (data: Buffer) => {
          this.handleData(data);
        });
        
        this.socket.on('error', (error: Error) => {
          logger.error('Signal socket error', { error: error.message });
          this.connected = false;
          this.scheduleReconnect();
        });
        
        this.socket.on('close', () => {
          logger.warn('Signal socket closed');
          this.connected = false;
          this.scheduleReconnect();
        });
        
        // Timeout for initial connection
        setTimeout(() => {
          if (!this.connected) {
            logger.warn('Signal connection timeout - daemon may not be running');
            resolve();
          }
        }, 5000);
        
      } catch (error) {
        logger.error('Failed to connect to signal-cli', { error: String(error) });
        this.scheduleReconnect();
        resolve();
      }
    });
  }
  
  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error('Max reconnect attempts reached for Signal');
      return;
    }
    
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 60000);
    this.reconnectAttempts++;
    
    logger.info(`Reconnecting to Signal in ${delay / 1000}s (attempt ${this.reconnectAttempts})`);
    
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
  
  private subscribeToMessages(): void {
    // Send JSON-RPC request to subscribe to incoming messages
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      method: 'subscribeReceive',
      params: { account: config.signal.number },
      id: randomUUID()
    };
    
    this.sendRpc(request);
  }
  
  private handleData(data: Buffer): void {
    this.buffer += data.toString();
    
    // Process complete JSON-RPC messages (newline-delimited)
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      
      if (line.trim()) {
        try {
          const message = JSON.parse(line);
          this.handleJsonRpc(message);
        } catch (e) {
          logger.debug('Non-JSON line from signal-cli', { line: line.substring(0, 100) });
        }
      }
    }
  }
  
  private handleJsonRpc(message: JsonRpcResponse | SignalMessage): void {
    // Check if this is a message notification
    if ('envelope' in message) {
      this.handleIncomingMessage(message as SignalMessage);
      return;
    }
    
    // Handle JSON-RPC response
    const rpc = message as JsonRpcResponse;
    if (rpc.error) {
      logger.error('Signal RPC error', { error: rpc.error.message });
    }
  }
  
  private async handleIncomingMessage(msg: SignalMessage): Promise<void> {
    const envelope = msg.envelope;
    const dataMessage = envelope.dataMessage;
    
    // If no dataMessage at all, skip
    if (!dataMessage) return;

    // If no text but has audio attachment, try to transcribe
    if (!dataMessage.message) {
      const audioAttachment = dataMessage.attachments?.find(
        (a) => a.contentType?.startsWith('audio/')
      );
      if (audioAttachment?.filename || audioAttachment?.id) {
        const audioPath = audioAttachment.filename || `/tmp/signal-attachment-${audioAttachment.id}`;
        try {
          const { transcribeAudio } = await import('../capabilities/voice/transcriber.js');
          const result = await transcribeAudio(audioPath);
          if (result.success && result.text) {
            logger.info('Voice note transcribed', { method: result.method, length: result.text.length });
            // Continue processing with transcribed text
            dataMessage.message = result.text;
          } else {
            logger.debug('Voice transcription failed or empty', { text: result.text });
            return;
          }
        } catch (err) {
          logger.debug('Voice transcription error', { error: String(err) });
          return;
        }
      } else {
        return;
      }
    }
    
    // Skip group messages (only handle direct messages)
    if (dataMessage.groupInfo) {
      logger.debug('Skipping group message');
      return;
    }
    
    const sender = envelope.source;
    const content = dataMessage.message;
    
    logger.info('Received Signal message', { 
      from: sender.substring(0, 4) + '***',
      length: content.length 
    });
    
    // Check authorization
    if (!config.security.allowed_numbers.includes(sender)) {
      logger.security.unauthorized(sender);
      if (!config.security.silent_deny) {
        await this.send({
          recipient: sender,
          content: 'Unauthorized. This incident has been logged.'
        });
      }
      return;
    }
    
    // Create incoming message
    const incoming: IncomingMessage = {
      id: randomUUID(),
      sender,
      content,
      timestamp: new Date(envelope.timestamp),
      interface: 'signal'
    };
    
    // Handle attachments if present
    if (dataMessage.attachments && dataMessage.attachments.length > 0) {
      incoming.attachments = dataMessage.attachments.map(att => ({
        type: att.contentType.startsWith('image/') ? 'image' : 
              att.contentType.startsWith('audio/') ? 'audio' : 'file',
        path: att.filename,
        mimeType: att.contentType
      }));
    }
    
    // Pass to message handler
    if (this.messageHandler) {
      try {
        await this.messageHandler(incoming);
      } catch (error) {
        logger.error('Error handling Signal message', { error: String(error) });
      }
    }
  }
  
  private sendRpc(request: JsonRpcRequest): void {
    if (!this.socket || !this.connected) {
      logger.warn('Cannot send RPC: not connected to signal-cli');
      return;
    }
    
    const data = JSON.stringify(request) + '\n';
    this.socket.write(data);
  }
  
  async stop(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    
    this.connected = false;
    logger.info('Signal interface stopped');
  }
  
  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }
  
  async send(message: OutgoingMessage): Promise<void> {
    if (!this.connected || !this.socket) {
      logger.warn('Cannot send via Signal: not connected');
      return;
    }
    
    // Truncate long messages (Signal has a limit)
    let content = message.content;
    if (content.length > 4000) {
      content = content.substring(0, 3950) + '\n\n... (truncated)';
    }
    
    const params: Record<string, unknown> = {
      account: config.signal.number,
      recipients: [message.recipient],
      message: content
    };

    // Include file attachments if provided
    if (message.attachments && message.attachments.length > 0) {
      params.attachments = message.attachments;
    }

    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      method: 'send',
      params,
      id: randomUUID()
    };
    
    this.sendRpc(request);
    
    logger.info('Sent Signal message', { 
      to: message.recipient.substring(0, 4) + '***',
      length: content.length,
      attachments: message.attachments?.length || 0
    });
  }
  
  /**
   * Check if Signal interface is available and connected
   */
  isAvailable(): boolean {
    return this.connected;
  }
}

// Singleton instance
export const signalInterface = new SignalInterface();

// SETUP INSTRUCTIONS: See README.md for signal-cli setup on Linux
