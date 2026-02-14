#!/usr/bin/env node
/**
 * Test wake word model with a raw PCM file (16 kHz, 16-bit LE, mono).
 * Pipes the file into wake_listener.py and prints stdout (WAKE when detected).
 *
 * Usage:
 *   node scripts/test-wake-with-pcm.mjs <pcm-file> [model-path]
 *
 * Create a test PCM from a WAV (e.g. recording of "Hey Jeeves"):
 *   ffmpeg -i recording.wav -ar 16000 -ac 1 -f s16le -acodec pcm_s16le hey_jeeves.raw
 *   node scripts/test-wake-with-pcm.mjs hey_jeeves.raw
 *
 * Or from mic with sox (install sox): record 5s, 16kHz mono
 *   sox -d -t raw -r 16000 -e signed-integer -b 16 -c 1 test.pcm trim 0 5
 */
import { createReadStream } from 'fs';
import { spawn } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const pcmPath = process.argv[2];
const modelPath = process.argv[3] || resolve(ROOT, 'models', 'wake', 'hey_jeeves.onnx');

if (!pcmPath) {
  console.error('Usage: node scripts/test-wake-with-pcm.mjs <pcm-file> [model-path]');
  console.error('  PCM: 16 kHz, 16-bit LE, mono (raw, no header)');
  process.exit(1);
}

const scriptPath = resolve(ROOT, 'scripts', 'wake_listener.py');
const venvPython = resolve(ROOT, 'scripts', 'venv', 'bin', 'python3');
const { existsSync } = await import('fs');
const pythonBin = existsSync(venvPython) ? venvPython : 'python3';

console.error('Piping', pcmPath, 'into wake_listener.py (model:', modelPath, ')');
const proc = spawn(pythonBin, [scriptPath, modelPath], {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: ROOT
});

proc.stdout.on('data', (d) => {
  process.stdout.write(d);
  if (d.toString().includes('WAKE')) console.error('\n(WAKE printed above)');
});
proc.stderr.on('data', (d) => process.stderr.write(d));
proc.on('error', (err) => {
  console.error('Spawn error:', err.message);
  process.exit(1);
});
proc.on('exit', (code, sig) => {
  process.exit(code != null && code !== 0 ? code : 0);
});

createReadStream(pcmPath).on('error', (err) => {
  console.error('Read error:', err.message);
  proc.kill('SIGTERM');
  process.exit(1);
}).pipe(proc.stdin);
