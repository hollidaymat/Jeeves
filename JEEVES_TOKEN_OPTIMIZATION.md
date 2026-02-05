# Jeeves Token Optimization Guide

## Target: $0.03 MVPs, $1 Full Projects

Based on Clawdbot's architecture, here's how to get Jeeves to these numbers.

---

## The Core Insight: Don't Use LLM for Orchestration

**The expensive way (what most agents do):**
```
Message → LLM decides what to do → Tool call → LLM evaluates result → Tool call → LLM decides next step → Response

Each LLM call: ~10,000 tokens
5 calls for simple task: 50,000 tokens = $0.15
```

**The cheap way (Lobster pattern):**
```
Message → LLM classifies intent (once) → Deterministic pipeline → LLM formats response (once)

2 LLM calls: 4,000 tokens = $0.01
```

**Savings: 92%**

---

## Implementation: Workflow Engine

### 1. Define Common Workflows as YAML

Instead of letting the LLM figure out multi-step tasks, pre-define them:

```yaml
# workflows/create-component.yaml
name: create-component
description: "Create a new React component"
trigger_patterns:
  - "create component"
  - "add component"
  - "new component"

steps:
  # Step 1: LLM extracts parameters (ONLY LLM call for orchestration)
  - name: extract-params
    type: llm
    model: haiku  # Cheap model for simple extraction
    prompt: |
      Extract from this request:
      - component_name (PascalCase)
      - component_type (functional|class)
      - props (list of prop names)
      
      Request: {{message}}
      
      Return JSON only: {"name": "", "type": "", "props": []}

  # Step 2: Deterministic file creation (NO LLM)
  - name: create-file
    type: exec
    command: |
      mkdir -p components/{{extract-params.name}}
      touch components/{{extract-params.name}}/index.tsx
      touch components/{{extract-params.name}}/{{extract-params.name}}.tsx
      touch components/{{extract-params.name}}/{{extract-params.name}}.test.tsx

  # Step 3: LLM generates component code (smart model, but focused)
  - name: generate-code
    type: llm
    model: sonnet
    max_tokens: 1000  # Capped - don't let it ramble
    prompt: |
      Generate a {{extract-params.type}} React component.
      Name: {{extract-params.name}}
      Props: {{extract-params.props}}
      
      Return ONLY the component code, no explanation.

  # Step 4: Write file (NO LLM)
  - name: write-file
    type: exec
    command: |
      cat > components/{{extract-params.name}}/{{extract-params.name}}.tsx << 'EOF'
      {{generate-code.output}}
      EOF

  # Step 5: Format response (Haiku - cheap)
  - name: respond
    type: llm
    model: haiku
    max_tokens: 100
    prompt: |
      Confirm component creation in 1 sentence.
      Component: {{extract-params.name}}
      Files created: 3
```

**Token breakdown:**
- extract-params (Haiku): ~500 tokens = $0.0005
- generate-code (Sonnet): ~1500 tokens = $0.005
- respond (Haiku): ~200 tokens = $0.0002

**Total: ~$0.006 per component creation**

---

## 2. Intent Classification Router

Before running any workflow, classify the intent with minimal tokens:

```javascript
// src/intent-classifier.js
const INTENT_PATTERNS = {
  // Exact matches - no LLM needed
  'status': /^(status|health|how are you)$/i,
  'cost': /^(cost|budget|spending|usage)$/i,
  'help': /^(help|commands|\?)$/i,
  
  // Pattern matches - no LLM needed
  'open-project': /^open\s+(\w+)/i,
  'create-component': /create\s+(component|comp)/i,
  'git-commit': /commit|push|pull/i,
  
  // Requires LLM classification
  'complex': null
};

async function classifyIntent(message) {
  // Try pattern matching first (FREE)
  for (const [intent, pattern] of Object.entries(INTENT_PATTERNS)) {
    if (pattern && pattern.test(message)) {
      return { intent, confidence: 1.0, method: 'pattern', cost: 0 };
    }
  }
  
  // Fall back to Haiku classification (CHEAP)
  const response = await claude.messages.create({
    model: 'claude-haiku-4-20250514',
    max_tokens: 50,  // Tiny response
    system: 'Classify intent. Return only: {"intent": "name", "confidence": 0.0-1.0}',
    messages: [{ role: 'user', content: message }]
  });
  
  return { ...JSON.parse(response.content), method: 'llm', cost: 0.001 };
}
```

**Cost: $0 for pattern matches, $0.001 for LLM classification**

---

## 3. Prompt Caching Strategy

Anthropic's prompt caching is the biggest cost saver:

```javascript
// src/prompt-cache.js
const SYSTEM_PROMPT = `You are Jeeves, an autonomous AI employee...
[Your full system prompt - can be 5000+ tokens]`;

// Cache the system prompt
const cachedSystemPrompt = {
  type: "text",
  text: SYSTEM_PROMPT,
  cache_control: { type: "ephemeral" }  // 5-minute TTL
};

// Keep cache warm with heartbeat
setInterval(async () => {
  await claude.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1,
    system: [cachedSystemPrompt],
    messages: [{ role: 'user', content: 'heartbeat' }]
  });
}, 4.5 * 60 * 1000);  // Every 4.5 minutes (before 5min TTL)

// All requests use cached system prompt
async function query(userMessage) {
  return claude.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    system: [cachedSystemPrompt],  // 90% cheaper on cache hit
    messages: [{ role: 'user', content: userMessage }]
  });
}
```

**Savings:**
- First request: 5000 tokens × $3/M × 1.25 = $0.01875
- Subsequent requests: 5000 tokens × $3/M × 0.1 = $0.0015

**90% savings on system prompt after first request**

---

## 4. Tiered Context Loading

Don't load everything. Load what's needed:

```javascript
// src/context-tiers.js
const CONTEXT_TIERS = {
  // Tier 0: Zero context (pattern-matched intents)
  minimal: {
    systemPrompt: false,
    projectContext: false,
    fileContents: false,
    history: 0
  },
  
  // Tier 1: Light context (simple questions, status)
  light: {
    systemPrompt: true,  // Cached
    projectContext: false,
    fileContents: false,
    history: 0
  },
  
  // Tier 2: Standard context (single file edits)
  standard: {
    systemPrompt: true,
    projectContext: true,  // package.json, directory structure
    fileContents: 'target',  // Only the file being edited
    history: 3  // Last 3 exchanges
  },
  
  // Tier 3: Full context (complex tasks, PRDs)
  full: {
    systemPrompt: true,
    projectContext: true,
    fileContents: 'relevant',  // Multiple files
    history: 10
  }
};

function selectTier(intent) {
  switch (intent) {
    case 'status':
    case 'cost':
    case 'help':
      return 'minimal';  // No LLM needed
      
    case 'question':
    case 'explain':
      return 'light';  // ~500 tokens
      
    case 'edit-file':
    case 'create-component':
      return 'standard';  // ~2000 tokens
      
    case 'build-feature':
    case 'prd-execution':
      return 'full';  // ~10000 tokens
      
    default:
      return 'standard';
  }
}
```

---

## 5. Response Length Control

LLMs ramble. Stop them:

```javascript
// src/response-control.js
const RESPONSE_LIMITS = {
  confirmation: 50,     // "Done. Component created."
  status: 100,          // Quick status summary
  explanation: 300,     // Brief explanation
  code: 1000,           // Code generation
  analysis: 2000,       // Detailed analysis
  prd_response: 500     // PRD checkpoint
};

const CONCISE_INSTRUCTION = `
RESPONSE RULES:
- Be extremely concise
- No preamble ("I'll help you with that...")
- No postamble ("Let me know if you need anything else!")
- State action taken + result only
- For errors: problem + solution only

Examples:
GOOD: "Created UserProfile component with 3 props."
BAD: "I've successfully created the UserProfile component for you! It includes three props as you specified. Let me know if you'd like any changes!"
`;
```

---

## 6. The $0.03 MVP Math

Let's break down a real MVP (landing page + auth + database):

| Task | Method | Tokens | Cost |
|------|--------|--------|------|
| Classify intent | Pattern | 0 | $0 |
| Load PRD | File read | 0 | $0 |
| Extract requirements | Haiku | 800 | $0.0008 |
| Generate DB schema | Sonnet (cached) | 1500 | $0.002 |
| Generate API routes | Sonnet (cached) | 2000 | $0.003 |
| Generate landing page | Sonnet (cached) | 3000 | $0.004 |
| Generate auth components | Sonnet (cached) | 2500 | $0.003 |
| Integration code | Sonnet (cached) | 1500 | $0.002 |
| 5 status checkpoints | Haiku | 500 | $0.0005 |
| Final summary | Haiku | 300 | $0.0003 |

**Total: ~$0.015 + 20% buffer = ~$0.02**

With a few iterations and corrections: **$0.03-0.05**

---

## 7. Session Compaction

When context grows, summarize and reset:

```javascript
// src/compaction.js
async function compactSession(sessionId) {
  const history = await getSessionHistory(sessionId);
  
  if (history.tokenCount < 50000) return;  // Not yet needed
  
  // Summarize with Haiku (cheap)
  const summary = await claude.messages.create({
    model: 'claude-haiku-4-20250514',
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: `Summarize this conversation in bullet points. Focus on:
        - Decisions made
        - Current state of work
        - Pending tasks
        - User preferences learned
        
        Conversation:
        ${history.messages.slice(-20).map(m => `${m.role}: ${m.content}`).join('\n')}`
    }]
  });
  
  // Reset session with summary as context
  await resetSession(sessionId, {
    compactedSummary: summary.content,
    compactedAt: Date.now(),
    previousTokenCount: history.tokenCount
  });
  
  return { 
    before: history.tokenCount, 
    after: 500,  // Just the summary
    savings: ((history.tokenCount - 500) / history.tokenCount * 100).toFixed(1) + '%'
  };
}
```

---

## Implementation Priority for Cursor

### Phase 1: Intent Classification (Biggest Win) ✅ COMPLETE
```
[x] Add pattern matching for common intents
[x] Route simple queries to Haiku
[x] Skip LLM entirely for status/cost/help
```
**Implementation:** `src/core/parser.ts` - PATTERNS object with resolutionMethod tracking

### Phase 2: Prompt Caching ✅ COMPLETE
```
[x] Implement cached system prompt
[x] Add heartbeat to keep cache warm
[x] Track cache hit rate
```
**Implementation:** `src/core/cursor-agent.ts` - startCacheHeartbeat(), getCacheStatus()

### Phase 3: Workflow Engine ✅ COMPLETE
```
[x] Define YAML workflow format
[x] Implement workflow executor
[x] Create workflows for common tasks (create-component, edit-file, git-commit)
```
**Implementation:** `src/core/workflow-engine.ts`, `workflows/*.yaml`

### Phase 4: Response Control ✅ COMPLETE
```
[x] Add max_tokens limits per intent type
[x] Update system prompt with conciseness rules
[x] Measure and track response lengths
```
**Implementation:** TOKEN_LIMITS in `src/core/cursor-agent.ts`, tier-based maxTokens

### Phase 5: Session Compaction ✅ COMPLETE
```
[x] Implement auto-compaction when context grows
[x] Store compacted summaries
[x] Test conversation continuity after compaction
```
**Implementation:** `src/core/session-compactor.ts`, `src/core/memory.ts` compactGeneralConversations()

### Phase 6: Cost Tracking ✅ COMPLETE
```
[x] Track LLM usage per call
[x] Daily reports with breakdown by intent/model
[x] Pattern match vs LLM tracking
```
**Implementation:** `src/core/cost-tracker.ts`

---

## Cost Tracking Dashboard

Every operation should log:

```javascript
// src/cost-tracker.js
const costs = {
  daily: { tokens: 0, cost: 0, calls: 0 },
  byIntent: {},
  byModel: {}
};

function trackUsage(intent, model, inputTokens, outputTokens) {
  const cost = calculateCost(model, inputTokens, outputTokens);
  
  costs.daily.tokens += inputTokens + outputTokens;
  costs.daily.cost += cost;
  costs.daily.calls += 1;
  
  costs.byIntent[intent] = (costs.byIntent[intent] || 0) + cost;
  costs.byModel[model] = (costs.byModel[model] || 0) + cost;
  
  // Log for analysis
  console.log(`[COST] ${intent}: ${model} - ${inputTokens}+${outputTokens} tokens = $${cost.toFixed(4)}`);
}

// Daily report
function getDailyReport() {
  return {
    total: `$${costs.daily.cost.toFixed(4)}`,
    avgPerCall: `$${(costs.daily.cost / costs.daily.calls).toFixed(4)}`,
    topIntents: Object.entries(costs.byIntent)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5),
    modelSplit: costs.byModel
  };
}
```

---

## The Goal

| Metric | Current (Estimated) | Target |
|--------|---------------------|--------|
| Simple query | $0.01 | $0.001 |
| File edit | $0.05 | $0.01 |
| Component creation | $0.10 | $0.02 |
| Full MVP | $1.00 | $0.03-0.05 |
| Full project | $5.00 | $0.50-1.00 |

**Key insight:** The LLM should think, not orchestrate. Move orchestration to deterministic code.
