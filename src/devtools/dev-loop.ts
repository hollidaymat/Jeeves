/**
 * Dev Loop (devtools)
 * Orchestrator: Understand -> Plan -> Write -> Test -> Iterate (max 3) -> Report.
 * Includes error recovery: path retries, partial file reads, and failure context.
 */

import { existsSync } from 'fs';
import { writeFile, unlink } from 'fs/promises';
import { join, resolve } from 'path';
import { execSync } from 'child_process';
import { readMultipleFilesWithRecovery, readProjectFile } from './file-reader.js';
import { writeProjectFile, editProjectFile, rollbackFile, getRecentChanges } from './file-writer.js';
import { runProjectTests, runTypeCheck, runSmokeTest, runSelfTests, type TestResult } from './test-runner.js';
import { assessTask, generatePlan, analyzeFailure, analyzeWriteFailure, planAndExecuteToolChain, type DevPlan, type DevStep } from './dev-llm.js';
import { checkGuardrails } from './guardrails.js';
import { getTrustLevel } from '../core/trust.js';
import { startReasoningTrace, addReasoningStep, completeReasoningTrace } from '../core/ooda-logger.js';
import type { FileReadResult } from './file-reader.js';

const MAX_ITERATIONS = 5;
const JEEVES_ROOT = '/home/jeeves/signal-cursor-controller';

export type TestMode = 'typecheck-only' | 'smoke-test' | 'full-test';

/** Acceptance criteria: test phase must complete within these limits. */
export const ACCEPTANCE_MS: Record<TestMode, number> = {
  'typecheck-only': 2_000,
  'smoke-test': 3_000,
  'full-test': 15_000,
};

/** Checkpoint for step-level rollback (Phase 7). */
export interface Checkpoint {
  stepIndex: number;
  stepDescription: string;
  step: DevStep;
  filesSnapshot: Map<string, string>;
  testResult: TestResult | null;
  timestamp: number;
}

async function rollbackToCheckpoint(checkpoint: Checkpoint): Promise<void> {
  for (const [filePath, originalContent] of checkpoint.filesSnapshot) {
    try {
      await writeFile(filePath, originalContent, 'utf-8');
    } catch {
      try {
        await unlink(filePath);
      } catch {
        /* ignore */
      }
    }
  }
  if (checkpoint.step.action === 'create') {
    const fullPath = join(JEEVES_ROOT, checkpoint.step.file);
    try {
      await unlink(fullPath);
    } catch {
      /* ignore */
    }
  }
}

async function executeWithCheckpoints(
  plan: DevPlan,
  task: DevTask,
  fileContents: FileReadResult[],
  opts: {
    allowedPaths: Set<string>;
    backupPaths: string[];
    filesChanged: string[];
    testResults: TestResult[];
    testMode: TestMode;
  }
): Promise<DevResult> {
  const { allowedPaths, testMode } = opts;
  const allBackupPaths = [...opts.backupPaths];
  const allFilesChanged = [...opts.filesChanged];
  const allTestResults = [...opts.testResults];
  let totalIterations = 0;
  const MAX_TOTAL = 5;
  const MAX_STEP_ATTEMPTS = 2;

  const stepsToRun = plan.steps.filter((s) => allowedPaths.has(normalizeStepPath(s.file)));
  if (stepsToRun.length === 0) {
    return {
      taskId: task.id,
      status: 'failed',
      iterations: 0,
      filesChanged: allFilesChanged,
      testResults: allTestResults,
      backupPaths: allBackupPaths,
      summary: 'No steps allowed for requested files.',
      rollbackAvailable: false,
      phase: 'apply',
      error: 'No steps allowed',
    };
  }

  for (let i = 0; i < stepsToRun.length && totalIterations < MAX_TOTAL; i++) {
    const stepIndex = plan.steps.indexOf(stepsToRun[i]);
    const step = plan.steps[stepIndex];
    if (typeof step.action === 'string' && /^(update|edit|change|patch)$/i.test(step.action)) {
      step.action = 'modify';
    }
    if (step.action !== 'create' && step.action !== 'modify') continue;
    if (step.action === 'modify' && (step.oldContent == null || step.newContent == null) && step.content != null) {
      try {
        const fr = await readProjectFile(step.file);
        const prepend = /top|prepend|beginning|start|at the top|add.*(comment|at the top)/i.test(step.description);
        step.oldContent = fr.content;
        step.newContent = prepend
          ? step.content!.trimEnd() + (fr.content.startsWith('\n') ? '' : '\n') + fr.content
          : fr.content + (fr.content.endsWith('\n') ? '' : '\n') + step.content!.trimStart();
      } catch {
        continue;
      }
    }
    if (step.action === 'modify' && (step.oldContent == null || step.newContent == null)) continue;
    if (step.action === 'create' && !step.content) continue;

    const checkpoint: Checkpoint = {
      stepIndex,
      stepDescription: step.description,
      step,
      filesSnapshot: new Map(),
      testResult: null,
      timestamp: Date.now(),
    };
    try {
      const existing = await readProjectFile(step.file);
      checkpoint.filesSnapshot.set(existing.path, existing.content);
    } catch {
      /* new file, no snapshot */
    }

    let stepSuccess = false;
    let stepAttempts = 0;
    while (!stepSuccess && stepAttempts < MAX_STEP_ATTEMPTS && totalIterations < MAX_TOTAL) {
      stepAttempts++;
      totalIterations++;

      let writeResult;
      if (step.action === 'create') {
        writeResult = await writeProjectFile(step.file, step.content!, task.id, step.description);
      } else {
        writeResult = await editProjectFile(step.file, step.oldContent!, step.newContent!, task.id, step.description);
      }
      if (!writeResult.success) {
        if (stepAttempts < MAX_STEP_ATTEMPTS) {
          const fix = await analyzeWriteFailure(writeResult.error ?? '', step, fileContents);
          if (fix.canFix && fix.newOldContent != null && fix.newNewContent != null) {
            step.oldContent = fix.newOldContent;
            step.newContent = fix.newNewContent;
            continue;
          }
        }
        await rollbackToCheckpoint(checkpoint);
        return {
          taskId: task.id,
          status: 'failed',
          iterations: totalIterations,
          filesChanged: allFilesChanged,
          testResults: allTestResults,
          backupPaths: allBackupPaths,
          summary: `Step ${stepIndex + 1} failed: ${writeResult.error}. Rolled back.`,
          rollbackAvailable: false,
          phase: 'apply',
          error: writeResult.error,
        };
      }
      if (writeResult.backupPath) allBackupPaths.push(writeResult.backupPath);
      const addedPath = (writeResult.path || step.file).replace(JEEVES_ROOT + '/', '').replace(JEEVES_ROOT, '') || step.file;
      if (addedPath && !allFilesChanged.includes(addedPath)) allFilesChanged.push(addedPath);

      const typeCheck = await runTypeCheck();
      checkpoint.testResult = typeCheck;
      allTestResults.push(typeCheck);
      if (typeCheck.failed > 0) {
        if (stepAttempts < MAX_STEP_ATTEMPTS) {
          const fix = await analyzeFailure(typeCheck, fileContents, plan);
          if (fix.canFix && fix.newSteps[0]) {
            plan.steps[stepIndex] = fix.newSteps[0];
            await rollbackToCheckpoint(checkpoint);
            continue;
          }
        }
        await rollbackToCheckpoint(checkpoint);
        break;
      }
      stepSuccess = true;
    }
  }

  const mode: TestMode = task.testMode ?? 'smoke-test';
  const testPhaseStart = Date.now();
  if (mode === 'typecheck-only') {
    const elapsed = Date.now() - testPhaseStart;
    if (elapsed > ACCEPTANCE_MS['typecheck-only']) {
      return {
        taskId: task.id,
        status: 'failed',
        iterations: totalIterations,
        filesChanged: allFilesChanged,
        testResults: allTestResults,
        backupPaths: allBackupPaths,
        summary: `typecheck-only exceeded 2s (took ${(elapsed / 1000).toFixed(1)}s).`,
        rollbackAvailable: true,
        phase: 'typecheck',
      };
    }
    return {
      taskId: task.id,
      status: 'success',
      iterations: totalIterations,
      filesChanged: allFilesChanged,
      testResults: allTestResults,
      backupPaths: allBackupPaths,
      summary: `Completed (typecheck-only). ${allFilesChanged.length} files changed.`,
      rollbackAvailable: true,
    };
  }

  let projectTests: TestResult;
  try {
    if (mode === 'smoke-test') {
      projectTests = await runSmokeTest();
    } else {
      projectTests = await runProjectTests();
    }
  } catch (err) {
    projectTests = testResultFromError('project-tests', err);
    allTestResults.push(projectTests);
    return {
      taskId: task.id,
      status: 'failed',
      iterations: totalIterations,
      filesChanged: allFilesChanged,
      testResults: allTestResults,
      backupPaths: allBackupPaths,
      summary: `Tests could not run: ${err instanceof Error ? err.message : String(err)}`,
      rollbackAvailable: true,
      phase: 'test',
      error: err instanceof Error ? err.message : String(err),
    };
  }
  allTestResults.push(projectTests);
  const elapsed = Date.now() - testPhaseStart;
  if (elapsed > ACCEPTANCE_MS[mode]) {
    return {
      taskId: task.id,
      status: 'failed',
      iterations: totalIterations,
      filesChanged: allFilesChanged,
      testResults: allTestResults,
      backupPaths: allBackupPaths,
      summary: `Test phase exceeded ${ACCEPTANCE_MS[mode] / 1000}s (took ${(elapsed / 1000).toFixed(1)}s).`,
      rollbackAvailable: true,
      phase: 'test',
    };
  }
  if (mode === 'smoke-test' && projectTests.failed > 0) {
    for (const bp of allBackupPaths) {
      await rollbackFile(bp);
    }
    return {
      taskId: task.id,
      status: 'failed',
      iterations: totalIterations,
      filesChanged: allFilesChanged,
      testResults: allTestResults,
      backupPaths: [],
      summary: `Smoke tests failed: ${projectTests.failures?.[0]?.error ?? 'unknown'}`,
      rollbackAvailable: false,
      phase: 'test',
      error: projectTests.failures?.[0]?.error,
    };
  }
  if (mode === 'smoke-test') {
    return {
      taskId: task.id,
      status: 'success',
      iterations: totalIterations,
      filesChanged: allFilesChanged,
      testResults: allTestResults,
      backupPaths: allBackupPaths,
      summary: `Completed (smoke-test). ${allFilesChanged.length} files changed.`,
      rollbackAvailable: true,
    };
  }

  if (mode === 'full-test') {
    let selfTests: TestResult;
    try {
      selfTests = await runSelfTests();
    } catch (err) {
      selfTests = testResultFromError('jeeves-qa', err);
    }
    allTestResults.push(selfTests);
    const selfFailed = selfTests.failed > 0;
    const projectFailed = projectTests.failed > 0;
    if (!projectFailed && !selfFailed) {
      return {
        taskId: task.id,
        status: 'success',
        iterations: totalIterations,
        filesChanged: allFilesChanged,
        testResults: allTestResults,
        backupPaths: allBackupPaths,
        summary: `Completed (full-test). ${allFilesChanged.length} files changed. All tests passing.`,
        rollbackAvailable: true,
      };
    }
    if (totalIterations < MAX_TOTAL) {
      const fix = await analyzeFailure(projectTests, fileContents, plan);
      if (fix.canFix && fix.newSteps.length > 0) {
        for (const fixStep of fix.newSteps) {
          const wr = await editProjectFile(
            fixStep.file,
            fixStep.oldContent!,
            fixStep.newContent!,
            task.id,
            `Fix: ${fixStep.description}`
          );
          if (wr.backupPath) allBackupPaths.push(wr.backupPath);
        }
        const retest = await runProjectTests();
        allTestResults.push(retest);
        if (retest.failed === 0) {
          return {
            taskId: task.id,
            status: 'success',
            iterations: totalIterations + 1,
            filesChanged: allFilesChanged,
            testResults: allTestResults,
            backupPaths: allBackupPaths,
            summary: `Completed with fix pass. All tests passing.`,
            rollbackAvailable: true,
          };
        }
      }
    }
    return {
      taskId: task.id,
      status: 'partial',
      iterations: totalIterations,
      filesChanged: allFilesChanged,
      testResults: allTestResults,
      backupPaths: allBackupPaths,
      summary: `${projectTests.passed + selfTests.passed} passed, ${projectTests.failed + selfTests.failed} failed.`,
      rollbackAvailable: true,
    };
  }

  return {
    taskId: task.id,
    status: projectTests.failed === 0 ? 'success' : 'partial',
    iterations: totalIterations,
    filesChanged: allFilesChanged,
    testResults: allTestResults,
    backupPaths: allBackupPaths,
    summary: `${allFilesChanged.length} files changed. ${projectTests.passed} passing, ${projectTests.failed} failing.`,
    rollbackAvailable: true,
  };
}

export interface DevTask {
  id: string;
  description: string;
  requestedBy: string;
  priority: 'low' | 'medium' | 'high';
  createdAt: string;
  /** Which tests to run after apply. Default: smoke-test. */
  testMode?: TestMode;
}

export interface DevResult {
  taskId: string;
  status: 'success' | 'partial' | 'failed' | 'blocked';
  iterations: number;
  filesChanged: string[];
  testResults: TestResult[];
  summary: string;
  rollbackAvailable: boolean;
  backupPaths: string[];
  /** Set when status is failed/blocked: short error message. */
  error?: string;
  /** Phase when failure occurred: assess | plan | read | apply | typecheck | test */
  phase?: string;
}

function testResultFromError(suite: string, err: unknown): TestResult {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    suite,
    passed: 0,
    failed: 1,
    skipped: 0,
    total: 1,
    duration: 0,
    failures: [{ test: suite, error: msg }],
    output: msg,
  };
}

function normalizeStepPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (filePath.startsWith(JEEVES_ROOT)) {
    const rel = filePath.slice(JEEVES_ROOT.length).replace(/^\/+/, '');
    return rel || normalized;
  }
  return normalized;
}

const JEEVES_HOME = process.env.HOME || '/home/jeeves';

/**
 * If the task is only "create a folder [name] in <path>" or "folder called X in /path" (description may omit "create"
 * when extracted by dev.task patterns), return the absolute dir path. Only returns paths under JEEVES_HOME.
 */
function parseCreateFolderTask(description: string): string | null {
  const raw = description.trim();
  // "create a folder called X in /path" or "a folder called X in /path" (after "create " is stripped by registry)
  const calledIn = raw.match(/(?:create\s+)?(?:a\s+)?folder\s+(?:called\s+)?(\S+)\s+in\s+(\S+)/i);
  if (calledIn) {
    const name = calledIn[1].replace(/[.]$/, '');
    const parent = calledIn[2].replace(/[.]$/, '');
    const abs = resolve(parent, name);
    if (abs === JEEVES_HOME || (abs + '/').startsWith(JEEVES_HOME + '/')) return abs;
    return null;
  }
  // "create folder /absolute/path" or "mkdir /absolute/path" or "folder /path"
  const direct = raw.match(/(?:create\s+folder|mkdir|folder)\s+(\/[\w./-]+)/i);
  if (direct) {
    const abs = resolve(direct[1]);
    if (abs === JEEVES_HOME || (abs + '/').startsWith(JEEVES_HOME + '/')) return abs;
    return null;
  }
  return null;
}

/**
 * If the task is "create N folders inside /path name1;name2;name3" (or comma-separated), return { parentDir, names }.
 * Description may omit "create " when extracted by dev.task. Only allows paths under JEEVES_HOME.
 */
function parseCreateMultipleFoldersTask(
  description: string
): { parentDir: string; names: string[] } | null {
  const raw = description.trim();
  // "create 3 folders inside /path a;b;c" or "3 folders inside /path a;b;c"
  const match = raw.match(/(?:create\s+)?(\d+\s+)?folders?\s+inside\s+(\S+)\s+(.+)/i);
  if (!match) return null;
  const parent = match[2].replace(/[.]$/, '');
  const absParent = resolve(parent);
  if (absParent !== JEEVES_HOME && !(absParent + '/').startsWith(JEEVES_HOME + '/')) return null;
  const namesStr = match[3].trim();
  const names = namesStr
    .split(/[;,]/)
    .map((n) => n.trim())
    .filter(Boolean);
  if (names.length === 0) return null;
  return { parentDir: absParent, names };
}

/** Extract explicit file paths from task description (e.g. "src/devtools/test-runner.ts") so we only read/edit those. */
function explicitPathsFromTask(description: string): string[] {
  const re = /\b(src\/[a-zA-Z0-9_/.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|yaml|yml|md|mts|cts))/g;
  const seen = new Set<string>();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(description)) !== null) {
    const p = m[1].trim();
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

/** If task is "add a comment at the top of X that says Y", return { file: X, content: Y }; else null. */
function parseAddCommentAtTop(description: string): { file: string; content: string } | null {
  const paths = explicitPathsFromTask(description);
  const match = description.match(/that\s+says\s+(.+?)(?:\.|$)/is);
  if (paths.length !== 1 || !match) return null;
  const comment = match[1].trim();
  if (!comment) return null;
  return { file: paths[0], content: comment.endsWith('\n') ? comment : comment + '\n' };
}

export async function executeDevTask(task: DevTask): Promise<DevResult> {
  const backupPaths: string[] = [];
  const filesChanged: string[] = [];
  const testResults: TestResult[] = [];
  let iterations = 0;

  const fail = (
    status: DevResult['status'],
    summary: string,
    opts: {
      phase?: string;
      error?: string;
      clearBackups?: boolean;
      iterations?: number;
      filesChanged?: string[];
      testResults?: TestResult[];
      backupPaths?: string[];
    } = {}
  ): DevResult => {
    const result: DevResult = {
      taskId: task.id,
      status,
      iterations: opts.iterations ?? iterations,
      filesChanged: opts.filesChanged ?? [...filesChanged],
      testResults: opts.testResults ?? [...testResults],
      backupPaths: opts.clearBackups ? [] : (opts.backupPaths ?? [...backupPaths]),
      summary,
      rollbackAvailable: opts.clearBackups ? false : (opts.backupPaths ?? backupPaths).length > 0,
      error: opts.error ?? summary.slice(0, 200),
      phase: opts.phase,
    };
    addReasoningStep({
      phase: 'act',
      thought: `Result: ${status}. ${summary}`,
      data: { filesChanged: result.filesChanged, iterations: result.iterations },
      duration: 0,
    });
    completeReasoningTrace(
      status === 'blocked' ? 'escalated' : 'failed',
      0,
      0,
      ''
    );
    return result;
  };

  const endTrace = (result: DevResult): DevResult => {
    addReasoningStep({
      phase: 'act',
      thought: `Result: ${result.status}. ${result.summary}`,
      data: { filesChanged: result.filesChanged, iterations: result.iterations },
      duration: 0,
    });
    completeReasoningTrace(
      result.status === 'success' ? 'success' : result.status === 'blocked' ? 'escalated' : 'failed',
      0,
      0,
      ''
    );
    return result;
  };

  startReasoningTrace(task.id, task.description);

  try {
    const guardrailResult = checkGuardrails({
      description: task.description,
      requestedBy: task.requestedBy,
    });
    if (!guardrailResult.allowed) {
      return fail('blocked', `Blocked by guardrails: ${guardrailResult.reason ?? 'unknown'}`, { phase: 'guardrails' });
    }

    const createMultiple = parseCreateMultipleFoldersTask(task.description);
    if (createMultiple) {
      try {
        const created: string[] = [];
        for (const name of createMultiple.names) {
          const dir = join(createMultiple.parentDir, name);
          if (dir !== JEEVES_HOME && !(dir + '/').startsWith(JEEVES_HOME + '/')) continue;
          execSync(`mkdir -p ${JSON.stringify(dir)}`, { stdio: 'pipe' });
          created.push(dir);
        }
        return endTrace({
          taskId: task.id,
          status: 'success',
          iterations: 0,
          filesChanged: [],
          testResults: [],
          summary: `Created ${created.length} folder(s): ${created.join(', ')}.`,
          rollbackAvailable: false,
          backupPaths: [],
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return fail('failed', `Could not create folders: ${msg}`, { phase: 'apply', error: msg });
      }
    }

    const createFolderPath = parseCreateFolderTask(task.description);
    if (createFolderPath) {
      try {
        execSync(`mkdir -p ${JSON.stringify(createFolderPath)}`, { stdio: 'pipe' });
        return endTrace({
          taskId: task.id,
          status: 'success',
          iterations: 0,
          filesChanged: [],
          testResults: [],
          summary: `Created folder ${createFolderPath}.`,
          rollbackAvailable: false,
          backupPaths: [],
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return fail('failed', `Could not create folder: ${msg}`, { phase: 'apply', error: msg });
      }
    }

    let pathsToRead: string[];
    let fileContents: Awaited<ReturnType<typeof readMultipleFilesWithRecovery>>['contents'];
    let plan: DevPlan;
    let allowedPaths: Set<string>;
    let readFailures: { path: string; error: string }[] = [];

    const addCommentFast = parseAddCommentAtTop(task.description);
    if (addCommentFast && existsSync(join(JEEVES_ROOT, addCommentFast.file))) {
      // Fast path: "add a comment at the top of X that says Y" — skip LLM (saves ~20–40s)
      pathsToRead = [addCommentFast.file];
      const { contents: raw, failedPaths: failed } = await readMultipleFilesWithRecovery(pathsToRead);
      readFailures = failed;
      fileContents = raw;
      if (fileContents.length === 0 && readFailures.length > 0) {
        return fail(
          'failed',
          `Could not read ${addCommentFast.file}: ${readFailures[0]?.error ?? 'unknown'}`,
          { phase: 'read', error: readFailures[0]?.error }
        );
      }
      plan = {
        steps: [
          {
            file: addCommentFast.file,
            action: 'modify',
            description: 'Add comment at top',
            content: addCommentFast.content,
          },
        ],
        testStrategy: 'Run type check and routing tests.',
      };
      allowedPaths = new Set([
        ...pathsToRead.map((p) => normalizeStepPath(p)),
        ...fileContents.map((f) => normalizeStepPath(f.path)),
      ]);
    } else {
      addReasoningStep({
        phase: 'observe',
        thought: `Reading codebase to understand: "${task.description}"`,
        duration: 0,
      });
      let assessment: { approach: string; risk: 'low' | 'medium' | 'high'; estimatedComplexity: number; relevantFiles: string[] };
      let chainPlan: Awaited<ReturnType<typeof planAndExecuteToolChain>>['plan'] | undefined;
      try {
        const { results: chainResults, plan: chain } = await planAndExecuteToolChain(task.description, [], {
          understandOnly: true,
        });
        chainPlan = chain;
        const readResults = Array.from(chainResults.values()).filter(
          (v): v is import('./file-reader.js').FileReadResult =>
            v != null && typeof v === 'object' && 'content' in v && 'path' in v && 'lines' in v
        );
        if (readResults.length > 0) {
          fileContents = readResults;
          pathsToRead = readResults.map((f) => f.path);
          assessment = {
            approach: chain.approach ?? 'Read relevant files and implement changes.',
            risk: chain.risk === 'low' || chain.risk === 'medium' || chain.risk === 'high' ? chain.risk : 'medium',
            estimatedComplexity: typeof chain.estimatedComplexity === 'number' ? chain.estimatedComplexity : 5,
            relevantFiles: pathsToRead,
          };
        } else {
          assessment = await assessTask(task.description);
          const explicitPaths = explicitPathsFromTask(task.description);
          pathsToRead =
            explicitPaths.length > 0
              ? explicitPaths
              : assessment.relevantFiles.length > 0
                ? assessment.relevantFiles
                : ['src/devtools/file-reader.ts'];
          if (explicitPaths.length === 0) {
            const existing = pathsToRead.filter((p) => existsSync(join(JEEVES_ROOT, p)));
            if (existing.length === 0) {
              return fail(
                'failed',
                'Include a file path in the task (e.g. "dev typecheck-only: add a comment to src/devtools/test-runner.ts"). No valid files could be read.',
                { phase: 'read' }
              );
            }
            pathsToRead = existing;
          }
          const { contents: fileContentsRaw, failedPaths: failed } =
            await readMultipleFilesWithRecovery(pathsToRead);
          readFailures = failed;
          fileContents = fileContentsRaw;
          if (fileContents.length === 0 && readFailures.length > 0) {
            return fail(
              'failed',
              `Could not read any requested files. First error: ${readFailures[0].path}: ${readFailures[0].error}`,
              { phase: 'read', error: readFailures[0].error }
            );
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return fail('failed', `Assessment failed: ${msg}`, { phase: 'assess', error: msg });
      }

      if (assessment.risk === 'high') {
        const trustLevel = getTrustLevel();
        if (trustLevel < 3) {
          return fail(
            'blocked',
            `High-risk task requires trust level 3+. Current: ${trustLevel}. Requesting approval.`,
            { phase: 'guardrails' }
          );
        }
      }

      if (fileContents.length === 0) {
        const explicitPaths = explicitPathsFromTask(task.description);
        pathsToRead =
          explicitPaths.length > 0
            ? explicitPaths
            : assessment.relevantFiles.length > 0
              ? assessment.relevantFiles
              : ['src/devtools/file-reader.ts'];
        const existing = pathsToRead.filter((p) => existsSync(join(JEEVES_ROOT, p)));
        if (existing.length === 0) {
          return fail(
            'failed',
            'Include a file path in the task. No valid files could be read.',
            { phase: 'read' }
          );
        }
        pathsToRead = existing;
        const { contents: fileContentsRaw, failedPaths: failed } =
          await readMultipleFilesWithRecovery(pathsToRead);
        readFailures = failed;
        fileContents = fileContentsRaw;
        if (fileContents.length === 0 && readFailures.length > 0) {
          return fail(
            'failed',
            `Could not read any requested files. First error: ${readFailures[0].path}: ${readFailures[0].error}`,
            { phase: 'read', error: readFailures[0].error }
          );
        }
      }

      try {
        plan = await generatePlan(task.description, fileContents, assessment.approach);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return fail('failed', `Plan generation failed: ${msg}`, { phase: 'plan', error: msg });
      }

      allowedPaths = new Set([
        ...pathsToRead.map((p) => normalizeStepPath(p)),
        ...fileContents.map((f) => normalizeStepPath(f.path)),
      ]);
      const originalCount = plan.steps.length;
      plan.steps = plan.steps.filter((s) => allowedPaths.has(normalizeStepPath(s.file)));
      if (plan.steps.length === 0 && originalCount > 0) {
        const addComment = parseAddCommentAtTop(task.description);
        if (addComment && allowedPaths.has(normalizeStepPath(addComment.file))) {
          plan.steps = [
            { file: addComment.file, action: 'modify', description: 'Add comment at top', content: addComment.content },
          ];
        } else {
          return fail(
            'failed',
            `Plan had no steps for requested file(s). Allowed: ${[...allowedPaths].join(', ')}. Dropped ${originalCount} step(s) for other files.`,
            { phase: 'apply' }
          );
        }
      }
      if (plan.steps.length === 0) {
        const addComment = parseAddCommentAtTop(task.description);
        if (addComment && allowedPaths.has(normalizeStepPath(addComment.file))) {
          plan.steps = [
            { file: addComment.file, action: 'modify', description: 'Add comment at top', content: addComment.content },
          ];
        } else {
          return fail('failed', 'Plan produced no steps.', { phase: 'plan' });
        }
      }
    }

    addReasoningStep({
      phase: 'decide',
      thought: `Plan: ${plan.steps.length} steps. Strategy: ${plan.testStrategy}`,
      data: { steps: plan.steps.map((s) => `${s.action} ${s.file}: ${s.description}`) },
      duration: 0,
    });

    const result = await executeWithCheckpoints(plan, task, fileContents, {
      allowedPaths,
      backupPaths,
      filesChanged,
      testResults,
      testMode: task.testMode ?? 'smoke-test',
    });
    if (result.status === 'failed') {
      return fail('failed', result.summary, {
        phase: result.phase ?? 'apply',
        error: result.error,
        clearBackups: !result.rollbackAvailable,
        iterations: result.iterations,
        filesChanged: result.filesChanged,
        testResults: result.testResults,
        backupPaths: result.backupPaths,
      });
    }
    return endTrace(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail(
      'failed',
      `Unexpected error: ${msg}`,
      { phase: 'unknown', error: msg }
    );
  }
}

export async function rollbackDevTask(result: DevResult): Promise<boolean> {
  let success = true;
  for (const bp of result.backupPaths) {
    const ok = await rollbackFile(bp);
    if (!ok) success = false;
  }
  return success;
}

export { getRecentChanges };
