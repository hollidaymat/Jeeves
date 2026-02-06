/**
 * Parser Test Suite
 * 
 * Tests for intent classification, disambiguation, and pronoun resolution.
 * Run with: npx tsx tests/parser.test.ts
 */

import { quickClassify, needsLLMClassification } from '../src/core/classifier.js';
import { extractEntities, isPRDContent, hasDestructiveIntent } from '../src/core/entities.js';
import { applyDisambiguation, hasAmbiguousPattern } from '../src/core/disambiguation.js';
import { ReferenceResolverImpl } from '../src/core/reference-resolver.js';

// ==========================================
// TEST UTILITIES
// ==========================================

let passed = 0;
let failed = 0;
const errors: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    const msg = error instanceof Error ? error.message : String(error);
    errors.push(`${name}: ${msg}`);
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${msg}`);
  }
}

function assertEqual<T>(actual: T, expected: T, message?: string): void {
  if (actual !== expected) {
    throw new Error(message || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertTrue(actual: boolean, message?: string): void {
  if (!actual) {
    throw new Error(message || 'Expected true, got false');
  }
}

function assertFalse(actual: boolean, message?: string): void {
  if (actual) {
    throw new Error(message || 'Expected false, got true');
  }
}

function assertNotNull<T>(actual: T | null | undefined, message?: string): asserts actual is T {
  if (actual === null || actual === undefined) {
    throw new Error(message || 'Expected non-null value');
  }
}

// ==========================================
// QUICK CLASSIFY TESTS
// ==========================================

console.log('\n📋 Quick Classify Tests');

test('classifies PRD content correctly', () => {
  const prd = `# PRD: Expense Tracker Dashboard

## Overview
A single-page expense tracker with categorization and visual breakdown.

## Requirements
### Data Model
- Expense: amount, category, date, note
- Categories: Food, Transport, Entertainment, Bills, Other

### UI Components
1. Add Expense Form - Amount input, category dropdown
2. Expense List - Sortable table with delete action
3. Summary Cards - Total spent, this month
4. Category Breakdown - Donut chart

Build me a complete expense tracker MVP with all these features.`;
  
  const result = quickClassify(prd);
  assertNotNull(result);
  assertEqual(result.category, 'prd');
});

test('classifies feedback "no that\'s wrong" correctly', () => {
  const result = quickClassify("no that's wrong");
  assertNotNull(result);
  assertEqual(result.category, 'feedback');
  assertEqual(result.action, 'correction');
});

test('classifies "actually use the other pattern" as feedback', () => {
  const result = quickClassify("actually use the other pattern");
  assertNotNull(result);
  assertEqual(result.category, 'feedback');
});

test('classifies "how does auth work" as question', () => {
  const result = quickClassify("how does auth work");
  assertNotNull(result);
  assertEqual(result.category, 'question');
});

test('classifies "what is the status" as question', () => {
  const result = quickClassify("what is the status");
  assertNotNull(result);
  assertEqual(result.category, 'question');
});

test('classifies "can you check the auth" as command', () => {
  const result = quickClassify("can you check the auth");
  assertNotNull(result);
  assertEqual(result.category, 'command');
  assertEqual(result.action, 'check');
});

test('classifies "don\'t touch the config" as negation', () => {
  const result = quickClassify("don't touch the config");
  assertNotNull(result);
  assertTrue(result.isNegation);
  assertEqual(result.action, 'stop');
});

test('returns null for ambiguous short messages', () => {
  const result = quickClassify("maybe later");
  assertEqual(result, null);
});

// ==========================================
// ENTITY EXTRACTION TESTS
// ==========================================

console.log('\n📋 Entity Extraction Tests');

test('extracts file paths', () => {
  const entities = extractEntities("Check the ./src/index.ts file");
  assertTrue(entities.filePaths.length > 0);
});

test('extracts URLs', () => {
  const entities = extractEntities("Go to https://example.com/api");
  assertTrue(entities.urls.length > 0);
  assertEqual(entities.urls[0], 'https://example.com/api');
});

test('extracts code references', () => {
  const entities = extractEntities("Fix the `handleClick` function");
  assertTrue(entities.codeRefs.length > 0);
  assertEqual(entities.codeRefs[0], 'handleClick');
});

test('detects negations', () => {
  const entities = extractEntities("Don't delete the file");
  assertTrue(entities.hasNegation);
  assertTrue(entities.negations.length > 0);
});

test('detects pronouns', () => {
  const entities = extractEntities("Fix it and deploy");
  assertTrue(entities.hasPronouns);
  assertTrue(entities.pronouns.includes('it'));
});

test('detects destructive intent', () => {
  assertTrue(hasDestructiveIntent("delete all the files"));
  assertTrue(hasDestructiveIntent("rm -rf ./dist"));
  assertTrue(hasDestructiveIntent("git push --force"));
  assertFalse(hasDestructiveIntent("create a new file"));
});

test('detects PRD content', () => {
  const prd = `## Requirements
This is a detailed spec with multiple sections and comprehensive requirements for the project.

### Features
- Feature 1: User authentication with JWT tokens
- Feature 2: Dashboard with real-time updates
- Feature 3: Settings page with theme toggle

### Implementation Notes
Build me a complete system with all these features and proper error handling.`;
  
  assertTrue(isPRDContent(prd));
  assertFalse(isPRDContent("open project"));
});

// ==========================================
// DISAMBIGUATION TESTS
// ==========================================

console.log('\n📋 Disambiguation Tests');

test('disambiguates "can you check" as command', () => {
  const result = applyDisambiguation("can you check the auth flow");
  assertNotNull(result);
  assertEqual(result.category, 'command');
  assertEqual(result.action, 'check');
});

test('disambiguates "please fix" as command', () => {
  const result = applyDisambiguation("please fix the bug");
  assertNotNull(result);
  assertEqual(result.category, 'command');
  assertEqual(result.action, 'fix');
});

test('disambiguates "don\'t delete" as negation command', () => {
  const result = applyDisambiguation("don't delete the config");
  assertNotNull(result);
  assertTrue(result.isNegation === true);
  assertEqual(result.action, 'stop');
});

test('disambiguates "this is wrong" as feedback', () => {
  const result = applyDisambiguation("this is wrong");
  assertNotNull(result);
  assertEqual(result.category, 'feedback');
});

test('disambiguates "no, use the other one" as feedback', () => {
  const result = applyDisambiguation("no, use the other one");
  assertNotNull(result);
  assertEqual(result.category, 'feedback');
});

test('disambiguates "like the dashboard" as reference', () => {
  const result = applyDisambiguation("make it like the dashboard");
  assertNotNull(result);
  assertTrue(result.isReference === true);
  assertEqual(result.referenceTarget, 'dashboard');
});

test('disambiguates "yes" as approval', () => {
  const result = applyDisambiguation("yes");
  assertNotNull(result);
  assertEqual(result.action, 'approve');
});

test('disambiguates "let\'s go" as approval', () => {
  const result = applyDisambiguation("let's go");
  assertNotNull(result);
  assertEqual(result.action, 'approve');
});

test('disambiguates "go ahead" as approval', () => {
  const result = applyDisambiguation("go ahead");
  assertNotNull(result);
  assertEqual(result.action, 'approve');
});

test('detects ambiguous patterns', () => {
  assertTrue(hasAmbiguousPattern("make it like the other one"));
  assertTrue(hasAmbiguousPattern("what about the config"));
});

// ==========================================
// REFERENCE RESOLVER TESTS
// ==========================================

console.log('\n📋 Reference Resolver Tests');

test('resolves "it" to last mentioned file', () => {
  const resolver = new ReferenceResolverImpl();
  resolver.setReference('file', 'auth.ts');
  
  const result = resolver.resolve("fix it");
  assertTrue(result.hadPronouns);
  assertTrue(result.resolved.includes('auth.ts'));
});

test('resolves "the file" to last mentioned file', () => {
  const resolver = new ReferenceResolverImpl();
  resolver.setReference('file', 'config.json');
  
  const result = resolver.resolve("update the file");
  assertTrue(result.hadPronouns);
  assertTrue(result.resolved.includes('config.json'));
});

test('resolves "the project" to last mentioned project', () => {
  const resolver = new ReferenceResolverImpl();
  resolver.setReference('project', 'basecamp');
  
  const result = resolver.resolve("open the project");
  assertTrue(result.hadPronouns);
  assertTrue(result.resolved.includes('basecamp'));
});

test('tracks multiple references', () => {
  const resolver = new ReferenceResolverImpl();
  resolver.update({ 
    resolved_path: '/path/to/file.ts',
    action: 'open_project',
    target: 'myproject'
  });
  
  const state = resolver.getState();
  assertEqual(state.file, '/path/to/file.ts');
  assertEqual(state.project, 'myproject');
});

test('clear() resets all references', () => {
  const resolver = new ReferenceResolverImpl();
  resolver.setReference('file', 'test.ts');
  resolver.setReference('project', 'myapp');
  resolver.clear();
  
  const state = resolver.getState();
  assertEqual(state.file, null);
  assertEqual(state.project, null);
});

test('getUnresolvedPronouns returns unresolved pronouns', () => {
  const resolver = new ReferenceResolverImpl();
  // Don't set any references
  
  const unresolved = resolver.getUnresolvedPronouns("fix it and update that");
  assertTrue(unresolved.includes('it'));
  assertTrue(unresolved.includes('that'));
});

// ==========================================
// NEEDS LLM CLASSIFICATION TESTS
// ==========================================

console.log('\n📋 Needs LLM Classification Tests');

test('short messages do not need LLM', () => {
  assertFalse(needsLLMClassification("open project"));
  assertFalse(needsLLMClassification("status"));
});

test('long messages need LLM', () => {
  const longMessage = `This is a very long message that contains a lot of information about what the user wants. 
    It has multiple sentences and clauses. It also mentions specific features and requirements.
    The user wants to build something complex with many parts.`;
  assertTrue(needsLLMClassification(longMessage));
});

test('messages with markdown need LLM', () => {
  // Messages need to be at least 50 chars or have other complexity indicators
  const markdownMessage = `## Header Section
- bullet point one with some details
- bullet point two with more info`;
  assertTrue(needsLLMClassification(markdownMessage));
  
  const codeBlockMessage = `Please fix this code block:
\`\`\`javascript
function test() { return true; }
\`\`\``;
  assertTrue(needsLLMClassification(codeBlockMessage));
});

test('ambiguous phrases need LLM', () => {
  // These need to be long enough (50+ chars) to trigger LLM classification
  assertTrue(needsLLMClassification("make it similar to the dashboard we built last week with the charts"));
  assertTrue(needsLLMClassification("instead of using that pattern, use something else that works better"));
});

// ==========================================
// RESULTS
// ==========================================

console.log('\n' + '='.repeat(50));
console.log(`\n📊 Test Results: ${passed} passed, ${failed} failed\n`);

if (failed > 0) {
  console.log('❌ Failed tests:');
  errors.forEach(e => console.log(`  - ${e}`));
  process.exit(1);
} else {
  console.log('✅ All tests passed!');
  process.exit(0);
}
