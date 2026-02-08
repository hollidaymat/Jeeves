/**
 * Routing Test Suite
 * Tests command registry matching. Examples are sourced from COMMAND_REGISTRY.
 * Run with: npx tsx tests/routing.test.ts
 */

import { matchCommand, matchResultToParsedIntent } from '../src/core/command-matcher.js';
import { fuzzyMatch } from '../src/core/fuzzy-matcher.js';
import { COMMAND_REGISTRY } from '../src/core/command-registry.js';

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

function assertNotNull<T>(actual: T | null | undefined, message?: string): asserts actual is T {
  if (actual === null || actual === undefined) {
    throw new Error(message || 'Expected non-null value');
  }
}

// ==========================================
// REGISTRY EXAMPLE TESTS (auto-generated from registry)
// ==========================================

console.log('\n📋 Command Registry Example Tests');

for (const cmd of COMMAND_REGISTRY) {
  for (const ex of cmd.examples) {
    test(`${cmd.id}: "${ex}"`, () => {
      const m = matchCommand(ex);
      assertNotNull(m, `Expected match for "${ex}"`);
      assertEqual(m.commandId, cmd.id);
      // Action may be overridden by extract (e.g. homelab service control)
      const expectedAction = cmd.action;
      if (!cmd.extract || !cmd.extract.toString().includes('_action')) {
        assertEqual(m.action, expectedAction);
      }
    });
  }
}

// ==========================================
// CRITICAL ROUTING TESTS
// ==========================================

console.log('\n📋 Critical Routing Tests');

test('Vercel URL: "can you check vercel and find the url for Sentinel"', () => {
  const m = matchCommand('can you check vercel and find the url for Sentinel');
  assertNotNull(m);
  assertEqual(m.commandId, 'vercel.url');
  assertEqual(m.action, 'vercel_url');
  assertEqual((m.params.target as string)?.toLowerCase(), 'sentinel');
});

test('Vercel URL: "vercel url for dive-connect"', () => {
  const m = matchCommand('vercel url for dive-connect');
  assertNotNull(m);
  assertEqual(m.commandId, 'vercel.url');
  assertEqual((m.params.target as string)?.toLowerCase(), 'dive-connect');
});

test('restart jellyfin → homelab_service_restart', () => {
  const m = matchCommand('restart jellyfin');
  assertNotNull(m);
  assertEqual(m.action, 'homelab_service_restart');
  assertEqual(m.params.target, 'jellyfin');
});

test('stop agent → cursor_stop (not homelab)', () => {
  const m = matchCommand('stop agent');
  assertNotNull(m);
  // Should match agent stop, not homelab service control
  assertEqual(m.action, 'cursor_stop');
});

test('start dev → dev_start (not homelab)', () => {
  const m = matchCommand('start dev');
  assertNotNull(m);
  assertEqual(m.action, 'dev_start');
});

test('status → system status', () => {
  const m = matchCommand('status');
  assertNotNull(m);
  assertEqual(m.commandId, 'system.status');
  assertEqual(m.action, 'status');
});

test('help → system help', () => {
  const m = matchCommand('help');
  assertNotNull(m);
  assertEqual(m.action, 'help');
});

test('homelab status → homelab_status', () => {
  const m = matchCommand('homelab status');
  assertNotNull(m);
  assertEqual(m.action, 'homelab_status');
});

test('empty message → no match', () => {
  const m = matchCommand('');
  assertEqual(m, null);
});

test('whitespace only → no match', () => {
  const m = matchCommand('   ');
  assertEqual(m, null);
});

test('unknown gibberish → no match', () => {
  const m = matchCommand('xyzzy flarble quux');
  assertEqual(m, null);
});

// ==========================================
// MATCH RESULT TO PARSED INTENT
// ==========================================

console.log('\n📋 MatchResult → ParsedIntent');

test('matchResultToParsedIntent produces valid shape', () => {
  const m = matchCommand('restart jellyfin');
  assertNotNull(m);
  const intent = matchResultToParsedIntent(m);
  assertEqual(intent.action, 'homelab_service_restart');
  assertEqual(intent.target, 'jellyfin');
  assertEqual(intent.resolutionMethod, 'registry');
  assertEqual(intent.estimatedCost, 0);
});

// ==========================================
// FUZZY MATCHER
// ==========================================

console.log('\n📋 Fuzzy Matcher');

test('fuzzy: "statis" → status', () => {
  const f = fuzzyMatch('statis');
  assertNotNull(f);
  assertEqual(f.commandId, 'system.status');
  assertEqual(f.suggestion, 'status');
});

test('fuzzy: "vercel stauts" → vercel status', () => {
  const f = fuzzyMatch('vercel stauts');
  assertNotNull(f);
  assertEqual(f.commandId, 'vercel.projects');
});

test('fuzzy: "helpp" → help', () => {
  const f = fuzzyMatch('helpp');
  assertNotNull(f);
  assertEqual(f.commandId, 'system.help');
});

test('fuzzy: "xyzzy" → no match', () => {
  const f = fuzzyMatch('xyzzy');
  assertEqual(f, null);
});

// ==========================================
// RUN
// ==========================================

console.log('\n' + '='.repeat(50));
console.log(`Routing: ${passed} passed, ${failed} failed`);
if (errors.length > 0) {
  console.log('\nErrors:');
  errors.forEach((e) => console.log('  -', e));
  process.exit(1);
}
