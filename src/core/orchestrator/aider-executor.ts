/**
 * Aider executor: runs aider CLI with spec file, returns execution result.
 * Uses aider --message-file <spec> --yes for headless automation.
 */

import { spawn, execSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Jeeves project root (signal-cursor-controller). Default when PROJECT_ROOT/AIDER_WORK_DIR unset. */
const JEEVES_PROJECT_ROOT = resolve(__dirname, '../../..');
import type { AntigravitySpec, ExecutionResult } from './types.js';
import { logger } from '../../utils/logger.js';

/** Detect pass from test output. "228 passed, 0 failed" = pass; "1 failed" = fail. */
function detectTestPassed(output: string): boolean {
  const hasPass = /pass|success|✓|all tests passed|tests? passed|passed,\s*0 failed/i.test(output);
  const hasFailure = /[1-9]\d*\s+failed|tests? failed|failed,\s*\d+ passed|error:\s*\S/i.test(output);
  return hasPass && !hasFailure;
}

/** Run the spec's test command in project dir; return { passed, output, error }. */
export function runTestsAfterAider(spec: AntigravitySpec): { passed: boolean; output: string; error?: string } {
  const workDir = process.env.PROJECT_ROOT || process.env.AIDER_WORK_DIR || JEEVES_PROJECT_ROOT;
  const cmd = spec.test_command || 'npm test';
  logger.info('[orchestrator] Running tests after Aider', { workDir, cmd });
  try {
    const result = execSync(cmd, {
      cwd: workDir,
      encoding: 'utf-8',
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const output = (result || '').slice(-3000);
    const passed = detectTestPassed(output);
    logger.info('[orchestrator] Test run finished', { passed, outputSnippet: output.slice(-200) });
    return { passed, output, error: passed ? undefined : output.slice(-800) };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const out = (err.stdout || err.stderr || err.message || String(e)).slice(-3000);
    logger.warn('[orchestrator] Test run failed', { error: out.slice(-500) });
    return { passed: false, output: out, error: out.slice(-800) };
  }
}

const TASK_TEMP_DIR = process.env.TASK_TEMP_DIR || '/tmp/jeeves_tasks';
const AIDER_BIN = process.env.AIDER_BIN || 'aider';
const AIDER_MODEL = process.env.AIDER_MODEL || 'claude-sonnet-4-6';
const AIDER_STUB = process.env.AIDER_STUB === 'true';

/**
 * Run Aider CLI with spec file. If AIDER_STUB=true, return stub success.
 */
export async function executeWithAider(spec: AntigravitySpec): Promise<ExecutionResult> {
  const taskFile = join(TASK_TEMP_DIR, `jeeves_task_${spec.task_id}.md`);
  const start = Date.now();

  if (AIDER_STUB) {
    logger.info('[orchestrator] Aider stub: skipping CLI');
    return {
      task_id: spec.task_id,
      status: 'completed',
      test_results: { passed: true, output: 'stub' },
      duration_ms: Date.now() - start,
    };
  }

  if (!existsSync(taskFile)) {
    return {
      task_id: spec.task_id,
      status: 'failed',
      test_results: { passed: false, error: `Spec file not found: ${taskFile}` },
      duration_ms: Date.now() - start,
    };
  }

  const workDir = process.env.PROJECT_ROOT || process.env.AIDER_WORK_DIR || JEEVES_PROJECT_ROOT;
  const targetDirs = (process.env.AIDER_TARGET_DIRS || 'src').split(/\s+/).filter(Boolean);
  logger.info('[orchestrator] Aider run', { task_id: spec.task_id, workDir, test_command: spec.test_command });
  if (targetDirs.length === 0) targetDirs.push('.');

  const args = [
    '--message-file',
    taskFile,
    '--yes-always',
    '--auto-commits',
    '--no-git-commit-verify',
    ...targetDirs,
  ];

  if (AIDER_MODEL) {
    args.unshift('--model', AIDER_MODEL);
  }

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';

    const proc = spawn(AIDER_BIN, args, {
      cwd: workDir,
      env: { ...process.env },
    });

    proc.stdout?.on('data', (chunk: Buffer | string) => {
      const s = chunk.toString();
      stdout += s;
    });
    proc.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      const duration_ms = Date.now() - start;
      const output = (stdout + stderr).slice(-4000);
      const passed = detectTestPassed(output);

      if (code !== 0) {
        logger.warn('[orchestrator] Aider CLI exited non-zero', {
          task_id: spec.task_id,
          code,
          stderr: stderr.slice(0, 500),
        });
      }

      resolve({
        task_id: spec.task_id,
        status: code === 0 && passed ? 'completed' : 'failed',
        test_results: {
          passed: code === 0 && passed,
          error: code !== 0 ? stderr.slice(-1000) : undefined,
          output,
        },
        duration_ms,
        stdout,
        stderr: stderr || undefined,
      });
    });

    proc.on('error', (err) => {
      const duration_ms = Date.now() - start;
      const errMsg = String(err);
      logger.warn('[orchestrator] Aider spawn failed', { task_id: spec.task_id, error: errMsg });
      const suggestHandoff =
        'Orchestration unavailable (Aider spawn failed). Try again or use "send to aider: ..." for spec-only handoff.';
      resolve({
        task_id: spec.task_id,
        status: 'failed',
        test_results: {
          passed: false,
          error: `${errMsg}\n\n${suggestHandoff}`,
          output: stdout + stderr,
        },
        duration_ms,
        stdout,
        stderr: String(err),
      });
    });
  });
}

/**
 * Test that Jeeves can talk to Aider: task dir writable, aider CLI present.
 */
export function testAiderConnection(): { ok: boolean; message: string; details?: string } {
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
    const out = execSync(`${AIDER_BIN} --version`, { encoding: 'utf-8', timeout: 5000 });
    const hasVersion = /aider|version|\d+\.\d+/i.test(out || '');
    return {
      ok: true,
      message: 'Task dir OK, Aider CLI found.',
      details: hasVersion ? out?.trim() || 'aider --version succeeded.' : out?.slice(0, 200) || 'No output',
    };
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    return {
      ok: false,
      message: 'Aider CLI not found. Install: pipx install aider-chat (or set AIDER_BIN)',
      details: err.stderr || err.message || String(e),
    };
  }
}
