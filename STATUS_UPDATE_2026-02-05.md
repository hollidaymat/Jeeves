# Jeeves Status Update - February 5, 2026

## Session Summary

This session focused on debugging, optimization, and hardening Jeeves after discovering critical file corruption issues.

---

## Issues Discovered & Fixed

### 1. File Corruption/Truncation (CRITICAL)

**Problem:** Two files were corrupted by Jeeves edits:
- `sentinel/lib/scanners/ssl.ts` - truncated from ~610 lines to 17 lines
- `signal-cursor-controller/web/styles.css` - truncated from 897 lines to 4 lines

**Root Cause:** Files cut off mid-edit, likely from interrupted sessions or incomplete AI responses. The problematic commit was `a1d8040`.

**Fix:** Restored files from git history. Implemented comprehensive File Safety System (see below).

---

### 2. Excessive Token Usage

**Problem:** A 3-word greeting ("you back bud?") consumed 4,087 input tokens.

**Root Cause:** 
- System prompt was ~150 lines (~1,500 tokens) sent on every request
- 20 messages of conversation history loaded regardless of query complexity
- All context (projects, browse history, execution results) included every time

**Fix:** Implemented tiered prompt system:

| Tier | Tokens | History | Trigger |
|------|--------|---------|---------|
| MINIMAL | ~150 | 3 msgs | Greetings, simple chat |
| STANDARD | ~400 | 8 msgs | Normal questions |
| FULL | ~1,200 | 15 msgs | Complex technical work |

**Result:** 308 tokens for same greeting (92% reduction).

---

### 3. UI Issues

**Problems:**
- Blank lines appearing in console
- Model info logging cluttering UI
- `use haiku` command not recognized
- Minimal responses too terse

**Fixes:**
- Filtered empty messages and model logs from UI
- Added `set_model` action type and parser pattern
- Updated minimal prompt to encourage conversational responses

---

## New Features Implemented

### File Safety System

5-layer defense against file corruption:

1. **Pre-edit Backup** - Creates `.jeeves-backup/<file>.<timestamp>.bak`
2. **Size Sanity Check** - Blocks writes that shrink files >50%
3. **Content Validation** - Detects unbalanced braces, truncated content
4. **Atomic Writes** - Write to temp file, then rename (crash-safe)
5. **Auto-cleanup** - Removes backups older than 24 hours

New commands:
- `backups <filename>` - List available backups
- `restore <filename> [number]` - Restore from backup

### Token Optimization

- Prompt complexity analyzer categorizes messages
- Context loaded conditionally based on keywords
- Conversation history scaled to task complexity

### Model Switching

Commands now work:
- `use haiku` - Lock to fastest model
- `use sonnet` - Lock to balanced model
- `use opus` - Lock to most capable model
- `use auto` - Return to automatic selection

---

## Configuration Added

```typescript
safety: {
  backupEnabled: true,
  backupRetentionHours: 24,
  maxShrinkagePercent: 50,
  validateContent: true,
  atomicWrites: true,
  gitAutoStash: false  // Opt-in
}
```

---

## Files Modified This Session

| File | Changes |
|------|---------|
| `src/core/cursor-agent.ts` | +300 lines (safety system, prompt tiers) |
| `src/core/parser.ts` | Added model/backup patterns |
| `src/core/executor.ts` | Added model/backup handlers |
| `src/types/index.ts` | Added safety config, new action types |
| `src/config.ts` | Added safety defaults |
| `src/interfaces/web.ts` | Removed debug logging |
| `src/core/handler.ts` | Removed debug logging |
| `web/app.js` | Fixed streaming bug, UI filtering |
| `.gitignore` | Added `.jeeves-backup/`, `*.jeeves-tmp` |

---

## Lessons Learned

1. **File writes need validation** - Never trust AI-generated content lengths. Always validate before writing.

2. **Token costs add up** - System prompts and history compound quickly. Tier based on task complexity.

3. **Streaming logic is tricky** - The frontend was suppressing valid responses because `stream_start/end` events were always sent, even without actual streamed content.

4. **Test edge cases** - The corruption happened on large files (600-900 lines). Small test files wouldn't have caught this.

5. **Git is the last resort backup** - We recovered from git, but shouldn't rely on it. Auto-backup before every edit.

---

## What's Left / Future Work

- [ ] **Git auto-stash** - Optional pre-edit git stash for extra safety
- [ ] **Prompt caching** - Anthropic supports caching stable prompt prefixes
- [ ] **Session persistence** - Save/restore session state across restarts
- [ ] **Undo command** - Quick undo last edit without digging through backups
- [ ] **Edit preview** - Show diff before applying, not just after

---

## Current State

Jeeves is running at `http://127.0.0.1:3847` with:
- File Safety System active
- Token-optimized prompts
- Model switching working
- 7 projects indexed
- Trust level 2 (semi-autonomous)
