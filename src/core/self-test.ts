/**
 * Jeeves Self-Test
 * Runs the full test suite (jeeves-qa), collects results, and formats a report.
 * Triggered by "run self test" command or POST /api/self-test.
 */

import { spawn } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { getGrowthTrend } from './growth-tracker.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '../..');
const JEEVES_QA_PATH = resolve(ROOT, '..', 'jeeves-qa');

export interface SuiteResult {
  name: string;
  passed: number;
  failed: number;
  skipped: number;
  failures: string[];
}

export interface SelfTestResults {
  suites: SuiteResult[];
  totals: { passed: number; failed: number; skipped: number };
  durationMs: number;
  cognitive: {
    contextAssembler: boolean;
    dbConnected: boolean;
    layersAvailable: string[];
    lastTraceAge: number | null;
  };
  growth: ReturnType<typeof getGrowthTrend>;
}

export interface SelfTestOptions {
  /** Callback for progress messages (e.g. "Running self-test...") */
  onProgress?: (message: string) => void;
  /** API base URL for cognitive health check */
  apiBase?: string;
}

/**
 * Run the full self-test suite and return formatted results.
 */
export async function runSelfTest(options: SelfTestOptions = {}): Promise<SelfTestResults> {
  const { onProgress, apiBase = `http://127.0.0.1:${config.server.port}` } = options;

  const startTime = Date.now();
  onProgress?.('Running self-test. This takes 30–60 seconds.');

  // 1. Run jeeves-qa with --json --no-llm (fast, machine-readable)
  const qaResult = await runJeevesQa(apiBase, onProgress);

  // 2. Cognitive pipeline check
  const cognitive = await checkCognitiveHealth(apiBase);

  // 3. Growth trend
  const growth = getGrowthTrend(10);

  const durationMs = Date.now() - startTime;

  return {
    suites: qaResult.suites,
    totals: qaResult.totals,
    durationMs,
    cognitive: {
      contextAssembler: cognitive.assemblerConnected,
      dbConnected: cognitive.dbConnected,
      layersAvailable: cognitive.layersAvailable,
      lastTraceAge: cognitive.lastTraceAge,
    },
    growth,
  };
}

async function runJeevesQa(
  apiBase: string,
  onProgress?: (msg: string) => void
): Promise<{ suites: SuiteResult[]; totals: { passed: number; failed: number; skipped: number } }> {
  if (!existsSync(JEEVES_QA_PATH) || !existsSync(resolve(JEEVES_QA_PATH, 'src/index.ts'))) {
    logger.warn('Self-test: jeeves-qa not found', { path: JEEVES_QA_PATH });
    return { suites: [], totals: { passed: 0, failed: 0, skipped: 0 } };
  }

  return new Promise((resolvePromise, reject) => {
    const args = ['src/index.ts', '--json', '--no-llm', '--host', apiBase];
    const proc = spawn('npx', ['tsx', ...args], {
      cwd: JEEVES_QA_PATH,
      timeout: 120_000,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      try {
        const parsed = JSON.parse(stdout.trim());
        resolvePromise({
          suites: parsed.suites ?? [],
          totals: parsed.totals ?? { passed: 0, failed: 0, skipped: 0 },
        });
      } catch {
        logger.warn('Self-test: jeeves-qa did not return valid JSON', { code, stderr: stderr.slice(0, 200) });
        resolvePromise({
          suites: [],
          totals: { passed: 0, failed: code === 0 ? 0 : 1, skipped: 0 },
        });
      }
    });

    proc.on('error', (err) => {
      logger.error('Self-test: failed to spawn jeeves-qa', { error: String(err), path: JEEVES_QA_PATH });
      reject(err);
    });
  });
}

async function checkCognitiveHealth(apiBase: string): Promise<{
  assemblerConnected: boolean;
  dbConnected: boolean;
  layersAvailable: string[];
  lastTraceAge: number | null;
}> {
  try {
    const res = await fetch(`${apiBase.replace(/\/$/, '')}/api/debug/cognitive-health`, {
      signal: AbortSignal.timeout(5000),
    });
    const data = (await res.json()) as {
      assemblerConnected?: boolean;
      dbConnected?: boolean;
      layersAvailable?: string[];
      lastTraceAge?: number | null;
    };
    return {
      assemblerConnected: data.assemblerConnected ?? false,
      dbConnected: data.dbConnected ?? false,
      layersAvailable: data.layersAvailable ?? [],
      lastTraceAge: data.lastTraceAge ?? null,
    };
  } catch {
    return {
      assemblerConnected: false,
      dbConnected: false,
      layersAvailable: [],
      lastTraceAge: null,
    };
  }
}

/**
 * Format self-test results for Signal/compact display.
 */
export function formatSelfTestReport(results: SelfTestResults): string {
  const total = results.totals.passed + results.totals.failed;
  const passRate = total > 0 ? ((results.totals.passed / total) * 100).toFixed(0) : '0';
  const duration = (results.durationMs / 1000).toFixed(1);

  const cogOnline =
    (results.cognitive.contextAssembler ? 1 : 0) +
    (results.cognitive.dbConnected ? 1 : 0);
  const cogTotal = 2; // contextAssembler + dbConnected as main checks

  const suiteLines = results.suites
    .map((s) => {
      const icon = s.failed === 0 ? 'PASS' : 'FAIL';
      const totalSuite = s.passed + s.failed;
      return `  ${icon} ${s.name}: ${s.passed}/${totalSuite}`;
    })
    .join('\n');

  const failures = results.suites
    .filter((s) => s.failures.length > 0)
    .flatMap((s) => s.failures.map((f) => `  - ${f}`));
  const failureBlock = failures.length > 0 ? `\nFailures:\n${failures.slice(0, 5).join('\n')}` : '';

  const growthLine = results.growth.status && results.growth.status !== 'UNKNOWN'
    ? `\nGrowth: ${results.growth.status}`
    : '';

  return `SELF-TEST COMPLETE (${duration}s)

Score: ${results.totals.passed}/${total} (${passRate}%)
Cognitive: ${cogOnline}/${cogTotal} systems online

Suites:
${suiteLines}
${failureBlock}
${growthLine}`;
}
