#!/usr/bin/env node
/**
 * Test Hey Jeeves wake stream: connect to /voice, send wake_stream_start,
 * expect wake_stream_ready (or error), then send silent PCM chunks for a few seconds.
 * Usage: node scripts/test-wake-stream.mjs [host] [port]
 * Loads .env from repo root. Requires Jeeves running with VOICE_ENABLED=true.
 */
import WebSocket from 'ws';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '..', '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
}

const port = process.argv[3] || process.env.PORT || 3847;
const host = process.argv[2] || process.env.HOST || '127.0.0.1';
const useTls = !!process.env.TLS_KEY_PATH;
const protocol = useTls ? 'wss' : 'ws';
const url = `${protocol}://${host}:${port}/voice`;

const wsOpts = (host === '127.0.0.1' || host === 'localhost') && useTls ? { rejectUnauthorized: false } : {};

// 2560 bytes = 1280 samples * 2 (16-bit), silent PCM 16 kHz mono
const SILENT_CHUNK = Buffer.alloc(2560, 0);
const SILENT_B64 = SILENT_CHUNK.toString('base64');

const RUN_CHUNKS = 50; // ~4 s at 80 ms per chunk
let gotReady = false;
let gotError = false;
let errorMessage = '';

console.log('Connecting to', url, '...');
const ws = new WebSocket(url, wsOpts);

ws.on('open', () => {
  console.log('Connected. Sending wake_stream_start');
  ws.send(JSON.stringify({ type: 'wake_stream_start' }));
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'wake_stream_ready') {
    gotReady = true;
    console.log('OK: wake_stream_ready received');
    let sent = 0;
    const interval = setInterval(() => {
      ws.send(JSON.stringify({ type: 'wake_stream_chunk', pcm: SILENT_B64 }));
      sent++;
      if (sent >= RUN_CHUNKS) {
        clearInterval(interval);
        ws.send(JSON.stringify({ type: 'wake_stream_stop' }));
        setTimeout(() => {
          console.log('Sent', RUN_CHUNKS, 'silent chunks and stop. Exiting.');
          ws.close();
        }, 200);
      }
    }, 85);
    return;
  }
  if (msg.type === 'error') {
    gotError = true;
    errorMessage = msg.message || 'Unknown error';
    console.error('Error:', errorMessage);
    ws.close();
    return;
  }
  if (msg.type === 'wake_detected') {
    console.log('(Wake word detected – would record in real client)');
    return;
  }
  console.log('[', msg.type, ']', msg.type === 'voice_response' && msg.text ? msg.text.slice(0, 60) : '');
});

ws.on('error', (err) => {
  console.error('WebSocket error:', err.message);
  process.exit(1);
});

ws.on('close', () => {
  if (gotError) {
    console.error('Test failed:', errorMessage);
    process.exit(1);
  }
  if (gotReady) {
    console.log('Test passed: server accepted wake stream and PCM.');
    process.exit(0);
  }
  console.error('Closed without wake_stream_ready');
  process.exit(1);
});

setTimeout(() => {
  if (!gotReady && !gotError) {
    console.error('Timeout (15s) waiting for wake_stream_ready or error');
    ws.close();
    process.exit(1);
  }
}, 15000);
