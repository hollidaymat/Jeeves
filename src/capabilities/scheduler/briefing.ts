/**
 * Morning Briefing System
 *
 * Generates a concise daily briefing from all subsystems and sends it
 * via Signal.  Pure data-gathering + string templates — no LLM needed.
 */

import { logger } from '../../utils/logger.js';
import { getOwnerNumber } from '../../config.js';

// Broadcast hook (same pattern as other capabilities)
let broadcastFn: ((type: string, payload: unknown) => void) | null = null;
export function setBriefingBroadcast(fn: (type: string, payload: unknown) => void): void {
  broadcastFn = fn;
}

// --- Data types ---

interface BriefingData {
  cursorTasks: { count: number; prUrls: string[] };
  scout: { count: number; topTitles: string[] };
  security: { healthy: boolean; incidents: number };
  vercel: { count: number; healthy: boolean; issues: number };
  clients: { count: number; statuses: string[] };
  proposals: { items: string[]; canApprove: boolean };
  update: { upToDate: boolean; behind: number };
}

// --- Data gathering (each source in try/catch so failures don't break briefing) ---

async function gatherData(): Promise<BriefingData> {
  const data: BriefingData = {
    cursorTasks: { count: 0, prUrls: [] },
    scout: { count: 0, topTitles: [] },
    security: { healthy: true, incidents: 0 },
    vercel: { count: 0, healthy: true, issues: 0 },
    clients: { count: 0, statuses: [] },
    proposals: { items: [], canApprove: false },
    update: { upToDate: true, behind: 0 },
  };

  try {
    const { getCompletedCursorTasks } = await import('../../integrations/cursor-orchestrator.js');
    const tasks = getCompletedCursorTasks(5);
    data.cursorTasks.count = tasks.length;
    data.cursorTasks.prUrls = tasks.filter((t) => t.prUrl).map((t) => t.prUrl as string);
  } catch { /* unavailable */ }

  try {
    const { getDigest } = await import('../scout/digest.js');
    const digest = getDigest();
    const lines = digest.split('\n').filter((l) => l.trim().startsWith('['));
    data.scout.count = lines.length;
    data.scout.topTitles = lines.slice(0, 2).map((l) => l.replace(/^\s*\[.*?]\s*/, '').trim());
  } catch { /* unavailable */ }

  try {
    const { getSecurityDashboard } = await import('../security/monitor.js');
    const dash = getSecurityDashboard();
    data.security.incidents = dash.portfolio.incidents24h;
    data.security.healthy = dash.portfolio.allHealthy;
  } catch { /* unavailable */ }

  try {
    const { getVercelStatus } = await import('../../api/vercel.js');
    const status = await getVercelStatus();
    data.vercel.count = status.projects.length;
    const unhealthy = status.projects.filter((p) => p.production.status !== 'READY');
    data.vercel.issues = unhealthy.length;
    data.vercel.healthy = unhealthy.length === 0;
  } catch { /* unavailable */ }

  try {
    const { getClients } = await import('../saas-builder/client-registry.js');
    const clients = getClients();
    data.clients.count = clients.length;
    data.clients.statuses = clients.map((c) => `${c.businessName}: ${c.status}`);
  } catch { /* unavailable */ }

  try {
    const { getProposalStatus } = await import('../self/proposals.js');
    const ps = getProposalStatus();
    data.proposals.canApprove = ps.canApprove;
    data.proposals.items = ps.currentBatch
      .filter((p) => p.status === 'pending')
      .slice(0, 3)
      .map((p) => p.title);
  } catch { /* unavailable */ }

  try {
    const { getUpdateStatus } = await import('../self/updater.js');
    const us = getUpdateStatus();
    data.update.behind = us.behind;
    data.update.upToDate = us.behind === 0;
  } catch { /* unavailable */ }

  return data;
}

// --- Formatting (target: <2 000 chars) ---

function formatBriefing(d: BriefingData): string {
  const lines: string[] = ['Good morning, Matt.', ''];

  // OVERNIGHT
  lines.push('OVERNIGHT:');
  const prNote = d.cursorTasks.prUrls.length > 0
    ? ` ${d.cursorTasks.prUrls.join(' ')}` : '';
  lines.push(`- ${d.cursorTasks.count} tasks completed${prNote}`);
  const scoutDetail = d.scout.topTitles.length > 0
    ? ` ${d.scout.topTitles.join('; ')}` : '';
  lines.push(`- ${d.scout.count} new findings${scoutDetail}`);
  lines.push(`- Security: ${d.security.healthy ? 'all healthy' : `${d.security.incidents} incidents`}`);

  // SITES
  lines.push('', 'SITES:');
  lines.push(`- ${d.vercel.count} Vercel projects ${d.vercel.healthy ? 'all healthy' : `${d.vercel.issues} issues`}`);
  const clientSummary = d.clients.statuses.length > 0
    ? d.clients.statuses.slice(0, 5).join(', ') : 'none';
  lines.push(`- ${d.clients.count} clients [${clientSummary}]`);

  // TODAY
  lines.push('', 'TODAY:');
  if (d.proposals.items.length > 0) {
    d.proposals.items.forEach((title, i) => lines.push(`- ${i + 1}. ${title}`));
  } else {
    lines.push('- No improvement proposals ready');
  }
  lines.push(`- Update status: ${d.update.upToDate ? 'up to date' : `${d.update.behind} commits behind`}`);

  // Footer
  lines.push('', 'Reply "approve 1/2/3" to pick a proposal or "morning briefing" to refresh.');
  return lines.join('\n');
}

// --- Public API ---

/** Build and return the briefing text without sending it. */
export async function getBriefingText(): Promise<string> {
  const data = await gatherData();
  return formatBriefing(data);
}

/** Generate and send the morning briefing via Signal + web broadcast. */
export async function runMorningBriefing(): Promise<void> {
  logger.info('Generating morning briefing...');
  const briefingText = await getBriefingText();

  // Broadcast to web UI
  if (broadcastFn) {
    broadcastFn('morning_briefing', { text: briefingText, generatedAt: new Date().toISOString() });
  }

  // Send via Signal
  try {
    const { signalInterface } = await import('../../interfaces/signal.js');
    if (signalInterface.isAvailable()) {
      await signalInterface.send({
        recipient: getOwnerNumber(),
        content: briefingText,
      });
      logger.info('Morning briefing sent via Signal');
    }
  } catch {
    logger.debug('Could not send briefing via Signal');
  }

  logger.info('Morning briefing complete');
}

// --- Scheduler registration ---

export function registerBriefingHandler(): void {
  import('./engine.js')
    .then(({ registerHandler }) => {
      registerHandler('morning_briefing', runMorningBriefing);
    })
    .catch(() => {});
}
