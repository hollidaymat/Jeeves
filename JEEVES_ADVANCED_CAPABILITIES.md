# Jeeves Advanced Capabilities

The missing pieces for a truly intelligent employee.

---

## 1. Persistent Memory Architecture

**Problem:** Jeeves learns in-session but forgets across sessions.

**Solution:** Three-layer memory system.

```
┌─────────────────────────────────────────────────────────┐
│ WORKING MEMORY (RAM)                                    │
│ Current task context, active files, immediate state     │
│ Lifespan: This task only                                │
└─────────────────────────────────────────────────────────┘
                         ↓ promoted if useful
┌─────────────────────────────────────────────────────────┐
│ EPISODIC MEMORY (SQLite)                                │
│ Task logs, decisions made, outcomes, corrections        │
│ Searchable by: project, date, outcome, pattern          │
│ Lifespan: 90 days, then summarized → semantic           │
└─────────────────────────────────────────────────────────┘
                         ↓ patterns extracted
┌─────────────────────────────────────────────────────────┐
│ SEMANTIC MEMORY (Vector DB - local)                     │
│ Learned preferences, patterns, principles               │
│ "You hate moment.js" "You prefer functional components" │
│ Lifespan: Permanent, weighted by reinforcement          │
└─────────────────────────────────────────────────────────┘
```

**Implementation:**

```javascript
// memory/index.js
const sqlite = require('better-sqlite3');
const { LocalIndex } = require('vectra');  // Local vector DB, no cloud

class Memory {
  constructor(dataDir) {
    this.episodic = new sqlite(`${dataDir}/episodic.db`);
    this.semantic = new LocalIndex(`${dataDir}/semantic`);
    this.working = new Map();
    this.initSchema();
  }

  // Record a task completion
  async recordEpisode(task) {
    const { id, type, input, output, decisions, outcome, corrections, duration, cost } = task;
    
    this.episodic.prepare(`
      INSERT INTO episodes (id, type, input, output, decisions, outcome, corrections, duration, cost, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, type, JSON.stringify(input), JSON.stringify(output), 
           JSON.stringify(decisions), outcome, JSON.stringify(corrections), duration, cost, Date.now());

    // Extract patterns from corrections
    if (corrections.length > 0) {
      await this.learnFromCorrections(corrections);
    }
  }

  // Promote repeated patterns to semantic memory
  async learnFromCorrections(corrections) {
    for (const correction of corrections) {
      const embedding = await this.embed(correction.lesson);
      await this.semantic.upsertItem({
        id: `lesson-${Date.now()}`,
        vector: embedding,
        metadata: {
          type: 'preference',
          lesson: correction.lesson,
          context: correction.context,
          reinforcements: 1
        }
      });
    }
  }

  // Query relevant memories before starting task
  async getRelevantContext(taskDescription, limit = 5) {
    const embedding = await this.embed(taskDescription);
    const results = await this.semantic.queryItems(embedding, limit);
    
    return results.map(r => ({
      lesson: r.item.metadata.lesson,
      relevance: r.score,
      reinforcements: r.item.metadata.reinforcements
    }));
  }

  // Reinforce a lesson when it proves useful again
  async reinforce(lessonId) {
    const item = await this.semantic.getItem(lessonId);
    item.metadata.reinforcements++;
    await this.semantic.upsertItem(item);
  }
}
```

**Memory-aware prompting:**

```javascript
async function buildPromptWithMemory(task) {
  const relevantMemories = await memory.getRelevantContext(task.description, 5);
  
  let memoryBlock = '';
  if (relevantMemories.length > 0) {
    memoryBlock = `
RELEVANT LEARNED PREFERENCES:
${relevantMemories.map(m => `- ${m.lesson} (confidence: ${m.reinforcements})`).join('\n')}

Apply these unless they conflict with explicit instructions.
`;
  }

  return SYSTEM_PROMPT + memoryBlock + task.description;
}
```

---

## 2. Decomposition Skill

**Problem:** Breaking PRDs into right-sized chunks. Too granular = overhead death. Too coarse = loses track.

**Solution:** Hierarchical decomposition with size heuristics.

```
PRD
 └── Milestones (3-7, each independently valuable)
      └── Tasks (2-5 per milestone, single session completable)
           └── Steps (implicit, not tracked)
```

**The Heuristics:**

| Signal | Action |
|--------|--------|
| Task takes >2 hours estimated | Split it |
| Task touches >5 files | Split it |
| Task has >2 decision points | Split it |
| Tasks are <15 min each | Merge them |
| Tasks have tight dependencies | Merge them |

**Implementation:**

```javascript
async function decomposePRD(prd) {
  // First pass: identify natural boundaries
  const analysis = await claude.analyze({
    prompt: `Analyze this PRD for natural decomposition boundaries.
    
Identify:
1. Independent subsystems (can be built/tested separately)
2. Data dependencies (what needs to exist before what)
3. Risk clusters (where are the unknowns)

PRD:
${prd}

Output JSON: { subsystems: [], dependencies: [], risks: [] }`
  });

  // Second pass: size each subsystem
  const sized = await Promise.all(analysis.subsystems.map(async sub => {
    const estimate = await estimateSize(sub);
    return { ...sub, ...estimate };
  }));

  // Apply heuristics
  const milestones = [];
  let current = { name: '', tasks: [], totalHours: 0 };

  for (const sub of sized) {
    if (sub.estimatedHours > 2 || sub.files > 5) {
      // Split this subsystem
      const split = await splitSubsystem(sub);
      for (const task of split) {
        addToMilestones(milestones, task);
      }
    } else if (current.totalHours + sub.estimatedHours < 4) {
      // Merge into current milestone
      current.tasks.push(sub);
      current.totalHours += sub.estimatedHours;
    } else {
      // Start new milestone
      if (current.tasks.length > 0) milestones.push(current);
      current = { name: sub.name, tasks: [sub], totalHours: sub.estimatedHours };
    }
  }

  return {
    milestones,
    totalEstimate: milestones.reduce((sum, m) => sum + m.totalHours, 0),
    riskAreas: analysis.risks
  };
}
```

**Decomposition output example:**

```
PRD: User authentication system with OAuth, email/password, and 2FA

DECOMPOSITION:
├── Milestone 1: Core Auth (2.5 hrs, $0.15)
│   ├── Database schema for users, sessions
│   └── Basic email/password flow
│
├── Milestone 2: OAuth Integration (1.5 hrs, $0.12)
│   ├── Google OAuth
│   └── GitHub OAuth
│
├── Milestone 3: 2FA (2 hrs, $0.18)
│   ├── TOTP setup flow
│   └── Recovery codes
│
└── Milestone 4: Security Hardening (1 hr, $0.08)
    ├── Rate limiting
    └── Session management

Total: 7 hrs, $0.53
Risk areas: OAuth callback handling (external dependency)

Approve plan? [Yes / Adjust / Questions]
```

---

## 3. Failure Debugging

**Problem:** When stuck, agents retry blindly or give up. Neither is smart.

**Solution:** Scientific method for debugging.

```
Stuck Detection
     ↓
Hypothesis Formation
     ↓
Experiment Design
     ↓
Execute & Observe
     ↓
Update Understanding
     ↓
[Solved] or [Escalate with learnings]
```

**Implementation:**

```javascript
class DebugEngine {
  constructor(maxAttempts = 3) {
    this.maxAttempts = maxAttempts;
    this.hypotheses = [];
    this.experiments = [];
  }

  async debug(failure) {
    // Step 1: Form hypotheses
    this.hypotheses = await this.formHypotheses(failure);
    
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      const hypothesis = this.hypotheses[attempt];
      if (!hypothesis) break;

      // Step 2: Design experiment
      const experiment = await this.designExperiment(hypothesis);
      
      // Step 3: Run experiment
      const result = await this.runExperiment(experiment);
      this.experiments.push({ hypothesis, experiment, result });

      // Step 4: Evaluate
      if (result.solved) {
        return { 
          solved: true, 
          solution: result.solution,
          learnings: this.extractLearnings()
        };
      }

      // Update hypotheses based on what we learned
      await this.updateHypotheses(result);
    }

    // Escalate with full context
    return {
      solved: false,
      escalation: this.buildEscalationReport()
    };
  }

  async formHypotheses(failure) {
    const response = await claude.analyze({
      prompt: `This operation failed. Form 3 hypotheses for why, ranked by likelihood.

FAILURE:
${JSON.stringify(failure, null, 2)}

For each hypothesis:
1. What you think went wrong
2. What evidence would confirm it
3. What experiment would test it

Output JSON array.`
    });
    return response;
  }

  buildEscalationReport() {
    return `
DEBUGGING REPORT - ESCALATION REQUIRED

I attempted ${this.experiments.length} approaches and couldn't solve this.

HYPOTHESES TESTED:
${this.hypotheses.map((h, i) => `${i + 1}. ${h.description} - ${this.experiments[i]?.result.outcome || 'not tested'}`).join('\n')}

WHAT I LEARNED:
${this.extractLearnings().join('\n')}

WHAT I NEED:
- More context about: ${this.identifyContextGaps()}
- Or human decision on: ${this.identifyDecisionPoints()}
`;
  }
}
```

---

## 4. Mental Simulation

**Problem:** Agents act then see consequences. Smart employees preview first.

**Solution:** Pre-execution impact analysis.

```javascript
async function simulateChange(change) {
  const { file, modification, type } = change;

  // 1. Static analysis: what depends on this?
  const dependents = await findDependents(file);
  
  // 2. Type-level impact: will this break interfaces?
  const typeImpact = await analyzeTypeImpact(file, modification);
  
  // 3. Test coverage: what tests touch this?
  const affectedTests = await findAffectedTests(file);
  
  // 4. Runtime analysis: what could break at runtime?
  const runtimeRisks = await analyzeRuntimeRisks(modification);

  const simulation = {
    safetyScore: calculateSafetyScore(dependents, typeImpact, affectedTests, runtimeRisks),
    impacts: {
      files: dependents.map(d => d.path),
      types: typeImpact.breaking,
      tests: affectedTests.length,
      runtimeRisks: runtimeRisks.warnings
    },
    recommendation: null
  };

  if (simulation.safetyScore < 0.5) {
    simulation.recommendation = 'HIGH RISK - Review impacts before proceeding';
  } else if (simulation.safetyScore < 0.8) {
    simulation.recommendation = 'MODERATE RISK - Run affected tests after change';
  } else {
    simulation.recommendation = 'LOW RISK - Proceed with standard validation';
  }

  return simulation;
}

// Before any file write
async function safeWrite(file, content, context) {
  const simulation = await simulateChange({ file, modification: content, type: 'write' });
  
  if (simulation.safetyScore < 0.5) {
    return {
      blocked: true,
      reason: `High-risk change detected`,
      impacts: simulation.impacts,
      question: `This change affects ${simulation.impacts.files.length} files and may break ${simulation.impacts.types.length} interfaces. Proceed anyway?`
    };
  }

  // Proceed with write + existing safety layers
  return await executeWrite(file, content);
}
```

---

## 5. Context Switching / State Preservation

**Problem:** Interrupt mid-task, lose the thread.

**Solution:** First-class interrupts with state serialization.

```javascript
class TaskState {
  constructor(taskId) {
    this.taskId = taskId;
    this.phase = 'planning';
    this.thinking = [];      // Chain of thought so far
    this.decisions = [];     // Decisions made
    this.filesModified = []; // With diffs
    this.nextSteps = [];     // What was about to happen
    this.openQuestions = []; // Unresolved questions
  }

  serialize() {
    return JSON.stringify({
      taskId: this.taskId,
      phase: this.phase,
      thinking: this.thinking,
      decisions: this.decisions,
      filesModified: this.filesModified,
      nextSteps: this.nextSteps,
      openQuestions: this.openQuestions,
      timestamp: Date.now()
    });
  }

  static deserialize(json) {
    const data = JSON.parse(json);
    const state = new TaskState(data.taskId);
    Object.assign(state, data);
    return state;
  }

  buildResumptionPrompt() {
    return `
RESUMING INTERRUPTED TASK: ${this.taskId}

PHASE: ${this.phase}

THINKING SO FAR:
${this.thinking.map((t, i) => `${i + 1}. ${t}`).join('\n')}

DECISIONS MADE:
${this.decisions.map(d => `- ${d.decision}: ${d.rationale}`).join('\n')}

FILES MODIFIED:
${this.filesModified.map(f => `- ${f.path} (${f.changeType})`).join('\n')}

NEXT STEPS (before interrupt):
${this.nextSteps.map((s, i) => `${i + 1}. ${s}`).join('\n')}

OPEN QUESTIONS:
${this.openQuestions.map(q => `- ${q}`).join('\n')}

Continue from where you left off.
`;
  }
}

// Interrupt handler
async function handleInterrupt(urgentTask, currentState) {
  // Save current state
  const stateFile = `${DATA_DIR}/interrupted/${currentState.taskId}.json`;
  await fs.writeFile(stateFile, currentState.serialize());

  // Notify
  await notify(`Pausing "${currentState.taskId}" at ${currentState.phase} phase. State saved.`);

  // Handle urgent task
  const result = await executeTask(urgentTask);

  // Prompt to resume
  await notify(`Urgent task complete. Resume "${currentState.taskId}"? [Yes / Later]`);
}

async function resumeTask(taskId) {
  const stateFile = `${DATA_DIR}/interrupted/${taskId}.json`;
  const state = TaskState.deserialize(await fs.readFile(stateFile, 'utf-8'));
  
  // Resume with full context
  return await executeWithState(state);
}
```

---

## 6. Self-Extending (Tool Creation)

**Problem:** Jeeves uses tools. But when he does the same thing 5 times, he should automate it.

**Solution:** Pattern detection → tool generation.

```javascript
class ToolForge {
  constructor(memory) {
    this.memory = memory;
    this.patternThreshold = 3;  // Create tool after 3 similar operations
  }

  async recordOperation(operation) {
    // Store operation signature
    const signature = this.extractSignature(operation);
    await this.memory.episodic.prepare(`
      INSERT INTO operations (signature, params, timestamp)
      VALUES (?, ?, ?)
    `).run(signature, JSON.stringify(operation.params), Date.now());

    // Check for patterns
    const similar = await this.findSimilarOperations(signature);
    if (similar.length >= this.patternThreshold) {
      await this.proposeNewTool(signature, similar);
    }
  }

  extractSignature(operation) {
    // Abstract away specific values, keep structure
    // "Read file X, extract function Y, modify, write" → "file-extract-modify-write"
    return operation.steps.map(s => s.type).join('-');
  }

  async proposeNewTool(signature, examples) {
    const proposal = await claude.analyze({
      prompt: `I've performed this operation pattern ${examples.length} times:

PATTERN: ${signature}

EXAMPLES:
${examples.slice(0, 3).map(e => JSON.stringify(e.params)).join('\n')}

Design a reusable tool that abstracts this pattern.

Output:
1. Tool name
2. Parameters (what varies between uses)
3. Implementation (JavaScript function)
4. Example usage`
    });

    await this.notifyToolProposal(proposal);
  }

  async notifyToolProposal(proposal) {
    await notify(`
TOOL CREATION PROPOSAL

I've done this ${this.patternThreshold}+ times. Should I create a reusable tool?

NAME: ${proposal.name}
PARAMS: ${proposal.params.join(', ')}

EXAMPLE USAGE:
${proposal.exampleUsage}

[Create Tool] [Not Now] [Never for this pattern]
`);
  }
}
```

**Example flow:**

```
Task 1: "Add created_at and updated_at to the posts table"
Task 2: "Add created_at and updated_at to the comments table"  
Task 3: "Add timestamps to the users table"

Jeeves notices pattern...

TOOL CREATION PROPOSAL

I've done this 3+ times. Should I create a reusable tool?

NAME: addTimestampFields
PARAMS: tableName, fields (default: ['created_at', 'updated_at'])

EXAMPLE USAGE:
await tools.addTimestampFields('reactions');

[Create Tool] [Not Now] [Never for this pattern]
```

---

## 7. Feedback → Behavioral Change

**Problem:** Corrections are logged but don't change behavior.

**Solution:** Weighted preference system with decay.

```javascript
class BehaviorEngine {
  constructor(memory) {
    this.memory = memory;
    this.preferences = new Map();  // Active preferences in memory
    this.decayRate = 0.95;         // Per week
    this.reinforceBoost = 1.5;     // When preference proves correct
  }

  async loadPreferences() {
    const prefs = await this.memory.semantic.listItems({ type: 'preference' });
    for (const pref of prefs) {
      this.preferences.set(pref.id, {
        rule: pref.metadata.lesson,
        weight: pref.metadata.weight || 1.0,
        lastUsed: pref.metadata.lastUsed
      });
    }
  }

  // Called before making a decision
  async getApplicableRules(context) {
    const applicable = [];
    
    for (const [id, pref] of this.preferences) {
      const relevance = await this.checkRelevance(pref.rule, context);
      if (relevance > 0.7) {
        applicable.push({
          id,
          rule: pref.rule,
          effectiveWeight: pref.weight * relevance
        });
      }
    }

    // Sort by effective weight
    return applicable.sort((a, b) => b.effectiveWeight - a.effectiveWeight);
  }

  // Called when you correct Jeeves
  async recordCorrection(correction) {
    const { wrong, right, context } = correction;

    // Decrease weight of the wrong behavior
    const wrongPref = await this.findMatchingPreference(wrong);
    if (wrongPref) {
      wrongPref.weight *= 0.5;  // Halve confidence
      await this.savePreference(wrongPref);
    }

    // Increase weight of (or create) the right behavior
    let rightPref = await this.findMatchingPreference(right);
    if (rightPref) {
      rightPref.weight *= this.reinforceBoost;
    } else {
      rightPref = await this.createPreference(right, context);
    }
    await this.savePreference(rightPref);
  }

  // Called when Jeeves successfully applies a preference
  async reinforce(prefId) {
    const pref = this.preferences.get(prefId);
    if (pref) {
      pref.weight *= this.reinforceBoost;
      pref.lastUsed = Date.now();
      await this.savePreference(pref);
    }
  }

  // Weekly decay of unused preferences
  async applyDecay() {
    const oneWeekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    
    for (const [id, pref] of this.preferences) {
      if (pref.lastUsed < oneWeekAgo) {
        pref.weight *= this.decayRate;
        
        // Remove if weight too low
        if (pref.weight < 0.1) {
          await this.removePreference(id);
        } else {
          await this.savePreference(pref);
        }
      }
    }
  }
}
```

**Behavior in action:**

```
Week 1: You correct Jeeves for using moment.js
        → Creates preference: "Use date-fns, not moment.js" (weight: 1.0)

Week 2: Jeeves encounters date formatting, checks preferences
        → Finds rule, uses date-fns
        → You don't correct → reinforced (weight: 1.5)

Week 3: Same pattern → reinforced (weight: 2.25)

Week 10: Rule hasn't been relevant in 7 weeks
         → Decayed (weight: 0.85)
         → Still applies when relevant, just lower priority

Week 52: You explicitly say "actually, use Temporal now"
         → Old rule weight halved (0.4)
         → New rule created (1.0)
         → Behavior changes
```

---

## 8. Deliberate Practice

**Problem:** Doing 1000 tasks the same way is mediocrity. Getting better at each is exponential.

**Solution:** Self-review cycles.

```javascript
class PracticeEngine {
  constructor(memory) {
    this.memory = memory;
  }

  // Run weekly
  async weeklyReview() {
    const episodes = await this.memory.getEpisodesFromPastWeek();
    
    // Categorize outcomes
    const analysis = {
      successes: episodes.filter(e => e.outcome === 'success'),
      failures: episodes.filter(e => e.outcome === 'failure'),
      corrections: episodes.filter(e => e.corrections.length > 0),
      slowest: this.findSlowest(episodes, 5),
      mostExpensive: this.findMostExpensive(episodes, 5)
    };

    // Identify patterns in failures
    const failurePatterns = await this.analyzeFailurePatterns(analysis.failures);
    
    // Identify efficiency opportunities
    const efficiencyOps = await this.findEfficiencyOpportunities(analysis);

    // Generate practice plan
    const practicePlan = await this.generatePracticePlan(failurePatterns, efficiencyOps);

    return {
      summary: this.buildWeeklySummary(analysis),
      failurePatterns,
      efficiencyOps,
      practicePlan
    };
  }

  async analyzeFailurePatterns(failures) {
    if (failures.length === 0) return [];

    const response = await claude.analyze({
      prompt: `Analyze these failures for patterns:

${failures.map(f => `- Task: ${f.type}, Error: ${f.error}, Context: ${f.context}`).join('\n')}

Identify:
1. Common failure modes
2. Root causes
3. What skill improvement would prevent these

Output JSON: { patterns: [{ mode, cause, skillGap }] }`
    });

    return response.patterns;
  }

  async generatePracticePlan(failurePatterns, efficiencyOps) {
    const plan = [];

    // Address each failure pattern
    for (const pattern of failurePatterns) {
      plan.push({
        area: pattern.skillGap,
        action: `Practice: ${pattern.mode} scenarios`,
        metric: 'Reduce occurrence by 50%',
        exercises: await this.generateExercises(pattern)
      });
    }

    // Address efficiency gaps
    for (const op of efficiencyOps) {
      plan.push({
        area: op.area,
        action: op.suggestion,
        metric: op.targetImprovement,
        exercises: []
      });
    }

    return plan;
  }

  buildWeeklySummary(analysis) {
    const successRate = analysis.successes.length / 
      (analysis.successes.length + analysis.failures.length);
    
    const correctionRate = analysis.corrections.length / analysis.successes.length;

    return `
WEEKLY PERFORMANCE REVIEW

Tasks completed: ${analysis.successes.length + analysis.failures.length}
Success rate: ${(successRate * 100).toFixed(1)}%
Correction rate: ${(correctionRate * 100).toFixed(1)}%

Slowest tasks:
${analysis.slowest.map(t => `- ${t.type}: ${t.duration}min`).join('\n')}

Most expensive:
${analysis.mostExpensive.map(t => `- ${t.type}: $${t.cost.toFixed(2)}`).join('\n')}

Areas for improvement:
${analysis.failures.length > 0 ? '- Failure handling in: ' + [...new Set(analysis.failures.map(f => f.type))].join(', ') : '- None identified'}
${correctionRate > 0.2 ? '- Reducing corrections (currently ' + (correctionRate * 100).toFixed(0) + '%)' : ''}
`;
  }
}
```

**Weekly output:**

```
WEEKLY PERFORMANCE REVIEW

Tasks completed: 47
Success rate: 91.5%
Correction rate: 12.8%

Slowest tasks:
- PRD execution: 187min
- OAuth integration: 94min
- Database migration: 52min

Most expensive:
- PRD execution: $0.84
- Code refactor: $0.31
- OAuth integration: $0.28

Areas for improvement:
- Failure handling in: file operations, git merge
- Reducing corrections (currently 13%)

PRACTICE PLAN:

1. FILE OPERATIONS
   Pattern: Truncating files on targeted edits
   Action: Practice partial file updates with verification
   Target: Reduce occurrences by 50%

2. CORRECTION RATE
   Pattern: Wrong library choices, verbose responses
   Action: Check preferences before library decisions
   Target: Reduce to <10%

Execute practice plan? [Yes / Skip this week]
```

---

## Integration

All systems connect:

```
                    ┌──────────────────┐
                    │  JEEVES CORE     │
                    └────────┬─────────┘
                             │
        ┌────────────────────┼────────────────────┐
        │                    │                    │
        ▼                    ▼                    ▼
┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│    MEMORY     │   │   BEHAVIOR    │   │   PRACTICE    │
│               │   │               │   │               │
│ Working       │◄──│ Preferences   │◄──│ Weekly review │
│ Episodic      │   │ Weights       │   │ Failure       │
│ Semantic      │   │ Reinforcement │   │ patterns      │
└───────────────┘   └───────────────┘   └───────────────┘
        │                    │                    │
        └────────────────────┼────────────────────┘
                             │
        ┌────────────────────┼────────────────────┐
        │                    │                    │
        ▼                    ▼                    ▼
┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│ DECOMPOSITION │   │   DEBUGGING   │   │  SIMULATION   │
│               │   │               │   │               │
│ PRD → Tasks   │   │ Hypothesis    │   │ Impact        │
│ Size heuristics│  │ Experiment    │   │ preview       │
│ Dependencies  │   │ Escalation    │   │ Risk scoring  │
└───────────────┘   └───────────────┘   └───────────────┘
        │                    │                    │
        └────────────────────┼────────────────────┘
                             │
                             ▼
                    ┌───────────────┐
                    │  TOOL FORGE   │
                    │               │
                    │ Pattern detect│
                    │ Tool creation │
                    │ Self-extension│
                    └───────────────┘
```

---

## Priority Implementation Order

| Capability | Complexity | Impact | Order |
|------------|------------|--------|-------|
| Feedback → Behavior | Medium | High | 1 |
| Mental Simulation | Low | High | 2 |
| Failure Debugging | Medium | High | 3 |
| Context Switching | Medium | Medium | 4 |
| Memory Architecture | High | High | 5 |
| Decomposition | Medium | Medium | 6 |
| Deliberate Practice | Medium | Medium | 7 |
| Tool Creation | High | Medium | 8 |

Start with Feedback → Behavior because it makes every subsequent interaction better. End with Tool Creation because it requires all other systems to be stable first.
