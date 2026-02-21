# JEEVES EVOLVED ARCHITECTURE v2.0 - REFERENCE-BASED IMPLEMENTATION

## Overview
Complete architectural upgrade by adapting proven patterns from ai-engineering-hub. Cursor clones reference repos, studies patterns, adapts to Jeeves. Minimal new code, maximum battle-tested patterns.

- **Agentic RAG** - Adapt from `patchy631/ai-engineering-hub/agentic_rag/` (intelligent context retrieval)
- **MCP Integration** - Adapt from `patchy631/ai-engineering-hub/Multi-Agent-deep-researcher-mcp/` (tool orchestration)
- **Multi-agent System** - Adapt from `patchy631/ai-engineering-hub/Multi-Agent-deep-researcher-mcp/` and `Build-reasoning-model/` (agent spawning)
- **Aider as MCP Tool** - Glue code only (wrap Aider CLI as MCP tool)
- **Playbook Learning** - Reuse existing learnings DB + new playbook queries
- **Web UI** - Add "ORCHESTRATION" tab to existing Jeeves web UI

---

## ARCHITECTURE DIAGRAM

```
┌─────────────────────────────────────────────────────────────────┐
│                     SIGNAL / WEB UI / VOICE                     │
└────────────────────────────┬────────────────────────────────────┘
                             │
                    ┌────────▼────────┐
                    │   TASK ROUTER   │
                    │  (matches intent)│
                    └────────┬────────┘
                             │
                    ┌────────▼────────────────┐
                    │  AGENTIC RAG RETRIEVER  │
                    │ (smart context loading) │
                    └────────┬────────────────┘
                             │
        ┌────────────────────┼────────────────────┐
        │                    │                    │
   ┌────▼────┐        ┌──────▼──────┐      ┌──────▼──────┐
   │ PLANNER  │        │  EXECUTOR   │      │  VALIDATOR  │
   │ (Claude) │───────►│   (Claude)  │─────►│   (Claude)  │
   └──────────┘        └──────┬──────┘      └──────┬──────┘
                               │                    │
                        ┌──────▼──────┐      ┌──────▼───────┐
                        │ MCP + Aider │      │ Test + Verify│
                        │  (code gen) │      │  (validate)  │
                        └─────────────┘      └──────┬───────┘
                                                    │
                                           ┌────────▼────────┐
                                           │  LEARNINGS DB   │
                                           │  (playbooks)    │
                                           └─────────────────┘
```

---

## PART 1: AGENTIC RAG CONTEXT RETRIEVAL

### Reference Pattern
**Source:** `patchy631/ai-engineering-hub/agentic_rag/`

**Cursor Instructions:**
1. Clone repo: `git clone https://github.com/patchy631/ai-engineering-hub.git`
2. Study these files in `/agentic_rag/`:
   - `retriever.py` - How Claude decides what context is needed
   - `rag_agent.py` - Iteration logic with confidence scoring
   - `context_validator.py` - How to validate context sufficiency
3. Port the pattern to TypeScript: `src/core/context/agentic-retriever.ts`

**Keep from Source:**
- Claude prompt for context decision-making
- Iteration loop (max 3 rounds)
- Confidence scoring (0-1, influences whether to iterate)
- Validation logic (ask Claude "is this sufficient?")

**Adapt for Jeeves:**
- Input: PRD from Signal/Web instead of file
- Output: Feed into agent spawning (not their final RAG)
- Context sources: File system, grep patterns, database schema, playbooks
- Reuse existing learnings DB connection

**Database Addition:**
```sql
CREATE TABLE context_usage (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  context_sources TEXT[], -- ["file:src/api/auth.ts", "pattern:error-handling"]
  retrieval_rounds INTEGER,
  final_confidence REAL,
  success BOOLEAN,
  created_at TIMESTAMP
);

CREATE TABLE retrieval_patterns (
  id TEXT PRIMARY KEY,
  task_type TEXT,
  effective_sources TEXT[],
  avg_retrieval_rounds REAL,
  success_rate REAL
);
```

---

## PART 2: MCP SERVER & AIDER TOOL

### Reference Pattern
**Source:** `patchy631/ai-engineering-hub/Multi-Agent-deep-researcher-mcp/`

**Cursor Instructions:**
1. Study their MCP implementation:
   - `/src/tools/` - Tool definition structure
   - `/src/mcp-server.ts` - MCP server setup
   - `/src/tool-registry.ts` - How they load/register tools
2. Copy their MCP server bootstrap pattern
3. Remove their tools (web search, etc)
4. Add Aider as a single MCP tool

**Keep from Source:**
- MCP server initialization pattern
- Tool definition interface (name, description, schema, execute)
- CLI tool execution wrapper (they execute external commands)
- Error handling and timeouts for CLI tools
- Dynamic tool registry

**Aider as MCP Tool (Glue Code Only):**

File: `src/mcp/tools/aider-tool.ts`
```typescript
export const AIDER_TOOL = {
  name: "aider_code_generation",
  description: "Generate/modify code using Aider CLI with Claude API",
  inputSchema: {
    type: "object",
    properties: {
      task_spec: { 
        type: "string", 
        description: "Detailed spec of code changes needed" 
      },
      files_to_edit: { 
        type: "array", 
        items: { type: "string" },
        description: "Which files Aider should focus on"
      },
      model: {
        type: "string",
        enum: ["claude-3-5-sonnet-20241022"],
        description: "Model for code generation"
      }
    },
    required: ["task_spec"]
  },
  
  execute: async (input: any) => {
    // Wrap: aider --model ${input.model} --task "${input.task_spec}" ${input.files_to_edit.join(" ")}
    // Return: { success: bool, output: string, files_modified: string[], errors: string[] }
    // THIS IS JUST GLUE - reuse their pattern from source repo
  }
};
```

File: `src/mcp/server.ts`
- Initialize MCP server (copy their pattern)
- Register AIDER_TOOL
- Keep their error handling and timeouts
- No need to write MCP protocol - use their code

---

## PART 3: MULTI-AGENT ORCHESTRATION

### Reference Pattern
**Sources:** 
- `patchy631/ai-engineering-hub/Multi-Agent-deep-researcher-mcp/` (agent spawning)
- `patchy631/ai-engineering-hub/Build-reasoning-model/` (multi-step planning)

**Cursor Instructions:**
Study how they:
- Spawn independent agents
- Pass messages between agents
- Handle multi-step reasoning
- Implement retry/error recovery

**Implementation (Glue Code):**

File: `src/agents/orchestrator.ts`

```typescript
type AgentName = "planner" | "executor" | "validator";

interface Agent {
  name: AgentName;
  systemPrompt: string;
  maxIterations: number;
}

// Three specialized agents
const PLANNER: Agent = {
  name: "planner",
  systemPrompt: "You are Jeeves' planning agent. Take the PRD and context, create a detailed spec with acceptance criteria.",
  maxIterations: 1
};

const EXECUTOR: Agent = {
  name: "executor",
  systemPrompt: "You are Jeeves' execution agent. Use the aider_code_generation MCP tool to implement the spec.",
  maxIterations: 3 // Retry up to 3 times
};

const VALIDATOR: Agent = {
  name: "validator",
  systemPrompt: "You are Jeeves' validation agent. Run tests, validate output, provide feedback.",
  maxIterations: 2
};

async function executeTask(prd: string, userId: string) {
  const taskId = generateId();
  
  try {
    // 1. Retrieve context
    const context = await agenticRetrieve({ taskDescription: prd });
    
    // 2. Plan
    const spec = await runAgent(PLANNER, { prd, context });
    
    // 3. Execute (max 3 attempts)
    let execution = await runAgent(EXECUTOR, { spec, context });
    let attempt = 1;
    
    while (!execution.success && attempt < 3) {
      execution = await runAgent(EXECUTOR, { 
        spec: spec + `\n\nAttempt ${attempt + 1}. Previous error: ${execution.error}`,
        context 
      });
      attempt++;
    }
    
    if (!execution.success) {
      return { status: "execution_failed", reason: execution.error, taskId };
    }
    
    // 4. Validate
    let validation = await runAgent(VALIDATOR, { execution, context });
    
    if (!validation.success && validation.can_fix) {
      // Request executor to fix based on feedback
      execution = await runAgent(EXECUTOR, {
        spec: spec + `\n\nValidator feedback: ${validation.feedback}`,
        context
      });
      validation = await runAgent(VALIDATOR, { execution, context });
    }
    
    if (!validation.success) {
      // Escalate to user
      sendSignalMessage(userId, `⚠️ Task "${prd}" needs input. Reason: ${validation.feedback}`);
      return { status: "escalated", reason: validation.feedback, taskId };
    }
    
    // 5. Record learning
    await recordLearning({
      task_id: taskId,
      prd,
      spec,
      execution,
      validation,
      success: true,
      context_sources: context.sources,
      agents_used: ["planner", "executor", "validator"],
      total_iterations: attempt + 1
    });
    
    sendSignalMessage(userId, `✅ Task completed: ${prd}`);
    return { status: "completed", taskId, execution };
    
  } catch (error) {
    sendSignalMessage(userId, `❌ Task failed: ${error.message}`);
    return { status: "error", reason: error.message, taskId };
  }
}

// Helper to run an agent
async function runAgent(agent: Agent, context: any, iteration = 1): Promise<any> {
  if (iteration > agent.maxIterations) {
    throw new Error(`Agent ${agent.name} exceeded max iterations (${agent.maxIterations})`);
  }
  
  const response = await claude.messages.create({
    model: "claude-3-5-sonnet-20241022",
    max_tokens: 4000,
    system: agent.systemPrompt,
    tools: agent.name === "executor" ? [AIDER_TOOL] : [],
    messages: [{
      role: "user",
      content: `Context: ${JSON.stringify(context, null, 2)}`
    }]
  });
  
  // Parse response, handle tool use, etc
  // THIS IS GLUE CODE - integrate with their agent pattern
  return parseAgentResponse(response);
}
```

---

## PART 4: PLAYBOOK LEARNING

### Database Schema (Reuse Existing)
Add to learnings DB:

```sql
CREATE TABLE playbooks (
  id TEXT PRIMARY KEY,
  task_type TEXT, -- "auth", "api", "database", etc
  success_pattern TEXT, -- What spec pattern succeeded
  spec_template TEXT, -- Template for similar future tasks
  common_errors TEXT[], 
  solutions TEXT[],
  success_rate REAL,
  usage_count INTEGER,
  last_updated TIMESTAMP
);

CREATE TABLE playbook_matches (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  playbook_id TEXT,
  matched BOOLEAN,
  success BOOLEAN,
  created_at TIMESTAMP
);
```

### Playbook Generation (Glue Code)

File: `src/learning/playbook-generator.ts`

```typescript
// Every 5 completed tasks, analyze and generate playbooks
async function generatePlaybooks() {
  const recentTasks = await queryTasks({ limit: 5, success: true });
  
  // Group by task type / domain
  const grouped = groupBy(recentTasks, t => extractTaskType(t.prd));
  
  for (const [taskType, tasks] of Object.entries(grouped)) {
    // Analyze what made them successful
    const commonPatterns = await claude.messages.create({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 2000,
      messages: [{
        role: "user",
        content: `Analyze these successful ${taskType} tasks and extract a reusable pattern:
        ${tasks.map(t => t.spec).join("\n\n---\n\n")}
        
        Return a JSON playbook with:
        { spec_template, common_errors, solutions, success_indicators }`
      }]
    });
    
    // Store playbook
    await savePlaybook({
      task_type: taskType,
      success_pattern: commonPatterns.content[0].text,
      // ... other fields
    });
  }
}

// When new task arrives, check playbooks
async function applyPlaybooks(prd: string) {
  const taskType = extractTaskType(prd);
  const playbook = await queryPlaybook({ task_type: taskType, limit: 1 });
  
  if (playbook && playbook.success_rate > 0.8) {
    // Return playbook template to be injected into planner
    return playbook.spec_template;
  }
  
  return null;
}
```

---

## PART 5: WEB UI - ORCHESTRATION TAB

### Add to Existing Jeeves UI

New tab in navigation: CONSOLE | HOMELAB | ACTIVITY | ... | **ORCHESTRATION** | NOTES

**API Routes:** `src/web/routes/orchestration.ts`

```typescript
GET /api/orchestration/status
// { task_id, agent, step, iteration, status, tokens_used, elapsed_ms }

GET /api/orchestration/tasks?days=7
// { total, completed, escalated, avg_iterations, avg_duration_ms }

GET /api/orchestration/playbooks
// { total, by_task_type, success_rates, recently_added }

GET /api/orchestration/agents
// { name, completed_tasks, error_rate, avg_iterations }

GET /api/orchestration/logs/:task_id
// { agent, action, result, timestamp }

POST /api/orchestration/cancel/:task_id
// Cancel task, escalate to user
```

**Web Component:** `web/components/OrchestrationDashboard.tsx`

Single page layout:
- **Header:** Current task + agent
- **Left:** Real-time logs (what each agent is doing)
- **Right:** Stats (playbooks matched, tokens, iterations)
- **Bottom:** Escalated tasks pending user input

---

## PART 6: COMMAND ROUTING & ENTRY POINTS

File: `src/handlers/orchestration-handler.ts`

```typescript
export async function handlePRD(prd: string, userId: string) {
  // 1. Validate PRD
  const validation = await validatePRD(prd);
  if (!validation.valid) {
    return { error: validation.reason };
  }
  
  // 2. Start orchestration (async in background)
  const taskId = await executeTask(prd, userId);
  
  // 3. Return immediately
  return { taskId, status: "started" };
}
```

Wire into existing Signal handler:
```typescript
// In Signal message handler:
if (messageType === "PRD" || messageType === "build") {
  const result = await handlePRD(cleanedMessage, userId);
  replySignal(result.taskId ? `Task started: ${result.taskId}` : `Error: ${result.error}`);
}
```

---

## IMPLEMENTATION CHECKLIST

**Phase 1: Setup (4-6 hours)**
- [ ] Clone patchy631/ai-engineering-hub
- [ ] Study agentic_rag/ structure
- [ ] Study Multi-Agent-deep-researcher-mcp/ structure
- [ ] Study Build-reasoning-model/ structure

**Phase 2: Agentic RAG (2-3 hours)**
- [ ] Create agentic-retriever.ts
- [ ] Port Claude prompts from source
- [ ] Add context_usage table
- [ ] Test standalone context retrieval

**Phase 3: MCP & Aider (2-3 hours)**
- [ ] Create MCP server (copy pattern)
- [ ] Create Aider tool wrapper
- [ ] Test MCP tool invocation
- [ ] Verify Aider executes via MCP

**Phase 4: Multi-Agent (3-4 hours)**
- [ ] Create Planner agent
- [ ] Create Executor agent
- [ ] Create Validator agent
- [ ] Implement orchestrator loop
- [ ] Add retry/escalation logic

**Phase 5: Playbook Learning (2-3 hours)**
- [ ] Create playbook tables
- [ ] Implement playbook generator
- [ ] Wire playbooks into planner
- [ ] Test playbook matching

**Phase 6: Web UI (2-3 hours)**
- [ ] Add ORCHESTRATION tab
- [ ] Create API endpoints
- [ ] Build real-time logs component
- [ ] Build stats dashboard

**Phase 7: Integration & Testing (2-3 hours)**
- [ ] Wire Signal handler to orchestrator
- [ ] End-to-end test: PRD → Orchestrator → Aider → Validation → Learning
- [ ] Test escalation flow
- [ ] Monitor playbook improvement

**Total Estimated Time:** 18-25 hours (3-4 days)

---

## FILES TO CREATE/MODIFY

**Create:**
- `src/core/context/agentic-retriever.ts` (port from source)
- `src/mcp/server.ts` (adapt from source)
- `src/mcp/tools/aider-tool.ts` (glue code)
- `src/agents/orchestrator.ts` (glue code)
- `src/learning/playbook-generator.ts` (glue code)
- `src/handlers/orchestration-handler.ts` (integration)
- `src/web/routes/orchestration.ts` (API)
- `web/components/OrchestrationDashboard.tsx` (UI)

**Modify:**
- `src/db/learnings.db` (add playbook tables)
- `src/handlers/signal-handler.ts` (route PRDs to orchestrator)
- `web/components/Navigation.tsx` (add ORCHESTRATION tab)
- Existing web UI server (mount new routes)

---

## WHAT NOT TO DO

- Don't write MCP protocol from scratch - their implementation is complete
- Don't rewrite agent spawning - adapt theirs
- Don't create new retrieval logic - adapt agentic_rag pattern
- Don't build tool execution wrappers - reuse their patterns

Focus on: Gluing together existing patterns + small adapters + Jeeves-specific integration.
