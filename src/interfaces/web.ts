/**
 * Web Interface
 * Express server + WebSocket for the command center UI
 */

import express, { Request, Response } from 'express';
import { createServer as createHttpServer } from 'http';
import { createServer as createHttpsServer } from 'https';
import { readFileSync } from 'fs';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'crypto';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';
import { logger, registerWSClient, unregisterWSClient } from '../utils/logger.js';
import { setupVoiceWebSocket } from '../integrations/voice/voice-server.js';
import { getSystemStatus, handleMessage } from '../core/handler.js';
import { getProjectIndex, listProjects } from '../core/project-scanner.js';
import { getPendingChanges, setStreamCallback } from '../core/cursor-agent.js';
import { exportConversations, clearGeneralConversations, addGeneralMessage } from '../core/memory.js';
import { onCheckpoint, getExecutionStatus } from '../core/prd-executor.js';
import { getLastTrace, getTraceById, getTraceStats } from '../core/ooda-logger.js';
import { recordScenarioRun, getGrowthStats, getRecentOodaJournal, recordRunSummary, getGrowthTrend } from '../core/growth-tracker.js';
import { applyScenarioFailure, applyScenarioSuccess } from '../core/context/layers/learnings.js';
import { getLastExecutionOutcome, getExecutionLog } from '../core/execution-logger.js';
import { getScenarioRunCounts } from '../core/novel-scenario-generator.js';
import { detectGamingSignals } from '../core/anti-gaming.js';
import { isHomelabEnabled, getDashboardStatus } from '../homelab/index.js';
import { collectServiceDetail, getRequiredEnvVars } from '../homelab/services/collectors.js';
import { getActivitySnapshot } from '../models/activity.js';
import { getCostDashboardData } from '../core/cost-tracker.js';
import { getProjects, addProject, moveTask } from '../models/projects.js';
import { getVercelStatus } from '../api/vercel.js';
import { runSelfTest, formatSelfTestReport } from '../core/self-test.js';
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
  private server = config.server.tls
    ? createHttpsServer(
        {
          key: readFileSync(config.server.tls.keyPath),
          cert: readFileSync(config.server.tls.certPath)
        },
        this.app
      )
    : createHttpServer(this.app);
  private wss = new WebSocketServer({ noServer: true });
  private voiceWss: WebSocketServer | null = null;
  private messageHandler: MessageHandler | null = null;
  private clients = new Set<WebSocket>();
  private homelabBroadcastTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.setupRoutes();
    this.setupWebSocket();
    if (config.voice?.enabled) {
      this.voiceWss = new WebSocketServer({ noServer: true });
      setupVoiceWebSocket(this.voiceWss, this.app);
      logger.info('Voice interface enabled', { path: '/voice', testPage: '/voice/test' });
    }
    this.server.on('upgrade', (request, socket, head) => {
      const path = (request.url || '').split('?')[0];
      if (path === '/voice' && this.voiceWss) {
        this.voiceWss.handleUpgrade(request, socket, head, (ws) => {
          this.voiceWss!.emit('connection', ws, request);
        });
      } else {
        this.wss.handleUpgrade(request, socket, head, (ws) => {
          this.wss.emit('connection', ws, request);
        });
      }
    });
    this.setupPrdCallbacks();
    this.setupCursorBroadcast();
  }

  private setupCursorBroadcast(): void {
    // Wire up the Cursor orchestrator's broadcast to our WebSocket
    import('../integrations/cursor-orchestrator.js').then(({ setBroadcast }) => {
      setBroadcast((type: string, payload: unknown) => {
        this.broadcast({ type: type as WSMessage['type'], payload });
      });
    }).catch(() => {
      // Cursor integration not available, that's fine
    });
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
    // Serve static files from web directory (no caching so updates take effect immediately)
    const webDir = resolve(__dirname, '../../web');
    this.app.use(express.static(webDir, { etag: false, maxAge: 0 }));
    this.app.use('/tablet', express.static(resolve(webDir, 'tablet'), { index: 'index.html', etag: false, maxAge: 0 }));
    this.app.use((_req, res, next) => {
      res.setHeader('Cache-Control', 'no-store');
      next();
    });
    
    // Parse JSON bodies
    this.app.use(express.json());

    // Performance profiler: request timing for API routes (excludes static)
    this.app.use((req: Request, res: Response, next) => {
      const start = Date.now();
      res.on('finish', () => {
        Promise.resolve().then(() => import('../core/profiler/performance-collector.js')).then(({ recordMetric }) => {
          recordMetric({ category: 'response_time', source: 'web_server', metric_name: 'response_time_ms', value: Date.now() - start, metadata: { method: req.method, path: req.path, statusCode: res.statusCode } });
        }).catch(() => {});
      });
      next();
    });
    
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

    // API: Clear conversation history
    this.app.delete('/api/conversations', (_req: Request, res: Response) => {
      const result = clearGeneralConversations();
      res.json({ success: true, cleared: result.cleared });
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

    // API: Download watcher status
    this.app.get('/api/downloads', async (_req: Request, res: Response) => {
      try {
        const { getWatcherStatus } = await import('../homelab/media/download-watcher.js');
        res.json(getWatcherStatus());
      } catch (error) {
        res.json({ active: false, watching: [], recentlyCompleted: [], pollIntervalMs: 30000, lastPollAt: null });
      }
    });

    // API: Timeline events
    this.app.get('/api/timeline', async (req: Request, res: Response) => {
      try {
        const { getRecentEvents } = await import('../capabilities/timeline/timeline.js');
        const hours = parseInt(req.query.hours as string) || 24;
        res.json({ events: getRecentEvents(hours) });
      } catch (error) {
        res.json({ events: [] });
      }
    });

    // API: Notes
    this.app.get('/api/notes', async (req: Request, res: Response) => {
      try {
        const { listNotes, searchNotes } = await import('../capabilities/notes/scratchpad.js');
        const q = (req.query.q as string)?.trim();
        const notes = q ? searchNotes(q) : listNotes();
        res.json({ notes });
      } catch (error) {
        res.json({ notes: [] });
      }
    });
    this.app.post('/api/notes', async (req: Request, res: Response) => {
      try {
        const { addNote } = await import('../capabilities/notes/scratchpad.js');
        const content = (req.body?.content as string)?.trim();
        if (!content) {
          res.status(400).json({ error: 'content required' });
          return;
        }
        const note = addNote(content);
        res.status(201).json(note);
      } catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : 'Failed to add note' });
      }
    });
    this.app.delete('/api/notes/:id', async (req: Request, res: Response) => {
      try {
        const { deleteNote } = await import('../capabilities/notes/scratchpad.js');
        const deleted = deleteNote(req.params.id);
        res.json({ success: deleted });
      } catch (error) {
        res.status(500).json({ success: false, error: String(error) });
      }
    });

    // API: Reminders
    this.app.get('/api/reminders', async (_req: Request, res: Response) => {
      try {
        const { listReminders } = await import('../capabilities/reminders/reminders.js');
        res.json({ reminders: listReminders() });
      } catch (error) {
        res.json({ reminders: [] });
      }
    });

    // API: Custom schedules
    this.app.get('/api/schedules', async (_req: Request, res: Response) => {
      try {
        const { listCustomSchedules } = await import('../capabilities/scheduler/custom-schedules.js');
        res.json({ schedules: listCustomSchedules() });
      } catch (error) {
        res.json({ schedules: [] });
      }
    });

    // API: Quiet hours
    this.app.get('/api/quiet-hours', async (_req: Request, res: Response) => {
      try {
        const { getPrefs, isQuietHours } = await import('../capabilities/notifications/quiet-hours.js');
        res.json({ ...getPrefs(), isCurrentlyQuiet: isQuietHours() });
      } catch (error) {
        res.json({ quietHoursEnabled: false, isCurrentlyQuiet: false });
      }
    });

    // API: Disk health
    this.app.get('/api/disk-health', async (_req: Request, res: Response) => {
      try {
        const { getSmartHealth } = await import('../homelab/system/smart-monitor.js');
        res.json(await getSmartHealth());
      } catch (error) {
        res.json({ disks: [], overallHealthy: true, summary: 'SMART not available' });
      }
    });

    // API: Bandwidth
    this.app.get('/api/bandwidth', async (_req: Request, res: Response) => {
      try {
        const { getBandwidthStats } = await import('../homelab/integrations/bandwidth-monitor.js');
        res.json(await getBandwidthStats());
      } catch (error) {
        res.json({ containers: [], totalIn: '0B', totalOut: '0B', summary: 'unavailable' });
      }
    });

    // API: Tailscale
    this.app.get('/api/tailscale', async (_req: Request, res: Response) => {
      try {
        const { getTailscaleStatus } = await import('../homelab/integrations/tailscale.js');
        res.json(await getTailscaleStatus() || { connected: false, devices: [] });
      } catch (error) {
        res.json({ connected: false, devices: [] });
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

    // API: Budget enforcement status
    this.app.get('/api/costs/budget', async (_req: Request, res: Response) => {
      try {
        const { getBudgetStatus } = await import('../core/cost-tracker.js');
        res.json(getBudgetStatus());
      } catch (error) {
        res.json({ global: { dailyUsed: 0, dailyCap: 5, hourlyUsed: 0, hourlyCap: 2, circuitBreakerOpen: false }, features: {} });
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

    // API: Cursor tasks
    this.app.get('/api/cursor/tasks', async (_req: Request, res: Response) => {
      try {
        const { getAllCursorTasks } = await import('../integrations/cursor-orchestrator.js');
        res.json(getAllCursorTasks());
      } catch (error) {
        res.json({ active: [], completed: [] });
      }
    });

    // API: Cursor task conversation
    this.app.get('/api/cursor/tasks/:id/conversation', async (req: Request, res: Response) => {
      try {
        const { getTaskConversation } = await import('../integrations/cursor-orchestrator.js');
        const result = await getTaskConversation(req.params.id);
        res.json(result);
      } catch (error) {
        res.json({ success: false, message: String(error) });
      }
    });

    // API: Cursor follow-up
    this.app.post('/api/cursor/tasks/:id/followup', async (req: Request, res: Response) => {
      try {
        const { sendFollowUp } = await import('../integrations/cursor-orchestrator.js');
        const { instruction } = req.body;
        if (!instruction) { res.status(400).json({ error: 'instruction required' }); return; }
        const result = await sendFollowUp(req.params.id, instruction);
        res.json(result);
      } catch (error) {
        res.status(500).json({ success: false, message: String(error) });
      }
    });

    // API: Stop Cursor task
    this.app.post('/api/cursor/tasks/:id/stop', async (req: Request, res: Response) => {
      try {
        const { stopCursorTask } = await import('../integrations/cursor-orchestrator.js');
        const result = await stopCursorTask(req.params.id);
        res.json(result);
      } catch (error) {
        res.status(500).json({ success: false, message: String(error) });
      }
    });

    // API: Available repos for Cursor
    this.app.get('/api/cursor/repos', async (_req: Request, res: Response) => {
      try {
        const { getAvailableRepos } = await import('../integrations/cursor-orchestrator.js');
        res.json({ repos: getAvailableRepos() });
      } catch (error) {
        res.json({ repos: [] });
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

    // API: Scout status + findings
    this.app.get('/api/scout/status', async (_req: Request, res: Response) => {
      try {
        const { getScoutStatus, getFindings } = await import('../capabilities/scout/loop.js');
        const { getDigestQueue } = await import('../capabilities/scout/digest.js');
        const status = getScoutStatus();
        const findings = getFindings({ limit: 50 });
        const digestQueue = getDigestQueue();
        res.json({ ...status, findings, digestQueue });
      } catch (error) {
        res.json({ totalSources: 0, totalFindings: 0, findings: [], digestQueue: [], lastRun: null });
      }
    });

    // API: Scout digest
    this.app.get('/api/scout/digest', async (_req: Request, res: Response) => {
      try {
        const { getDigest } = await import('../capabilities/scout/digest.js');
        res.json({ digest: getDigest() });
      } catch (error) {
        res.json({ digest: 'Scout not available' });
      }
    });

    // API: Acknowledge scout findings
    this.app.post('/api/scout/acknowledge', async (req: Request, res: Response) => {
      try {
        const { acknowledgeFindings } = await import('../capabilities/scout/loop.js');
        const { ids } = req.body;
        if (ids && Array.isArray(ids)) {
          acknowledgeFindings(ids);
        }
        res.json({ success: true });
      } catch (error) {
        res.status(500).json({ success: false, error: String(error) });
      }
    });

    // API: Reasoning evaluation (REASONING tab)
    this.app.get('/api/reasoning/metrics', async (req: Request, res: Response) => {
      try {
        const { getReasoningMetrics } = await import('../core/reasoning-metrics.js');
        const days = req.query.days as string | undefined;
        const since = days ? parseInt(days, 10) : null;
        res.json(getReasoningMetrics(Number.isNaN(since) ? null : since));
      } catch (error) {
        res.json({ successRate: 0, testPassRate: 0, avgConfidence: 0, learningApplied: 0, totalTasks: 0 });
      }
    });
    this.app.get('/api/reasoning/tasks', async (req: Request, res: Response) => {
      try {
        const { getReasoningTasks } = await import('../core/reasoning-metrics.js');
        const days = req.query.days as string | undefined;
        const since = days ? parseInt(days, 10) : null;
        res.json(getReasoningTasks(Number.isNaN(since) ? null : since));
      } catch (error) {
        res.json([]);
      }
    });
    this.app.get('/api/reasoning/confidence', async (req: Request, res: Response) => {
      try {
        const { getReasoningConfidence } = await import('../core/reasoning-metrics.js');
        const days = req.query.days as string | undefined;
        const since = days ? parseInt(days, 10) : null;
        res.json(getReasoningConfidence(Number.isNaN(since) ? null : since));
      } catch (error) {
        res.json([]);
      }
    });
    this.app.get('/api/reasoning/errors', async (req: Request, res: Response) => {
      try {
        const { getReasoningErrors } = await import('../core/reasoning-metrics.js');
        const days = req.query.days as string | undefined;
        const since = days ? parseInt(days, 10) : null;
        res.json(getReasoningErrors(Number.isNaN(since) ? null : since));
      } catch (error) {
        res.json([]);
      }
    });
    this.app.get('/api/reasoning/timeline', async (req: Request, res: Response) => {
      try {
        const { getReasoningTimeline } = await import('../core/reasoning-metrics.js');
        const days = req.query.days as string | undefined;
        const since = days ? parseInt(days, 10) : null;
        res.json(getReasoningTimeline(Number.isNaN(since) ? null : since));
      } catch (error) {
        res.json([]);
      }
    });

    // API: Performance profiler
    this.app.get('/api/performance/summary', async (req: Request, res: Response) => {
      try {
        const { getPerformanceSummary } = await import('../core/profiler/performance-api.js');
        const days = parseInt((req.query.days as string) || '7', 10);
        res.json(getPerformanceSummary(Number.isNaN(days) ? 7 : days));
      } catch (error) {
        res.json({ avgResponseMs: 0, systemLoad: 0, totalCores: 4, memoryUsedMb: 0, memoryTotalMb: 0, containersRunning: 0, containersUnhealthy: 0, responseTimeTrend: 0 });
      }
    });
    this.app.get('/api/performance/bottlenecks', async (req: Request, res: Response) => {
      try {
        const { getBottlenecks } = await import('../core/profiler/performance-api.js');
        const days = parseInt((req.query.days as string) || '7', 10);
        res.json(getBottlenecks(Number.isNaN(days) ? 7 : days));
      } catch (error) {
        res.json([]);
      }
    });
    this.app.get('/api/performance/response-times', async (req: Request, res: Response) => {
      try {
        const { getResponseTimes } = await import('../core/profiler/performance-api.js');
        const days = parseInt((req.query.days as string) || '7', 10);
        res.json(getResponseTimes(Number.isNaN(days) ? 7 : days));
      } catch (error) {
        res.json([]);
      }
    });
    this.app.get('/api/performance/snapshots', async (req: Request, res: Response) => {
      try {
        const { getSnapshots } = await import('../core/profiler/performance-api.js');
        const days = parseInt((req.query.days as string) || '1', 10);
        res.json(getSnapshots(Number.isNaN(days) ? 1 : days));
      } catch (error) {
        res.json([]);
      }
    });
    this.app.get('/api/performance/recommendations', async (_req: Request, res: Response) => {
      try {
        const { getRecommendations } = await import('../core/profiler/performance-api.js');
        res.json(getRecommendations());
      } catch (error) {
        res.json([]);
      }
    });
    this.app.post('/api/performance/recommendations/:id/dismiss', async (req: Request, res: Response) => {
      try {
        const { dismissRecommendation } = await import('../core/profiler/performance-api.js');
        dismissRecommendation(req.params.id);
        res.json({ ok: true });
      } catch (error) {
        res.status(400).json({ error: String(error) });
      }
    });
    this.app.post('/api/performance/recommendations/:id/apply', async (req: Request, res: Response) => {
      try {
        const { applyRecommendation } = await import('../core/profiler/performance-api.js');
        applyRecommendation(req.params.id);
        res.json({ ok: true });
      } catch (error) {
        res.status(400).json({ error: String(error) });
      }
    });

    // API: Security dashboard
    this.app.get('/api/security/dashboard', async (_req: Request, res: Response) => {
      try {
        const { getSecurityDashboard } = await import('../capabilities/security/monitor.js');
        res.json(getSecurityDashboard());
      } catch (error) {
        res.json({ portfolio: { totalProjects: 0, allHealthy: true, totalBlocked: 0, incidents24h: 0 }, projects: [], recentEvents: [] });
      }
    });

    // API: Security events
    this.app.get('/api/security/events', async (_req: Request, res: Response) => {
      try {
        const { getSecurityEvents } = await import('../capabilities/security/monitor.js');
        const limit = parseInt((_req.query as Record<string,string>).limit || '50', 10);
        res.json({ events: getSecurityEvents(limit) });
      } catch (error) {
        res.json({ events: [] });
      }
    });

    // API: Vercel billing status
    this.app.get('/api/security/billing', async (_req: Request, res: Response) => {
      try {
        const { checkVercelBilling } = await import('../capabilities/security/billing.js');
        const billing = await checkVercelBilling();
        res.json(billing || { alert: 'unavailable', message: 'Billing API not configured' });
      } catch (error) {
        res.json({ alert: 'unavailable', message: String(error) });
      }
    });

    // API: Clients list
    this.app.get('/api/clients', async (_req: Request, res: Response) => {
      try {
        const { getClients } = await import('../capabilities/saas-builder/client-registry.js');
        res.json({ clients: getClients() });
      } catch (error) {
        res.json({ clients: [] });
      }
    });

    // API: Client detail
    this.app.get('/api/clients/:id', async (req: Request, res: Response) => {
      try {
        const { getClient } = await import('../capabilities/saas-builder/client-registry.js');
        const client = getClient(req.params.id);
        if (client) {
          res.json(client);
        } else {
          res.status(404).json({ error: 'Client not found' });
        }
      } catch (error) {
        res.status(500).json({ error: String(error) });
      }
    });

    // API: Revenue summary
    this.app.get('/api/revenue', async (_req: Request, res: Response) => {
      try {
        const { getRevenueSummary, getRevenueEntries } = await import('../capabilities/revenue/tracker.js');
        res.json({ summary: getRevenueSummary(), entries: getRevenueEntries() });
      } catch (error) {
        res.json({ summary: { totalRevenue: 0, totalCosts: 0, totalProfit: 0, projectCount: 0, avgMargin: '0' }, entries: [] });
      }
    });

    // API: Decision stats
    this.app.get('/api/decisions/stats', async (_req: Request, res: Response) => {
      try {
        const { getDecisionStats } = await import('../capabilities/twin/decision-recorder.js');
        res.json(getDecisionStats());
      } catch (error) {
        res.json({ total: 0, byCategory: {}, readyForPrediction: false });
      }
    });

    // API: Self-improvement proposals
    this.app.get('/api/self/proposals', async (_req: Request, res: Response) => {
      try {
        const { getProposalStatus } = await import('../capabilities/self/proposals.js');
        res.json(getProposalStatus());
      } catch (error) {
        res.json({ currentBatch: [], canApprove: false, approvalsToday: 0, batchDate: '', historyCount: 0 });
      }
    });

    // API: Generate proposals (trigger)
    this.app.post('/api/self/proposals/generate', async (_req: Request, res: Response) => {
      try {
        const { generateProposals } = await import('../capabilities/self/proposals.js');
        const proposals = await generateProposals();
        res.json({ proposals });
      } catch (error) {
        res.status(500).json({ error: String(error) });
      }
    });

    // API: Approve proposal
    this.app.post('/api/self/proposals/:num/approve', async (req: Request, res: Response) => {
      try {
        const { approveProposal } = await import('../capabilities/self/proposals.js');
        const result = await approveProposal(parseInt(req.params.num, 10));
        res.json(result);
      } catch (error) {
        res.status(500).json({ success: false, message: String(error) });
      }
    });

    // API: Reject proposal
    this.app.post('/api/self/proposals/:num/reject', async (req: Request, res: Response) => {
      try {
        const { rejectProposal } = await import('../capabilities/self/proposals.js');
        const result = rejectProposal(parseInt(req.params.num, 10));
        res.json(result);
      } catch (error) {
        res.status(500).json({ success: false, message: String(error) });
      }
    });

    // API: Self-update status
    this.app.get('/api/self/update', async (_req: Request, res: Response) => {
      try {
        const { getUpdateStatus } = await import('../capabilities/self/updater.js');
        res.json(getUpdateStatus());
      } catch (error) {
        res.json({ behind: 0, autoUpdateEnabled: false, lastCheck: '', lastError: 'Not available' });
      }
    });

    // API: Check for updates
    this.app.post('/api/self/update/check', async (_req: Request, res: Response) => {
      try {
        const { checkForUpdates } = await import('../capabilities/self/updater.js');
        const status = await checkForUpdates();
        res.json(status);
      } catch (error) {
        res.status(500).json({ error: String(error) });
      }
    });

    // API: Pull and restart
    this.app.post('/api/self/update/pull', async (_req: Request, res: Response) => {
      try {
        const { pullAndRestart } = await import('../capabilities/self/updater.js');
        const result = await pullAndRestart();
        res.json(result);
      } catch (error) {
        res.status(500).json({ success: false, message: String(error) });
      }
    });

    // API: Scheduler status
    this.app.get('/api/scheduler', async (_req: Request, res: Response) => {
      try {
        const { getSchedules, isSchedulerRunning } = await import('../capabilities/scheduler/engine.js');
        res.json({ running: isSchedulerRunning(), schedules: getSchedules() });
      } catch (error) {
        res.json({ running: false, schedules: [] });
      }
    });

    // API: Morning briefing (on-demand)
    this.app.get('/api/briefing', async (_req: Request, res: Response) => {
      try {
        const { getBriefingText } = await import('../capabilities/scheduler/briefing.js');
        const text = await getBriefingText();
        res.json({ briefing: text });
      } catch (error) {
        res.json({ briefing: 'Briefing not available' });
      }
    });

    // API: Uptime status
    this.app.get('/api/uptime', async (_req: Request, res: Response) => {
      try {
        const { getUptimeStatus, getUptimeAlerts } = await import('../capabilities/security/uptime.js');
        res.json({ sites: getUptimeStatus(), alerts: getUptimeAlerts(20) });
      } catch (error) {
        res.json({ sites: [], alerts: [] });
      }
    });

    // API: Uptime for specific client
    this.app.get('/api/uptime/:clientId', async (req: Request, res: Response) => {
      try {
        const { getClientUptime } = await import('../capabilities/security/uptime.js');
        const uptime = getClientUptime(req.params.clientId);
        if (uptime) {
          res.json(uptime);
        } else {
          res.status(404).json({ error: 'Client not found' });
        }
      } catch (error) {
        res.status(500).json({ error: String(error) });
      }
    });

    // API: Visual reviews
    this.app.get('/api/reviews', async (_req: Request, res: Response) => {
      try {
        const { getRecentReviews } = await import('../capabilities/self/visual-reviewer.js');
        res.json({ reviews: getRecentReviews() });
      } catch (error) {
        res.json({ reviews: [] });
      }
    });

    // API: Visual review for specific task
    this.app.get('/api/reviews/:taskId', async (req: Request, res: Response) => {
      try {
        const { getReview } = await import('../capabilities/self/visual-reviewer.js');
        const review = getReview(req.params.taskId);
        if (review) {
          res.json(review);
        } else {
          res.status(404).json({ error: 'Review not found' });
        }
      } catch (error) {
        res.status(500).json({ error: String(error) });
      }
    });

    // API: Changelog for project
    this.app.get('/api/changelog/:project', async (req: Request, res: Response) => {
      try {
        const { getChangelog } = await import('../capabilities/self/changelog.js');
        res.json({ changelog: getChangelog(req.params.project) });
      } catch (error) {
        res.json({ changelog: 'Not available' });
      }
    });

    // API: Cost advisor report
    this.app.get('/api/costs/advisor', async (_req: Request, res: Response) => {
      try {
        const { getLatestReport } = await import('../capabilities/revenue/cost-advisor.js');
        const report = getLatestReport();
        res.json(report || { error: 'No report available' });
      } catch (error) {
        res.json({ error: 'Cost advisor not available' });
      }
    });

    // API: Impact analysis for a PR
    this.app.post('/api/impact/analyze', async (req: Request, res: Response) => {
      try {
        const { analyzePRImpact } = await import('../capabilities/self/impact-analyzer.js');
        const { repo, prNumber } = req.body;
        if (!repo || !prNumber) {
          res.status(400).json({ error: 'repo and prNumber required' });
          return;
        }
        const report = await analyzePRImpact(repo, parseInt(prNumber, 10));
        res.json(report || { impacts: [] });
      } catch (error) {
        res.status(500).json({ error: String(error) });
      }
    });

    // API: Manual merge
    this.app.post('/api/merge', async (req: Request, res: Response) => {
      try {
        const { manualMerge } = await import('../integrations/cursor-refinement.js');
        const { target } = req.body;
        if (!target) {
          res.status(400).json({ success: false, message: 'target (PR URL or task ID) required' });
          return;
        }
        const result = await manualMerge(target);
        res.json(result);
      } catch (error) {
        res.status(500).json({ success: false, message: String(error) });
      }
    });

    // API: Debug OODA traces
    this.app.get('/api/debug/last-ooda', (_req: Request, res: Response) => {
      const trace = getLastTrace();
      res.json(trace ?? { error: 'No trace recorded' });
    });
    this.app.get('/api/debug/ooda/:requestId', (req: Request, res: Response) => {
      const trace = getTraceById(req.params.requestId);
      res.json(trace ?? { error: 'Trace not found' });
    });
    this.app.get('/api/debug/ooda/stats', (_req: Request, res: Response) => {
      res.json(getTraceStats());
    });
    /** Journal: last N OODA traces from DB (persisted across restarts). */
    this.app.get('/api/debug/journal', (req: Request, res: Response) => {
      const limit = Math.min(parseInt(String(req.query.limit), 10) || 50, 200);
      res.json({ entries: getRecentOodaJournal(limit) });
    });
    /** Last execution outcome: did the last plan or dev_task succeed? (paths, steps, outcome) */
    this.app.get('/api/debug/last-execution-outcome', (req: Request, res: Response) => {
      try {
        const full = req.query.full === '1' || req.query.full === 'true';
        const out = getLastExecutionOutcome(full);
        if (!out) {
          res.json({ error: 'No execution recorded yet.', succeeded: false });
          return;
        }
        res.json(out);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: msg, succeeded: false });
      }
    });
    /** Execution log: last N plan/dev_task runs for audit. */
    this.app.get('/api/debug/execution-log', (req: Request, res: Response) => {
      const limit = Math.min(parseInt(String(req.query.limit), 10) || 50, 200);
      res.json({ entries: getExecutionLog(limit) });
    });

    // API: Cognitive debug (Brain 2)
    this.app.get('/api/debug/last-trace', (_req: Request, res: Response) => {
      const trace = getLastTrace();
      if (!trace) {
        res.json({ error: 'No trace recorded' });
        return;
      }
      res.json({
        requestId: trace.requestId,
        timestamp: trace.timestamp,
        routingPath: trace.routingPath,
        contextLoaded: trace.observe.contextLoaded,
        tokenBudget: trace.observe.tokensUsed,
        classification: trace.orient.classification,
        action: trace.decide.action,
        full: trace,
      });
    });
    this.app.get('/api/debug/context-layers', (_req: Request, res: Response) => {
      const trace = getLastTrace();
      if (!trace) {
        res.json({ error: 'No trace recorded', contextLoaded: [], tokenBudget: 0, classification: null });
        return;
      }
      res.json({
        contextLoaded: trace.observe.contextLoaded,
        tokenBudget: trace.observe.tokensUsed,
        classification: trace.orient.classification,
      });
    });
    this.app.get('/api/debug/cognitive-health', async (_req: Request, res: Response) => {
      const trace = getLastTrace();
      const lastTraceAge = trace ? Date.now() - trace.timestamp : null;

      let dbConnected = false;
      try {
        const { getDb } = await import('../core/context/db.js');
        getDb().prepare('SELECT 1').get();
        dbConnected = true;
      } catch {
        /* ignore */
      }

      let assemblerConnected = false;
      try {
        const { assembleContext } = await import('../core/context/index.js');
        await assembleContext({ message: 'ping', action: 'agent_ask' });
        assemblerConnected = true;
      } catch {
        /* ignore */
      }

      const layersAvailable = ['schema', 'annotations', 'patterns', 'docs', 'learnings', 'runtime', 'project'];

      res.json({
        assemblerConnected,
        dbConnected,
        layersAvailable,
        lastTraceAge,
      });
    });

    this.app.post('/api/debug/growth/scenario-run', (req: Request, res: Response) => {
      const { scenarioId, passed, responseMs, oodaRequestId, failureDetail } = req.body ?? {};
      if (!scenarioId || typeof passed !== 'boolean') {
        res.status(400).json({ error: 'Missing scenarioId or passed' });
        return;
      }
      recordScenarioRun(scenarioId, passed, { responseMs, oodaRequestId });
      if (passed) {
        applyScenarioSuccess(scenarioId);
      } else if (
        failureDetail &&
        typeof failureDetail.trigger === 'string' &&
        typeof failureDetail.check === 'string' &&
        typeof failureDetail.detail === 'string'
      ) {
        applyScenarioFailure(scenarioId, failureDetail);
      }
      res.json({ ok: true });
    });
    this.app.get('/api/debug/growth/stats', (_req: Request, res: Response) => {
      res.json(getGrowthStats());
    });
    this.app.get('/api/debug/growth/anti-gaming', (_req: Request, res: Response) => {
      res.json({ signals: detectGamingSignals() });
    });
    this.app.get('/api/debug/growth/scenario-counts', (_req: Request, res: Response) => {
      res.json(getScenarioRunCounts());
    });
    this.app.post('/api/debug/growth/run-summary', (req: Request, res: Response) => {
      const { total_pass, total_fail, novel_pass, novel_fail, context_loaded_rate, avg_confidence_score } = req.body ?? {};
      if (
        typeof total_pass !== 'number' ||
        typeof total_fail !== 'number' ||
        typeof novel_pass !== 'number' ||
        typeof novel_fail !== 'number' ||
        typeof context_loaded_rate !== 'number'
      ) {
        res.status(400).json({ error: 'Missing or invalid: total_pass, total_fail, novel_pass, novel_fail, context_loaded_rate' });
        return;
      }
      const id = recordRunSummary({
        total_pass,
        total_fail,
        novel_pass,
        novel_fail,
        context_loaded_rate,
        avg_confidence_score,
      });
      res.json({ ok: true, id });
    });
    this.app.get('/api/debug/growth-trend', (req: Request, res: Response) => {
      const limit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) || 10 : 10;
      res.json(getGrowthTrend(limit));
    });

    // API: Self-test (runs jeeves-qa, cognitive check, growth trend)
    this.app.post('/api/self-test', async (_req: Request, res: Response) => {
      try {
        this.broadcast({ type: 'self_test_started', payload: {} });
        const results = await runSelfTest({
          onProgress: (msg) => this.broadcast({ type: 'self_test_progress', payload: { message: msg } }),
        });
        const report = formatSelfTestReport(results);
        this.broadcast({ type: 'self_test_complete', payload: { report, results } });
        res.json({ success: true, report, results });
      } catch (err) {
        const msg = `Self-test failed: ${err instanceof Error ? err.message : String(err)}`;
        this.broadcast({ type: 'self_test_complete', payload: { report: msg, error: true } });
        res.status(500).json({ success: false, error: msg });
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
        
        const { stripMarkdown } = await import('../utils/signal-format.js');
        const responseContent = stripMarkdown(response?.content || 'No response');
        
        // Store conversation in memory for export
        addGeneralMessage('user', content);
        addGeneralMessage('assistant', responseContent);
        
        res.json({
          success: true,
          response: responseContent
        });
        
        // Broadcast final response (for non-streaming clients)
        this.broadcast({
          type: 'response',
          payload: {
            request: content,
            response: responseContent,
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
      
      const scheme = config.server.tls ? 'https' : 'http';
      this.server.listen(config.server.port, config.server.host, () => {
        logger.info(`Web interface started at ${scheme}://${config.server.host}:${config.server.port}`);
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
        
        // Broadcast download status if watcher is active
        try {
          const { getWatcherStatus, isWatching } = await import('../homelab/media/download-watcher.js');
          if (isWatching()) {
            this.broadcast({ type: 'download_status' as any, payload: getWatcherStatus() });
          }
        } catch {
          // Download watcher not available
        }
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
      
      // Close WebSocket servers
      try {
        this.wss.close();
      } catch {
        // Ignore
      }
      try {
        if (this.voiceWss) this.voiceWss.close();
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
