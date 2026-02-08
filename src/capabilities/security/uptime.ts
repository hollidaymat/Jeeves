/**
 * Client Site Uptime Monitoring
 * 
 * Checks all live client sites every 5 minutes via HTTP.
 * Alerts on downtime, tracks history, attempts auto-redeploy.
 * Registered as scheduler handler 'uptime_check'.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_FILE = resolve(__dirname, '..', '..', '..', 'data', 'uptime.json');

// Types
export interface UptimeRecord {
  clientId: string;
  clientName: string;
  url: string;
  timestamp: string;
  healthy: boolean;
  statusCode: number;
  responseTime: number;  // ms
}

export interface ClientUptimeStatus {
  clientId: string;
  clientName: string;
  url: string;
  currentlyUp: boolean;
  lastCheck: string;
  lastDown?: string;
  uptime24h: number;  // percentage
  avgResponseTime: number;
  checksTotal: number;
  checksHealthy: number;
  recentHistory: UptimeRecord[];  // last 20
}

interface UptimeStore {
  records: Record<string, UptimeRecord[]>;  // clientId -> records (last 288 = 24h at 5min intervals)
  alerts: Array<{ clientId: string; clientName: string; timestamp: string; message: string }>;
  lastUpdated: string;
}

// State
let store: UptimeStore | null = null;
let broadcastFn: ((type: string, payload: unknown) => void) | null = null;

const MAX_RECORDS_PER_CLIENT = 288;  // 24h at 5min intervals
const MAX_ALERTS = 100;

export function setUptimeBroadcast(fn: (type: string, payload: unknown) => void): void {
  broadcastFn = fn;
}

function broadcast(type: string, payload: unknown): void {
  if (broadcastFn) broadcastFn(type, payload);
}

// Persistence
function loadStore(): UptimeStore {
  if (store) return store;
  try {
    if (existsSync(DATA_FILE)) {
      store = JSON.parse(readFileSync(DATA_FILE, 'utf-8'));
    }
  } catch { /* corrupt */ }
  if (!store) {
    store = { records: {}, alerts: [], lastUpdated: '' };
  }
  return store;
}

function saveStore(): void {
  if (!store) return;
  store.lastUpdated = new Date().toISOString();
  try {
    writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
  } catch (err) {
    logger.error('Failed to save uptime store', { error: String(err) });
  }
}

/**
 * Parse HTTP status code from IndividualCheck details string (e.g. "HTTP 200").
 */
function parseStatusCode(details?: string): number {
  if (!details) return 0;
  const match = details.match(/HTTP (\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

/**
 * Run uptime checks on all live clients.
 * This is the scheduled handler function.
 */
export async function runUptimeCheck(): Promise<void> {
  const s = loadStore();

  let clients: Array<{ id: string; businessName: string; subdomain: string; status: string }> = [];
  try {
    const { getClients } = await import('../saas-builder/client-registry.js');
    clients = getClients().filter(c => c.status === 'live' && c.subdomain);
  } catch {
    logger.debug('Client registry not available for uptime checks');
    return;
  }

  if (clients.length === 0) return;

  // Import health checker — returns IndividualCheck { passed, responseTimeMs, details?, error? }
  let doHealthCheck: (url: string) => Promise<{ healthy: boolean; statusCode: number; responseTime: number }>;
  try {
    const hc = await import('../../homelab/services/health-checker.js');
    doHealthCheck = async (url: string) => {
      const result = await hc.httpHealthCheck(url, 10000);
      return {
        healthy: result.passed,
        statusCode: parseStatusCode(result.details),
        responseTime: result.responseTimeMs,
      };
    };
  } catch {
    // Health checker not available, use raw fetch as fallback
    doHealthCheck = async (url: string) => {
      const start = Date.now();
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        return { healthy: res.ok, statusCode: res.status, responseTime: Date.now() - start };
      } catch {
        return { healthy: false, statusCode: 0, responseTime: Date.now() - start };
      }
    };
  }

  for (const client of clients) {
    const url = `https://${client.subdomain}`;
    try {
      const result = await doHealthCheck(url);

      const record: UptimeRecord = {
        clientId: client.id,
        clientName: client.businessName,
        url,
        timestamp: new Date().toISOString(),
        healthy: result.healthy,
        statusCode: result.statusCode,
        responseTime: result.responseTime,
      };

      // Store record
      if (!s.records[client.id]) s.records[client.id] = [];
      s.records[client.id].push(record);
      if (s.records[client.id].length > MAX_RECORDS_PER_CLIENT) {
        s.records[client.id] = s.records[client.id].slice(-MAX_RECORDS_PER_CLIENT);
      }

      // Alert on downtime
      if (!result.healthy) {
        const prevRecords = s.records[client.id];
        const wasUpBefore = prevRecords.length >= 2 && prevRecords[prevRecords.length - 2]?.healthy;

        if (wasUpBefore || prevRecords.length <= 1) {
          // Just went down — alert
          const alert = {
            clientId: client.id,
            clientName: client.businessName,
            timestamp: new Date().toISOString(),
            message: `${client.businessName} (${url}) is DOWN. Status: ${result.statusCode || 'timeout'}`,
          };
          s.alerts.unshift(alert);
          if (s.alerts.length > MAX_ALERTS) s.alerts.pop();

          logger.warn('Client site DOWN', { client: client.businessName, url, statusCode: result.statusCode });
          broadcast('uptime:site_down', alert);

          // Send Signal alert
          try {
            const { getOwnerNumber } = await import('../../config.js');
            const { signalInterface } = await import('../../interfaces/signal.js');
            if (signalInterface.isAvailable()) {
              await signalInterface.send({
                recipient: getOwnerNumber(),
                content: `ALERT: ${alert.message}`,
              });
            }
          } catch { /* Signal not available */ }
        }
      }

    } catch (err) {
      logger.debug('Uptime check failed for client', { client: client.businessName, error: String(err) });
    }
  }

  saveStore();
}

/**
 * Get uptime status for all clients.
 */
export function getUptimeStatus(): ClientUptimeStatus[] {
  const s = loadStore();
  const statuses: ClientUptimeStatus[] = [];

  for (const [clientId, records] of Object.entries(s.records)) {
    if (records.length === 0) continue;

    const latest = records[records.length - 1];
    const healthy = records.filter(r => r.healthy);
    const totalResponseTime = records.reduce((sum, r) => sum + r.responseTime, 0);
    const lastDown = [...records].reverse().find(r => !r.healthy);

    statuses.push({
      clientId,
      clientName: latest.clientName,
      url: latest.url,
      currentlyUp: latest.healthy,
      lastCheck: latest.timestamp,
      lastDown: lastDown?.timestamp,
      uptime24h: records.length > 0 ? Math.round((healthy.length / records.length) * 10000) / 100 : 100,
      avgResponseTime: records.length > 0 ? Math.round(totalResponseTime / records.length) : 0,
      checksTotal: records.length,
      checksHealthy: healthy.length,
      recentHistory: records.slice(-20),
    });
  }

  return statuses;
}

/**
 * Get uptime for a specific client.
 */
export function getClientUptime(clientId: string): ClientUptimeStatus | null {
  const all = getUptimeStatus();
  return all.find(s => s.clientId === clientId) || null;
}

/**
 * Get recent alerts.
 */
export function getUptimeAlerts(limit = 20): Array<{ clientId: string; clientName: string; timestamp: string; message: string }> {
  return loadStore().alerts.slice(0, limit);
}

/**
 * Register with the scheduler.
 */
export function registerUptimeHandler(): void {
  import('../scheduler/engine.js').then(({ registerHandler }) => {
    registerHandler('uptime_check', runUptimeCheck);
  }).catch(() => {});
}
