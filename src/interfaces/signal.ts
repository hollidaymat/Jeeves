/**
 * Signal CLI Interface
 * Connects to signal-cli daemon via JSON-RPC for real Signal messaging
 * 
 * Requires Linux with signal-cli installed and running as daemon
 */

import { createConnection, Socket } from 'net';
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { join } from 'path';
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
        storedFilename?: string;
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

/** signal-cli stores received attachments by id (override base with SIGNAL_ATTACHMENT_DIR) */
function resolveAttachmentPath(attachmentId: string): string | undefined {
  const base = process.env.SIGNAL_ATTACHMENT_DIR
    || join(process.env.HOME || '/home/jeeves', '.local', 'share', 'signal-cli');
  const candidates = [
    join(base, 'attachments', attachmentId),
    join(base, 'data', 'attachments', attachmentId),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return candidates[0];
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
          logger.debug('Signal socket error', { error: error.message });
          this.connected = false;
          this.scheduleReconnect();
        });
        
        this.socket.on('close', () => {
          logger.debug('Signal socket closed');
          this.connected = false;
          this.scheduleReconnect();
        });
        
        // Timeout for initial connection
        setTimeout(() => {
          if (!this.connected) {
            logger.debug('Signal connection timeout - daemon may not be running');
            resolve();
          }
        }, 5000);
        
      } catch (error) {
        logger.debug('Failed to connect to signal-cli', { error: String(error) });
        this.scheduleReconnect();
        resolve();
      }
    });
  }
  
  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.warn('Max reconnect attempts reached for Signal');
      return;
    }
    
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 60000);
    this.reconnectAttempts++;
    
    logger.debug(`Reconnecting to Signal in ${delay / 1000}s (attempt ${this.reconnectAttempts})`);
    
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
  
  private handleJsonRpc(message: Record<string, unknown>): void {
    // JSON-RPC notification from signal-cli: {"jsonrpc":"2.0","method":"receive","params":{"envelope":{...}}}
    if (message.method === 'receive' && message.params) {
      const params = message.params as Record<string, unknown>;
      if (params.envelope) {
        this.handleIncomingMessage({ envelope: params.envelope } as SignalMessage);
        return;
      }
    }
    
    // Legacy format: envelope at top level
    if ('envelope' in message) {
      this.handleIncomingMessage(message as unknown as SignalMessage);
      return;
    }
    
    // Handle JSON-RPC response
    const rpc = message as unknown as JsonRpcResponse;
    if (rpc.error) {
      logger.error('Signal RPC error', { error: rpc.error.message });
    }
  }
  
  private async handleIncomingMessage(msg: SignalMessage): Promise<void> {
    const envelope = msg.envelope;
    const dataMessage = envelope.dataMessage;
    
    // If no dataMessage at all, skip
    if (!dataMessage) return;

    const dataMsg = dataMessage as { message?: string; body?: string; attachments?: Array<{ contentType: string; filename?: string; storedFilename?: string; id?: string; size: number }> };
    const textContent = dataMsg.message ?? dataMsg.body ?? '';
    if (!textContent) {
      const audioAttachment = dataMessage.attachments?.find(
        (a) => a.contentType?.startsWith('audio/')
      );
      if (!audioAttachment) return;
      if (audioAttachment.filename || (audioAttachment as { storedFilename?: string }).storedFilename || audioAttachment.id) {
        const audioPath = (audioAttachment as { storedFilename?: string }).storedFilename || audioAttachment.filename || `/tmp/signal-attachment-${audioAttachment.id}`;
        try {
          const { transcribeAudio } = await import('../capabilities/voice/transcriber.js');
          const result = await transcribeAudio(audioPath);
          if (result.success && result.text) {
            logger.info('Voice note transcribed', { method: result.method, length: result.text.length });
            // Continue processing with transcribed text
            (dataMessage as { message?: string }).message = result.text;
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
    
    const content = (dataMessage as { message?: string }).message ?? (dataMessage as { body?: string }).body ?? '';
    
    // Skip group messages (only handle direct messages)
    if (dataMessage.groupInfo) {
      logger.debug('Skipping group message');
      return;
    }
    
    const sender = envelope.source;
    const attCount = dataMessage.attachments?.length ?? 0;
    if (attCount > 0) {
      const first = dataMessage.attachments![0] as Record<string, unknown>;
      logger.info('Received Signal message', { 
        from: sender.substring(0, 4) + '***',
        length: content.length,
        attachmentCount: attCount,
        firstAttachmentKeys: Object.keys(first || {}),
      });
    } else {
      logger.info('Received Signal message', { 
        from: sender.substring(0, 4) + '***',
        length: content.length 
      });
    }
    
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
    
    // Handle attachments: signal-cli stores files by id; map to path
    if (dataMsg.attachments && dataMsg.attachments.length > 0) {
      const cType = (s: string) => (s || '').toLowerCase();
      incoming.attachments = dataMsg.attachments.map(att => {
        const raw = att as Record<string, unknown>;
        let path = (raw.storedFilename ?? raw.filename ?? raw.path ?? raw.uri) as string | undefined;
        if (!path && raw.id) {
          path = resolveAttachmentPath(String(raw.id));
        }
        const type = cType(att.contentType as string).startsWith('image/') ? 'image' as const
          : cType(att.contentType as string).startsWith('audio/') ? 'audio' as const
          : 'file' as const;
        return { type, path: path || undefined, mimeType: att.contentType as string };
      });
      const first = incoming.attachments[0];
      const pathInfo = first ? { firstPath: (first as { path?: string }).path, firstPathExists: (first as { path?: string }).path ? existsSync((first as { path?: string }).path!) : false } : {};
      logger.info('Signal message has attachments', {
        count: incoming.attachments.length,
        firstType: first?.type,
        ...pathInfo,
      });
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
      logger.debug('Cannot send RPC: not connected to signal-cli');
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
      logger.debug('Cannot send via Signal: not connected');
      return;
    }
    
    const { formatForSignal } = await import('../utils/signal-format.js');
    let content = formatForSignal(message.content);
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
