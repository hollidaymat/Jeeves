# Jeeves Parser Improvements

## Current Problem
Misinterpreting commands. Parsing is brittle.

---

## Fix 1: Two-Stage Parsing

Don't parse and act in one shot. Separate intent from execution.

```javascript
// Stage 1: Classify intent (cheap, Haiku)
async function classifyIntent(message) {
  const response = await haiku.complete({
    system: `Classify the user intent. Return JSON only.
Categories: command, question, prd, feedback, unclear
Extract: action, target, parameters`,
    prompt: message,
    max_tokens: 150
  });
  return JSON.parse(response);
}

// Stage 2: Confirm before execute (if confidence < 0.8)
async function confirmIntent(parsed, original) {
  if (parsed.confidence < 0.8) {
    return {
      needsConfirmation: true,
      message: `I understood: "${parsed.action}" on "${parsed.target}". Correct?`
    };
  }
  return { needsConfirmation: false, parsed };
}
```

---

## Fix 2: Structured Classification Prompt

Bad prompt:
```
What does the user want?
```

Good prompt:
```
Classify this message. Return valid JSON only.

MESSAGE: "{input}"

CATEGORIES:
- command: User wants action taken (open, run, build, deploy, fix)
- question: User wants information (how, what, why, explain)
- prd: User is providing a spec/requirements (build me, create, implement this)
- feedback: User is correcting or commenting (no, wrong, actually, instead)
- unclear: Cannot determine intent

EXTRACT:
- action: The verb (open, build, explain, fix, etc.)
- target: The object (project name, file, concept)
- parameters: Any modifiers (urgent, simple, like X)
- confidence: 0.0-1.0

RESPOND WITH JSON ONLY:
{"category":"","action":"","target":"","parameters":[],"confidence":0.0}
```

---

## Fix 3: Entity Extraction Patterns

Pre-extract entities before LLM classification:

```javascript
const ENTITY_PATTERNS = {
  // File paths
  filePath: /(?:^|[\s"'`])([.~]?\/[\w\-./]+\.\w+)/g,
  
  // Project names (quoted or after "project"/"repo")
  projectName: /(?:project|repo|repository)\s+["']?(\w[\w-]*)["']?/i,
  
  // URLs
  url: /https?:\/\/[^\s<>"{}|\\^`[\]]+/g,
  
  // Cost/budget mentions
  cost: /\$[\d.]+|\d+\s*(?:dollars?|cents?)/gi,
  
  // Time references
  time: /(?:yesterday|today|tomorrow|last\s+\w+|\d+\s*(?:hours?|days?|minutes?)\s*ago)/gi,
  
  // Code references
  codeRef: /`([^`]+)`/g,
  
  // Negations (critical for intent)
  negation: /\b(don't|do not|stop|cancel|abort|never|without)\b/gi
};

function extractEntities(message) {
  const entities = {};
  for (const [name, pattern] of Object.entries(ENTITY_PATTERNS)) {
    const matches = message.match(pattern);
    if (matches) entities[name] = matches;
  }
  return entities;
}
```

---

## Fix 4: Disambiguation Rules

Common misinterpretations and fixes:

| Message | Wrong Parse | Right Parse | Rule |
|---------|-------------|-------------|------|
| "not the auth file" | action: modify auth | negation detected → clarify | Check negations first |
| "like the dashboard" | action: open dashboard | "like" = similarity reference | "like X" ≠ "open X" |
| "can you check" | question | command (check = action) | "can you" + verb = command |
| "what about X" | question about X | often means "also do X" | Context-dependent |
| "this is wrong" | question | feedback/correction | "this" = reference to prior |

```javascript
const DISAMBIGUATION_RULES = [
  {
    pattern: /^(can|could|would) you\s+(\w+)/i,
    transform: (match) => ({ category: 'command', action: match[2] })
  },
  {
    pattern: /\b(don't|do not|stop|never)\b.*\b(\w+)\b/i,
    transform: (match) => ({ 
      category: 'command', 
      action: 'stop',
      target: match[2],
      isNegation: true 
    })
  },
  {
    pattern: /^(this|that|it)\s+(is|was|looks)\s+(wrong|bad|broken)/i,
    transform: () => ({ category: 'feedback', action: 'correction' })
  },
  {
    pattern: /like\s+(the\s+)?(\w+)/i,
    transform: (match) => ({ 
      isReference: true, 
      referenceTarget: match[2],
      NOT_AN_ACTION: true 
    })
  }
];
```

---

## Fix 5: Confidence Thresholds with Actions

```javascript
const CONFIDENCE_ACTIONS = {
  high: { min: 0.85, action: 'execute' },
  medium: { min: 0.6, action: 'confirm' },
  low: { min: 0.3, action: 'clarify' },
  none: { min: 0, action: 'ask_rephrase' }
};

function getConfidenceAction(score) {
  if (score >= 0.85) return 'execute';
  if (score >= 0.6) return {
    action: 'confirm',
    template: 'I think you want me to {action} {target}. Correct?'
  };
  if (score >= 0.3) return {
    action: 'clarify', 
    template: 'I\'m not sure what you mean. Did you want to:\nA) {option1}\nB) {option2}\nC) Something else'
  };
  return {
    action: 'rephrase',
    template: 'I didn\'t understand that. Can you rephrase?'
  };
}
```

---

## Fix 6: Context Window for Pronouns

"it", "that", "this" need reference resolution:

```javascript
class ReferenceResolver {
  constructor() {
    this.lastMentioned = {
      file: null,
      project: null,
      task: null,
      error: null
    };
  }

  update(parsed) {
    if (parsed.target?.includes('/')) this.lastMentioned.file = parsed.target;
    if (parsed.category === 'prd') this.lastMentioned.task = parsed.target;
    // etc.
  }

  resolve(message) {
    const pronouns = {
      'it': this.lastMentioned.file || this.lastMentioned.task,
      'that': this.lastMentioned.task || this.lastMentioned.file,
      'this': this.lastMentioned.error || this.lastMentioned.task,
      'the file': this.lastMentioned.file,
      'the project': this.lastMentioned.project
    };

    let resolved = message;
    for (const [pronoun, value] of Object.entries(pronouns)) {
      if (value && message.toLowerCase().includes(pronoun)) {
        resolved = resolved.replace(new RegExp(pronoun, 'gi'), value);
      }
    }
    return { original: message, resolved, hadPronouns: resolved !== message };
  }
}
```

---

## Fix 7: Test Suite

Before deploying parser changes, run against known cases:

```javascript
const PARSER_TESTS = [
  // Commands
  { input: 'open basecamp', expect: { category: 'command', action: 'open', target: 'basecamp' }},
  { input: 'can you check the auth flow', expect: { category: 'command', action: 'check' }},
  { input: 'deploy to staging', expect: { category: 'command', action: 'deploy', target: 'staging' }},
  
  // Questions
  { input: 'how does the auth work', expect: { category: 'question' }},
  { input: 'what is the status', expect: { category: 'question', action: 'status' }},
  
  // PRDs
  { input: 'build me a login page', expect: { category: 'prd' }},
  { input: 'I need a dashboard that shows...', expect: { category: 'prd' }},
  
  // Feedback
  { input: 'no that\'s wrong', expect: { category: 'feedback' }},
  { input: 'actually use the other pattern', expect: { category: 'feedback' }},
  
  // Negations
  { input: 'don\'t touch the config', expect: { isNegation: true, target: 'config' }},
  { input: 'stop the deploy', expect: { action: 'stop' }},
  
  // References
  { input: 'make it like the dashboard', expect: { isReference: true, referenceTarget: 'dashboard' }},
  
  // Pronouns (with context)
  { 
    context: { lastMentioned: { file: 'auth.ts' }},
    input: 'fix it', 
    expect: { action: 'fix', target: 'auth.ts' }
  }
];

async function runParserTests() {
  let passed = 0, failed = 0;
  for (const test of PARSER_TESTS) {
    const result = await classifyIntent(test.input, test.context);
    const matches = Object.entries(test.expect).every(
      ([key, value]) => result[key] === value
    );
    if (matches) passed++;
    else {
      failed++;
      console.log(`FAIL: "${test.input}"\nExpected: ${JSON.stringify(test.expect)}\nGot: ${JSON.stringify(result)}\n`);
    }
  }
  console.log(`Parser tests: ${passed} passed, ${failed} failed`);
}
```

---

## Implementation Priority

1. **Structured classification prompt** - Biggest bang, immediate improvement
2. **Confidence thresholds** - Stop acting on bad parses
3. **Disambiguation rules** - Fix known failure patterns
4. **Entity extraction** - Pre-process before LLM
5. **Reference resolver** - Handle pronouns
6. **Test suite** - Prevent regressions

---

## Quick Win: Add This to System Prompt

```
PARSING RULES:
1. "can you X" = command to do X
2. "don't X" = command to NOT do X (stop/prevent)
3. "like X" = reference/comparison, NOT action on X
4. "it/this/that" = refers to last mentioned item
5. If unsure, ask. Never guess on destructive actions.
6. Confidence below 0.6 = ask for confirmation
```
