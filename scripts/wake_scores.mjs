#!/usr/bin/env node
/**
 * Run wake model on a PCM file and print scores per chunk (and max).
 * Usage: node scripts/wake_scores.mjs <pcm-file> [model-path]
 * PCM: 16kHz, 16-bit LE, mono. Use to see why a recording doesn't trigger (max vs 0.5 threshold).
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
  console.error('Usage: node scripts/wake_scores.mjs <pcm-file> [model-path]');
  process.exit(1);
}

// Run Python script that reads stdin and prints "SCORE <float>" per chunk, then "MAX <float>"
const script = `
import os, sys
os.environ.setdefault("ORT_EXECUTION_PROVIDERS", "CPUExecutionProvider")
import numpy as np
from openwakeword.model import Model

model_path = sys.argv[1]
model = Model([model_path])
model_name = list(model.models.keys())[0]
chunk_bytes = 2560
max_score = 0.0
chunk_idx = 0
while True:
    raw = sys.stdin.buffer.read(chunk_bytes)
    if not raw or len(raw) < chunk_bytes:
        break
    samples = np.frombuffer(raw, dtype=np.int16)
    if len(samples) != 1280:
        continue
    samples_f = samples.astype(np.float32) / 32768.0
    pred = model.predict(samples_f)
    score = pred.get(model_name, 0.0)
    if score > max_score:
        max_score = score
    if chunk_idx % 10 == 0 or score > 0.2:
        print(f"SCORE {chunk_idx} {score}", flush=True)
    chunk_idx += 1
print(f"MAX {max_score}", flush=True)
`;

const venvPython = resolve(ROOT, 'scripts', 'venv', 'bin', 'python3');
const { existsSync } = await import('fs');
const pythonBin = existsSync(venvPython) ? venvPython : 'python3';

const proc = spawn(pythonBin, ['-c', script, modelPath], {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: ROOT,
  env: { ...process.env, ORT_EXECUTION_PROVIDERS: 'CPUExecutionProvider' }
});

createReadStream(pcmPath).pipe(proc.stdin);

let maxScore = 0;
proc.stdout.on('data', (d) => {
  const s = d.toString();
  for (const line of s.split('\n')) {
    if (line.startsWith('SCORE')) {
      const [, idx, score] = line.split(' ');
      const v = parseFloat(score);
      if (v > maxScore) maxScore = v;
      console.log(line);
    } else if (line.startsWith('MAX')) {
      const v = parseFloat(line.split(' ')[1]);
      console.log(line);
      console.log('Threshold in wake_listener.py is 0.1. Max score was', v, v >= 0.1 ? '(would trigger)' : '(would not trigger)');
    }
  }
});
proc.stderr.on('data', () => {}); // suppress CUDA/provider warnings
proc.on('exit', (code) => process.exit(code ?? 0));
