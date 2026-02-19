// smoke test
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
    model: 'claude-sonnet-4-5-20250929',
    haiku_model: 'claude-3-5-haiku-20241022',
    max_tokens: 500
  },
  projects: {
    directories: [process.env.HOME || '/home/jeeves'],
    scan_depth: 2,
    markers: ['.git', 'package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml'],
    exclude: ['node_modules', '.git', 'dist', 'build', '.next', '.cache', 'cache']
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
  prd: {
    enabled: true,
    triggers: [
      "here's a prd",
      "here is a prd",
      "build this",
      "implement this",
      "implement this spec",
      "here's what i need",
      "execute this prd",
      "prd:"
    ],
    auto_approve: false,
    checkpoint_frequency: 'none',  // Auto-continue through all phases without waiting
    auto_commit: true,
    branch_strategy: 'feature-branch',
    pause_timeout_minutes: 0  // No timeout since we auto-continue
  },
  trust: {
    enabled: true,
    initial_level: 2 as const,  // Start at semi-autonomous
    successful_tasks_required: 10,
    rollbacks_allowed: 0,
    time_at_level_minimum_days: 7,
    monthly_spend_limit: 50,
    per_task_spend_limit: 10
  },
  server: {
    host: process.env.HOST || '127.0.0.1',
    port: parseInt(process.env.PORT || '3847', 10),
    tls: (() => {
      const keyPath = process.env.TLS_KEY_PATH;
      const certPath = process.env.TLS_CERT_PATH;
      if (!keyPath || !certPath || !existsSync(keyPath) || !existsSync(certPath)) return undefined;
      return { keyPath, certPath };
    })()
  },
  rate_limits: {
    messages_per_minute: 10,
    messages_per_hour: 100,
    messages_per_day: 500
  },
  safety: {
    backupEnabled: true,
    backupRetentionHours: 24,
    maxShrinkagePercent: 50,
    validateContent: true,
    atomicWrites: true,
    gitAutoStash: false  // Opt-in - can cause confusion
  },
  budgets: {
    dailyHardCap: 5.00,          // $5/day — everything stops
    hourlySoftCap: 2.00,         // $2/hr — throttle to Haiku-only
    circuitBreakerThreshold: 3,  // 3 consecutive failures → pause
    circuitBreakerPauseMs: 60000,// 60s pause
    features: {
      conversation:       { maxTokens: 200,  maxCallsPerPeriod: 0,  periodMs: 3600000,  dailyCap: 0.10 },
      parser:             { maxTokens: 500,  maxCallsPerPeriod: 0,  periodMs: 0,        dailyCap: 0 },     // core — uncapped
      prd_builder:        { maxTokens: 2000, maxCallsPerPeriod: 15, periodMs: 3600000,  dailyCap: 2.00 },
      scout_relevance:    { maxTokens: 150,  maxCallsPerPeriod: 20, periodMs: 86400000, dailyCap: 0.50 },
      scout_digest:       { maxTokens: 500,  maxCallsPerPeriod: 1,  periodMs: 86400000, dailyCap: 0.01 },
      security_triage:    { maxTokens: 300,  maxCallsPerPeriod: 10, periodMs: 3600000,  dailyCap: 0.25 },
      freelance_analysis: { maxTokens: 500,  maxCallsPerPeriod: 5,  periodMs: 86400000, dailyCap: 0.10 },
      decision_predict:   { maxTokens: 200,  maxCallsPerPeriod: 20, periodMs: 86400000, dailyCap: 0.05 },
      cursor_refinement:  { maxTokens: 500,  maxCallsPerPeriod: 10, periodMs: 86400000, dailyCap: 0.50 },
      self_proposals:     { maxTokens: 600,  maxCallsPerPeriod: 2,  periodMs: 86400000, dailyCap: 0.02 },
      voice_transcription: { maxTokens: 0,  maxCallsPerPeriod: 20, periodMs: 86400000, dailyCap: 0.50 },
      changelog:          { maxTokens: 200, maxCallsPerPeriod: 10, periodMs: 604800000, dailyCap: 0.05 },
      cost_advisor:       { maxTokens: 300, maxCallsPerPeriod: 2,  periodMs: 604800000, dailyCap: 0.02 },
    }
  },
  voice: {
    enabled: process.env.VOICE_ENABLED === 'true',
    piperUrl: process.env.PIPER_URL || 'http://127.0.0.1:10200',
    piperVoice: process.env.PIPER_VOICE || 'en_GB-alan-medium',
    whisperUrl: process.env.WHISPER_URL || 'http://127.0.0.1:10300',
    wakeModelPath: process.env.VOICE_WAKE_MODEL_PATH || resolve(ROOT_DIR, 'models', 'wake', 'hey_jeeves.onnx')
  },
  homelab: {
    enabled: false,  // Only enable on Linux homelab box
    stacksDir: '/opt/stacks',
    configsDir: '/opt/configs',
    backupsDir: '/opt/backups',
    dataDir: '/data',
    maxRamMB: 14336,             // 14GB hard limit (reserve 2GB for OS + Jeeves)
    monitorInterval: 300000,     // Check every 5 minutes (was 60s, ufw calls are expensive)
    thresholds: {
      cpu: { warning: 80, critical: 95 },
      ram: { warning: 85, critical: 95 },
      disk: { warning: 80, critical: 90 },
      temp: { warning: 75, critical: 85 }  // N150 throttles at ~90C
    }
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
      projects: (() => {
        const merged = { ...defaultConfig.projects, ...fileConfig.projects };
        if (!merged.directories?.length) merged.directories = defaultConfig.projects.directories;
        return merged;
      })(),
      commands: { ...defaultConfig.commands, ...fileConfig.commands },
      terminal: { ...defaultConfig.terminal, ...fileConfig.terminal },
      memory: { ...defaultConfig.memory, ...fileConfig.memory },
      prd: { ...defaultConfig.prd, ...fileConfig.prd },
      trust: { ...defaultConfig.trust, ...fileConfig.trust },
      server: { ...defaultConfig.server, ...fileConfig.server },
      rate_limits: { ...defaultConfig.rate_limits, ...fileConfig.rate_limits },
      safety: { ...defaultConfig.safety, ...fileConfig.safety },
      budgets: {
        ...defaultConfig.budgets,
        ...((fileConfig as Record<string, unknown>).budgets as Partial<Config['budgets']> || {}),
        features: {
          ...defaultConfig.budgets.features,
          ...(((fileConfig as Record<string, unknown>).budgets as Partial<Config['budgets']>)?.features || {})
        }
      },
      homelab: {
        ...defaultConfig.homelab,
        ...(fileConfig as Record<string, unknown>).homelab as Partial<Config['homelab']> || {},
        thresholds: {
          ...defaultConfig.homelab.thresholds,
          ...((((fileConfig as Record<string, unknown>).homelab as Partial<Config['homelab']>)?.thresholds) || {})
        }
      },
      voice: fileConfig.voice !== undefined
        ? { ...defaultConfig.voice!, ...(fileConfig as Record<string, unknown>).voice as Partial<Config['voice']> }
        : defaultConfig.voice
    };

    return merged;
  } catch (error) {
    console.error('[config] Error loading config.json:', error);
    return defaultConfig;
  }
}

// Export singleton config
export const config = loadConfig();

/** Number to send proactive notifications to (owner's phone). Use first allowed_number, not the bot's own number (which would be Note to Self when phone is linked). */
export function getOwnerNumber(): string {
  const owner = config.security.allowed_numbers[0];
  return owner || config.signal.number;
}

// Validate critical configuration
export function validateConfig(): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // API key required for local development (Vercel AI Gateway handles it in prod)
  if (!process.env.ANTHROPIC_API_KEY) {
    errors.push('ANTHROPIC_API_KEY environment variable is required');
  }

  if (!config.projects.directories?.length) {
    errors.push('No project directories configured (set projects.directories in config.json or HOME)');
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
