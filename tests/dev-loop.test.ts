/**
 * Dev loop: action normalization (Update/Edit → modify) so LLM output is accepted.
 * Run with: npx tsx tests/dev-loop.test.ts
 */

const normalizeAction = (action: string): string =>
  /^(update|edit|change|patch)$/i.test(action) ? 'modify' : action;

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error instanceof Error ? error.message : String(error)}`);
  }
}
function assertEqual<T>(actual: T, expected: T): void {
  if (actual !== expected) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

console.log('\n📋 Dev loop action normalization\n');
test('normalizes Update to modify', () => {
  assertEqual(normalizeAction('Update'), 'modify');
  assertEqual(normalizeAction('update'), 'modify');
});
test('normalizes Edit to modify', () => {
  assertEqual(normalizeAction('Edit'), 'modify');
  assertEqual(normalizeAction('edit'), 'modify');
});
test('normalizes Change and Patch to modify', () => {
  assertEqual(normalizeAction('Change'), 'modify');
  assertEqual(normalizeAction('patch'), 'modify');
});
test('leaves create and modify unchanged', () => {
  assertEqual(normalizeAction('create'), 'create');
  assertEqual(normalizeAction('modify'), 'modify');
});
test('leaves unknown actions unchanged', () => {
  assertEqual(normalizeAction('delete'), 'delete');
  assertEqual(normalizeAction('unknown'), 'unknown');
});
console.log('\n==================================================');
console.log(`Dev loop: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
