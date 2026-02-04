/**
 * Configuration Loader
 * Loads config from .env and config.json with sensible defaults
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config as dotenvConfig } from 'dotenv';
import type { Config } from './types/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = resolve(__dirname, '..');

// Load .env file
dotenvConfig({ path: resolve(ROOT_DIR, '.env') });

// Default configuration
const defaultConfig: Config = {
  signal: {
    number: process.env.SIGNAL_PHONE_NUMBER || '',
    socket: '/tmp/signal-cli.sock'
  },
  security: {
    allowed_numbers: [],
    log_unauthorized: true,
    silent_deny: true
  },
  claude: {
    model: 'anthropic/claude-sonnet-4.5',
    haiku_model: 'anthropic/claude-haiku-4',
    max_tokens: 500
  },
  projects: {
    directories: [],
    scan_depth: 2,
    markers: ['.git', 'package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml'],
    exclude: ['node_modules', '.git', 'dist', 'build', '.next']
  },
  commands: {
    cursor: process.platform === 'win32'
      ? 'C:\\Users\\matth\\AppData\\Local\\Programs\\cursor\\resources\\app\\bin\\cursor.cmd'
      : '/usr/bin/cursor'
  },
  terminal: {
    timeout_ms: 120000,
    max_output_lines: 200,
    max_output_chars: 10000,
    allowed_npm_scripts: ['dev', 'start', 'build', 'test', 'lint', 'format', 'watch', 'serve', 'typecheck'],
    allowed_git_commands: ['status', 'pull', 'fetch', 'diff', 'log', 'branch', 'stash', 'checkout'],
    custom_commands: {}
  },
  memory: {
    enabled: true,
    max_conversations_per_project: 100,
    max_messages_per_conversation: 50,
    storage_path: './data/memory.json',
    auto_summarize: false
  },
  server: {
    host: process.env.HOST || '127.0.0.1',
    port: parseInt(process.env.PORT || '3847', 10)
  },
  rate_limits: {
    messages_per_minute: 10,
    messages_per_hour: 100,
    messages_per_day: 500
  }
};

/**
 * Load configuration from config.json, merging with defaults
 */
function loadConfig(): Config {
  const configPath = resolve(ROOT_DIR, 'config.json');
  
  if (!existsSync(configPath)) {
    console.warn('[config] No config.json found, using defaults');
    console.warn('[config] Copy config.example.json to config.json and customize');
    return defaultConfig;
  }

  try {
    const fileContent = readFileSync(configPath, 'utf-8');
    const fileConfig = JSON.parse(fileContent) as Partial<Config>;
    
    // Deep merge with defaults
    const merged: Config = {
      signal: { ...defaultConfig.signal, ...fileConfig.signal },
      security: { ...defaultConfig.security, ...fileConfig.security },
      claude: { ...defaultConfig.claude, ...fileConfig.claude },
      projects: { ...defaultConfig.projects, ...fileConfig.projects },
      commands: { ...defaultConfig.commands, ...fileConfig.commands },
      terminal: { ...defaultConfig.terminal, ...fileConfig.terminal },
      memory: { ...defaultConfig.memory, ...fileConfig.memory },
      server: { ...defaultConfig.server, ...fileConfig.server },
      rate_limits: { ...defaultConfig.rate_limits, ...fileConfig.rate_limits }
    };

    return merged;
  } catch (error) {
    console.error('[config] Error loading config.json:', error);
    return defaultConfig;
  }
}

// Export singleton config
export const config = loadConfig();

// Validate critical configuration
export function validateConfig(): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // API key required for local development (Vercel AI Gateway handles it in prod)
  if (!process.env.ANTHROPIC_API_KEY) {
    errors.push('ANTHROPIC_API_KEY environment variable is required');
  }

  if (config.projects.directories.length === 0) {
    errors.push('No project directories configured');
  }

  if (!existsSync(config.commands.cursor)) {
    errors.push(`Cursor CLI not found at: ${config.commands.cursor}`);
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

export const ROOT = ROOT_DIR;
