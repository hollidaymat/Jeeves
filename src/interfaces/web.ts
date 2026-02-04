/**
 * Web Interface
 * Express server + WebSocket for the command center UI
 */

import express, { Request, Response } from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'crypto';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';
import { logger, registerWSClient, unregisterWSClient } from '../utils/logger.js';
import { getSystemStatus, handleMessage } from '../core/handler.js';
import { getProjectIndex, listProjects } from '../core/project-scanner.js';
import { getPendingChanges } from '../core/cursor-agent.js';
import { onCheckpoint, getExecutionStatus } from '../core/prd-executor.js';
import type { IncomingMessage, OutgoingMessage, MessageInterface, WSMessage, PrdCheckpoint } from '../types/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

type MessageHandler = (message: IncomingMessage) => Promise<void>;

/**
 * Web Interface with Express + WebSocket
 */
export class WebInterface implements MessageInterface {
  name = 'web';
  private app = express();
  private server = createServer(this.app);
  private wss = new WebSocketServer({ server: this.server });
  private messageHandler: MessageHandler | null = null;
  private clients = new Set<WebSocket>();
  
  constructor() {
    this.setupRoutes();
    this.setupWebSocket();
    this.setupPrdCallbacks();
  }
  
  private setupPrdCallbacks(): void {
    // Register for PRD execution checkpoints
    onCheckpoint((checkpoint: PrdCheckpoint) => {
      this.broadcast({
        type: 'prd_checkpoint',
        payload: checkpoint
      });
      
      // Also send as a response so it appears in the console
      this.broadcast({
        type: 'response',
        payload: {
          response: `**${checkpoint.phaseName}**\n\n${checkpoint.message}`,
          timestamp: checkpoint.timestamp
        }
      });
    });
  }
  
  private setupRoutes(): void {
    // Serve static files from web directory
    const webDir = resolve(__dirname, '../../web');
    this.app.use(express.static(webDir));
    
    // Parse JSON bodies
    this.app.use(express.json());
    
    // API: Get status
    this.app.get('/api/status', (_req: Request, res: Response) => {
      res.json(getSystemStatus());
    });
    
    // API: Get projects
    this.app.get('/api/projects', (_req: Request, res: Response) => {
      const index = getProjectIndex();
      const projects = Array.from(index.projects.values());
      res.json({
        projects,
        scanned_at: index.scanned_at
      });
    });
    
    // API: Send command
    this.app.post('/api/command', async (req: Request, res: Response) => {
      const { content } = req.body;
      
      if (!content) {
        res.status(400).json({ error: 'Missing content' });
        return;
      }
      
      const message: IncomingMessage = {
        id: randomUUID(),
        sender: 'web',
        content,
        timestamp: new Date(),
        interface: 'web'
      };
      
      try {
        const response = await handleMessage(message);
        res.json({
          success: true,
          response: response?.content || 'No response'
        });
        
        // Broadcast response to WebSocket clients
        this.broadcast({
          type: 'response',
          payload: {
            request: content,
            response: response?.content || 'No response',
            timestamp: new Date().toISOString()
          }
        });
        
        // Broadcast pending changes if any
        const pendingChanges = getPendingChanges();
        this.broadcast({
          type: 'pending_changes',
          payload: pendingChanges.map(c => ({
            filePath: c.filePath,
            originalContent: c.originalContent,
            newContent: c.newContent,
            description: c.description
          }))
        });
      } catch (error) {
        res.status(500).json({ 
          error: error instanceof Error ? error.message : 'Unknown error' 
        });
      }
    });
  }
  
  private setupWebSocket(): void {
    this.wss.on('connection', (ws: WebSocket) => {
      this.clients.add(ws);
      
      // Register for log broadcasts
      registerWSClient(ws);
      
      logger.info('WebSocket client connected', { total: this.clients.size });
      
      // Send initial status
      ws.send(JSON.stringify({
        type: 'status',
        payload: getSystemStatus()
      }));
      
      // Send project list
      ws.send(JSON.stringify({
        type: 'projects',
        payload: Array.from(getProjectIndex().projects.values())
      }));
      
      // Send PRD execution status if active
      const prdStatus = getExecutionStatus();
      if (prdStatus.active) {
        ws.send(JSON.stringify({
          type: 'prd_status',
          payload: prdStatus
        }));
      }
      
      ws.on('message', async (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString()) as WSMessage;
          
          if (message.type === 'command' && typeof message.payload === 'string') {
            const incoming: IncomingMessage = {
              id: randomUUID(),
              sender: 'web',
              content: message.payload,
              timestamp: new Date(),
              interface: 'web'
            };
            
            if (this.messageHandler) {
              await this.messageHandler(incoming);
            }
          }
        } catch (error) {
          logger.error('WebSocket message error', { error: String(error) });
        }
      });
      
      ws.on('close', () => {
        this.clients.delete(ws);
        unregisterWSClient(ws);
        logger.info('WebSocket client disconnected', { total: this.clients.size });
      });
      
      ws.on('error', (error) => {
        logger.error('WebSocket error', { error: String(error) });
        this.clients.delete(ws);
        unregisterWSClient(ws);
      });
    });
  }
  
  private broadcast(message: WSMessage): void {
    const data = JSON.stringify(message);
    this.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    });
  }
  
  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(config.server.port, config.server.host, () => {
        logger.info(`Web interface started at http://${config.server.host}:${config.server.port}`);
        resolve();
      });
    });
  }
  
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      this.wss.close();
      this.server.close(() => {
        logger.info('Web interface stopped');
        resolve();
      });
    });
  }
  
  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }
  
  async send(message: OutgoingMessage): Promise<void> {
    this.broadcast({
      type: 'response',
      payload: {
        response: message.content,
        timestamp: new Date().toISOString()
      }
    });
  }
}

// Singleton instance
export const webInterface = new WebInterface();
