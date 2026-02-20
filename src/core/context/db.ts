/**
 * Knowledge Database
 * 
 * SQLite-backed storage for all 6 context layers.
 * Single database at data/knowledge.db with tables for:
 * - schema_snapshots (Layer 1)
 * - annotations (Layer 2)
 * - patterns (Layer 3)
 * - doc_chunks (Layer 4)
 * - learnings (Layer 5)
 */

import Database from 'better-sqlite3';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { logger } from '../../utils/logger.js';

// ==========================================
// DATABASE SINGLETON
// ==========================================

let db: Database.Database | null = null;

const DB_DIR = join(process.cwd(), 'data', 'knowledge');
const DB_PATH = join(DB_DIR, 'knowledge.db');

/**
 * Get or initialize the knowledge database.
 */
export function getDb(): Database.Database {
  if (db) return db;

  // Ensure directory exists
  if (!existsSync(DB_DIR)) {
    mkdirSync(DB_DIR, { recursive: true });
  }

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  runMigrations(db);
  logger.info('Knowledge database initialized', { path: DB_PATH });

  return db;
}

/**
 * Close the database connection.
 */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
    logger.debug('Knowledge database closed');
  }
}

// ==========================================
// MIGRATIONS
// ==========================================

function runMigrations(database: Database.Database): void {
  database.exec(`
    -- Migration tracking
    CREATE TABLE IF NOT EXISTS migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );
  `);

  const applied = new Set(
    database.prepare('SELECT name FROM migrations').all().map((r: any) => r.name)
  );

  const migrations: Array<{ name: string; sql: string }> = [
    {
      name: '001_initial_schema',
      sql: `
        -- Layer 1: Schema snapshots (infrastructure state)
        CREATE TABLE IF NOT EXISTS schema_snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
          data TEXT NOT NULL
        );

        -- Layer 2: Annotations (owner rules & preferences)
        CREATE TABLE IF NOT EXISTS annotations (
          id TEXT PRIMARY KEY,
          category TEXT NOT NULL,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          added_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
          source TEXT DEFAULT 'seed'
        );
        CREATE INDEX IF NOT EXISTS idx_annotations_category ON annotations(category);
        CREATE INDEX IF NOT EXISTS idx_annotations_key ON annotations(key);

        -- Layer 3: Patterns (proven solutions)
        CREATE TABLE IF NOT EXISTS patterns (
          id TEXT PRIMARY KEY,
          description TEXT NOT NULL,
          steps TEXT NOT NULL,
          rollback TEXT,
          success_count INTEGER DEFAULT 1,
          last_used INTEGER,
          category TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_patterns_category ON patterns(category);

        -- Layer 4: Doc chunks (indexed documentation)
        CREATE TABLE IF NOT EXISTS doc_chunks (
          id TEXT PRIMARY KEY,
          source_file TEXT NOT NULL,
          section TEXT,
          content TEXT NOT NULL,
          keywords TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_doc_chunks_source ON doc_chunks(source_file);

        -- Layer 5: Learnings (error patterns & fixes)
        CREATE TABLE IF NOT EXISTS learnings (
          id TEXT PRIMARY KEY,
          timestamp INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
          category TEXT NOT NULL,
          trigger_text TEXT NOT NULL,
          root_cause TEXT,
          fix TEXT NOT NULL,
          lesson TEXT NOT NULL,
          applies_to TEXT,
          confidence REAL DEFAULT 0.5,
          times_applied INTEGER DEFAULT 0,
          times_failed INTEGER DEFAULT 0,
          superseded_by TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_learnings_category ON learnings(category);
        CREATE INDEX IF NOT EXISTS idx_learnings_applies_to ON learnings(applies_to);
        CREATE INDEX IF NOT EXISTS idx_learnings_confidence ON learnings(confidence);
      `
    },
    {
      name: '002_growth_tables',
      sql: `
        -- Growth: persisted OODA traces for learning (beyond in-memory window)
        CREATE TABLE IF NOT EXISTS growth_ooda_traces (
          request_id TEXT PRIMARY KEY,
          timestamp INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
          routing_path TEXT NOT NULL,
          raw_input TEXT NOT NULL,
          context_loaded TEXT NOT NULL DEFAULT '[]',
          classification TEXT,
          confidence_score REAL,
          action TEXT NOT NULL,
          success INTEGER NOT NULL DEFAULT 1,
          total_time_ms INTEGER DEFAULT 0,
          model_used TEXT,
          loop_count INTEGER DEFAULT 1
        );
        CREATE INDEX IF NOT EXISTS idx_growth_ooda_routing ON growth_ooda_traces(routing_path);
        CREATE INDEX IF NOT EXISTS idx_growth_ooda_timestamp ON growth_ooda_traces(timestamp);

        -- Growth: scenario run history for NovelScenarioGenerator and AntiGaming
        CREATE TABLE IF NOT EXISTS growth_scenario_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          scenario_id TEXT NOT NULL,
          run_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
          passed INTEGER NOT NULL DEFAULT 0,
          response_ms INTEGER,
          ooda_request_id TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_growth_scenario_id ON growth_scenario_runs(scenario_id);
        CREATE INDEX IF NOT EXISTS idx_growth_scenario_run_at ON growth_scenario_runs(run_at);

        -- Growth: Cursor task outcomes for feedback loop
        CREATE TABLE IF NOT EXISTS growth_cursor_outcomes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT NOT NULL,
          status TEXT NOT NULL,
          summary TEXT,
          pr_url TEXT,
          completed_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
        );
        CREATE INDEX IF NOT EXISTS idx_growth_cursor_task ON growth_cursor_outcomes(task_id);
      `
    },
    {
      name: '003_cognitive_fix',
      sql: `
        -- Preferences (owner rules per domain)
        CREATE TABLE IF NOT EXISTS preferences (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          domain TEXT DEFAULT 'global',
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          source TEXT DEFAULT 'inferred',
          created_at INTEGER DEFAULT (strftime('%s', 'now'))
        );
        CREATE INDEX IF NOT EXISTS idx_preferences_domain ON preferences(domain);

        -- Decisions (decision log for learning)
        CREATE TABLE IF NOT EXISTS decisions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          category TEXT NOT NULL,
          context_summary TEXT,
          decision TEXT NOT NULL,
          reasoning TEXT,
          confidence REAL,
          timestamp INTEGER DEFAULT (strftime('%s', 'now'))
        );
        CREATE INDEX IF NOT EXISTS idx_decisions_category ON decisions(category);

        -- Cognitive traces (debug + growth comparison)
        CREATE TABLE IF NOT EXISTS cognitive_traces (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          message_id TEXT,
          message TEXT,
          classification TEXT,
          context_loaded TEXT,
          token_budget INTEGER,
          model TEXT,
          response_time_ms INTEGER,
          confidence REAL,
          timestamp INTEGER DEFAULT (strftime('%s', 'now'))
        );
        CREATE INDEX IF NOT EXISTS idx_cognitive_traces_timestamp ON cognitive_traces(timestamp);
        CREATE INDEX IF NOT EXISTS idx_cognitive_traces_classification ON cognitive_traces(classification);
        CREATE INDEX IF NOT EXISTS idx_cognitive_traces_message_id ON cognitive_traces(message_id);
      `
    },
    {
      name: '004_growth_run_summaries',
      sql: `
        -- Growth run summaries (Phase 6: after each test run)
        CREATE TABLE IF NOT EXISTS growth_run_summaries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
          total_pass INTEGER NOT NULL DEFAULT 0,
          total_fail INTEGER NOT NULL DEFAULT 0,
          novel_pass INTEGER NOT NULL DEFAULT 0,
          novel_fail INTEGER NOT NULL DEFAULT 0,
          context_loaded_rate REAL NOT NULL DEFAULT 0,
          avg_confidence_score REAL
        );
        CREATE INDEX IF NOT EXISTS idx_growth_run_summaries_run_at ON growth_run_summaries(run_at);
      `
    },
    {
      name: '005_execution_log',
      sql: `
        -- Execution log: plan runs and dev_task runs (so we can tell if Jeeves succeeded)
        CREATE TABLE IF NOT EXISTS execution_log (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          description TEXT NOT NULL,
          trigger_message TEXT,
          project_root TEXT NOT NULL,
          outcome TEXT NOT NULL,
          steps_json TEXT NOT NULL DEFAULT '[]',
          summary TEXT,
          created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
        );
        CREATE INDEX IF NOT EXISTS idx_execution_log_created_at ON execution_log(created_at);
        CREATE INDEX IF NOT EXISTS idx_execution_log_outcome ON execution_log(outcome);
      `
    },
    {
      name: '006_reasoning_tables',
      sql: `
        -- Reasoning evaluation: one row per completed task (for REASONING tab metrics)
        CREATE TABLE IF NOT EXISTS reasoning_tasks (
          id TEXT PRIMARY KEY,
          timestamp INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
          task_type TEXT NOT NULL,
          success INTEGER NOT NULL DEFAULT 0,
          confidence REAL,
          iterations INTEGER NOT NULL DEFAULT 1,
          test_passed INTEGER,
          trace_id TEXT,
          classification TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_reasoning_tasks_timestamp ON reasoning_tasks(timestamp);
        CREATE INDEX IF NOT EXISTS idx_reasoning_tasks_task_type ON reasoning_tasks(task_type);
        CREATE INDEX IF NOT EXISTS idx_reasoning_tasks_success ON reasoning_tasks(success);
        CREATE INDEX IF NOT EXISTS idx_reasoning_tasks_confidence ON reasoning_tasks(confidence);

        -- Error occurrences for "common errors & recurrence" and "fixed by learning"
        CREATE TABLE IF NOT EXISTS reasoning_error_occurrences (
          id TEXT PRIMARY KEY,
          timestamp INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
          error_type TEXT NOT NULL,
          learning_id TEXT,
          FOREIGN KEY (learning_id) REFERENCES learnings(id)
        );
        CREATE INDEX IF NOT EXISTS idx_reasoning_errors_error_type ON reasoning_error_occurrences(error_type);
        CREATE INDEX IF NOT EXISTS idx_reasoning_errors_timestamp ON reasoning_error_occurrences(timestamp);
      `
    },
    {
      name: '007_performance_profiler',
      sql: `
        -- Performance profiler: raw metrics from instrumented code
        CREATE TABLE IF NOT EXISTS performance_metrics (
          id TEXT PRIMARY KEY,
          timestamp INTEGER NOT NULL,
          category TEXT NOT NULL,
          source TEXT NOT NULL,
          metric_name TEXT NOT NULL,
          value REAL NOT NULL,
          metadata TEXT,
          created_at INTEGER DEFAULT (strftime('%s', 'now'))
        );
        CREATE INDEX IF NOT EXISTS idx_perf_metrics_timestamp ON performance_metrics(timestamp);
        CREATE INDEX IF NOT EXISTS idx_perf_metrics_category ON performance_metrics(category);
        CREATE INDEX IF NOT EXISTS idx_perf_metrics_source ON performance_metrics(source);

        -- System snapshots (CPU, memory, disk, load, docker) every 60s
        CREATE TABLE IF NOT EXISTS performance_snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp INTEGER NOT NULL,
          cpu_percent REAL,
          memory_used_mb REAL,
          memory_total_mb REAL,
          disk_used_gb REAL,
          disk_total_gb REAL,
          docker_containers_running INTEGER,
          docker_containers_total INTEGER,
          uptime_seconds INTEGER,
          load_average_1m REAL,
          load_average_5m REAL,
          load_average_15m REAL
        );
        CREATE INDEX IF NOT EXISTS idx_perf_snapshots_timestamp ON performance_snapshots(timestamp);

        -- Detected bottlenecks (keep indefinitely)
        CREATE TABLE IF NOT EXISTS bottlenecks (
          id TEXT PRIMARY KEY,
          detected_at INTEGER NOT NULL,
          category TEXT NOT NULL,
          source TEXT NOT NULL,
          severity TEXT NOT NULL,
          description TEXT NOT NULL,
          recommendation TEXT NOT NULL,
          auto_fixable INTEGER DEFAULT 0,
          resolved INTEGER DEFAULT 0,
          resolved_at INTEGER
        );

        -- Optimizer recommendations
        CREATE TABLE IF NOT EXISTS performance_recommendations (
          id TEXT PRIMARY KEY,
          created_at INTEGER NOT NULL,
          priority TEXT NOT NULL,
          category TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          action TEXT NOT NULL,
          auto_action TEXT,
          impact TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending'
        );
      `
    },
    {
      name: '008_orchestrator_tables',
      sql: `
        CREATE TABLE IF NOT EXISTS orchestrator_tasks (
          task_id TEXT PRIMARY KEY,
          prd TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
          completed_at INTEGER,
          final_code TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_orchestrator_tasks_status ON orchestrator_tasks(status);
        CREATE INDEX IF NOT EXISTS idx_orchestrator_tasks_created_at ON orchestrator_tasks(created_at);

        CREATE TABLE IF NOT EXISTS orchestrator_task_iterations (
          task_id TEXT NOT NULL,
          iteration INTEGER NOT NULL,
          spec TEXT NOT NULL,
          antigravity_output TEXT,
          test_result TEXT,
          error TEXT,
          jeeves_action TEXT,
          duration_ms INTEGER,
          PRIMARY KEY (task_id, iteration)
        );
        CREATE INDEX IF NOT EXISTS idx_orchestrator_iterations_task ON orchestrator_task_iterations(task_id);

        CREATE TABLE IF NOT EXISTS orchestrator_playbooks (
          pattern TEXT PRIMARY KEY,
          success_rate REAL NOT NULL DEFAULT 0,
          avg_iterations REAL NOT NULL DEFAULT 0,
          common_errors TEXT NOT NULL DEFAULT '[]',
          winning_spec_template TEXT,
          last_updated INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
        );
      `
    }
  ];

  const insertMigration = database.prepare('INSERT INTO migrations (name) VALUES (?)');

  for (const migration of migrations) {
    if (!applied.has(migration.name)) {
      logger.info('Running migration', { name: migration.name });
      database.exec(migration.sql);
      insertMigration.run(migration.name);
    }
  }
}

// ==========================================
// HELPER FUNCTIONS
// ==========================================

/**
 * Generate a unique ID with a prefix.
 */
export function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

/**
 * Estimate token count from a string (rough: ~4 chars per token).
 */
export function estimateTokens(data: unknown): number {
  const str = typeof data === 'string' ? data : JSON.stringify(data);
  return Math.ceil(str.length / 4);
}
