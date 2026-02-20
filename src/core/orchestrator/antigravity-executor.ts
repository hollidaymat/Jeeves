/**
 * Antigravity executor: runs antigravity CLI with spec file, returns execution result.
 * Supports: (1) stub, (2) antigravity chat (editor CLI), (3) hypothetical antigravity execute.
 * When ANTIGRAVITY_SERVE_WEB=true, spawns antigravity serve-web so you can watch the session in a browser for QA.
 */

import { execSync, spawn } from 'child_process';
import { existsSync, readFileSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import type { AntigravitySpec, ExecutionResult } from './types.js';
import { logger } from '../../utils/logger.js';

const TASK_TEMP_DIR = process.env.TASK_TEMP_DIR || '/tmp/antigravity_tasks';
const TASK_OUTPUT_DIR = process.env.TASK_OUTPUT_DIR || '/tmp/antigravity_output';
const ANTIGRAVITY_MODEL = process.env.ANTIGRAVITY_MODEL || 'claude-sonnet-4-20250514';
const ANTIGRAVITY_STUB = process.env.ANTIGRAVITY_STUB === 'true';
/** Use `antigravity chat --mode agent` with the spec file instead of `antigravity execute` (which does not exist on the editor CLI). */
const ANTIGRAVITY_USE_CHAT = process.env.ANTIGRAVITY_USE_CHAT === 'true';
/** When true, spawn `antigravity serve-web` so the editor UI is available in a browser for QA. */
const ANTIGRAVITY_SERVE_WEB = process.env.ANTIGRAVITY_SERVE_WEB === 'true';
const ANTIGRAVITY_SERVE_WEB_PORT = process.env.ANTIGRAVITY_SERVE_WEB_PORT || '3010';

let serveWebStarted = false;
let lastServeWebUrl: string | undefined;

/** Path Antigravity uses for serve-web (Linux APT package does not include it). */
const TUNNEL_BIN = '/usr/share/antigravity/bin/antigravity-tunnel';

function isServeWebAvailable(): boolean {
  return existsSync(TUNNEL_BIN);
}

/** QA browser URL when ANTIGRAVITY_SERVE_WEB is set and serve-web is available; so the Orchestration tab can show the link. */
export function getServeWebUrl(): string | undefined {
  if (ANTIGRAVITY_SERVE_WEB && isServeWebAvailable()) {
    return lastServeWebUrl ?? `http://localhost:${ANTIGRAVITY_SERVE_WEB_PORT}`;
  }
  return lastServeWebUrl;
}

/**
 * Run Antigravity CLI. If ANTIGRAVITY_STUB=true, return stub. If ANTIGRAVITY_USE_CHAT=true, use `antigravity chat`.
 */
export async function executeWithAntigravity(spec: AntigravitySpec): Promise<ExecutionResult> {
  const taskFile = join(TASK_TEMP_DIR, `antigravity_task_${spec.task_id}.md`);
  const outputDir = join(TASK_OUTPUT_DIR, spec.task_id);
  const start = Date.now();

  if (ANTIGRAVITY_STUB) {
    logger.info('[orchestrator] Antigravity stub: skipping CLI');
    return {
      task_id: spec.task_id,
      status: 'completed',
      test_results: { passed: true, output: 'stub' },
      duration_ms: Date.now() - start,
    };
  }

  if (ANTIGRAVITY_USE_CHAT) {
    const serveWebUrl = ensureServeWebForBrowser();
    const result = runAntigravityChat(spec, taskFile, start);
    if (serveWebUrl) result.serve_web_url = serveWebUrl;
    return result;
  }

  try {
    const cmd = `antigravity execute --task-file ${JSON.stringify(taskFile)} --model ${ANTIGRAVITY_MODEL} --output-dir ${JSON.stringify(outputDir)}`;
    const result = execSync(cmd, {
      encoding: 'utf-8',
      timeout: 600_000, // 10 min
      maxBuffer: 10 * 1024 * 1024,
    });
    const duration_ms = Date.now() - start;
    const passed = inferTestPassed(result, outputDir);
    return {
      task_id: spec.task_id,
      status: passed ? 'completed' : 'failed',
      test_results: { passed, output: result.slice(-2000) },
      duration_ms,
      stdout: result,
    };
  } catch (err: unknown) {
    const e = err as { status?: number; signal?: string; stdout?: string; stderr?: string };
    const duration_ms = Date.now() - start;
    const stderr = e.stderr ?? (e as Error).message ?? String(err);
    const stdout = e.stdout ?? '';
    logger.warn('[orchestrator] Antigravity CLI failed', { task_id: spec.task_id, stderr: stderr.slice(0, 500) });
    return {
      task_id: spec.task_id,
      status: 'failed',
      test_results: { passed: false, error: stderr, output: stdout },
      duration_ms,
      stdout,
      stderr,
    };
  }
}

/**
 * If ANTIGRAVITY_SERVE_WEB is true, start `antigravity serve-web` in the background once.
 * Returns URL to open in browser for QA, or undefined if not enabled or failed.
 * Note: serve-web requires antigravity-tunnel; the Linux APT package does not ship it.
 */
function ensureServeWebForBrowser(): string | undefined {
  if (!ANTIGRAVITY_SERVE_WEB) return undefined;
  if (!isServeWebAvailable()) {
    logger.debug('[orchestrator] antigravity serve-web skipped: antigravity-tunnel not found (Linux APT package does not include it)');
    return undefined;
  }
  const defaultUrl = `http://localhost:${ANTIGRAVITY_SERVE_WEB_PORT}`;
  if (serveWebStarted) {
    lastServeWebUrl = defaultUrl;
    return defaultUrl;
  }
  serveWebStarted = true;
  lastServeWebUrl = defaultUrl;
  try {
    const child = spawn('antigravity', ['serve-web'], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: ANTIGRAVITY_SERVE_WEB_PORT },
    });
    child.stdout?.on('data', (chunk: Buffer | string) => {
      const s = chunk.toString();
      const m = s.match(/https?:\/\/[^\s'")\]]+/);
      if (m) logger.info('[orchestrator] Antigravity serve-web', { url: m[0] });
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      logger.debug('[orchestrator] antigravity serve-web stderr', { line: chunk.toString().slice(0, 200) });
    });
    child.unref();
  } catch (e) {
    logger.warn('[orchestrator] antigravity serve-web spawn failed', { error: String(e) });
    serveWebStarted = false;
    lastServeWebUrl = undefined;
    return undefined;
  }
  return defaultUrl;
}

/**
 * Start Antigravity serve-web on demand (for QA browser). Call via "start antigravity browser" etc.
 */
export function startAntigravityServeWeb(): { ok: boolean; url?: string; message: string } {
  if (!ANTIGRAVITY_SERVE_WEB) {
    return { ok: false, message: 'Set ANTIGRAVITY_SERVE_WEB=true in your env, then restart Jeeves.' };
  }
  if (!isServeWebAvailable()) {
    return {
      ok: false,
      message: 'serve-web requires antigravity-tunnel; the Linux APT package does not include it. Use the Antigravity desktop app for QA (runs still use antigravity chat).',
    };
  }
  const already = serveWebStarted;
  const url = ensureServeWebForBrowser();
  if (url) {
    return { ok: true, url, message: `Antigravity serve-web ${already ? 'already running' : 'started'}. Open: ${url}` };
  }
  return { ok: false, message: 'Failed to start antigravity serve-web (check logs). Try running `PORT=3010 antigravity serve-web` in a terminal.' };
}

/**
 * Run `antigravity chat --mode agent` with the spec file as context.
 * Note: This may open a GUI window; on a headless server it may fail (e.g. no DISPLAY).
 */
function runAntigravityChat(spec: AntigravitySpec, taskFile: string, startTime: number): ExecutionResult {
  if (!existsSync(taskFile)) {
    return {
      task_id: spec.task_id,
      status: 'failed',
      test_results: { passed: false, error: `Spec file not found: ${taskFile}` },
      duration_ms: Date.now() - startTime,
    };
  }
  const specContent = readFileSync(taskFile, 'utf-8');
  const prompt = `Implement the task described in the attached spec. Work in the current directory. When done, run the test command if given and report pass/fail.`;
  const cmd = `antigravity chat --mode agent --add-file ${JSON.stringify(taskFile)} ${JSON.stringify(prompt)} -`;
  try {
    const result = execSync(cmd, {
      encoding: 'utf-8',
      timeout: 600_000, // 10 min
      maxBuffer: 10 * 1024 * 1024,
      input: specContent,
    });
    const duration_ms = Date.now() - startTime;
    const output = (result || '').slice(-4000);
    const passed = /pass|success|✓|all tests passed/i.test(output) && !/failed|error:\s*\S/i.test(output);
    return {
      task_id: spec.task_id,
      status: passed ? 'completed' : 'failed',
      test_results: { passed, output },
      duration_ms,
      stdout: result,
    };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    const duration_ms = Date.now() - startTime;
    const stderr = e.stderr ?? (e as Error).message ?? String(err);
    const stdout = e.stdout ?? '';
    logger.warn('[orchestrator] Antigravity chat failed', { task_id: spec.task_id, stderr: String(stderr).slice(0, 500) });
    return {
      task_id: spec.task_id,
      status: 'failed',
      test_results: { passed: false, error: String(stderr), output: stdout },
      duration_ms,
      stdout,
      stderr: String(stderr),
    };
  }
}

function inferTestPassed(stdout: string, outputDir: string): boolean {
  if (/tests?\s+passed|all\s+tests?\s+passed|✓|passed:\s*\d+/i.test(stdout)) return true;
  if (/tests?\s+failed|error:|failed:\s*\d+/i.test(stdout)) return false;
  const resultPath = join(outputDir, 'test-result.json');
  if (existsSync(resultPath)) {
    try {
      const data = JSON.parse(readFileSync(resultPath, 'utf-8'));
      return data.passed === true || data.success === true;
    } catch {
      // ignore
    }
  }
  return false;
}

/**
 * Test that Jeeves can talk to Antigravity: task dir writable, antigravity CLI present.
 */
export function testAntigravityConnection(): { ok: boolean; message: string; details?: string } {
  try {
    if (!existsSync(TASK_TEMP_DIR)) {
      mkdirSync(TASK_TEMP_DIR, { recursive: true });
    }
    const probePath = join(TASK_TEMP_DIR, '.jeeves_probe');
    writeFileSync(probePath, 'ok', 'utf-8');
    unlinkSync(probePath);
  } catch (e) {
    return { ok: false, message: 'Task dir not writable', details: String(e) };
  }
  try {
    const out = execSync('antigravity --help', { encoding: 'utf-8', timeout: 5000 });
    const hasHelp = /usage|Usage|--help|chat|execute/i.test(out || '');
    return {
      ok: true,
      message: 'Task dir OK, Antigravity CLI found.',
      details: hasHelp ? 'antigravity --help succeeded.' : out?.slice(0, 200) || 'No output',
    };
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    return {
      ok: false,
      message: 'Antigravity CLI not found or not in PATH.',
      details: err.stderr || err.message || String(e),
    };
  }
}
