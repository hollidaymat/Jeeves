# Jeeves Reasoning Upgrade - Closing the OpenClaw Gap

**Generated:** 2026-02-19
**Purpose:** Upgrade Jeeves' reasoning architecture to match autonomous agent capabilities.
**Prerequisite:** Context assembler must be wired and injecting variable-length prompts (Cognitive Fix V2 must be done first). Autonomous Developer spec must be implemented.
**Scope:** 7 targeted upgrades to existing systems. No rewrites. No new frameworks.

---

## WHAT THIS SPEC DOES NOT COVER

- Email, calendar, flight booking (not relevant to Jeeves' role)
- New UI components (covered by WEBUI_EXPANSION.md)
- Performance profiling (covered by ADAPTIVE_PERFORMANCE_PROFILER.md)
- Basic autonomous dev tools (covered by AUTONOMOUS_DEVELOPER.md)

This spec ONLY covers the reasoning gaps between Jeeves and OpenClaw-class agents.

---

## WHAT EXISTS (DO NOT REBUILD)

From AUTONOMOUS_DEVELOPER.md:
- `src/devtools/dev-loop.ts` - 3-iteration sequential loop
- `src/devtools/dev-llm.ts` - LLM calls for dev tasks (assessTask, generatePlan, analyzeFailure)
- `src/devtools/file-reader.ts` - Structured file reading
- `src/devtools/file-writer.ts` - Safe writes with backup/rollback
- `src/devtools/test-runner.ts` - Test execution with parsed results
- `src/devtools/guardrails.ts` - Safety system

From existing core:
- `src/core/cognitive/confidence.ts` - Confidence scoring with thresholds
- `src/core/ooda-logger.ts` - OODA trace recording
- `src/core/context/` - 6-layer context assembler
- `data/knowledge/knowledge.db` - SQLite learnings table
- `src/core/trust.ts` - Trust levels

---

## UPGRADE 1: Multi-Step Planning with Checkpoints and Backtracking

### Problem
Current dev-loop.ts runs a flat 3-iteration loop. If step 3 fails, it restarts from scratch. It doesn't know which step failed or how to recover intelligently.

### What to Change
File: `src/devtools/dev-loop.ts`

Replace the flat while loop with a checkpoint-based execution engine.

### Implementation

```typescript
// Add to dev-loop.ts - replace the while(iterations < MAX_ITERATIONS) block

export interface Checkpoint {
  stepIndex: number;
  stepDescription: string;
  filesSnapshot: Map<string, string>; // file path -> content before this step
  testResult: TestResult | null;
  timestamp: number;
}

export interface StepResult {
  stepIndex: number;
  success: boolean;
  error?: string;
  filesChanged: string[];
  canRetryFrom: number; // which checkpoint to retry from (-1 = start over)
}

async function executeWithCheckpoints(
  plan: DevPlan,
  task: DevTask,
  fileContents: FileReadResult[]
): Promise<DevResult> {
  const checkpoints: Checkpoint[] = [];
  const allFilesChanged: string[] = [];
  const allBackupPaths: string[] = [];
  const allTestResults: TestResult[] = [];
  let totalIterations = 0;
  const MAX_TOTAL_ITERATIONS = 5; // More generous than 3 because we're smarter about retries

  for (let stepIdx = 0; stepIdx < plan.steps.length; stepIdx++) {
    const step = plan.steps[stepIdx];

    // Create checkpoint BEFORE executing step
    const checkpoint: Checkpoint = {
      stepIndex: stepIdx,
      stepDescription: step.description,
      filesSnapshot: new Map(),
      testResult: null,
      timestamp: Date.now()
    };

    // Snapshot files this step will touch
    try {
      const existingContent = await readProjectFile(step.file);
      checkpoint.filesSnapshot.set(step.file, existingContent.content);
    } catch {
      // New file, no snapshot needed
    }

    checkpoints.push(checkpoint);

    // Execute the step
    let stepSuccess = false;
    let stepAttempts = 0;
    const MAX_STEP_ATTEMPTS = 2;

    while (!stepSuccess && stepAttempts < MAX_STEP_ATTEMPTS && totalIterations < MAX_TOTAL_ITERATIONS) {
      stepAttempts++;
      totalIterations++;

      let writeResult;
      if (step.action === 'create') {
        writeResult = await writeProjectFile(step.file, step.content, task.id, step.description);
      } else {
        writeResult = await editProjectFile(step.file, step.oldContent, step.newContent, task.id, step.description);
      }

      if (!writeResult.success) {
        // Write failed - can we fix it?
        if (stepAttempts < MAX_STEP_ATTEMPTS) {
          const fix = await analyzeWriteFailure(writeResult.error, step, fileContents);
          if (fix.canFix) {
            step.oldContent = fix.newOldContent;
            step.newContent = fix.newNewContent;
            continue; // Retry this step with fixed content
          }
        }
        // Can't fix - rollback to last good checkpoint
        await rollbackToCheckpoint(checkpoints[stepIdx]);
        return {
          taskId: task.id,
          status: 'failed',
          iterations: totalIterations,
          filesChanged: allFilesChanged,
          testResults: allTestResults,
          backupPaths: allBackupPaths,
          summary: `Step ${stepIdx + 1}/${plan.steps.length} failed: ${writeResult.error}. Rolled back.`,
          rollbackAvailable: false
        };
      }

      if (writeResult.backupPath) allBackupPaths.push(writeResult.backupPath);
      if (!allFilesChanged.includes(step.file)) allFilesChanged.push(step.file);

      // Run type check after each step (fast, catches errors early)
      const typeCheck = await runTypeCheck();
      checkpoint.testResult = typeCheck;
      allTestResults.push(typeCheck);

      if (typeCheck.failed > 0) {
        // Type error after this step - try to fix in place
        if (stepAttempts < MAX_STEP_ATTEMPTS) {
          const fix = await analyzeFailure(typeCheck, fileContents, plan);
          if (fix.canFix) {
            // Update this step's content and retry
            plan.steps[stepIdx] = fix.newSteps[0] || step;
            // Rollback this step's changes before retry
            await rollbackToCheckpoint(checkpoint);
            continue;
          }
        }
        // Can't fix type errors - rollback this step only, skip it
        await rollbackToCheckpoint(checkpoint);
        // Record that this step failed so we can report it
        allTestResults.push(typeCheck);
        break; // Move to next step or finish
      }

      stepSuccess = true;
    }
  }

  // All steps done - run full test suite
  const fullTests = await runProjectTests();
  allTestResults.push(fullTests);

  if (fullTests.failed === 0) {
    return {
      taskId: task.id,
      status: 'success',
      iterations: totalIterations,
      filesChanged: allFilesChanged,
      testResults: allTestResults,
      backupPaths: allBackupPaths,
      summary: `Completed in ${totalIterations} iterations. ${allFilesChanged.length} files changed. All ${fullTests.passed} tests passing.`,
      rollbackAvailable: true
    };
  }

  // Tests failed after all steps - try one final fix pass
  if (totalIterations < MAX_TOTAL_ITERATIONS) {
    totalIterations++;
    const fix = await analyzeFailure(fullTests, fileContents, plan);
    if (fix.canFix) {
      for (const fixStep of fix.newSteps) {
        const writeResult = await editProjectFile(
          fixStep.file, fixStep.oldContent, fixStep.newContent,
          task.id, `Fix: ${fixStep.description}`
        );
        if (writeResult.backupPath) allBackupPaths.push(writeResult.backupPath);
      }
      const retestResults = await runProjectTests();
      allTestResults.push(retestResults);
      if (retestResults.failed === 0) {
        return {
          taskId: task.id,
          status: 'success',
          iterations: totalIterations,
          filesChanged: allFilesChanged,
          testResults: allTestResults,
          backupPaths: allBackupPaths,
          summary: `Completed in ${totalIterations} iterations (with fix pass). All tests passing.`,
          rollbackAvailable: true
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
    summary: `${allFilesChanged.length} files changed. ${fullTests.passed} tests passing, ${fullTests.failed} still failing.`,
    rollbackAvailable: true
  };
}

async function rollbackToCheckpoint(checkpoint: Checkpoint): Promise<void> {
  for (const [filePath, originalContent] of checkpoint.filesSnapshot) {
    try {
      await writeFile(filePath, originalContent, 'utf-8');
    } catch {
      // File might not exist if it was newly created - delete it
      try { await unlink(filePath); } catch { /* ignore */ }
    }
  }
}

// New: analyze why a write operation failed (old_string not found, etc.)
async function analyzeWriteFailure(
  error: string,
  step: DevStep,
  fileContents: FileReadResult[]
): Promise<{ canFix: boolean; newOldContent?: string; newNewContent?: string }> {
  // If old_string not found, re-read the file and generate correct old_string
  if (error.includes('old_string not found') || error.includes('not found in file')) {
    const currentFile = await readProjectFile(step.file);
    const analysis = await analyzeFailure(
      { suite: 'write-fix', passed: 0, failed: 1, skipped: 0, total: 1, duration: 0,
        failures: [{ test: 'write', error: `old_string not found. Current file content available.` }],
        output: `Attempted old_string:\n${step.oldContent}\n\nCurrent file (first 3000 chars):\n${currentFile.content.slice(0, 3000)}`
      },
      fileContents,
      { steps: [step], testStrategy: '' }
    );
    if (analysis.canFix && analysis.newSteps[0]) {
      return {
        canFix: true,
        newOldContent: analysis.newSteps[0].oldContent,
        newNewContent: analysis.newSteps[0].newContent
      };
    }
  }
  return { canFix: false };
}
```

### Imports to Add
```typescript
import { writeFile, unlink } from 'fs/promises';
```

### What Changes
- `executeDevTask()` now calls `executeWithCheckpoints()` instead of the flat while loop
- Each step gets a checkpoint before execution
- Failed steps retry with smarter error analysis
- Rollback targets the specific failed step, not the entire task
- MAX_ITERATIONS increases from 3 to 5 because retries are targeted

---

## UPGRADE 2: Tool Composition (Chain Without Re-prompting)

### Problem
Each tool call (file read, grep, edit, test) requires a separate LLM decision. Reading 5 files = 5 LLM calls.

### What to Change
File: `src/devtools/dev-llm.ts`

Add a `toolChain()` function that composes multiple tool calls from a single LLM plan.

### Implementation

```typescript
// Add to dev-llm.ts

export interface ToolCall {
  tool: 'read' | 'search' | 'list' | 'write' | 'edit' | 'test' | 'typecheck';
  args: Record<string, any>;
  dependsOn?: string; // ID of another tool call whose output feeds into this one
  id: string;
}

export interface ToolChainPlan {
  calls: ToolCall[];
  reasoning: string;
}

// Ask the LLM to plan ALL tool calls at once, then execute deterministically
export async function planAndExecuteToolChain(
  taskDescription: string,
  availableContext: FileReadResult[]
): Promise<Map<string, any>> {
  const results = new Map<string, any>();

  // Single LLM call to plan the entire chain
  const chainPlan = await planToolChain(taskDescription, availableContext);

  // Execute deterministically - no more LLM calls for orchestration
  for (const call of chainPlan.calls) {
    // Resolve dependencies
    const resolvedArgs = resolveDependencies(call.args, call.dependsOn, results);

    let result: any;
    switch (call.tool) {
      case 'read':
        result = await readProjectFile(resolvedArgs.path);
        break;
      case 'search':
        result = await searchProject(resolvedArgs.pattern, resolvedArgs.options);
        break;
      case 'list':
        result = await listDirectory(resolvedArgs.path);
        break;
      case 'write':
        result = await writeProjectFile(
          resolvedArgs.path, resolvedArgs.content,
          resolvedArgs.taskId, resolvedArgs.description
        );
        break;
      case 'edit':
        result = await editProjectFile(
          resolvedArgs.path, resolvedArgs.oldString, resolvedArgs.newString,
          resolvedArgs.taskId, resolvedArgs.description
        );
        break;
      case 'test':
        result = await runProjectTests(resolvedArgs.testFile);
        break;
      case 'typecheck':
        result = await runTypeCheck();
        break;
    }

    results.set(call.id, result);
  }

  return results;
}

// Single LLM call that plans ALL tool operations
async function planToolChain(
  taskDescription: string,
  context: FileReadResult[]
): Promise<ToolChainPlan> {
  const fileList = context.map(f => `${f.path} (${f.lines} lines, exports: ${f.exports.join(', ')})`).join('\n');

  // Use existing LLM call infrastructure - import from wherever Claude is called
  // This replaces multiple LLM round-trips with a single planning call
  const prompt = `You are Jeeves' tool planner. Given a task, plan ALL the tool operations needed.

Available tools:
- read: { path: string } - Read a file
- search: { pattern: string, options?: { glob?: string } } - Grep across project
- list: { path: string } - List directory contents
- write: { path: string, content: string, taskId: string, description: string } - Create new file
- edit: { path: string, oldString: string, newString: string, taskId: string, description: string } - Edit existing file
- test: { testFile?: string } - Run tests
- typecheck: {} - Run TypeScript compiler check

Files already in context:
${fileList}

Task: ${taskDescription}

Return JSON only:
{
  "calls": [
    { "id": "step1", "tool": "read", "args": { "path": "src/foo.ts" } },
    { "id": "step2", "tool": "edit", "args": { "path": "src/foo.ts", "oldString": "...", "newString": "..." }, "dependsOn": "step1" }
  ],
  "reasoning": "Brief explanation of the plan"
}

Rules:
- Use dependsOn when a step needs output from a previous step
- Minimize the number of steps
- Group independent reads together (they can run in parallel)
- Always end with typecheck or test if code was modified`;

  // Call LLM using existing pattern from src/core/cognitive/
  // Use Sonnet for planning
  const response = await callLLMForDevTask(prompt, 'sonnet', 2000);
  return JSON.parse(extractJSON(response));
}

function resolveDependencies(
  args: Record<string, any>,
  dependsOn: string | undefined,
  results: Map<string, any>
): Record<string, any> {
  if (!dependsOn) return args;

  const depResult = results.get(dependsOn);
  if (!depResult) return args;

  // Replace {{dependsOn.field}} placeholders in args
  const resolved = { ...args };
  for (const [key, value] of Object.entries(resolved)) {
    if (typeof value === 'string' && value.includes(`{{${dependsOn}`)) {
      resolved[key] = value.replace(
        new RegExp(`\\{\\{${dependsOn}\\.([^}]+)\\}\\}`, 'g'),
        (_match, field) => {
          return depResult[field] ?? depResult?.content ?? '';
        }
      );
    }
  }
  return resolved;
}

// Helper: extract JSON from LLM response (handles markdown code blocks)
function extractJSON(text: string): string {
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) return jsonMatch[1].trim();
  const braceMatch = text.match(/\{[\s\S]*\}/);
  if (braceMatch) return braceMatch[0];
  return text;
}
```

### What Changes
- `assessTask()` in dev-llm.ts now uses `planToolChain()` for the UNDERSTAND phase
- Instead of: LLM call -> read file -> LLM call -> read another file -> LLM call -> grep
- Now: LLM call (plan all reads) -> execute all reads deterministically -> proceed
- Token savings: ~60-70% reduction in LLM calls for multi-file tasks

### Integration Point
In `dev-loop.ts`, replace the separate `assessTask` + `readMultipleFiles` calls:

```typescript
// OLD (in executeDevTask):
// const assessment = await assessTask(task.description);
// const fileContents = await readMultipleFiles(assessment.relevantFiles);

// NEW:
const chainResults = await planAndExecuteToolChain(task.description, []);
const fileContents = Array.from(chainResults.values()).filter(r => r?.content);
```

---

## UPGRADE 3: Error Categorization

### Problem
Jeeves treats all errors the same - iterate and retry. Doesn't distinguish between:
- Syntax error (fix locally, retry)
- Architecture error (fix the plan, not the code)
- External dependency error (escalate, can't fix)
- Permission error (escalate, needs trust change)

### What to Change
File: `src/devtools/dev-llm.ts` (modify `analyzeFailure`)

### Implementation

```typescript
// Add to dev-llm.ts

export type ErrorCategory =
  | 'syntax'       // Typo, missing bracket, wrong import - fix in place
  | 'logic'        // Code compiles but logic is wrong - fix approach
  | 'architecture' // Wrong file, wrong pattern, wrong abstraction - replan
  | 'dependency'   // Missing package, wrong version, external service down - escalate
  | 'permission'   // Trust/guardrail block, file protection - escalate
  | 'unknown';     // Can't categorize - escalate

export interface CategorizedError {
  category: ErrorCategory;
  description: string;
  recoverable: boolean;
  action: 'fix_in_place' | 'replan_step' | 'replan_all' | 'escalate' | 'skip';
  retryFromStep: number; // -1 = start over, -2 = escalate
}

export function categorizeError(
  testResult: TestResult,
  writeError?: string
): CategorizedError {
  const errorText = writeError ||
    testResult.failures.map(f => f.error).join('\n') ||
    testResult.output;

  // Permission errors - always escalate
  if (errorText.includes('PROTECTED') || errorText.includes('ACCESS DENIED') ||
      errorText.includes('Cannot modify') || errorText.includes('trust level')) {
    return {
      category: 'permission',
      description: 'Blocked by security guardrails',
      recoverable: false,
      action: 'escalate',
      retryFromStep: -2
    };
  }

  // Dependency errors - escalate
  if (errorText.includes('Cannot find module') || errorText.includes('Module not found') ||
      errorText.includes('ECONNREFUSED') || errorText.includes('ETIMEDOUT') ||
      errorText.includes('npm ERR')) {
    return {
      category: 'dependency',
      description: 'Missing or broken dependency',
      recoverable: false,
      action: 'escalate',
      retryFromStep: -2
    };
  }

  // Syntax errors - fix in place
  if (errorText.includes('error TS') || errorText.includes('SyntaxError') ||
      errorText.includes('Unexpected token') || errorText.includes('Cannot find name') ||
      errorText.includes('is not assignable') || errorText.includes('Property') && errorText.includes('does not exist')) {
    return {
      category: 'syntax',
      description: 'TypeScript or syntax error',
      recoverable: true,
      action: 'fix_in_place',
      retryFromStep: -1 // retry current step
    };
  }

  // Logic errors - replan the step
  if (errorText.includes('expected') && errorText.includes('received') ||
      errorText.includes('AssertionError') || errorText.includes('toBe') ||
      errorText.includes('toEqual') || errorText.includes('not to throw')) {
    return {
      category: 'logic',
      description: 'Test assertion failed - logic error',
      recoverable: true,
      action: 'replan_step',
      retryFromStep: -1
    };
  }

  // Architecture errors - replan everything
  if (errorText.includes('circular dependency') || errorText.includes('stack overflow') ||
      errorText.includes('Maximum call stack') || errorText.length > 2000) {
    return {
      category: 'architecture',
      description: 'Fundamental approach issue',
      recoverable: true,
      action: 'replan_all',
      retryFromStep: 0
    };
  }

  return {
    category: 'unknown',
    description: 'Unrecognized error pattern',
    recoverable: false,
    action: 'escalate',
    retryFromStep: -2
  };
}

// Update analyzeFailure to use categorization
export async function analyzeFailure(
  testResult: TestResult,
  fileContents: FileReadResult[],
  currentPlan: DevPlan
): Promise<FailureAnalysis> {
  const error = categorizeError(testResult);

  // Escalate immediately for non-recoverable errors
  if (!error.recoverable) {
    return {
      canFix: false,
      reasoning: `${error.category} error: ${error.description}. Requires human intervention.`,
      newSteps: [],
      errorCategory: error.category
    };
  }

  // For syntax errors - targeted fix prompt
  if (error.action === 'fix_in_place') {
    return await generateSyntaxFix(testResult, fileContents, currentPlan);
  }

  // For logic errors - replan the specific step
  if (error.action === 'replan_step') {
    return await generateLogicFix(testResult, fileContents, currentPlan);
  }

  // For architecture errors - replan everything
  if (error.action === 'replan_all') {
    return await generateArchitectureFix(testResult, fileContents, currentPlan);
  }

  return { canFix: false, reasoning: 'Unknown error', newSteps: [], errorCategory: error.category };
}

// Targeted syntax fix - minimal LLM call
async function generateSyntaxFix(
  testResult: TestResult,
  fileContents: FileReadResult[],
  currentPlan: DevPlan
): Promise<FailureAnalysis> {
  const failureDetails = testResult.failures.map(f =>
    `File: ${f.file || 'unknown'}, Line: ${f.line || '?'}, Error: ${f.error}`
  ).join('\n');

  const prompt = `Fix these TypeScript/syntax errors. Return ONLY the corrected code edits.

Errors:
${failureDetails}

Current plan steps:
${JSON.stringify(currentPlan.steps.map(s => ({ file: s.file, action: s.action, desc: s.description })))}

Return JSON: { "canFix": true, "reasoning": "what was wrong", "newSteps": [DevStep] }`;

  const response = await callLLMForDevTask(prompt, 'haiku', 1500); // Haiku is fine for syntax
  return JSON.parse(extractJSON(response));
}

// Logic fix - needs Sonnet to understand test expectations
async function generateLogicFix(
  testResult: TestResult,
  fileContents: FileReadResult[],
  currentPlan: DevPlan
): Promise<FailureAnalysis> {
  const prompt = `Test assertions failed. The code compiles but produces wrong results.

Test failures:
${testResult.failures.map(f => `${f.test}: expected ${f.expected}, got ${f.actual}. Error: ${f.error}`).join('\n')}

Relevant file contents:
${fileContents.slice(0, 3).map(f => `--- ${f.path} ---\n${f.content.slice(0, 2000)}`).join('\n\n')}

Fix the logic error. Return JSON: { "canFix": true, "reasoning": "what the logic error was", "newSteps": [DevStep] }`;

  const response = await callLLMForDevTask(prompt, 'sonnet', 2000);
  return JSON.parse(extractJSON(response));
}

// Architecture fix - needs full replan with Sonnet
async function generateArchitectureFix(
  testResult: TestResult,
  fileContents: FileReadResult[],
  currentPlan: DevPlan
): Promise<FailureAnalysis> {
  const prompt = `The implementation approach has a fundamental issue. Replan from scratch.

Error: ${testResult.output.slice(0, 1500)}

Original plan:
${JSON.stringify(currentPlan.steps.map(s => ({ file: s.file, action: s.action, desc: s.description })))}

Generate a completely new plan. Different approach. Return JSON: { "canFix": true, "reasoning": "why the old approach failed and what the new approach is", "newSteps": [DevStep] }`;

  const response = await callLLMForDevTask(prompt, 'sonnet', 3000);
  return JSON.parse(extractJSON(response));
}
```

### Update FailureAnalysis Interface
```typescript
export interface FailureAnalysis {
  canFix: boolean;
  reasoning: string;
  newSteps: DevStep[];
  errorCategory?: ErrorCategory; // NEW
}
```

### What Changes
- `analyzeFailure()` now categorizes errors before deciding how to handle them
- Syntax errors use Haiku (cheap, fast) for fixes
- Logic errors use Sonnet for deeper analysis
- Architecture errors trigger full replan
- Permission/dependency errors escalate immediately instead of wasting iterations
- Saves 1-2 iterations on average because it doesn't retry unrecoverable errors

---

## UPGRADE 4: Reasoning Trace (Visible Thinking)

### Problem
Jeeves logs OODA traces but never exposes his active reasoning to the user. When something goes wrong, there's no way to understand why he chose a particular approach.

### What to Change
Files:
- `src/core/ooda-logger.ts` (extend)
- `src/web/routes/` (add reasoning endpoint)
- Web UI (add to existing REASONING tab from REASONING_TAB spec)

### Implementation

```typescript
// Extend ooda-logger.ts - add reasoning narrative

export interface ReasoningStep {
  phase: 'observe' | 'orient' | 'decide' | 'act';
  timestamp: number;
  thought: string;        // Human-readable reasoning
  data?: any;             // Supporting data (file contents, search results, etc.)
  confidence?: number;    // Confidence at this step
  alternatives?: string[]; // What else was considered
  duration: number;       // ms spent on this phase
}

export interface ReasoningTrace {
  taskId: string;
  taskDescription: string;
  startedAt: number;
  completedAt?: number;
  steps: ReasoningStep[];
  outcome: 'success' | 'failed' | 'escalated' | 'in_progress';
  totalTokensUsed: number;
  totalCost: number;
  modelUsed: string;
}

// In-memory ring buffer of last 50 traces
const traceBuffer: ReasoningTrace[] = [];
const MAX_TRACES = 50;
let currentTrace: ReasoningTrace | null = null;

export function startReasoningTrace(taskId: string, description: string): void {
  currentTrace = {
    taskId,
    taskDescription: description,
    startedAt: Date.now(),
    steps: [],
    outcome: 'in_progress',
    totalTokensUsed: 0,
    totalCost: 0,
    modelUsed: ''
  };
}

export function addReasoningStep(step: Omit<ReasoningStep, 'timestamp'>): void {
  if (!currentTrace) return;
  currentTrace.steps.push({
    ...step,
    timestamp: Date.now()
  });
}

export function completeReasoningTrace(
  outcome: ReasoningTrace['outcome'],
  tokensUsed: number,
  cost: number,
  model: string
): void {
  if (!currentTrace) return;
  currentTrace.completedAt = Date.now();
  currentTrace.outcome = outcome;
  currentTrace.totalTokensUsed = tokensUsed;
  currentTrace.totalCost = cost;
  currentTrace.modelUsed = model;

  traceBuffer.push(currentTrace);
  if (traceBuffer.length > MAX_TRACES) traceBuffer.shift();
  currentTrace = null;
}

export function getRecentTraces(limit: number = 20): ReasoningTrace[] {
  return traceBuffer.slice(-limit);
}

export function getTraceById(taskId: string): ReasoningTrace | undefined {
  return traceBuffer.find(t => t.taskId === taskId);
}

export function getCurrentTrace(): ReasoningTrace | null {
  return currentTrace;
}
```

### Wire Into Dev Loop
Add these calls throughout `dev-loop.ts`:

```typescript
// At the start of executeDevTask:
startReasoningTrace(task.id, task.description);

// Before assessTask:
addReasoningStep({
  phase: 'observe',
  thought: `Reading codebase to understand: "${task.description}"`,
  data: { filesToRead: assessment.relevantFiles },
  duration: 0 // Will be set by wrapper
});

// After assessTask returns:
addReasoningStep({
  phase: 'orient',
  thought: `Risk: ${assessment.risk}. Approach: ${assessment.approach}`,
  confidence: assessment.estimatedComplexity <= 5 ? 0.8 : 0.5,
  alternatives: [], // Populated by LLM if it considered alternatives
  duration: Date.now() - stepStart
});

// Before plan execution:
addReasoningStep({
  phase: 'decide',
  thought: `Plan: ${plan.steps.length} steps. Strategy: ${plan.testStrategy}`,
  data: { steps: plan.steps.map(s => `${s.action} ${s.file}: ${s.description}`) },
  duration: Date.now() - stepStart
});

// After completion:
addReasoningStep({
  phase: 'act',
  thought: `Result: ${result.status}. ${result.summary}`,
  data: { filesChanged: result.filesChanged, iterations: result.iterations },
  duration: Date.now() - stepStart
});

completeReasoningTrace(
  result.status === 'success' ? 'success' : result.status === 'blocked' ? 'escalated' : 'failed',
  totalTokensUsed,
  totalCost,
  modelUsed
);
```

### API Endpoint
Add to web server routes:

```typescript
// GET /api/reasoning/traces - list recent traces
// GET /api/reasoning/traces/:taskId - get specific trace
// GET /api/reasoning/current - get in-progress trace (if any)

import { getRecentTraces, getTraceById, getCurrentTrace } from '../core/ooda-logger.js';

router.get('/api/reasoning/traces', (req, res) => {
  const limit = parseInt(req.query.limit as string) || 20;
  res.json(getRecentTraces(limit));
});

router.get('/api/reasoning/traces/:taskId', (req, res) => {
  const trace = getTraceById(req.params.taskId);
  if (!trace) return res.status(404).json({ error: 'Trace not found' });
  res.json(trace);
});

router.get('/api/reasoning/current', (req, res) => {
  const current = getCurrentTrace();
  res.json(current || { status: 'idle' });
});
```

---

## UPGRADE 5: Long-Horizon Memory Integration

### Problem
Learnings exist in the SQLite database but aren't woven into planning decisions. Jeeves repeats mistakes because the learnings DB is just passive context, not active decision input.

### What to Change
File: `src/devtools/dev-llm.ts` (modify `assessTask` and `generatePlan`)

### Implementation

```typescript
// Add to dev-llm.ts

import Database from 'better-sqlite3'; // or however knowledge.db is accessed
import { join } from 'path';

const KNOWLEDGE_DB = join('/home/jeeves/signal-cursor-controller', 'data/knowledge/knowledge.db');

interface Learning {
  id: number;
  category: string;
  trigger_text: string;
  root_cause: string;
  fix: string;
  lesson: string;
  applies_to: string;
  confidence: number;
  created_at: string;
}

// Query learnings relevant to a task
export function getRelevantLearnings(taskDescription: string, limit: number = 5): Learning[] {
  const db = new Database(KNOWLEDGE_DB, { readonly: true });

  try {
    // Search by keyword overlap
    const words = taskDescription.toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 3); // Skip short words

    if (words.length === 0) return [];

    // Build a relevance query - match any keyword in trigger_text, lesson, or applies_to
    const conditions = words.map(() =>
      `(LOWER(trigger_text) LIKE ? OR LOWER(lesson) LIKE ? OR LOWER(applies_to) LIKE ? OR LOWER(fix) LIKE ?)`
    ).join(' OR ');

    const params = words.flatMap(w => [`%${w}%`, `%${w}%`, `%${w}%`, `%${w}%`]);

    const query = `
      SELECT *, (
        ${words.map(() => `(CASE WHEN LOWER(trigger_text) LIKE ? THEN 2 ELSE 0 END) +
         (CASE WHEN LOWER(lesson) LIKE ? THEN 1 ELSE 0 END)`).join(' + ')}
      ) as relevance_score
      FROM learnings
      WHERE ${conditions}
      ORDER BY relevance_score DESC, confidence DESC, created_at DESC
      LIMIT ?
    `;

    const scoringParams = words.flatMap(w => [`%${w}%`, `%${w}%`]);
    const allParams = [...scoringParams, ...params, limit];

    return db.prepare(query).all(...allParams) as Learning[];
  } catch {
    return [];
  } finally {
    db.close();
  }
}

// Format learnings for injection into LLM prompts
export function formatLearningsForPrompt(learnings: Learning[]): string {
  if (learnings.length === 0) return '';

  return `\n\nRELEVANT PAST LEARNINGS (apply these):
${learnings.map((l, i) => `${i + 1}. [${l.category}] ${l.lesson}
   Fix applied: ${l.fix}
   Confidence: ${(l.confidence * 100).toFixed(0)}%`).join('\n')}
`;
}
```

### Wire Into assessTask and generatePlan

```typescript
// In assessTask:
export async function assessTask(description: string): Promise<TaskAssessment> {
  const learnings = getRelevantLearnings(description);
  const learningsContext = formatLearningsForPrompt(learnings);

  const prompt = `... existing prompt ...
${learningsContext}

Consider these past learnings when assessing risk and choosing approach.
If a learning says a certain approach failed before, choose a different one.`;

  // ... rest of existing implementation
}

// In generatePlan:
export async function generatePlan(
  description: string,
  fileContents: FileReadResult[],
  approach: string
): Promise<DevPlan> {
  const learnings = getRelevantLearnings(description);
  const learningsContext = formatLearningsForPrompt(learnings);

  const prompt = `... existing prompt ...
${learningsContext}

IMPORTANT: If past learnings indicate a specific pattern failed, DO NOT repeat it.
Use the lessons learned to inform your implementation plan.`;

  // ... rest of existing implementation
}
```

### What Changes
- Every dev task now queries the learnings DB for relevant past experiences
- Learnings are injected into both assessment and planning prompts
- Failed approaches from past tasks influence future planning
- No new database tables needed - uses existing learnings table

---

## UPGRADE 6: Uncertainty Quantification (Decision Trees)

### Problem
Confidence scoring is binary: act or don't act. There's no middle ground where Jeeves considers multiple approaches and picks the best one based on probability.

### What to Change
File: `src/core/cognitive/confidence.ts` (extend)
File: `src/devtools/dev-llm.ts` (modify assessTask)

### Implementation

```typescript
// Add to confidence.ts

export interface ApproachOption {
  id: string;
  description: string;
  confidence: number;     // 0.0 - 1.0
  risk: 'low' | 'medium' | 'high';
  estimatedIterations: number;
  estimatedTokenCost: number;
  pros: string[];
  cons: string[];
}

export interface DecisionTree {
  task: string;
  options: ApproachOption[];
  selectedOption: string; // ID of chosen option
  selectionReasoning: string;
}

// Evaluate multiple approaches and pick the best one
export function selectBestApproach(options: ApproachOption[]): {
  selected: ApproachOption;
  reasoning: string;
} {
  if (options.length === 0) throw new Error('No approaches to evaluate');
  if (options.length === 1) return { selected: options[0], reasoning: 'Only one approach available' };

  // Score each option: confidence * (1 - risk_penalty) / estimated_iterations
  const scored = options.map(opt => {
    const riskPenalty = opt.risk === 'low' ? 0 : opt.risk === 'medium' ? 0.2 : 0.5;
    const score = (opt.confidence * (1 - riskPenalty)) / Math.max(opt.estimatedIterations, 1);
    return { ...opt, score };
  });

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  const best = scored[0];
  const runnerUp = scored[1];

  const reasoning = `Selected "${best.description}" (score: ${best.score.toFixed(2)}, ` +
    `confidence: ${(best.confidence * 100).toFixed(0)}%, risk: ${best.risk}) ` +
    `over "${runnerUp.description}" (score: ${runnerUp.score.toFixed(2)}, ` +
    `confidence: ${(runnerUp.confidence * 100).toFixed(0)}%, risk: ${runnerUp.risk})`;

  return { selected: best, reasoning };
}
```

### Wire Into assessTask

```typescript
// Modify assessTask in dev-llm.ts to request multiple approaches

export async function assessTask(description: string): Promise<TaskAssessment> {
  const learnings = getRelevantLearnings(description);
  const learningsContext = formatLearningsForPrompt(learnings);

  const prompt = `... existing context ...

For this task, propose 2-3 different approaches. For each approach, estimate:
- confidence (0.0-1.0): How likely this approach will work
- risk (low/medium/high): What could go wrong
- estimatedIterations (1-5): How many tries to get it right
- pros: What's good about this approach
- cons: What's bad about this approach

${learningsContext}

Return JSON:
{
  "approaches": [
    {
      "id": "a1",
      "description": "...",
      "confidence": 0.8,
      "risk": "low",
      "estimatedIterations": 1,
      "estimatedTokenCost": 500,
      "pros": ["..."],
      "cons": ["..."],
      "relevantFiles": ["..."],
      "approach": "..."
    }
  ]
}`;

  const response = await callLLMForDevTask(prompt, 'sonnet', 2000);
  const parsed = JSON.parse(extractJSON(response));

  // Select best approach using decision tree
  const { selected, reasoning } = selectBestApproach(parsed.approaches);

  // Log the decision for reasoning trace
  addReasoningStep({
    phase: 'orient',
    thought: reasoning,
    data: { allApproaches: parsed.approaches, selected: selected.id },
    alternatives: parsed.approaches.filter(a => a.id !== selected.id).map(a => a.description),
    confidence: selected.confidence,
    duration: 0
  });

  return {
    relevantFiles: selected.relevantFiles,
    approach: selected.approach,
    risk: selected.risk,
    estimatedComplexity: selected.estimatedIterations * 2
  };
}
```

### What Changes
- assessTask now considers multiple approaches instead of one
- Each approach gets scored on confidence, risk, and estimated effort
- Past learnings influence confidence ratings
- The decision is logged in the reasoning trace for transparency
- Token cost: ~200 extra tokens per assessment (worth it for better decisions)

---

## UPGRADE 7: Context Session Persistence

### Problem
Every message rebuilds context from scratch. The 6-layer assembler runs on every query, even if we just asked about the same topic 30 seconds ago.

### What to Change
File: `src/core/context/` (add session cache)

### Implementation

```typescript
// New file: src/core/context/session-cache.ts

export interface ContextSession {
  id: string;
  topic: string;              // What this session is about
  assembledContext: string;    // The full assembled context
  layersLoaded: string[];     // Which layers were queried
  tokensUsed: number;
  createdAt: number;
  lastAccessedAt: number;
  hitCount: number;           // How many times this session was reused
}

const sessions = new Map<string, ContextSession>();
const SESSION_TTL = 5 * 60 * 1000; // 5 minutes
const MAX_SESSIONS = 10;

// Generate a topic fingerprint from a message
export function getTopicFingerprint(message: string): string {
  // Extract key nouns and verbs, ignore filler words
  const stopWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
    'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'shall', 'should',
    'may', 'might', 'must', 'can', 'could', 'i', 'you', 'he', 'she', 'it', 'we', 'they',
    'me', 'him', 'her', 'us', 'them', 'my', 'your', 'his', 'its', 'our', 'their',
    'this', 'that', 'these', 'those', 'what', 'which', 'who', 'whom', 'how', 'when',
    'where', 'why', 'not', 'no', 'yes', 'just', 'also', 'very', 'too', 'only']);

  const words = message.toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w))
    .sort();

  return words.join('_');
}

// Check if we have a cached context session for this topic
export function getCachedSession(message: string): ContextSession | null {
  const fingerprint = getTopicFingerprint(message);

  // Clean expired sessions
  const now = Date.now();
  for (const [key, session] of sessions) {
    if (now - session.lastAccessedAt > SESSION_TTL) {
      sessions.delete(key);
    }
  }

  // Look for matching session (exact or similar topic)
  for (const [key, session] of sessions) {
    if (key === fingerprint || topicSimilarity(key, fingerprint) > 0.7) {
      session.lastAccessedAt = now;
      session.hitCount++;
      return session;
    }
  }

  return null;
}

// Store a context session
export function cacheSession(
  message: string,
  assembledContext: string,
  layersLoaded: string[],
  tokensUsed: number
): void {
  const fingerprint = getTopicFingerprint(message);

  // Evict oldest if at capacity
  if (sessions.size >= MAX_SESSIONS) {
    let oldest: [string, ContextSession] | null = null;
    for (const entry of sessions) {
      if (!oldest || entry[1].lastAccessedAt < oldest[1].lastAccessedAt) {
        oldest = entry;
      }
    }
    if (oldest) sessions.delete(oldest[0]);
  }

  sessions.set(fingerprint, {
    id: `session_${Date.now()}`,
    topic: fingerprint,
    assembledContext,
    layersLoaded,
    tokensUsed,
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
    hitCount: 1
  });
}

// Jaccard similarity between topic fingerprints
function topicSimilarity(a: string, b: string): number {
  const setA = new Set(a.split('_'));
  const setB = new Set(b.split('_'));
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

// Invalidate sessions when files change (called from file-writer.ts)
export function invalidateSessionsForFile(filePath: string): void {
  const fileName = filePath.split('/').pop()?.replace(/\.[^.]+$/, '') || '';
  for (const [key, _session] of sessions) {
    if (key.includes(fileName.toLowerCase())) {
      sessions.delete(key);
    }
  }
}
```

### Wire Into Context Assembler

```typescript
// In the context assembler (wherever assemble() is called before LLM):

import { getCachedSession, cacheSession } from './session-cache.js';

async function assembleContext(message: string): Promise<string> {
  // Check cache first
  const cached = getCachedSession(message);
  if (cached) {
    console.log(`[CONTEXT] Cache hit: reusing session (${cached.hitCount} hits, saved ${cached.tokensUsed} tokens)`);
    return cached.assembledContext;
  }

  // No cache - run full assembly
  const startTime = Date.now();
  const context = await runFullContextAssembly(message); // existing 6-layer assembly
  const duration = Date.now() - startTime;

  console.log(`[CONTEXT] Full assembly: ${duration}ms, ${context.length} chars`);

  // Cache the result
  cacheSession(message, context, getLayersLoaded(), estimateTokens(context));

  return context;
}
```

### Wire Into File Writer
```typescript
// In file-writer.ts, after any successful write:
import { invalidateSessionsForFile } from '../core/context/session-cache.js';

// After writeProjectFile or editProjectFile succeeds:
invalidateSessionsForFile(fullPath);
```

### What Changes
- Consecutive messages about the same topic reuse cached context (5 min TTL)
- Context assembly goes from 15534ms to ~0ms on cache hits
- Cache automatically invalidates when files change
- No stale data risk - sessions expire after 5 minutes
- Expected cache hit rate: ~40-50% during active development conversations

---

## BUILD ORDER

Follow this sequence exactly. Test after each upgrade.

### Phase 1: Error Categorization (Upgrade 3)
- Modify `src/devtools/dev-llm.ts`
- Add `categorizeError()` and update `analyzeFailure()`
- Test: create a task that produces a syntax error, verify it's categorized as 'syntax'
- Test: create a task that tries to modify trust.ts, verify it's categorized as 'permission'
- Run full self-test suite - no regressions

### Phase 2: Reasoning Trace (Upgrade 4)
- Extend `src/core/ooda-logger.ts`
- Add API endpoints for traces
- Test: execute a dev task, verify trace is recorded with all 4 phases
- Test: GET /api/reasoning/traces returns the trace
- Run full self-test suite - no regressions

### Phase 3: Long-Horizon Memory (Upgrade 5)
- Add `getRelevantLearnings()` to `src/devtools/dev-llm.ts`
- Wire into `assessTask()` and `generatePlan()`
- Test: add a learning about a specific file, then request a task touching that file
- Verify the learning appears in the LLM prompt
- Run full self-test suite - no regressions

### Phase 4: Context Session Persistence (Upgrade 7)
- Create `src/core/context/session-cache.ts`
- Wire into context assembler
- Wire invalidation into file-writer.ts
- Test: send same topic twice, verify second call uses cache
- Test: modify a file, verify related sessions are invalidated
- Run full self-test suite - no regressions

### Phase 5: Uncertainty Quantification (Upgrade 6)
- Extend `src/core/cognitive/confidence.ts`
- Modify `assessTask()` to request multiple approaches
- Test: give a task with obvious multiple approaches, verify 2-3 options returned
- Verify best option is selected and reasoning is logged
- Run full self-test suite - no regressions

### Phase 6: Tool Composition (Upgrade 2)
- Add `planAndExecuteToolChain()` to `src/devtools/dev-llm.ts`
- Wire into dev-loop.ts understand phase
- Test: give a task requiring 3+ file reads, verify single LLM call plans all reads
- Verify all reads execute deterministically
- Run full self-test suite - no regressions

### Phase 7: Checkpoint Backtracking (Upgrade 1)
- Replace flat while loop in `src/devtools/dev-loop.ts`
- Add `executeWithCheckpoints()`, `rollbackToCheckpoint()`
- Test: give a task where step 2 of 3 fails, verify only step 2 rolls back
- Test: give a task where step 2 fails but is fixable, verify it retries step 2 only
- Run full self-test suite - no regressions

---

## SAFETY RULES (CARRY FORWARD FROM AUTONOMOUS_DEVELOPER.md)

All existing safety rules still apply:
1. Cannot modify security systems (trust.ts, shell.ts, guardrails.ts, signal.ts)
2. Cannot modify config.json, .env, package.json
3. Every write creates backup, every write logs to changelog
4. Maximum 5 iterations per task (increased from 3 due to checkpoint efficiency)
5. Maximum 10 files per task, 500 lines per file
6. Code validated against forbidden patterns before writing
7. High-risk tasks require trust level 3+
8. Self-initiated destructive tasks always blocked

---

## SUCCESS CRITERIA

After all 7 upgrades:

1. **Error categorization:** Syntax errors fixed in 1 iteration (not 3). Permission errors escalated immediately (not after 3 failed retries).

2. **Reasoning trace:** Every dev task produces a trace viewable at /api/reasoning/traces. Trace shows observe/orient/decide/act with human-readable reasoning.

3. **Memory integration:** If Jeeves failed to implement rate limiting last week, this week's attempt references that failure and uses a different approach.

4. **Context caching:** Second message about same topic assembles in <50ms instead of 15000ms.

5. **Uncertainty quantification:** assessTask returns 2-3 approaches with confidence scores. Selected approach is logged with reasoning.

6. **Tool composition:** Multi-file tasks use 1 LLM call for planning instead of N calls for N files.

7. **Checkpoint backtracking:** 3-step task where step 2 fails only re-executes step 2, not steps 1-3.

---

## TOKEN COST IMPACT

| Operation | Before | After | Savings |
|-----------|--------|-------|---------|
| 5-file task assessment | 5 LLM calls (~25K tokens) | 1 LLM call (~6K tokens) | 76% |
| Syntax error fix | 3 iterations (~15K tokens) | 1 targeted fix (~3K tokens) | 80% |
| Repeated topic context | 15K tokens assembly | 0 tokens (cache hit) | 100% |
| Permission error | 3 failed iterations (~15K tokens) | 0 iterations (immediate escalate) | 100% |
| Average dev task | ~50K tokens ($0.15) | ~15K tokens ($0.05) | 70% |
