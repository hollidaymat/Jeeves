# Jeeves Development Guide for Cursor

## Project Overview

**Jeeves** is an autonomous AI employee that runs on a homelab. It takes PRDs and executes them with minimal supervision. You (Cursor) are being used to develop Jeeves - but Jeeves himself does direct coding via Claude API (no Cursor in the loop).

### Architecture Summary

```
┌─────────────────────────────────────────────────────────────────┐
│                         JEEVES                                   │
│                                                                  │
│   Interfaces:     [Signal] [Matrix] [SSH] [Web Dashboard]       │
│                              │                                   │
│   Core Systems:                                                  │
│   ├── Message Handler (stateless by default)                    │
│   ├── Intent Parser (routes to correct model)                   │
│   ├── Task Executor (PRD execution, standing orders)            │
│   ├── Trust System (escalating autonomy)                        │
│   ├── Budget Manager (cost tracking, limits)                    │
│   ├── File Safety System (5-layer protection)                   │
│   └── Direct Coder (Claude API, not Cursor)                     │
│                                                                  │
│   Safety Boundaries (IMMUTABLE - filesystem protected):         │
│   ├── src/safety/*                                              │
│   ├── src/trust/*                                               │
│   └── budget.json                                               │
└─────────────────────────────────────────────────────────────────┘
```

### Key Design Decisions Already Made

| Decision | Rationale |
|----------|-----------|
| Stateless message processing | Prevents token bloat from conversation history |
| Tiered prompts (92% token reduction) | Simple queries use minimal context |
| 5-layer file safety | Blocks writes that shrink files >50%, syntax errors |
| Trust escalation | Starts supervised, earns autonomy |
| Direct coding (no Cursor) | Removes dependency, full control |

---

## Jeeves' Safety System (Your Safety Net)

Jeeves has a 5-layer file safety system that will BLOCK writes that:
- Shrink files by more than 50%
- Have unbalanced braces/brackets/parentheses
- Appear truncated (missing closing statements)
- Fail syntax validation
- Don't match expected structure

**If Jeeves' edit gets blocked, he wrote bad code.** The safety system forces a re-read and retry.

You (Cursor) are developing this safety system. Be careful not to break it.

---

## Current Status (as of 2026-02-05)

**Working:**
- Core messaging loop (Signal integration)
- Tiered prompt system (92% token reduction)
- File safety system (5 layers)
- Backup/restore system
- Basic task execution
- Intent classification with pattern matching (FREE for common commands)
- Cost tracking with daily reports (`cost` command)
- Prompt caching with heartbeat
- YAML workflow engine (`workflows/*.yaml`)
- Session compaction for long conversations (`compact` command)
- Response token limits per intent type

**Implemented Optimizations:**
- Pattern matching: status, help, cost, use haiku/sonnet/opus, list backups, compact
- Workflow engine: create-component, edit-file, git-commit
- Token limits: 150 (minimal), 800 (standard), 2000 (full)
- Auto-compaction: triggers at 30k tokens, keeps last 10 messages

**Not Yet Built:**
- Web Dashboard UI
- Matrix interface
- Self-modification system
- Trust escalation automation

---

## Rules When Working on Jeeves

### 1. Never Read Entire Files

### 1. Never Read Entire Files

```
# BAD - burns context, loses awareness
"Read auth.ts and update the login function"

# GOOD - targeted read
"Show me lines 45-80 of auth.ts (the login function)"
"Show me only the validateToken function in auth.ts"
```

### 2. Use Line-Range Edits

```
# BAD - replace whole file
"Update auth.ts with this new code: [entire file]"

# GOOD - surgical edit
"In auth.ts, replace lines 52-58 with: [small change]"
"In auth.ts, find the function validateToken and add this parameter"
```

### 3. State What NOT to Change

```
"Update the login function in auth.ts. 
DO NOT modify any other functions.
DO NOT delete existing code outside the login function.
Preserve all imports and exports."
```

### 4. Checkpoint Before Big Changes

Before any substantial edit:
```
"Before making changes, list:
1. All functions in this file
2. All imports
3. All exports

Then make the edit, preserving everything you just listed."
```

### 5. Verify After Edit

```
"After the edit, confirm:
- File still has all original imports
- File still has all original exports  
- File still has all functions except the one modified
- No syntax errors"
```

---

## Token Budget Per Task

| Task Type | Max Context | Strategy |
|-----------|-------------|----------|
| Simple edit | 2,000 tokens | Read only the function |
| Add feature | 5,000 tokens | Read related functions only |
| Refactor | 10,000 tokens | Read file structure first, then sections |
| New file | 3,000 tokens | Reference patterns, don't copy whole files |

---

## If Context Is Getting Full

Signs you're running out:
- Responses getting shorter/cut off
- Model "forgetting" earlier instructions
- Edits affecting wrong parts of file

Recovery:
1. Stop current task
2. Summarize what's been done
3. Start fresh session with summary
4. Continue from checkpoint

---

## Edit Command Template

Use this format for safe edits:

```
TASK: [what you want changed]

FILE: [exact file path]

TARGET: [function name / line range / specific identifier]

CHANGE: [what to add/modify/remove]

PRESERVE: 
- All other functions
- All imports
- All exports
- File structure

VERIFY AFTER:
- File compiles/runs
- Target change is correct
- Nothing else was modified
```

---

## Example Safe Edit Request

```
TASK: Add rate limiting to the login endpoint

FILE: src/routes/auth.ts

TARGET: The loginHandler function (lines 45-72)

CHANGE: Wrap the existing logic with a rate limit check:
- Add import for rateLimiter at top
- Add rate limit check at start of function
- Keep all existing login logic intact

PRESERVE:
- registerHandler function
- logoutHandler function  
- All existing imports
- All exports
- Error handling patterns

VERIFY AFTER:
- File has 3 handler functions (login, register, logout)
- Rate limiter import exists
- Login function has rate limit + original logic
```

---

## Critical Files - Extra Caution Required

These files are core to Jeeves' safety and stability. Triple-check any edits:

| File/Directory | Purpose | Risk Level |
|----------------|---------|------------|
| `src/safety/*` | File safety system | CRITICAL - protects all writes |
| `src/trust/*` | Trust escalation | CRITICAL - controls autonomy |
| `src/budget/*` | Cost management | HIGH - prevents runaway spending |
| `src/interfaces/signal.js` | Primary interface | HIGH - main communication |
| `config.json` | Core configuration | HIGH - system behavior |
| `budget.json` | Spending limits | CRITICAL - immutable by design |

**Before editing critical files:**
1. Read the entire file first (exception to the rule)
2. Understand all dependencies
3. Make smallest possible change
4. Test in isolation if possible

---

## What Jeeves Needs Next (Priority Order)

1. **Context Management Improvements**
   - Better checkpoint/resume for long tasks
   - Smarter context pruning before limits hit

2. **Web Dashboard**
   - Dark mode, cyan/purple cyberpunk aesthetic
   - Monitoring-first (status, costs, logs)
   - Local only (localhost or LAN)

3. **Matrix Interface**
   - Self-hosted option for max security
   - E2E encrypted like Signal

4. **Trust Automation**
   - Track success/failure automatically
   - Propose trust level changes

---

## Quick Reference: Jeeves' Tiered Prompt System

| Tier | When Used | Context Size | Example |
|------|-----------|--------------|---------|
| Minimal | Status checks, simple queries | ~500 tokens | "status", "cost" |
| Standard | Single-file edits | ~2,000 tokens | "add a function to auth.ts" |
| Full | Multi-file, PRD execution | ~10,000 tokens | "build this feature" |

This 92% token reduction on simple queries is why Jeeves can stay under budget. Don't break it.
