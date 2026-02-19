// test
// Jeeves dev test Confirmation
// Jeeves dev test Confirmation
// Jeeves dev test Confirmation
// Jeeves dev test Confirmation
// Jeeves dev test 5
/**
 * Test Runner (devtools)
 * Run tests and parse results into structured data for the dev loop.
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { resolve } from 'path';

const JEEVES_ROOT = '/home/jeeves/signal-cursor-controller';
const JEEVES_QA_PATH = resolve(JEEVES_ROOT, '..', 'jeeves-qa');

/** True if path is inside project root and NOT jeeves-qa. Used so develop never runs QA. */
function isInRepoTestPath(filePath: string): boolean {
  const abs = resolve(JEEVES_ROOT, filePath);
  return abs.startsWith(JEEVES_ROOT) && !abs.startsWith(JEEVES_QA_PATH);
}

export interface TestResult {
  suite: string;
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  duration: number;
  failures: TestFailure[];
  output: string;
}

export interface TestFailure {
  test: string;
  error: string;
  file?: string;
  line?: number;
  expected?: string;
  actual?: string;
}

function runProcess(
  executable: string,
  args: string[],
  cwd: string,
  timeoutMs: number
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolvePromise) => {
    const proc = spawn(executable, args, {
      cwd,
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
    const t = setTimeout(() => {
      proc.kill('SIGTERM');
      setTimeout(() => proc.kill('SIGKILL'), 5000);
    }, timeoutMs);
    proc.on('close', (code) => {
      clearTimeout(t);
      resolvePromise({
        stdout,
        stderr,
        exitCode: code ?? -1,
      });
    });
    proc.on('error', () => {
      clearTimeout(t);
      resolvePromise({ stdout: '', stderr: 'spawn error', exitCode: -1 });
    });
  });
}

function parseTestOutput(raw: string, suite: string): TestResult {
  const output = raw.slice(0, 5000);
  const failures: TestFailure[] = [];

  try {
    const jsonMatch = raw.match(/\{[\s\S]*"passed"[\s\S]*"failed"[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const passed = parsed.passed ?? 0;
      const failed = parsed.failed ?? 0;
      const skipped = parsed.skipped ?? 0;
      return {
        suite,
        passed,
        failed,
        skipped,
        total: passed + failed + skipped,
        duration: parsed.duration ?? 0,
        failures: (parsed.failures ?? []).map((f: Record<string, unknown>) => ({
          test: String(f.name ?? f.test ?? 'unknown'),
          error: String(f.error ?? f.message ?? 'unknown error'),
          file: f.file as string | undefined,
          line: f.line as number | undefined,
          expected: f.expected as string | undefined,
          actual: f.actual as string | undefined,
        })),
        output,
      };
    }
  } catch {
    /* not JSON */
  }

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const summaryMatch = raw.match(/(\d+)\s+pass(?:ing|ed).*?(\d+)\s+fail(?:ing|ed)?/i);
  if (summaryMatch) {
    passed = parseInt(summaryMatch[1], 10);
    failed = parseInt(summaryMatch[2], 10);
  }
  const altMatch = raw.match(/Tests?:\s*(\d+)\s+passed.*?(\d+)\s+failed/i);
  if (altMatch) {
    passed = parseInt(altMatch[1], 10);
    failed = parseInt(altMatch[2], 10);
  }
  const failureBlocks = raw.split(/(?:FAIL|Error|✗|✕|×)\s+/);
  for (const block of failureBlocks.slice(1)) {
    const firstLine = block.split('\n')[0]?.trim();
    if (firstLine) {
      failures.push({
        test: firstLine.slice(0, 100),
        error: block.slice(0, 300).trim(),
      });
    }
  }

  return {
    suite,
    passed,
    failed: failed || failures.length,
    skipped,
    total: passed + (failed || failures.length) + skipped,
    duration: 0,
    failures,
    output,
  };
}

export async function runSelfTests(scenario?: string): Promise<TestResult> {
  if (!existsSync(JEEVES_QA_PATH) || !existsSync(resolve(JEEVES_QA_PATH, 'src/index.ts'))) {
    return {
      suite: 'jeeves-qa',
      passed: 0,
      failed: 0,
      skipped: 0,
      total: 0,
      duration: 0,
      failures: [{ test: 'jeeves-qa', error: 'jeeves-qa not found at ' + JEEVES_QA_PATH }],
      output: '',
    };
  }
  const args = ['tsx', 'src/index.ts', '--json', '--no-llm', '--host', 'http://localhost:3847'];
  if (scenario) args.push('--scenario', scenario);
  const result = await runProcess('npx', args, JEEVES_QA_PATH, 120_000);
  return parseTestOutput(result.stdout + result.stderr, 'jeeves-qa');
}

/** In-repo test files only. Develop commands must never run jeeves-qa. */
const PROJECT_TEST_FILES = ['tests/parser.test.ts', 'tests/routing.test.ts'];

/** Smoke: routing tests only (~1–2s). Used by dev loop when testMode is smoke-test. */
export async function runSmokeTest(): Promise<TestResult> {
  return runProjectTests('tests/routing.test.ts');
}

export async function runProjectTests(testFile?: string): Promise<TestResult> {
  const requested = testFile ? [testFile] : PROJECT_TEST_FILES;
  const files = requested.filter((f) => {
    if (!isInRepoTestPath(f)) {
      return false;
    }
    return true;
  });
  if (requested.length > 0 && files.length === 0) {
    return {
      suite: 'project',
      passed: 0,
      failed: 1,
      skipped: 0,
      total: 1,
      duration: 0,
      failures: [{ test: 'runProjectTests', error: 'Only in-repo tests under JEEVES_ROOT are allowed. jeeves-qa is never run by develop.' }],
      output: '',
    };
  }
  let combined = '';
  for (const file of files) {
    const result = await runProcess('npx', ['tsx', file], JEEVES_ROOT, 60_000);
    combined += result.stdout + result.stderr;
  }
  return parseTestOutput(combined, 'project');
}

export async function runSpecificTest(filePath: string): Promise<TestResult> {
  const result = await runProcess('npx', ['tsx', filePath], JEEVES_ROOT, 60_000);
  return parseTestOutput(result.stdout + result.stderr, filePath);
}

export async function runTypeCheck(): Promise<TestResult> {
  const result = await runProcess('npx', ['tsc', '--noEmit'], JEEVES_ROOT, 30_000);
  const raw = result.stdout + result.stderr;
  const errors = raw.split('\n').filter((l) => l.includes('error TS'));
  return {
    suite: 'typescript-check',
    passed: errors.length === 0 ? 1 : 0,
    failed: errors.length > 0 ? 1 : 0,
    skipped: 0,
    total: 1,
    duration: 0,
    failures: errors.map((e) => ({
      test: 'type-check',
      error: e.trim(),
      file: e.split('(')[0]?.trim(),
      line: parseInt(e.match(/\((\d+),/)?.[1] ?? '0', 10),
    })),
    output: raw.slice(0, 5000),
  };
}
