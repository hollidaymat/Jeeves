/**
 * Dev Loop (devtools)
 * Orchestrator: Understand -> Plan -> Write -> Test -> Iterate (max 3) -> Report.
 * Includes error recovery: path retries, partial file reads, and failure context.
 */

import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { execSync } from 'child_process';
import { readMultipleFilesWithRecovery, readProjectFile } from './file-reader.js';
import { writeProjectFile, editProjectFile, rollbackFile, getRecentChanges } from './file-writer.js';
import { runProjectTests, runTypeCheck, runSmokeTest, runSelfTests, type TestResult } from './test-runner.js';
import { assessTask, generatePlan, analyzeFailure, type DevPlan, type DevStep } from './dev-llm.js';
import { checkGuardrails } from './guardrails.js';
import { getTrustLevel } from '../core/trust.js';

const MAX_ITERATIONS = 3;
const JEEVES_ROOT = '/home/jeeves/signal-cursor-controller';

export type TestMode = 'typecheck-only' | 'smoke-test' | 'full-test';

/** Acceptance criteria: test phase must complete within these limits. */
export const ACCEPTANCE_MS: Record<TestMode, number> = {
  'typecheck-only': 2_000,
  'smoke-test': 3_000,
  'full-test': 15_000,
};

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
    opts: { phase?: string; error?: string; clearBackups?: boolean } = {}
  ): DevResult => ({
    taskId: task.id,
    status,
    iterations,
    filesChanged: [...filesChanged],
    testResults: [...testResults],
    backupPaths: opts.clearBackups ? [] : [...backupPaths],
    summary,
    rollbackAvailable: opts.clearBackups ? false : backupPaths.length > 0,
    error: opts.error ?? summary.slice(0, 200),
    phase: opts.phase,
  });

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
        return {
          taskId: task.id,
          status: 'success',
          iterations: 0,
          filesChanged: [],
          testResults: [],
          summary: `Created ${created.length} folder(s): ${created.join(', ')}.`,
          rollbackAvailable: false,
          backupPaths: [],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return fail('failed', `Could not create folders: ${msg}`, { phase: 'apply', error: msg });
      }
    }

    const createFolderPath = parseCreateFolderTask(task.description);
    if (createFolderPath) {
      try {
        execSync(`mkdir -p ${JSON.stringify(createFolderPath)}`, { stdio: 'pipe' });
        return {
          taskId: task.id,
          status: 'success',
          iterations: 0,
          filesChanged: [],
          testResults: [],
          summary: `Created folder ${createFolderPath}.`,
          rollbackAvailable: false,
          backupPaths: [],
        };
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
      let assessment;
      try {
        assessment = await assessTask(task.description);
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

    const readFailureNote =
      readFailures.length > 0
        ? ` (Skipped ${readFailures.length} file(s): ${readFailures.map((f) => f.path).join(', ')})`
        : '';

    while (iterations < MAX_ITERATIONS) {
      iterations++;
      let stepsAppliedThisIteration = 0;

      for (let stepIndex = 0; stepIndex < plan.steps.length; stepIndex++) {
        const step = plan.steps[stepIndex];
        // Normalize LLM action names to supported ones (create | modify)
        if (typeof step.action === 'string' && /^(update|edit|change|patch)$/i.test(step.action)) {
          step.action = 'modify';
        }
        if (!allowedPaths.has(normalizeStepPath(step.file))) {
          continue;
        }
        let writeResult;
        const tryPath = (filePath: string) => {
          if (step.action === 'create' && step.content) {
            return writeProjectFile(filePath, step.content, task.id, step.description);
          }
          if (step.action === 'modify' && step.oldContent != null && step.newContent != null) {
            return editProjectFile(filePath, step.oldContent, step.newContent, task.id, step.description);
          }
          return Promise.resolve({
            success: false,
            path: filePath,
            backupPath: null,
            linesChanged: 0,
            error: `Invalid step: missing content or oldContent/newContent for ${step.file}`,
          });
        };

        if (step.action !== 'create' && step.action !== 'modify') {
          return fail(
            'failed',
            `Invalid step at index ${stepIndex}: unknown action for ${step.file}`,
            { phase: 'apply', error: `invalid action: ${step.action}` }
          );
        }
        // Recover modify steps that have content but missing oldContent/newContent (e.g. "add comment at top")
        if (step.action === 'modify' && (step.oldContent == null || step.newContent == null) && step.content != null) {
          try {
            const fr = await readProjectFile(step.file);
            const prepend = /top|prepend|beginning|start|at the top|add.*(comment|at the top)/i.test(step.description);
            step.oldContent = fr.content;
            step.newContent = prepend
              ? step.content.trimEnd() + (fr.content.startsWith('\n') ? '' : '\n') + fr.content
              : fr.content + (fr.content.endsWith('\n') ? '' : '\n') + step.content.trimStart();
          } catch (e) {
            return fail(
              'failed',
              `Could not recover modify step for ${step.file}: ${e instanceof Error ? e.message : e}`,
              { phase: 'apply' }
            );
          }
        }
        if (step.action === 'modify' && (step.oldContent == null || step.newContent == null)) {
          return fail(
            'failed',
            `Invalid step at index ${stepIndex}: missing oldContent/newContent for ${step.file}`,
            { phase: 'apply' }
          );
        }
        if (step.action === 'create' && !step.content) {
          return fail(
            'failed',
            `Invalid step at index ${stepIndex}: missing content for ${step.file}`,
            { phase: 'apply' }
          );
        }

        writeResult = await tryPath(step.file);
        if (!writeResult.success && step.file !== normalizeStepPath(step.file)) {
          writeResult = await tryPath(normalizeStepPath(step.file));
        }
        if (!writeResult.success) {
          return fail(
            'failed',
            `Write failed at step ${stepIndex + 1} (${step.file}): ${writeResult.error ?? 'unknown'}.${readFailureNote}`,
            { phase: 'apply', error: writeResult.error }
          );
        }
        if (writeResult.backupPath) backupPaths.push(writeResult.backupPath);
        const addedPath = (writeResult.path || step.file)
          .replace(JEEVES_ROOT + '/', '')
          .replace(JEEVES_ROOT, '') || step.file;
        if (addedPath && !filesChanged.includes(addedPath)) filesChanged.push(addedPath);
        stepsAppliedThisIteration++;
      }

      if (stepsAppliedThisIteration === 0 && plan.steps.length > 0) {
        const addComment = parseAddCommentAtTop(task.description);
        if (addComment && allowedPaths.has(normalizeStepPath(addComment.file))) {
          const step = {
            file: addComment.file,
            action: 'modify' as const,
            description: 'Add comment at top',
            content: addComment.content,
          };
          try {
            const fr = await readProjectFile(step.file);
            const oldContent = fr.content;
            const newContent = step.content.trimEnd() + (oldContent.startsWith('\n') ? '' : '\n') + oldContent;
            const fallbackResult = await editProjectFile(
              step.file,
              oldContent,
              newContent,
              task.id,
              step.description
            );
            if (fallbackResult.success) {
              if (fallbackResult.backupPath) backupPaths.push(fallbackResult.backupPath);
              const addedPath = (fallbackResult.path || step.file).replace(JEEVES_ROOT + '/', '').replace(JEEVES_ROOT, '') || step.file;
              if (addedPath && !filesChanged.includes(addedPath)) filesChanged.push(addedPath);
            }
          } catch {
            return fail('failed', `Add-comment fallback failed for ${step.file}`, { phase: 'apply' });
          }
        } else {
          return fail(
            'failed',
            `No steps applied (all steps were for disallowed files). Allowed: ${[...allowedPaths].join(', ')}.`,
            { phase: 'apply' }
          );
        }
      }

      const testPhaseStart = Date.now();
      let typeCheck: TestResult;
      try {
        typeCheck = await runTypeCheck();
      } catch (err) {
        typeCheck = testResultFromError('typescript-check', err);
        testResults.push(typeCheck);
        return fail(
          'failed',
          `Typecheck could not run: ${err instanceof Error ? err.message : String(err)}. Check that \`npx tsc --noEmit\` works in the project.`,
          { phase: 'typecheck', error: err instanceof Error ? err.message : String(err), clearBackups: false }
        );
      }
      testResults.push(typeCheck);
      if (typeCheck.failed > 0) {
        let fix;
        try {
          fix = await analyzeFailure(typeCheck, fileContents, plan);
        } catch {
          fix = { canFix: false, reasoning: 'Analysis failed', newSteps: [] };
        }
        if (fix.canFix && fix.newSteps.length > 0) {
          plan = { ...plan, steps: fix.newSteps };
          const nextRead = await readMultipleFilesWithRecovery(pathsToRead);
          fileContents = nextRead.contents;
          continue;
        }
        for (const bp of backupPaths) {
          await rollbackFile(bp);
        }
        return fail(
          'failed',
          `Type errors could not be resolved: ${typeCheck.failures[0]?.error ?? 'unknown'}`,
          { phase: 'typecheck', clearBackups: true }
        );
      }

      const mode: TestMode = task.testMode ?? 'smoke-test';
      if (mode === 'typecheck-only') {
        const elapsed = Date.now() - testPhaseStart;
        if (elapsed > ACCEPTANCE_MS['typecheck-only']) {
          return fail(
            'failed',
            `typecheck-only exceeded 2s acceptance (took ${(elapsed / 1000).toFixed(1)}s).`,
            { phase: 'typecheck' }
          );
        }
        return {
          taskId: task.id,
          status: 'success',
          iterations,
          filesChanged,
          testResults,
          backupPaths,
          summary: `Task completed (typecheck-only). ${filesChanged.length} files changed.${readFailureNote}`,
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
        testResults.push(projectTests);
        return fail(
          'failed',
          `Tests could not run: ${err instanceof Error ? err.message : String(err)}.`,
          { phase: 'test', error: err instanceof Error ? err.message : String(err) }
        );
      }
      testResults.push(projectTests);

      const smokeElapsed = Date.now() - testPhaseStart;
      if (mode === 'smoke-test') {
        if (smokeElapsed > ACCEPTANCE_MS['smoke-test']) {
          return fail(
            'failed',
            `smoke-test exceeded 3s acceptance (took ${(smokeElapsed / 1000).toFixed(1)}s).`,
            { phase: 'test' }
          );
        }
        if (projectTests.failed > 0) {
          for (const bp of backupPaths) {
            await rollbackFile(bp);
          }
          return fail(
            'failed',
            `Smoke tests failed: ${projectTests.failures[0]?.error ?? 'unknown'}.${readFailureNote}`,
            { phase: 'test', clearBackups: true }
          );
        }
        return {
          taskId: task.id,
          status: 'success',
          iterations,
          filesChanged,
          testResults,
          backupPaths,
          summary: `Task completed (smoke-test). ${filesChanged.length} files changed.${readFailureNote}`,
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
        testResults.push(selfTests);
        const fullElapsed = Date.now() - testPhaseStart;
        if (fullElapsed > ACCEPTANCE_MS['full-test']) {
          return fail(
            'failed',
            `full-test exceeded 15s acceptance (took ${(fullElapsed / 1000).toFixed(1)}s).`,
            { phase: 'test' }
          );
        }
        const selfFailed = selfTests.failed > 0;
        const projectFailed = projectTests.failed > 0;
        if (!projectFailed && !selfFailed) {
          return {
            taskId: task.id,
            status: 'success',
            iterations,
            filesChanged,
            testResults,
            backupPaths,
            summary: `Task completed (full-test). ${filesChanged.length} files changed. All tests passing.${readFailureNote}`,
            rollbackAvailable: true,
          };
        }
        if (projectFailed || selfFailed) {
          if (iterations < MAX_ITERATIONS) {
            const nextRead = await readMultipleFilesWithRecovery(filesChanged);
            fileContents = nextRead.contents.length > 0 ? nextRead.contents : fileContents;
            let fix;
            try {
              fix = await analyzeFailure(projectTests, fileContents, plan);
            } catch {
              fix = { canFix: false, reasoning: 'Analysis failed', newSteps: [] };
            }
            if (fix.canFix && fix.newSteps.length > 0) {
              plan = { ...plan, steps: fix.newSteps };
              continue;
            }
          }
          const last = testResults[testResults.length - 1];
          return {
            taskId: task.id,
            status: 'partial',
            iterations,
            filesChanged,
            testResults,
            backupPaths,
            summary: `Full-test: ${projectTests.passed + selfTests.passed} passed, ${projectTests.failed + selfTests.failed} failed.${readFailureNote}`,
            rollbackAvailable: true,
          };
        }
      }

      if (projectTests.failed === 0) {
        return {
          taskId: task.id,
          status: 'success',
          iterations,
          filesChanged,
          testResults,
          backupPaths,
          summary: `Task completed (${mode}). ${filesChanged.length} files changed. All ${projectTests.passed} tests passing.${readFailureNote}`,
          rollbackAvailable: true,
        };
      }

      if (iterations < MAX_ITERATIONS) {
        const nextRead = await readMultipleFilesWithRecovery(filesChanged);
        fileContents = nextRead.contents.length > 0 ? nextRead.contents : fileContents;
        let fix;
        try {
          fix = await analyzeFailure(projectTests, fileContents, plan);
        } catch {
          fix = { canFix: false, reasoning: 'Analysis failed', newSteps: [] };
        }
        if (fix.canFix && fix.newSteps.length > 0) {
          plan = { ...plan, steps: fix.newSteps };
          continue;
        }
      }
    }

    const last = testResults[testResults.length - 1];
    return {
      taskId: task.id,
      status: 'partial',
      iterations,
      filesChanged,
      testResults,
      backupPaths,
      summary: `Reached max iterations (${MAX_ITERATIONS}). ${last?.passed ?? 0} tests passing, ${last?.failed ?? 0} still failing.${readFailureNote}`,
      rollbackAvailable: true,
    };
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
