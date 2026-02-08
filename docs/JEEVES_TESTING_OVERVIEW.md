# Jeeves Testing Overview

## Current Tests

### 1. Unit Tests (signal-cursor-controller)

Located in `tests/`. Run with `npm test` (runs both parser and routing tests).

#### Parser Tests (`tests/parser.test.ts`)

Tests intent classification, entity extraction, disambiguation, reference resolution, and LLM-classification heuristics. **Does not hit the live API** — tests internal modules in isolation.

| Category | Tests | Purpose |
|----------|-------|---------|
| Quick Classify | 8 | PRD, feedback, question, command, negation classification |
| Entity Extraction | 7 | File paths, URLs, code refs, negations, pronouns, destructive intent, PRD content |
| Disambiguation | 9 | Command vs feedback vs reference vs approval |
| Reference Resolver | 6 | "it" / "the file" / "the project" resolution |
| Needs LLM Classification | 4 | When to skip vs use LLM |

**Results (as of last run):** 32 passed, 3 failed  
**Failed:** `disambiguates "yes" as approval`, `disambiguates "let's go" as approval`, `disambiguates "go ahead" as approval`

---

#### Routing Tests (`tests/routing.test.ts`)

Tests the command registry and fuzzy matcher. **Does not hit the live API** — tests that messages match the correct command in code.

| Category | Tests | Purpose |
|----------|-------|---------|
| Registry Example Tests | ~152 | Every `COMMAND_REGISTRY` example must match its command |
| Critical Routing | 11 | Vercel URL, homelab exclusions, edge cases |
| MatchResult → ParsedIntent | 1 | Shape conversion for executor |
| Fuzzy Matcher | 4 | Typos like "statis" → "status", "vercel stauts" → "vercel status" |

**Results (as of last run):** 159 passed, 0 failed

---

### 2. Integration Tests (jeeves-qa)

Located in `jeeves-qa/`. **Hits the live Jeeves API** at `http://localhost:3847`. Run with `npx tsx src/index.ts` (Jeeves must be running). Use `--no-llm` for rule-based-only grading (no extra API cost).

| Scenario File | # Scenarios | What It Tests |
|---------------|-------------|---------------|
| api-endpoints.yaml | 19 | API endpoints, HTTP behavior |
| homelab.yaml | 14 | Homelab commands (containers, resources, logs, etc.) |
| personality.yaml | 15 | Greetings, compliments, opinions — natural tone, no robotic phrases (uses LLM grading when not `--no-llm`) |
| routing-accuracy.yaml | 10 | Commands route correctly: status, vercel, deploy, containers, downloads, backup, model switch, casual chat |
| commands.yaml | 10 | General command handling |
| edge-cases.yaml | 10 | Edge cases |
| memory-trust.yaml | 10 | Trust, memory, preferences |
| signal-experience.yaml | 8 | Signal-specific UX |
| regressions.yaml | 5 | Regression cases |
| vercel.yaml | 5 | Vercel deploy, URL lookup |
| cursor-commands.yaml | 5 | Cursor agent commands |
| backup.yaml | 3 | Backup status, list |
| context-memory.yaml | 3 | Context and memory |
| model-switching.yaml | 3 | Haiku, sonnet, auto model switching |
| browser.yaml | 2 | Browser commands |
| dev-server.yaml | 2 | Dev server start/stop |
| terminal.yaml | 2 | Terminal commands |
| media.yaml | 4 | Media search, download, queue |

**Total:** ~115 integration scenarios across 18 files.

**Expectations per scenario:**
- `must_contain_any` / `must_contain` — response must include these strings
- `must_not_contain` — response must not include these (e.g. "How can I help", "AI assistant")
- `max_response_ms` — response time limit
- `personality: true` — triggers LLM grading of tone (unless `--no-llm`)

---

## Proposed Additions (Continual Intent Testing Plan)

### 1. Expand Routing-Accuracy Scenarios

Add scenarios for **all registry commands** so intent is validated end-to-end. Currently routing-accuracy covers ~10 cases; the registry has 50+ commands.

**New scenarios to add:**
- `help`, `cost`, `containers`, `resources`, `temps`, `logs jellyfin`, `update all`
- `notes`, `reminders`, `timeline`, `quiet hours`, `schedules`
- `pihole`, `speed test`, `tailscale`, `nextcloud`, `grafana`, `uptime`
- `disk health`, `docker cleanup`, `errors`, `ssl check`, `deps postgres`

Each: `must_contain_any` with expected keywords, `must_not_contain` generic fallbacks, `max_response_ms` as a sanity check.

**Fuzzy typo cases:** `statis`, `vercel stauts` — should still return correct intent.

### 2. Natural Flow Scenarios

Add `conversational-flow.yaml` with short exchanges that should feel natural:
- "hey" → brief reply
- "thanks" → acknowledgement
- "man what a day" → empathetic reply
- No "unknown command" or error fallbacks

(Some overlap with existing personality.yaml; this would focus on rule-based checks, no LLM grading.)

### 3. Wire Into Continual Testing

- Add `npm run test:routing` in jeeves-qa (runs routing-accuracy with `--no-llm`)
- Add script in signal-cursor-controller to run jeeves-qa routing tests
- Optional: GitHub Action or cron for periodic runs against a running Jeeves instance

### 4. Registry Example Alignment

Generate routing-accuracy scenarios from `COMMAND_REGISTRY.examples` so adding a new command automatically adds a QA scenario. Keeps unit routing tests and integration scenarios in sync.

---

## Summary

| Test Suite | Location | Type | Last Result |
|------------|----------|------|-------------|
| Parser | signal-cursor-controller/tests/parser.test.ts | Unit | 32 pass, 3 fail |
| Routing | signal-cursor-controller/tests/routing.test.ts | Unit | 159 pass |
| jeeves-qa | jeeves-qa/scenarios/*.yaml | Integration (live API) | Depends on Jeeves being running |

**Proposal:** Expand routing-accuracy to cover all registry commands, add conversational-flow scenarios, and align with registry examples for continual intent validation.
