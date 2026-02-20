# Jeeves as Antigravity Orchestrator

## Prerequisites (get it working without QA)

You need a few one-time steps or Jeeves can't actually run Antigravity:

1. **Install Antigravity** (e.g. `scripts/install-antigravity-apt.sh` or [antigravity.google/download](https://antigravity.google/download)).
2. **Log in to Antigravity with a Google account** at least once. The CLI (`antigravity chat`) uses the same stored session; without login it will fail or hang. Run Antigravity from a desktop session (or the same user that runs Jeeves), complete sign-in, then close it.
3. **Set Jeeves env:** `ANTHROPIC_API_KEY` (for Jeeves), `ANTIGRAVITY_USE_CHAT=true` (so the coding step uses `antigravity chat`). Run Jeeves as the **same user** that logged into Antigravity.

**Step-by-step:** **docs/ANTIGRAVITY_ORCHESTRATOR_SETUP.md**

---

## Overview

Jeeves becomes the PM/orchestrator for Antigravity. You provide PRDs, Jeeves plans and coordinates with Antigravity, validates output, and escalates when needed. Antigravity executes code. Observer captures the full interaction cycle for learning.

## Architecture

```
You (PRD) → Jeeves (Orchestrator)
              ├─ Ask clarifying questions
              ├─ Generate detailed spec
              ├─ Call Antigravity
              ├─ Validate tests
              ├─ Iterate or escalate
              └─ Record learnings
                 ↓
            Antigravity (Executor)
              ├─ Read spec
              ├─ Generate code
              └─ Return artifacts
                 ↓
            Observer (Listener)
              ├─ Record interaction
              ├─ Store in DB
              └─ Generate playbook
```

## Phase 1: PRD Intake & Clarification (Jeeves)

**File:** `src/core/orchestrator/prd-intake.ts`

When you send a PRD to Jeeves:

```typescript
interface PRDRequest {
  title: string;
  description: string;
  acceptance_criteria?: string[];
}

// Jeeves receives PRD, analyzes it against current codebase
// If unclear: asks you questions
// If clear: proceeds to spec generation
```

**Jeeves behavior:**
- Reads existing code architecture
- Identifies missing context (dependencies, existing patterns, edge cases)
- Asks 2-5 clarifying questions if needed
- Once answered, creates detailed spec

**Stop condition:** User provides PRD with enough detail OR answers Jeeves' questions

---

## Phase 2: Spec Generation (Jeeves)

**File:** `src/core/orchestrator/spec-generator.ts`

Jeeves creates a machine-readable spec for Antigravity:

```typescript
interface AntigravitySpec {
  task_id: string;
  title: string;
  description: string;
  acceptance_criteria: string[];
  files_to_modify: string[];
  files_to_create: string[];
  dependencies: string[];
  test_command: string;
  estimated_complexity: 'low' | 'medium' | 'high';
  context: {
    architecture_notes: string;
    existing_patterns: string[];
    gotchas: string[];
  };
}
```

**Output:** Writes to `/tmp/antigravity_task_${task_id}.md`

```markdown
# Task: Add JWT Auth to API

## Description
Add JWT authentication to all API endpoints...

## Acceptance Criteria
- [ ] POST /auth/login returns JWT token
- [ ] Protected endpoints require Authorization header
- [ ] Invalid tokens return 401
- [ ] Token expires after 24 hours
- [ ] All tests pass

## Files to Modify
- src/api/auth.ts
- src/middleware/auth-middleware.ts
- src/types/user.ts

## Files to Create
- src/tests/auth.test.ts

## Architecture Context
Current auth uses session cookies. We're migrating to JWT for mobile/Jellyseerr compatibility.
Existing patterns: See src/api/users.ts for request validation structure.
Gotchas: Don't remove session auth yet - keep both working in parallel.

## Test Command
npm run test auth.test.ts

## Estimated Complexity
Medium - 2-3 hour task
```

---

## Phase 3: Antigravity Execution (Antigravity)

**File:** `src/core/orchestrator/antigravity-executor.ts`

Jeeves spawns Antigravity headless CLI:

```typescript
async function executeWithAntigravity(spec: AntigravitySpec): Promise<ExecutionResult> {
  const taskFile = `/tmp/antigravity_task_${spec.task_id}.md`;
  
  const command = `antigravity execute \
    --task-file ${taskFile} \
    --model claude-sonnet-4.5 \
    --output-dir /tmp/antigravity_output/${spec.task_id}`;
  
  const result = await runCommand(command);
  // Observer captures this execution
  
  return {
    task_id: spec.task_id,
    status: 'completed' | 'failed',
    artifacts: result.artifacts,
    test_results: result.test_output,
    duration_ms: result.duration
  };
}
```

**Antigravity does:**
- Reads spec file
- Generates code
- Runs tests
- Returns success/failure

---

## Phase 4: Validation & Iteration (Jeeves)

**File:** `src/core/orchestrator/validator.ts`

After Antigravity completes:

```typescript
async function validateAndIterate(
  spec: AntigravitySpec,
  execution: ExecutionResult,
  iteration: number = 1
): Promise<IterationResult> {
  
  if (execution.test_results.passed) {
    // SUCCESS: Record and return
    return {
      status: 'success',
      iteration_count: iteration,
      code_quality: analyzeCode(execution.artifacts),
      ready_to_deploy: true
    };
  }
  
  if (iteration >= 3) {
    // ESCALATE: Too many failures
    return {
      status: 'escalate',
      error: execution.test_results.error,
      message: `Failed 3 times. Need human help. Error: ${execution.test_results.error}`,
      ready_to_deploy: false
    };
  }
  
  // RETRY: Analyze error, provide feedback
  const errorAnalysis = await analyzeTestFailure(execution.test_results.error);
  
  if (errorAnalysis.type === 'simple_fix') {
    // Jeeves can fix it: edit the generated code
    return {
      status: 'retry',
      iteration: iteration + 1,
      action: 'jeeves_fixes',
      fix: errorAnalysis.suggested_fix
    };
  } else {
    // Antigravity needs to retry with more context
    return {
      status: 'retry',
      iteration: iteration + 1,
      action: 'antigravity_retry',
      feedback: errorAnalysis.feedback_for_antigravity
    };
  }
}
```

**Decision tree:**
- Tests pass → Deploy
- Tests fail + iteration < 3 → Analyze error
  - If simple fix → Jeeves edits code, re-test
  - If complex → Send error feedback to Antigravity, retry
- Tests fail + iteration >= 3 → Escalate to you

---

## Phase 5: Escalation (Jeeves → You)

When Jeeves gets stuck (3 failed iterations), he asks for help:

```
User: "Add JWT auth"

Jeeves: "I need clarification: should we support refresh tokens?"
User: "Yes, refresh tokens too"

Jeeves: (creates spec, calls Antigravity, validates)

Antigravity: (generates code, tests fail on token expiry)

Jeeves: (retry 1: fixes small issues, re-runs tests, still fails)
Jeeves: (retry 2: sends better error feedback to Antigravity, still fails)
Jeeves: (retry 3: fails again)

Jeeves: "I'm stuck. The token expiry validation keeps failing. Error: 
ValidationError: expected expiry field in JWT payload. 
Antigravity generated 2 different implementations, both failed.
Can you help me understand the expected JWT structure?"

You: "The expiry should be 'exp' field in seconds since epoch"

Jeeves: "Got it. Let me try once more with that context."
```

**Escalation conditions:**
- 3 failed iterations
- Antigravity error is "design question" (ambiguous spec)
- Jeeves detects conflict with existing code patterns

---

## Phase 6: Observer & Learning (Passive)

**File:** `src/core/observer/interaction-recorder.ts`

Observer captures the entire interaction cycle:

```typescript
interface InteractionRecord {
  task_id: string;
  prd: string;
  spec_generated: AntigravitySpec;
  executions: {
    iteration: number;
    antigravity_input: string;
    antigravity_output: string;
    test_result: 'pass' | 'fail';
    error?: string;
    jeeves_action?: string;
  }[];
  final_status: 'success' | 'escalated' | 'user_helped';
  total_iterations: number;
  total_duration_ms: number;
  generated_code: string;
  test_results: TestResult[];
}
```

Stored in database:
```sql
CREATE TABLE antigravity_interactions (
  task_id TEXT PRIMARY KEY,
  created_at TIMESTAMP,
  prd TEXT,
  spec JSONB,
  executions JSONB,
  final_status TEXT,
  iterations INT,
  duration_ms INT,
  code TEXT,
  test_results JSONB
);
```

Every 5 minutes, generate playbooks:

```typescript
interface Playbook {
  pattern: string;  // "jwt_auth", "add_endpoint", "fix_type_error"
  success_rate: number;  // 0-100
  avg_iterations: number;
  common_errors: string[];
  winning_spec_template: string;  // What spec wording worked?
  antigravity_prompts_that_worked: string[];
}
```

**Playbook generation:**
- Cluster similar tasks (all "auth" tasks, all "API" tasks)
- Track which specs led to success in 1 iteration
- Track which errors repeat
- Track which Antigravity error messages indicate which problems

---

## Phase 7: Jeeves Learning Application

**File:** `src/core/orchestrator/learnings-applier.ts`

On NEXT similar task, Jeeves uses playbooks:

```typescript
async function generateSpecWithLearnings(
  prd: PRDRequest,
  relevantPlaybooks: Playbook[]
): Promise<AntigravitySpec> {
  
  const spec = generateBaseSpec(prd);
  
  // Apply learnings
  if (relevantPlaybooks.length > 0) {
    spec.context.previous_winning_patterns = relevantPlaybooks
      .sort((a, b) => b.success_rate - a.success_rate)
      .map(p => p.winning_spec_template);
    
    spec.context.common_mistakes = relevantPlaybooks
      .flatMap(p => p.common_errors)
      .slice(0, 5);
  }
  
  return spec;
}
```

Playbook is injected into spec context, so Antigravity knows what worked before.

---

## Web UI Integration

**New tab:** "ORCHESTRATION" (between SCOUT and REASONING)

Shows live task orchestration:

```
ORCHESTRATION
┌─────────────────────────────────────────────────────┐
│ Active Task: Add JWT Auth                    [LIVE]  │
├─────────────────────────────────────────────────────┤
│ Phase: Iteration 1 of 3                             │
│ ├─ PRD Intake ✓ (1m 23s)                            │
│ ├─ Spec Generation ✓ (45s)                          │
│ ├─ Antigravity Execution (in progress...)           │
│ │  Output: Generating auth.ts...                    │
│ ├─ Validation (pending)                             │
│ └─ Learning Record (pending)                        │
│                                                      │
│ Spec: [Show/Hide]                                   │
│ Antigravity Output: [Show/Hide]                     │
│ Test Results: [Show/Hide]                           │
└─────────────────────────────────────────────────────┘

[Recent Tasks]
├─ Add JWT Auth (in progress)
├─ Fix rate limiting (success - 2 iterations)
├─ Add caching layer (success - 1 iteration)
└─ Implement notifications (escalated - needs help)
```

---

## Database Schema

```sql
CREATE TABLE tasks (
  task_id TEXT PRIMARY KEY,
  prd TEXT,
  status TEXT,
  created_at TIMESTAMP,
  completed_at TIMESTAMP,
  final_code TEXT
);

CREATE TABLE task_iterations (
  task_id TEXT,
  iteration INT,
  spec JSONB,
  antigravity_output TEXT,
  test_result TEXT,
  error TEXT,
  jeeves_action TEXT,
  duration_ms INT,
  PRIMARY KEY (task_id, iteration)
);

CREATE TABLE playbooks (
  pattern TEXT PRIMARY KEY,
  success_rate FLOAT,
  avg_iterations FLOAT,
  common_errors TEXT[],
  winning_spec_template TEXT,
  last_updated TIMESTAMP
);
```

---

## Implementation Order (1 Shot)

**Cursor Build Order:**

1. **PRD Intake** (`src/core/orchestrator/prd-intake.ts`)
   - Parse PRD, ask clarifying questions
   - Test: User provides PRD with gaps, Jeeves asks 3 questions

2. **Spec Generator** (`src/core/orchestrator/spec-generator.ts`)
   - Convert PRD + context into Antigravity-readable spec file
   - Test: Spec file written to /tmp, contains all required fields

3. **Antigravity Executor** (`src/core/orchestrator/antigravity-executor.ts`)
   - Call `antigravity execute` with spec
   - Capture output, parse results
   - Test: Mock Antigravity response, validate parsing

4. **Validator & Iterator** (`src/core/orchestrator/validator.ts`)
   - Check test results
   - Decide: success / retry / escalate
   - Test: 3 scenarios - pass, fail, escalate

5. **Observer Recorder** (`src/core/observer/interaction-recorder.ts`)
   - Record full interaction cycle to DB
   - Test: Verify DB records written

6. **Playbook Generator** (`src/core/observer/playbook-generator.ts`)
   - Analyze interactions every 5 minutes
   - Generate patterns, success rates, templates
   - Test: Mock 10 interactions, verify playbook generated

7. **Learnings Applier** (`src/core/orchestrator/learnings-applier.ts`)
   - Use playbooks in next spec generation
   - Test: Verify spec contains playbook context

8. **Web UI** (`web/components/OrchestrationTab.tsx`)
   - Show live task status
   - Display phases, output, test results
   - Test: Verify real-time updates as task progresses

9. **Integration** (`src/core/orchestrator/main.ts`)
   - Wire all pieces together
   - Command: `jeeves orchestrate "Add JWT auth"`
   - Test: Full E2E flow from PRD to success

10. **Database Setup** (`scripts/setup-orchestrator-db.sql`)
    - Create tables, indexes
    - Initialize empty playbooks table

---

## Environment Variables

```bash
ANTIGRAVITY_MODEL=claude-sonnet-4.5
ANTIGRAVITY_API_KEY=sk-...
ANTIGRAVITY_HEADLESS=true
PLAYBOOK_UPDATE_INTERVAL_MS=300000  # 5 minutes
MAX_ITERATIONS=3
TASK_TEMP_DIR=/tmp/antigravity_tasks
TASK_OUTPUT_DIR=/tmp/antigravity_output
```

---

## Success Criteria

- ✅ User gives PRD, Jeeves asks 2-3 clarifying questions
- ✅ Jeeves generates detailed spec, calls Antigravity
- ✅ Antigravity generates code, tests run
- ✅ If fail, Jeeves retries (up to 3 times)
- ✅ If succeed, Jeeves records learning
- ✅ After 10 tasks, playbook exists with patterns
- ✅ Web UI shows live orchestration progress
- ✅ Next similar task uses playbook (faster)
- ✅ If stuck after 3 iterations, Jeeves asks for help

---

## Linux and serve-web (browser QA)

On Linux, `antigravity serve-web` fails because the helper binary **antigravity-tunnel** is not shipped (neither in the APT package nor in the official Linux tarball). So the "Open QA browser" flow is unavailable out of the box.

**Options:** (1) Use the Antigravity **desktop app** for QA when running builds. (2) Use **Chrome on port 9222 + socat** to drive a browser from Linux (e.g. WSL2 → Windows Chrome). Full research and step-by-step: **docs/ANTIGRAVITY_WSL2_BROWSER_TUNNEL.md**.

---

## Acceptance Test

```
User: "Add Tailscale integration endpoint"

Jeeves: "Got it. A few questions:
  1. Should this be a new /api/tailscale endpoint or integrate with existing /api/network?
  2. Do we need to store Tailscale API key in secrets?
  3. What should the response format be?"

User: "Integrate with /api/network, yes on secrets, return {status, ip_address, tailnet_name}"

Jeeves: (generates spec)
"Spec ready. Calling Antigravity..."

[Antigravity generates code]

"Tests pass! ✓ Task complete. Recorded learning pattern: 'network_integration_endpoint'"

[Next similar task uses playbook]
```
