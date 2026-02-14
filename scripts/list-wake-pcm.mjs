#!/usr/bin/env node
/**
 * List wake-word test PCM files in the repo root (hey_jeeves_test_*.pcm).
 * Usage: node scripts/list-wake-pcm.mjs [--scores]
 *   --scores  run wake_scores.mjs on each file and show max score
 */
import { readdirSync, statSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const withScores = process.argv.includes('--scores');

let files;
try {
  files = readdirSync(ROOT)
    .filter((f) => f.startsWith('hey_jeeves_test_') && f.endsWith('.pcm'))
    .map((f) => ({
      name: f,
      path: resolve(ROOT, f),
      size: statSync(resolve(ROOT, f)).size,
      mtime: statSync(resolve(ROOT, f)).mtime
    }))
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
} catch (err) {
  console.error('Error reading repo root:', err.message);
  process.exit(1);
}

if (files.length === 0) {
  console.log('No hey_jeeves_test_*.pcm files in repo root.');
  console.log('Record from the voice panel (Record test PCM 2s), then save the file here.');
  process.exit(0);
}

console.log('Wake test PCM files in', ROOT);
console.log('');

for (const f of files) {
  const sizeK = (f.size / 1024).toFixed(1);
  const mtime = f.mtime.toISOString().replace('T', ' ').slice(0, 19);
  if (!withScores) {
    console.log('  %s  %s KB  %s', f.name.padEnd(45), sizeK.padStart(8), mtime);
    continue;
  }
  const out = spawnSync('node', [resolve(__dirname, 'wake_scores.mjs'), f.path], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const maxLine = out.stdout.split('\n').find((l) => l.startsWith('MAX '));
  const maxScore = maxLine ? parseFloat(maxLine.split(' ')[1]) : NaN;
  console.log('  %s  %s KB  %s  max=%.4f', f.name.padEnd(45), sizeK.padStart(8), mtime, maxScore);
}

console.log('');
console.log('Test one:  node scripts/test-wake-with-pcm.mjs <filename>');
console.log('Scores:    node scripts/wake_scores.mjs <filename>');
