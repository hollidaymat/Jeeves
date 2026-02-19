// Capabilities: self-test runs jeeves-qa + cognitive health; see docs/CAPABILITY_AUDIT
// Capabilities: self-test runs jeeves-qa + cognitive health; see docs/CAPABILITY_AUDIT
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
/** Base URL for self-test to hit our own server (same host/port/scheme as config). */
function defaultApiBase(): string {
  const scheme = config.server.tls ? 'https' : 'http';
  const host = config.server.host === '0.0.0.0' ? '127.0.0.1' : config.server.host;
  return `${scheme}://${host}:${config.server.port}`;
}

export async function runSelfTest(options: SelfTestOptions = {}): Promise<SelfTestResults> {
  const { onProgress, apiBase = defaultApiBase() } = options;

  logger.info('Self-test starting', { apiBase, serverHost: config.server.host, serverPort: config.server.port });

  const startTime = Date.now();
  onProgress?.('Running self-test. This takes 30–60 seconds.');

  // Pre-flight: ensure we can reach our own API (so jeeves-qa child will be able to)
  const healthUrl = `${apiBase.replace(/\/$/, '')}/api/debug/cognitive-health`;
  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isTlsOrCert = /certificate|self signed|UNABLE_TO_VERIFY|TLS|SSL|CERT_|fetch failed/i.test(msg);
    if (config.server.tls && (isTlsOrCert || msg === 'fetch failed')) {
      // HTTPS: parent's fetch often fails (cert or generic "fetch failed"); jeeves-qa child has NODE_TLS_REJECT_UNAUTHORIZED=0
      logger.info('Self-test: pre-flight failed (HTTPS); proceeding — jeeves-qa uses NODE_TLS_REJECT_UNAUTHORIZED=0', { apiBase, error: msg });
    } else {
      logger.error('Self-test: cannot reach API before running jeeves-qa', { apiBase, healthUrl, error: msg });
      onProgress?.(`API unreachable at ${apiBase}. Check server bind (e.g. 0.0.0.0 or 127.0.0.1) and port.`);
      return {
        suites: [],
        totals: { passed: 0, failed: 1, skipped: 0 },
        durationMs: Date.now() - startTime,
        cognitive: { contextAssembler: false, dbConnected: false, layersAvailable: [], lastTraceAge: null },
        growth: getGrowthTrend(10),
      };
    }
  }

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
    const env = { ...process.env };
    if (config.server.tls) {
      env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    }
    const proc = spawn('npx', ['tsx', ...args], {
      cwd: JEEVES_QA_PATH,
      timeout: 120_000,
      env,
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
      const trimmed = stdout.trim();
      let parsed: { suites?: SuiteResult[]; totals?: { passed: number; failed: number; skipped: number }; error?: string };
      try {
        // Accept JSON on last line in case of leading stray output
        const lastLine = trimmed.split('\n').filter(Boolean).pop() ?? trimmed;
        parsed = JSON.parse(lastLine) as typeof parsed;
      } catch {
        logger.warn('Self-test: jeeves-qa did not return valid JSON', {
          code,
          stderr: stderr.slice(0, 200),
          stdoutPreview: trimmed.slice(0, 300),
        });
        resolvePromise({
          suites: [],
          totals: { passed: 0, failed: code === 0 ? 0 : 1, skipped: 0 },
        });
        return;
      }
      if (parsed.error) {
        logger.warn('Self-test: jeeves-qa reported error', { error: parsed.error, code });
      }
      resolvePromise({
        suites: parsed.suites ?? [],
        totals: parsed.totals ?? { passed: 0, failed: 0, skipped: 0 },
      });
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
