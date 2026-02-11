#!/usr/bin/env node
/**
 * Send a test text_command over the voice WebSocket to verify the pipeline.
 * Usage: node scripts/voice-test-ws.mjs [command]
 * Default command: "status"
 * Requires: Jeeves running with VOICE_ENABLED=true
 * Loads .env from repo root so PORT/HOST/TLS match the running server.
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

const port = process.env.PORT || 3847;
const host = process.env.HOST || '127.0.0.1';
const useTls = !!process.env.TLS_KEY_PATH;
const protocol = useTls ? 'wss' : 'ws';
const url = `${protocol}://${host}:${port}/voice`;
const command = process.argv[2] || 'status';

const wsOpts = (host === '127.0.0.1' || host === 'localhost') && useTls ? { rejectUnauthorized: false } : {};
console.log('Connecting to', url, '...');
const ws = new WebSocket(url, wsOpts);

ws.on('open', () => {
  console.log('Connected. Sending text_command:', JSON.stringify(command));
  ws.send(JSON.stringify({ type: 'text_command', text: command, timestamp: Date.now() }));
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  const preview = msg.text ? msg.text.slice(0, 120) : msg.message || (msg.audio ? '<audio>' : JSON.stringify(msg).slice(0, 80));
  console.log('[', msg.type, ']', preview);
  if (msg.type === 'voice_response' || msg.type === 'error') {
    ws.close();
  }
});

ws.on('error', (err) => {
  console.error('WebSocket error:', err.message);
  process.exit(1);
});

ws.on('close', () => {
  console.log('Done.');
  process.exit(0);
});

setTimeout(() => {
  console.error('Timeout (60s) waiting for voice_response');
  ws.close();
  process.exit(1);
}, 60000);
