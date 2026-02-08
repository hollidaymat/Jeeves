# Jeeves_Cognitive_Fix

# Jeeves Cognitive Fix Plan

## Status: CRITICAL

Jeeves Brain 1 (registry/fast paths) works. Brain 2 (cognitive/OODA/context layers) is NOT connected.
Evidence: contextLoaded returns empty array. Complex requests produce generic Claude output with zero project awareness.

---

## Problem 1: Context Layers Never Load

### Current (Broken)
```
message -> registry check -> miss -> send raw to Claude -> generic response
```

### Target (Fixed)
```
message -> registry check -> miss -> CONTEXT ASSEMBLER -> enriched prompt to Claude -> grounded response
```

### Fix: Build Context Assembler Middleware

Every non-registry request MUST pass through this before hitting Claude:

```javascript
// src/cognitive/context-assembler.js

class ContextAssembler {
  constructor(db, services) {
    this.db = db;           // SQLite - learnings, decisions, patterns
    this.services = services; // Docker, Vercel, filesystem access
  }

  async assemble(message, classification) {
    const context = { layers: [], tokenBudget: 0 };

    // Layer 1: Schema - What does Jeeves manage?
    context.layers.push({
      name: 'schema',
      data: await this.getSchema(classification)
    });

    // Layer 2: Annotations - Owner preferences and rules
    context.layers.push({
      name: 'annotations',
      data: await this.getAnnotations(classification.domain)
    });

    // Layer 3: Patterns - Proven solutions
    context.layers.push({
      name: 'patterns',
      data: await this.getPatterns(classification.domain, message)
    });

    // Layer 4: Learnings - Past mistakes and fixes
    context.layers.push({
      name: 'learnings',
      data: await this.getLearnings(classification.domain)
    });

    // Layer 5: Runtime - Live system state
    context.layers.push({
      name: 'runtime',
      data: await this.getRuntime(classification)
    });

    // Layer 6: Docs - Relevant documentation
    context.layers.push({
      name: 'docs',
      data: await this.getDocs(classification.domain)
    });

    // Filter empty layers, calculate token usage
    context.layers = context.layers.filter(l => l.data && l.data.length > 0);
    context.tokenBudget = context.layers.reduce((sum, l) => sum + this.estimateTokens(l.data), 0);

    return context;
  }

  async getSchema(classification) {
    // Return what Jeeves actually manages based on domain
    if (classification.domain === 'infrastructure') {
      const containers = await this.services.docker.listContainers();
      return `Running containers: ${containers.map(c => c.name).join(', ')}`;
    }
    if (classification.domain === 'code') {
      const projects = await this.services.vercel.listProjects();
      return `Vercel projects: ${projects.map(p => p.name).join(', ')}`;
    }
    if (classification.domain === 'media') {
      return `Media services: jellyfin, radarr, sonarr, lidarr, bazarr, prowlarr, overseerr`;
    }
    return '';
  }

  async getAnnotations(domain) {
    // Owner preferences from SQLite
    const prefs = await this.db.all(
      'SELECT key, value FROM preferences WHERE domain = ? OR domain = "global"',
      [domain]
    );
    return prefs.map(p => `${p.key}: ${p.value}`).join('\n');
  }

  async getPatterns(domain, message) {
    // Proven solutions from past successful tasks
    const patterns = await this.db.all(
      `SELECT name, solution, success_count FROM patterns
       WHERE domain = ? AND success_count > 0
       ORDER BY success_count DESC LIMIT 5`,
      [domain]
    );
    return patterns.map(p => `Pattern: ${p.name} (used ${p.success_count}x)\nSolution: ${p.solution}`).join('\n\n');
  }

  async getLearnings(domain) {
    // Past mistakes - what NOT to do
    const learnings = await this.db.all(
      `SELECT error_type, what_happened, fix_applied, confidence
       FROM learnings WHERE domain = ? ORDER BY created_at DESC LIMIT 5`,
      [domain]
    );
    return learnings.map(l => `Error: ${l.error_type}\nHappened: ${l.what_happened}\nFix: ${l.fix_applied}`).join('\n\n');
  }

  async getRuntime(classification) {
    // Live system state
    const parts = [];
    try {
      const health = await this.services.system.getHealth();
      parts.push(`CPU: ${health.cpu}% | RAM: ${health.ram}% | Disk: ${health.disk}%`);
    } catch (e) { /* skip if unavailable */ }

    if (classification.domain === 'infrastructure') {
      try {
        const containers = await this.services.docker.listContainers();
        const unhealthy = containers.filter(c => c.state !== 'running');
        if (unhealthy.length > 0) {
          parts.push(`UNHEALTHY: ${unhealthy.map(c => c.name).join(', ')}`);
        }
      } catch (e) { /* skip */ }
    }
    return parts.join('\n');
  }

  async getDocs(domain) {
    // Check for relevant runbooks
    const fs = require('fs').promises;
    const runbookPath = `/home/jeeves/knowledge/runbooks/${domain}.md`;
    try {
      return await fs.readFile(runbookPath, 'utf8');
    } catch (e) {
      return '';
    }
  }

  estimateTokens(text) {
    return Math.ceil(text.length / 4);
  }
}

module.exports = { ContextAssembler };
```

### Integration Point

Find where non-registry messages hit Claude. Add assembler BEFORE the LLM call:

```javascript
// In the main message handler, after registry miss:

const context = await contextAssembler.assemble(message, classification);

const prompt = `
You are Jeeves, an autonomous infrastructure agent.

SYSTEM CONTEXT (from your knowledge base):
${context.layers.map(l => `[${l.name.toUpperCase()}]\n${l.data}`).join('\n\n')}

RULES:
- Reference the context above in your response
- If context contains relevant patterns, USE them
- If context contains learnings about past failures, AVOID those mistakes
- State your confidence level (0-100%)
- If you lack context to answer well, say so specifically

USER REQUEST: ${message}
`;

const response = await claude.send(prompt, { model: selectedModel });

// AFTER response, log what happened
await logCognitiveTrace({
  message,
  classification,
  contextLoaded: context.layers.map(l => l.name),
  tokenBudget: context.tokenBudget,
  model: selectedModel,
  responseTime: elapsed,
  timestamp: Date.now()
});
```

---

## Problem 2: No OODA Trace Endpoint

Tests cannot verify cognitive processing because there is no debug endpoint.

### Fix: Add /api/debug/last-trace

```javascript
// src/api/debug.js

let lastTrace = null;

function setLastTrace(trace) {
  lastTrace = trace;
}

function getDebugRoutes(app) {
  app.get('/api/debug/last-trace', (req, res) => {
    if (!lastTrace) {
      return res.json({ error: 'No trace recorded yet' });
    }
    res.json(lastTrace);
  });

  app.get('/api/debug/context-layers', (req, res) => {
    if (!lastTrace) {
      return res.json({ contextLoaded: [] });
    }
    res.json({
      contextLoaded: lastTrace.contextLoaded || [],
      tokenBudget: lastTrace.tokenBudget || 0,
      classification: lastTrace.classification || null
    });
  });

  app.get('/api/debug/cognitive-health', (req, res) => {
    res.json({
      assemblerConnected: !!global.contextAssembler,
      dbConnected: !!global.knowledgeDb,
      layersAvailable: ['schema', 'annotations', 'patterns', 'learnings', 'runtime', 'docs'],
      lastTraceAge: lastTrace ? Date.now() - lastTrace.timestamp : null
    });
  });
}

module.exports = { setLastTrace, getDebugRoutes };
```

---

## Problem 3: Recursive Loop Death Spiral

When Jeeves gets meta-questions like "did you learn?", he enters infinite self-referential loops.

### Root Cause
Claude produces text about learning without any mechanism to actually change behavior.

### Fix: Behavioral State Machine

```javascript
// src/cognitive/behavior-tracker.js

class BehaviorTracker {
  constructor(db) {
    this.db = db;
    this.recentResponses = []; // rolling window of last 5
  }

  async checkForLoop(newResponse) {
    this.recentResponses.push(this.fingerprint(newResponse));
    if (this.recentResponses.length > 5) {
      this.recentResponses.shift();
    }

    // If 3+ of last 5 responses have same fingerprint = loop
    const counts = {};
    this.recentResponses.forEach(fp => { counts[fp] = (counts[fp] || 0) + 1; });
    const maxRepeat = Math.max(...Object.values(counts));

    if (maxRepeat >= 3) {
      return {
        isLoop: true,
        action: 'BREAK_LOOP',
        response: this.getLoopBreaker()
      };
    }
    return { isLoop: false };
  }

  fingerprint(response) {
    // Extract structural pattern, ignore specific words
    const sentences = response.split(/[.!?]/).length;
    const hasList = response.includes('\n-') || response.includes('\n1.');
    const hasQuestion = response.includes('?');
    const length = response.length > 500 ? 'long' : response.length > 200 ? 'medium' : 'short';
    return `${length}-${sentences}-${hasList}-${hasQuestion}`;
  }

  getLoopBreaker() {
    // Hard-coded escape responses - NOT generated by Claude
    const breakers = [
      "I notice I'm repeating myself. Let me stop and ask: what specific action do you need me to take right now?",
      "Caught a loop. Resetting. Give me a concrete task and I'll execute it.",
      "I've been giving you the same answer. That's a failure. What do you actually need done?"
    ];
    return breakers[Math.floor(Math.random() * breakers.length)];
  }
}

module.exports = { BehaviorTracker };
```

### Integration
```javascript
// Before sending ANY response to user:
const loopCheck = await behaviorTracker.checkForLoop(response);
if (loopCheck.isLoop) {
  // Override Claude's response with hard-coded breaker
  response = loopCheck.response;
  await logLearning({
    error_type: 'recursive_loop',
    what_happened: `Entered loop on topic: ${message.substring(0, 50)}`,
    fix_applied: 'Hard break triggered',
    domain: classification.domain
  });
}
```

---

## Problem 4: Complex Requests Are Generic

Auth refactor, database safety, GraphQL migration all produce textbook Claude responses.

### Root Cause
No project context injected. Claude doesn't know what files exist, what stack is used, what's deployed.

### Fix: Project Awareness in Context Assembler

Add to the assembler:

```javascript
async getProjectContext(classification) {
  const context = [];

  // What's in the actual codebase?
  if (classification.intent === 'code_change' || classification.intent === 'review') {
    try {
      const { execSync } = require('child_process');

      // Get project structure
      const tree = execSync(
        'find /home/jeeves/signal-cursor-controller/src -type f -name "*.ts" -o -name "*.js" | head -30',
        { encoding: 'utf8', timeout: 5000 }
      );
      context.push(`PROJECT FILES:\n${tree}`);

      // Get package.json deps
      const pkg = require('/home/jeeves/signal-cursor-controller/package.json');
      context.push(`DEPENDENCIES: ${Object.keys(pkg.dependencies || {}).join(', ')}`);

      // Get recent git changes
      const gitLog = execSync(
        'cd /home/jeeves/signal-cursor-controller && git log --oneline -5 2>/dev/null || echo "no git"',
        { encoding: 'utf8', timeout: 5000 }
      );
      context.push(`RECENT CHANGES:\n${gitLog}`);
    } catch (e) {
      context.push('Could not read project files');
    }
  }

  return context.join('\n\n');
}
```

### Result
Instead of "I'll investigate your auth module, what framework are you using?"
Jeeves says: "Your auth is in src/auth/middleware.ts using express-session. The JWT refactor means replacing lines 12-45 with jsonwebtoken. Here's the plan."

---

## Problem 5: No Learning Persistence

Jeeves "learns" in conversation but forgets everything between sessions.

### Fix: SQLite Learning Tables

```sql
-- Run on Daemon
CREATE TABLE IF NOT EXISTS learnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  error_type TEXT NOT NULL,
  what_happened TEXT NOT NULL,
  fix_applied TEXT NOT NULL,
  confidence REAL DEFAULT 0.5,
  created_at INTEGER DEFAULT (strftime('%s','now')),
  last_referenced INTEGER
);

CREATE TABLE IF NOT EXISTS patterns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  name TEXT NOT NULL,
  trigger_description TEXT,
  solution TEXT NOT NULL,
  success_count INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS preferences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT DEFAULT 'global',
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  source TEXT DEFAULT 'inferred',
  created_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  context_summary TEXT,
  decision TEXT NOT NULL,
  reasoning TEXT,
  confidence REAL,
  timestamp INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS cognitive_traces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message TEXT,
  classification TEXT,
  context_loaded TEXT,
  token_budget INTEGER,
  model TEXT,
  response_time_ms INTEGER,
  confidence REAL,
  timestamp INTEGER DEFAULT (strftime('%s','now'))
);
```

### After Every Task Completion
```javascript
async function postTaskLearning(task, result) {
  if (result.success) {
    // Increment pattern success count or create new pattern
    await db.run(
      `INSERT INTO patterns (domain, name, solution, success_count)
       VALUES (?, ?, ?, 1)
       ON CONFLICT(domain, name) DO UPDATE SET success_count = success_count + 1`,
      [task.domain, task.type, JSON.stringify(task.steps)]
    );
  } else {
    // Record the failure as a learning
    await db.run(
      `INSERT INTO learnings (domain, error_type, what_happened, fix_applied)
       VALUES (?, ?, ?, ?)`,
      [task.domain, result.errorType, result.errorMessage, result.fixAttempted || 'none']
    );
  }
}
```

---

## Verification Tests

After implementing, these tests MUST pass:

### Test 1: Context Layers Load
```
Send: "review the auth module for security issues"
Check: GET /api/debug/last-trace
Expect: contextLoaded includes at least ['schema', 'runtime']
```

### Test 2: Project-Aware Responses
```
Send: "refactor auth to use JWT"
Expect: Response references actual files in the project (src/auth/*, package.json deps)
NOT: "What framework are you using?"
```

### Test 3: Loop Detection
```
Send same question 4 times
Expect: By 3rd repeat, hard-coded loop breaker fires
NOT: Same response 4 times
```

### Test 4: Learning Persists
```
Send: "restart jellyfin" (succeeds)
Check: SELECT * FROM patterns WHERE name = 'container_restart'
Expect: success_count incremented
```

### Test 5: Cognitive Health
```
GET /api/debug/cognitive-health
Expect: assemblerConnected: true, dbConnected: true, all 6 layers available
```

---

## Build Order (Sequential)

1. **Tables first** — Create SQLite tables (learnings, patterns, preferences, decisions, cognitive_traces)
2. **Assembler second** — Build ContextAssembler class
3. **Wire it in third** — Integrate assembler into message handler (between classification and Claude call)
4. **Debug endpoints fourth** — Add /api/debug/last-trace, /context-layers, /cognitive-health
5. **Loop detection fifth** — Build BehaviorTracker and wire before response delivery

**Existing Brain 1 routing stays untouched.**

## DO NOT
- Break existing registry routing (Brain 1 works, leave it alone)
- Add context assembly to fast-path responses (greetings, status checks)
- Send more than 2000 tokens of context to Haiku (budget awareness)
- Skip the debug endpoints (tests depend on them)
- Use Claude to generate loop-breaker responses (defeats the purpose)
