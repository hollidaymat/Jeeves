# JEEVES + AIDER ORCHESTRATOR

**Canonical orchestrator doc.** Setup: [docs/AIDER_ORCHESTRATOR_SETUP.md](docs/AIDER_ORCHESTRATOR_SETUP.md)

## Overview

Jeeves acts as project manager and validator for Aider code generation. Aider runs headless on Daemon, focused only on code execution (no planning overhead). Jeeves handles PRD intake, specification generation, validation, and learning. This hybrid approach maximizes token efficiency while keeping Jeeves meaningful and in control.

**Cost savings vs Antigravity:**
- Aider: ~60-80% fewer API calls (no constant replanning)
- Runs locally on Daemon (headless CLI only)
- Token usage: ~$20-40/month vs ~$200+/month

---

## Architecture

### Component Layout

```
Windows (You)
├─ SSH into Daemon
├─ Send PRD via Signal or Web UI
└─ View progress at http://daemon:3000/orchestrator

Daemon (/home/jeeves)
├─ Jeeves Core (Node.js daemon)
│  ├─ PRD intake & clarification layer
│  ├─ Spec generator (creates task definitions)
│  ├─ Aider orchestrator (spawns process, captures output)
│  ├─ Validator (runs tests, analyzes results)
│  └─ Learning recorder (stores patterns)
│
├─ Aider (installed via pip, CLI only)
│  └─ Spawned by Jeeves when needed
│
├─ Database (/home/jeeves/db)
│  ├─ tasks.db (task definitions, history)
│  ├─ aider_interactions.db (all Aider calls & results)
│  └─ playbooks.db (patterns, success rates)
│
└─ Web UI Server (Node.js)
   └─ /orchestrator tab (shows live flow, history, playbooks)
```

### Data Flow

```
1. You → PRD via Signal/Web UI
   │
2. Jeeves → Clarification Questions (if needed)
   │          "Need context on X, Y, Z?"
   │
3. You → Answers/Context
   │
4. Jeeves → Generates Spec
   │          (file: /tmp/jeeves_task_TIMESTAMP.md)
   │          Contains: goals, acceptance criteria, constraints
   │
5. Jeeves → Spawns Aider
   │          $ aider --model claude-sonnet-4-6 \
   │                   --config /tmp/jeeves_config.json \
   │                   --read-only docs/ \
   │                   --task-spec /tmp/jeeves_task_TIMESTAMP.md \
   │                   src/
   │
6. Aider → Generates Code (interactive mode, auto-confirm)
   │
7. Jeeves → Captures All Output
   │          - Prompts sent to Aider
   │          - File changes
   │          - Terminal output
   │          - Timing data
   │
8. Jeeves → Runs Tests
   │          - tsc, npm test, docker compose test
   │
9. If PASS → Record learning, deploy
   If FAIL → Analyze, decide:
            ├─ "Retry Aider with feedback" (attempt 2/3)
            ├─ "Ask user for clarification" (escalate)
            └─ "Fix locally" (Jeeves edits code)
   │
10. Jeeves → Records in Playbooks DB
    │         (what spec worked, success rate, errors, timing)
    │
11. Web UI → Shows complete flow with artifacts
```

---

## Jeeves Workflow

### Phase 1: PRD Intake

Jeeves receives task via:
- Signal message: "Jeeves, build X"
- Web UI form submission
- Direct API call

Jeeves responds:
```
"I need to understand the full scope. Questions:
1. User authentication: JWT or session-based?
2. Database: Postgres or SQLite?
3. Deployment target: Docker or Lambda?
4. Timeline constraints: ASAP or can iterate?

Reply with clarifications and I'll generate the spec."
```

**Implementation:**
- File: `src/core/jeeves-prdingest.ts`
- Function: `generateClarificationQuestions(prd: string): string[]`
- Stores PRD + context in tasks.db with status "awaiting_clarification"

### Phase 2: Spec Generation

Once Jeeves has context, generates detailed task specification:

**Spec template** (/tmp/jeeves_task_*.md):
```markdown
# Task: Add JWT Authentication

## Objective
Implement JWT-based authentication for API endpoints.

## Acceptance Criteria
- [ ] POST /auth/login accepts username/password
- [ ] Returns JWT token valid for 24h
- [ ] Protected endpoints reject invalid tokens (401)
- [ ] Tests pass: npm test
- [ ] No TypeScript errors: tsc

## Constraints
- Must not break existing auth flow
- No external auth services (Auth0, etc)
- Use existing user table schema
- Backward compatible with session-based fallback

## Context
Current auth: session-based at /src/auth/session.ts
User model: /src/models/User.ts
Test framework: Jest at /tests/

## Files to Modify
- src/auth/jwt.ts (create)
- src/middleware/auth.ts (update)
- src/routes/auth.ts (update)
- tests/auth.test.ts (update)

## Notes
- See /docs/security-policy.md for token requirements
- Existing tests must continue passing
- Rate limit logins to 5/minute
```

**Implementation:**
- File: `src/core/jeeves-specgenerator.ts`
- Function: `generateTaskSpec(prd: string, context: PRDContext): string`
- Uses context assembly layer (6-layer system) + playbook history
- Stores spec in /tmp/jeeves_task_TIMESTAMP.md
- Stores metadata in tasks.db

### Phase 3: Aider Orchestration

Jeeves spawns Aider as subprocess:

```typescript
// src/core/jeeves-aider-orchestrator.ts

async function orchestrateAider(spec: string, attempt: number = 1) {
  const configFile = generateAiderConfig();
  const taskFile = writeTaskSpec(spec);
  
  const aiderProcess = spawn('aider', [
    '--model', 'claude-sonnet-4-6',
    '--config', configFile,
    '--read-only', 'docs/',
    '--read-only', 'node_modules/',
    '--auto-commits',
    '--no-verify',
    'src/',
    'tests/'
  ]);

  let stdout = '';
  let stderr = '';
  const startTime = Date.now();

  aiderProcess.stdout.on('data', (data) => {
    stdout += data;
    recordOutput('stdout', data.toString());
    // Stream to web UI in real-time
    emitToWebUI({ type: 'aider_output', data: data.toString() });
  });

  aiderProcess.stderr.on('data', (data) => {
    stderr += data;
    recordOutput('stderr', data.toString());
  });

  return new Promise((resolve) => {
    aiderProcess.on('close', (code) => {
      const duration = Date.now() - startTime;
      resolve({
        exitCode: code,
        stdout,
        stderr,
        duration,
        timestamp: new Date(),
        attempt,
        taskFile
      });
    });
  });
}
```

**Key points:**
- Aider runs with `--auto-commits` (approves changes automatically)
- `--read-only` for docs and node_modules (faster, no rewrites)
- All output captured to aider_interactions.db
- Timing tracked (for playbook analytics)
- Real-time streaming to Web UI

### Phase 4: Validation & Testing

After Aider completes, Jeeves validates:

```typescript
// src/core/jeeves-validator.ts

async function validateAiderOutput(aiderResult: AiderResult) {
  // 1. Run type checking
  const typeCheck = await runCommand('tsc --noEmit');
  if (typeCheck.code !== 0) {
    return {
      status: 'type_error',
      error: typeCheck.stderr,
      recoverable: true,
      suggestion: 'Aider generated TypeScript errors. Retry with type hints.'
    };
  }

  // 2. Run test suite
  const testResult = await runCommand('npm test');
  if (testResult.code !== 0) {
    return {
      status: 'test_failed',
      error: testResult.stdout,
      recoverable: true,
      suggestion: 'Tests failed. Analyze error and retry.'
    };
  }

  // 3. Check acceptance criteria
  const acMet = await validateAcceptanceCriteria(aiderResult.spec);
  if (!acMet.allMet) {
    return {
      status: 'ac_failed',
      missing: acMet.missing,
      recoverable: true,
      suggestion: `Missing criteria: ${acMet.missing.join(', ')}`
    };
  }

  // 4. All good
  return { status: 'success', recordable: true };
}
```

### Phase 5: Error Handling & Escalation

If validation fails, Jeeves decides:

```typescript
async function handleValidationFailure(validation: ValidationResult, attempt: number) {
  if (validation.recoverable && attempt < 3) {
    if (validation.status === 'type_error') {
      // Retry with type hints in spec
      const enhancedSpec = spec + '\n\n## Type Hints\n' + validation.error;
      return orchestrateAider(enhancedSpec, attempt + 1);
    }
    
    if (validation.status === 'test_failed') {
      // Retry with test error context
      const enhancedSpec = spec + '\n\n## Test Failure Context\n' + validation.error;
      return orchestrateAider(enhancedSpec, attempt + 1);
    }
  }
  
  // If attempt 3 failed or not recoverable, escalate
  return {
    status: 'escalated',
    message: `Failed after 3 attempts. Error: ${validation.error}`,
    requiresUserInput: true
  };
}
```

**Max 3 attempts.** After 3 failures, Jeeves reports to you:
```
"I tried 3 times but couldn't get this to work. The issue is:

[Error details]

Can you clarify: [specific question]?"
```

### Phase 6: Learning & Recording

After success, Jeeves records patterns:

```typescript
// src/core/jeeves-learning-recorder.ts

async function recordLearning(taskData: {
  prd: string,
  spec: string,
  aiderOutput: AiderResult,
  validation: ValidationResult,
  attempts: number,
  duration: number
}) {
  // Extract patterns
  const patterns = {
    taskType: classifyTask(taskData.prd),
    specQuality: analyzeSpec(taskData.spec),
    successRate: taskData.validation.status === 'success' ? 100 : 0,
    attemptsNeeded: taskData.attempts,
    durationMs: taskData.duration,
    filesModified: extractFilesFromAiderOutput(taskData.aiderOutput),
    errors: taskData.validation.errors || [],
    aiderPrompts: extractPromptsFromOutput(taskData.aiderOutput)
  };

  // Store in playbooks.db
  await db.insertPlaybook({
    taskType: patterns.taskType,
    patterns: patterns,
    successCount: patterns.successRate === 100 ? 1 : 0,
    failureCount: patterns.successRate === 100 ? 0 : 1,
    avgAttempts: patterns.attemptsNeeded,
    avgDuration: patterns.durationMs,
    lastUsed: new Date(),
    specTemplate: generateSpecTemplate(taskData.spec),
    aiderPromptPattern: patterns.aiderPrompts
  });

  // On next similar task, playbook is injected into spec
}
```

---

## Aider Integration Details

### Aider Configuration File

Jeeves generates per-task config:

```json
{
  "model": "claude-sonnet-4-6",
  "git": true,
  "auto_commits": true,
  "no_verify": true,
  "dark_mode": true,
  "architect": false,
  "timeout": 300,
  "max_thinking_length": 8000
}
```

### Aider Spawning

```typescript
// src/integrations/aider.ts

export async function spawnAider(
  taskSpec: string,
  targetDir: string = 'src',
  attempt: number = 1
): Promise<AiderExecutionResult> {
  
  const env = {
    ...process.env,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    AIDER_DARK_MODE: 'true',
    AIDER_NO_VERIFY: 'true'
  };

  const args = [
    '--model', 'claude-sonnet-4-6',
    '--auto-commits',
    '--no-verify',
    '--read-only', 'node_modules/',
    '--read-only', 'docs/',
    targetDir
  ];

  const proc = spawn('aider', args, { env });
  
  // Send task spec as initial message
  setTimeout(() => {
    proc.stdin.write(taskSpec + '\n');
    proc.stdin.write('y\n'); // Auto-approve first change
  }, 2000);

  // Capture all output
  let output = '';
  proc.stdout.on('data', (data) => {
    output += data.toString();
  });

  return new Promise((resolve) => {
    proc.on('close', (code) => {
      resolve({
        exitCode: code,
        output,
        timestamp: new Date(),
        attempt
      });
    });
  });
}
```

---

## Database Schema

### tasks.db

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  prd TEXT NOT NULL,
  status TEXT DEFAULT 'pending', -- pending, clarifying, specifying, executing, validating, success, failed, escalated
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP,
  user_id TEXT,
  context JSON, -- User answers to clarification questions
  spec TEXT,
  spec_generated_at TIMESTAMP,
  acceptance_criteria JSON -- Parsed AC from spec
);

CREATE TABLE task_attempts (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id),
  attempt_number INTEGER,
  aider_invocation_id TEXT,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  validation_status TEXT, -- success, type_error, test_failed, ac_failed
  validation_output TEXT,
  errors JSON,
  files_modified TEXT[]
);
```

### aider_interactions.db

```sql
CREATE TABLE aider_calls (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  attempt_number INTEGER,
  input_spec TEXT,
  aider_stdout TEXT,
  aider_stderr TEXT,
  exit_code INTEGER,
  duration_ms INTEGER,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  files_changed JSON
);
```

### playbooks.db

```sql
CREATE TABLE playbooks (
  id TEXT PRIMARY KEY,
  task_type TEXT, -- 'auth', 'api_endpoint', 'db_migration', etc
  success_count INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0,
  avg_attempts FLOAT,
  avg_duration_ms FLOAT,
  spec_template TEXT,
  aider_prompt_pattern TEXT,
  common_errors JSON,
  last_used TIMESTAMP,
  created_at TIMESTAMP
);

CREATE TABLE playbook_suggestions (
  id TEXT PRIMARY KEY,
  playbook_id TEXT REFERENCES playbooks(id),
  suggestion TEXT, -- "When doing X, include Y in spec"
  confidence FLOAT, -- 0.0-1.0
  times_applied INTEGER,
  success_rate FLOAT
);
```

---

## Web UI: Orchestrator Tab

Add new tab to Jeeves web UI (alongside CONSOLE, HOMELAB, ACTIVITY, SCOUT, REASONING):

### Layout

```
ORCHESTRATOR

Active Task: "Add JWT Authentication"
Status: [Executing] [Validating] [Success]
Progress: ████████░░ 80%
Duration: 2m 34s

┌─ TASK INTAKE ─────────────────────────────────────┐
│ PRD: Add JWT-based authentication                 │
│ Status: ✓ Clarified                               │
│ Questions asked: 3 | Answered: 3                  │
└───────────────────────────────────────────────────┘

┌─ SPECIFICATION GENERATED ─────────────────────────┐
│ Task Spec: /tmp/jeeves_task_20260217_...md        │
│ Size: 2.4KB | Playbooks applied: 2                │
│ Acceptance Criteria: 5 items                      │
│ [View Spec] [Edit Spec]                           │
└───────────────────────────────────────────────────┘

┌─ AIDER EXECUTION ─────────────────────────────────┐
│ Attempt: 2/3                                      │
│ Started: 10:15:32                                 │
│ Output (live):                                    │
│                                                    │
│ > Creating src/auth/jwt.ts                        │
│ > Updating src/middleware/auth.ts                 │
│ > Running tests...                                │
│ ✓ 45 tests passed                                 │
└───────────────────────────────────────────────────┘

┌─ VALIDATION ──────────────────────────────────────┐
│ Type Check: ✓ Passed                              │
│ Tests: ✓ 45/45 passed                             │
│ Acceptance Criteria:                              │
│   ✓ POST /auth/login implemented                  │
│   ✓ JWT token generated (24h valid)               │
│   ✓ Protected endpoints reject invalid tokens     │
│   ✓ Tests pass                                    │
│   ✓ No TypeScript errors                          │
└───────────────────────────────────────────────────┘

┌─ LEARNING RECORDED ───────────────────────────────┐
│ Task Type: 'api_auth_feature'                     │
│ Success: ✓ Yes                                    │
│ Attempts: 2 | Duration: 3m 12s                    │
│ New Playbook Suggestion:                          │
│   "Include 'rate limiting' in JWT specs"          │
│   Confidence: 85%                                 │
│ [View Playbooks] [Export]                         │
└───────────────────────────────────────────────────┘

PLAYBOOK HISTORY (Last 10 Tasks)
┌──────────────────────────────────────────────────────┐
│ Task Type          Success  Avg Attempts  Avg Time   │
├──────────────────────────────────────────────────────┤
│ api_auth           100%     1.8           2m 40s     │
│ db_migration       80%      2.1           4m 15s     │
│ component_ui       95%      1.5           1m 30s     │
│ api_endpoint       90%      1.9           3m 45s     │
│ error_handling     75%      2.4           5m 10s     │
└──────────────────────────────────────────────────────┘
```

### Real-Time Features
- **Live Aider output** - As Aider generates code, output streams to the tab
- **Playbook injection indicator** - Show which playbook was applied
- **Error highlighting** - Validation failures highlighted in red with suggested fixes
- **One-click retry** - "Retry with feedback" button if validation fails

---

## Implementation: Files to Create/Modify

### New Files

1. `src/core/jeeves-prdingest.ts` - PRD intake, clarification Q&A
2. `src/core/jeeves-specgenerator.ts` - Spec generation with playbook context
3. `src/core/jeeves-aider-orchestrator.ts` - Spawn Aider, capture output, manage retries
4. `src/core/jeeves-validator.ts` - Validation logic (tests, type check, AC verification)
5. `src/core/jeeves-learning-recorder.ts` - Playbook recording, pattern extraction
6. `src/integrations/aider.ts` - Aider CLI integration
7. `src/api/orchestrator-routes.ts` - Web UI API endpoints
8. `web/components/OrchestratorTab.tsx` - React component for Web UI tab
9. `scripts/install-aider.sh` - Setup script for Aider on Daemon

### Modified Files

1. `src/command-router.ts` - Add `develop` command pattern matching
2. `src/signal-handler.ts` - Route PRD messages to orchestrator
3. `src/web/navigation.ts` - Add "ORCHESTRATOR" tab to nav
4. `src/db/schema.ts` - Add new tables (tasks, aider_interactions, playbooks)

---

## Installation & Setup

### On Daemon (Beelink)

```bash
# 1. Install Aider
pip install aider-chat

# 2. Verify installation
aider --version

# 3. Create Jeeves config directory
mkdir -p /home/jeeves/.aider

# 4. Test Aider with Jeeves API key
export ANTHROPIC_API_KEY="your-key-here"
aider --model claude-sonnet-4-6 --help
```

### Jeeves Configuration

Add to Jeeves config:

```json
{
  "aider": {
    "enabled": true,
    "model": "claude-sonnet-4-6",
    "maxAttempts": 3,
    "timeout": 300,
    "autoCommit": true,
    "darkMode": true,
    "readOnlyDirs": ["node_modules", "docs"]
  }
}
```

---

## Workflow Examples

### Example 1: Simple Feature Request

```
You: "Add pagination to the users API endpoint"

Jeeves: "Clarifications needed:
1. Cursor-based or offset-based pagination?
2. Default page size?"

You: "Cursor-based, default 20 items per page"

Jeeves: [Generates spec] "Calling Aider..."

Web UI shows: Aider generating code...
              Tests running... ✓ 45/45 passed
              Validation: ✓ All AC met

Jeeves: "Done! Pagination added. Recorded in playbooks for future tasks."
```

### Example 2: Retry on Failure

```
You: "Implement email notifications"

Jeeves: [Calls Aider]

Validation: ✗ Test failed: "Missing SMTP config"

Jeeves: "Test failed. Retrying with SMTP context... (Attempt 2/3)"

Web UI shows: [Retrying...] 

Validation: ✓ Success

Jeeves: "Fixed! SMTP config issue was context problem."
```

### Example 3: Escalation

```
You: "Implement OAuth2 integration"

Jeeves: [Attempt 1: type errors]
        [Attempt 2: test failures]
        [Attempt 3: AC not met - missing token refresh]

Jeeves: "I've tried 3 times but can't complete this. The issue is:
        Token refresh logic is complex and I'm not generating it correctly.
        
        Can you:
        1. Review the spec at /tmp/jeeves_task_20260217.md?
        2. Add more detail on token refresh flow?
        3. Point to any existing token refresh code I should reference?"
```

---

## Cost Analysis

### Tokens per Task (Aider vs Antigravity)

| Phase | Antigravity | Aider |
|-------|-------------|-------|
| Planning | 2000 tokens | 0 tokens (Jeeves handles) |
| Execution v1 | 4000 tokens | 1500 tokens |
| Validation | 1000 tokens | 500 tokens |
| Retry (if needed) | 3000 tokens | 800 tokens |
| **Total (avg 1.8 attempts)** | ~9000 tokens | ~3000 tokens |

**Monthly estimate (10 tasks/month):**
- Antigravity: 90,000 tokens = ~$2.70 (plus $200 subscription = $202.70)
- Aider: 30,000 tokens = ~$0.90

**Annual savings: ~$2400** vs Antigravity subscription cost.

---

## Success Criteria

- [ ] Jeeves accepts PRD, asks clarification questions
- [ ] Spec generated and stored in /tmp/
- [ ] Aider spawned as subprocess, output captured live
- [ ] Tests run automatically after Aider completes
- [ ] Retry logic works (up to 3 attempts)
- [ ] Escalation message generated if all attempts fail
- [ ] Playbooks recorded in database
- [ ] Web UI shows live orchestration flow
- [ ] Playbook suggestions appear on next similar task
- [ ] Can handle both success and failure scenarios gracefully

---

## Notes

- Aider runs headless, no user interaction needed (auto-approves changes)
- All output streamed to Web UI in real-time
- Playbooks are the "memory" - they compound over time
- Jeeves + Aider is slower per task than pure Antigravity, but cost-efficient and lets Jeeves stay relevant
- Can always upgrade to Antigravity later if speed becomes critical
