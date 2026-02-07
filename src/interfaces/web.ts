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
import { getPendingChanges, setStreamCallback } from '../core/cursor-agent.js';
import { exportConversations } from '../core/memory.js';
import { onCheckpoint, getExecutionStatus } from '../core/prd-executor.js';
import { isHomelabEnabled, getDashboardStatus } from '../homelab/index.js';
import { collectServiceDetail, getRequiredEnvVars } from '../homelab/services/collectors.js';
import { getActivitySnapshot } from '../models/activity.js';
import { getCostDashboardData } from '../core/cost-tracker.js';
import { getProjects, addProject, moveTask } from '../models/projects.js';
import { getVercelStatus } from '../api/vercel.js';
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
  private homelabBroadcastTimer: ReturnType<typeof setInterval> | null = null;
  
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
    
    // API: Download conversations
    this.app.get('/api/conversations/download', (req: Request, res: Response) => {
      const format = (req.query.format as 'json' | 'markdown') || 'json';
      const { filename, content, mimeType } = exportConversations(format);
      
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(content);
    });
    
    // API: Homelab status (dashboard data)
    this.app.get('/api/homelab/status', async (_req: Request, res: Response) => {
      try {
        const status = await getDashboardStatus();
        res.json(status);
      } catch (error) {
        res.json({ enabled: false, error: String(error) });
      }
    });

    // API: Service deep-dive detail
    this.app.get('/api/homelab/service/:name', async (req: Request, res: Response) => {
      try {
        const data = await collectServiceDetail(req.params.name);
        if (data) {
          res.json(data);
        } else {
          const required = getRequiredEnvVars(req.params.name);
          const hint = required.length > 0
            ? `Set ${required.join(', ')} in .env to enable`
            : 'No collector available for this service';
          res.json({ error: hint });
        }
      } catch (error) {
        res.json({ error: String(error) });
      }
    });

    // API: Activity snapshot
    this.app.get('/api/activity', (_req: Request, res: Response) => {
      try {
        res.json(getActivitySnapshot());
      } catch (error) {
        res.json({ currentTask: null, queue: [], standingOrders: [], history: [], summary: { tasks: 0, cost: 0, failures: 0 } });
      }
    });

    // API: Pause activity (placeholder)
    this.app.post('/api/activity/pause', (_req: Request, res: Response) => {
      res.json({ success: true, message: 'Pause acknowledged' });
    });

    // API: Cost dashboard
    this.app.get('/api/costs', (_req: Request, res: Response) => {
      try {
        const monthlyLimit = config.trust?.monthly_spend_limit || 50;
        res.json(getCostDashboardData(monthlyLimit));
      } catch (error) {
        res.json({ today: 0, week: 0, month: 0, limits: { daily: 0, weekly: 0, monthly: 0 }, byModel: {}, byCategory: {}, trend: 0 });
      }
    });

    // API: Projects board
    this.app.get('/api/projects-board', (_req: Request, res: Response) => {
      try {
        res.json({ projects: getProjects() });
      } catch (error) {
        res.json({ projects: [] });
      }
    });

    // API: Create project
    this.app.post('/api/projects-board', (req: Request, res: Response) => {
      try {
        const { name, description } = req.body;
        if (!name) { res.status(400).json({ error: 'Name required' }); return; }
        const project = addProject(name, description);
        res.json(project);
      } catch (error) {
        res.status(500).json({ error: String(error) });
      }
    });

    // API: Move task
    this.app.patch('/api/projects-board/:projectId/tasks/:taskId', (req: Request, res: Response) => {
      try {
        const { projectId, taskId } = req.params;
        const { status } = req.body;
        const success = moveTask(projectId, taskId, status);
        res.json({ success });
      } catch (error) {
        res.status(500).json({ error: String(error) });
      }
    });

    // API: Vercel status
    this.app.get('/api/vercel/status', async (_req: Request, res: Response) => {
      try {
        const status = await getVercelStatus();
        res.json(status);
      } catch (error) {
        res.json({ enabled: false, projects: [] });
      }
    });

    // API: Send command
    this.app.post('/api/command', async (req: Request, res: Response) => {
      const { content, attachments } = req.body;
      
      if (!content) {
        res.status(400).json({ error: 'Missing content' });
        return;
      }
      
      // Process attachments and build enhanced content
      let enhancedContent = content;
      const processedAttachments: IncomingMessage['attachments'] = [];
      
      if (attachments && Array.isArray(attachments)) {
        for (const attachment of attachments) {
          if (attachment.isImage) {
            // Store image data for vision processing
            processedAttachments.push({
              type: 'image',
              data: attachment.content, // base64 data URL
              name: attachment.name,
              mimeType: attachment.type || 'image/png'
            });
            enhancedContent += `\n\n[Attached image: ${attachment.name}]`;
          } else {
            // For text files, include content directly in the message
            enhancedContent += `\n\n--- Attached file: ${attachment.name} ---\n${attachment.content}\n--- End of ${attachment.name} ---`;
          }
        }
      }
      
      const message: IncomingMessage = {
        id: randomUUID(),
        sender: 'web',
        content: enhancedContent,
        timestamp: new Date(),
        interface: 'web',
        attachments: processedAttachments.length > 0 ? processedAttachments : undefined
      };
      
      try {
        // Enable streaming - broadcast chunks as they arrive
        const streamId = randomUUID();
        this.broadcast({ type: 'stream_start', payload: { streamId } });
        
        setStreamCallback((chunk: string) => {
          this.broadcast({ 
            type: 'stream_chunk', 
            payload: { streamId, chunk } 
          });
        });
        
        const response = await handleMessage(message);
        
        // Clear stream callback
        setStreamCallback(null);
        
        // Signal stream end
        this.broadcast({ type: 'stream_end', payload: { streamId } });
        
        res.json({
          success: true,
          response: response?.content || 'No response'
        });
        
        // Broadcast final response (for non-streaming clients)
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
        setStreamCallback(null);
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
    return new Promise((resolve, reject) => {
      // Handle server errors (including EADDRINUSE)
      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          logger.error(`Port ${config.server.port} is already in use. Waiting and retrying...`);
          setTimeout(() => {
            this.server.close();
            this.server.listen(config.server.port, config.server.host);
          }, 1000);
        } else {
          reject(err);
        }
      });
      
      this.server.listen(config.server.port, config.server.host, () => {
        logger.info(`Web interface started at http://${config.server.host}:${config.server.port}`);
        this.startHomelabBroadcast();
        resolve();
      });
    });
  }
  
  private startHomelabBroadcast(): void {
    if (!isHomelabEnabled()) return;

    const broadcastInterval = config.homelab.monitorInterval || 30000;
    this.homelabBroadcastTimer = setInterval(async () => {
      if (this.clients.size === 0) return; // No one listening
      try {
        const status = await getDashboardStatus();
        this.broadcast({ type: 'homelab_status', payload: status });

        // Also broadcast cost and activity data
        const monthlyLimit = config.trust?.monthly_spend_limit || 50;
        this.broadcast({ type: 'cost_update', payload: getCostDashboardData(monthlyLimit) });
        this.broadcast({ type: 'activity_update', payload: getActivitySnapshot() });
      } catch {
        // Non-critical, skip this cycle
      }
    }, broadcastInterval);

    logger.info('Homelab dashboard broadcast started', { interval: broadcastInterval });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      // Stop homelab broadcast
      if (this.homelabBroadcastTimer) {
        clearInterval(this.homelabBroadcastTimer);
        this.homelabBroadcastTimer = null;
      }

      // Close all WebSocket connections first
      for (const client of this.clients) {
        try {
          client.close();
        } catch {
          // Ignore errors closing clients
        }
      }
      this.clients.clear();
      
      // Close WebSocket server
      try {
        this.wss.close();
      } catch {
        // Ignore
      }
      
      // Close HTTP server with timeout
      const timeout = setTimeout(() => {
        logger.debug('Force closing server after timeout');
        resolve();
      }, 1000);
      
      this.server.close(() => {
        clearTimeout(timeout);
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
