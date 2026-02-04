/**
 * Structured Logger
 * JSON-formatted logging with levels and metadata
 */

import type { LogLevel, LogEntry } from '../types/index.js';

// WebSocket clients to broadcast logs to
let wsClients: Set<{ send: (data: string) => void }> = new Set();

export function registerWSClient(client: { send: (data: string) => void }) {
  wsClients.add(client);
}

export function unregisterWSClient(client: { send: (data: string) => void }) {
  wsClients.delete(client);
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

const currentLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || 'info';

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

function formatTimestamp(): string {
  return new Date().toISOString();
}

function colorize(level: LogLevel, text: string): string {
  const colors: Record<LogLevel, string> = {
    debug: '\x1b[90m',  // gray
    info: '\x1b[36m',   // cyan
    warn: '\x1b[33m',   // yellow
    error: '\x1b[31m'   // red
  };
  const reset = '\x1b[0m';
  return `${colors[level]}${text}${reset}`;
}

function log(level: LogLevel, message: string, data?: Record<string, unknown>) {
  if (!shouldLog(level)) return;

  const entry: LogEntry = {
    timestamp: formatTimestamp(),
    level,
    message,
    ...(data && { data })
  };

  // Console output with colors
  const prefix = colorize(level, `[${entry.timestamp}] [${level.toUpperCase()}]`);
  const dataStr = data ? ` ${JSON.stringify(data)}` : '';
  console.log(`${prefix} ${message}${dataStr}`);

  // Broadcast to WebSocket clients
  const wsMessage = JSON.stringify({
    type: 'log',
    payload: entry
  });
  
  wsClients.forEach(client => {
    try {
      client.send(wsMessage);
    } catch {
      // Client disconnected, will be cleaned up
    }
  });
}

export const logger = {
  debug: (message: string, data?: Record<string, unknown>) => log('debug', message, data),
  info: (message: string, data?: Record<string, unknown>) => log('info', message, data),
  warn: (message: string, data?: Record<string, unknown>) => log('warn', message, data),
  error: (message: string, data?: Record<string, unknown>) => log('error', message, data),

  // Security-specific logging
  security: {
    authorized: (sender: string, action: string) => {
      log('info', `Authorized request`, { sender, action, security: true });
    },
    unauthorized: (sender: string) => {
      log('warn', `Unauthorized attempt`, { sender, security: true });
    },
    command: (action: string, target: string, success: boolean) => {
      log('info', `Command executed`, { action, target, success, security: true });
    }
  }
};
