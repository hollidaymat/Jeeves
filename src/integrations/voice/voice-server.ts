/**
 * Voice WebSocket + REST for tablet. Attach to existing HTTP server and Express app.
 * When config.voice.enabled, call setupVoiceWebSocket(voiceWss, app) after creating
 * voiceWss = new WebSocketServer({ server, path: '/voice' }).
 * Server-side wake word: client sends wake_stream_start then wake_stream_chunk (PCM base64);
 * we spawn Python openWakeWord and on WAKE send wake_detected to client.
 */

import { randomUUID } from 'crypto';
import { spawn, type ChildProcess } from 'child_process';
import { existsSync, createReadStream } from 'fs';
import { Request, Response } from 'express';
import type { WebSocketServer, WebSocket } from 'ws';
import { resolve } from 'path';
import { config, ROOT } from '../../config.js';
import { logger } from '../../utils/logger.js';
import { handleMessage } from '../../core/handler.js';
import { getDashboardStatus } from '../../homelab/index.js';
import { synthesize, isAvailable as piperAvailable } from './piper.js';
import { transcribe, isAvailable as whisperAvailable } from './whisper.js';
import type { IncomingMessage } from '../../types/index.js';

const VOICE_MAX_RESPONSE_CHARS = 300;
/** When reply is longer than this, we speak a short summary instead of full text so TTS returns quickly. */
const VOICE_LONG_REPLY_THRESHOLD = 200;

function shortenForTTS(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= VOICE_MAX_RESPONSE_CHARS) return trimmed;
  const firstParagraph = trimmed.split(/\n\n/)[0];
  if (firstParagraph.length <= VOICE_MAX_RESPONSE_CHARS) return firstParagraph;
  return firstParagraph.slice(0, VOICE_MAX_RESPONSE_CHARS - 3) + '...';
}

/** For voice: use short phrase for long replies so user gets spoken feedback quickly. */
function speakableForVoice(reply: string): string {
  if (reply.length <= VOICE_LONG_REPLY_THRESHOLD) return shortenForTTS(reply);
  if (/homelab|connected|running|needs setup|api added/i.test(reply)) {
    return 'Homelab report ready. Check the screen for details.';
  }
  return 'Here\'s your report. Check the screen for details.';
}

function send(ws: WebSocket, payload: Record<string, unknown>): void {
  if (ws.readyState !== 1 /* OPEN */) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch (err) {
    logger.warn('Voice WS send failed', { error: String(err) });
  }
}

let voiceClients: Set<WebSocket> = new Set();

const WAKE_CHUNK_BYTES = 2560; // 1280 samples * 2 (16-bit PCM for openWakeWord)

const WAKE_LOG_CHUNK_INTERVAL = 25; // log every ~2s of PCM (25 * 80ms)
type WakeStreamState = { proc: ChildProcess; buffer: Buffer; chunksFed: number };
const wakeStreamByWs = new Map<WebSocket, WakeStreamState>();

function startWakeListener(ws: WebSocket): boolean {
  if (wakeStreamByWs.has(ws)) {
    logger.info('Wake listener already running for this client');
    return true;
  }
  const modelPath = config.voice?.wakeModelPath ?? '';
  if (!modelPath || !existsSync(modelPath)) {
    logger.warn('Wake model not found', { path: modelPath || '(empty)' });
    send(ws, { type: 'error', message: 'Wake model not found (VOICE_WAKE_MODEL_PATH)' });
    return false;
  }
  const scriptPath = resolve(ROOT, 'scripts', 'wake_listener.py');
  if (!existsSync(scriptPath)) {
    logger.warn('Wake listener script not found', { path: scriptPath });
    send(ws, { type: 'error', message: 'scripts/wake_listener.py not found' });
    return false;
  }
  const venvPython = resolve(ROOT, 'scripts', 'venv', 'bin', 'python3');
  const pythonBin = existsSync(venvPython) ? venvPython : 'python3';
  logger.info('Starting wake listener', { modelPath, scriptPath, pythonBin });
  try {
    const proc = spawn(pythonBin, [scriptPath, modelPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: ROOT
    });
    proc.stderr?.on('data', (d: Buffer) => logger.warn('Wake listener stderr', { msg: d.toString().trim() }));
    proc.on('error', (err) => {
      logger.warn('Wake listener process error', { error: String(err) });
      stopWakeListener(ws);
      send(ws, { type: 'error', message: 'Wake listener failed to start. Run: scripts/venv/bin/pip install openwakeword onnxruntime numpy (see models/wake/README.md)' });
    });
    proc.on('exit', (code) => {
      if (code != null && code !== 0) wakeStreamByWs.delete(ws);
    });
    let stdoutBuf = '';
    proc.stdout?.on('data', (d: Buffer) => {
      stdoutBuf += d.toString();
      const idx = stdoutBuf.indexOf('WAKE');
      if (idx !== -1) {
        stdoutBuf = stdoutBuf.slice(idx + 4);
        logger.info('Wake word detected');
        send(ws, { type: 'wake_detected', timestamp: Date.now() });
      }
    });
    wakeStreamByWs.set(ws, { proc, buffer: Buffer.alloc(0), chunksFed: 0 });
    return true;
  } catch (err) {
    send(ws, { type: 'error', message: err instanceof Error ? err.message : 'Wake listener failed' });
    return false;
  }
}

function feedWakePcm(ws: WebSocket, pcmBase64: string): void {
  const state = wakeStreamByWs.get(ws);
  if (!state || !state.proc.stdin?.writable) return;
  try {
    const chunk = Buffer.from(pcmBase64, 'base64');
    state.buffer = Buffer.concat([state.buffer, chunk]);
    while (state.buffer.length >= WAKE_CHUNK_BYTES) {
      const slice = state.buffer.subarray(0, WAKE_CHUNK_BYTES);
      state.buffer = state.buffer.subarray(WAKE_CHUNK_BYTES);
      state.proc.stdin.write(slice);
      state.chunksFed++;
      if (state.chunksFed === 1) logger.info('Wake PCM: first chunk received');
      else if (state.chunksFed % WAKE_LOG_CHUNK_INTERVAL === 0) logger.info('Wake PCM: chunks fed', { n: state.chunksFed });
    }
  } catch {
    // ignore bad base64
  }
}

function stopWakeListener(ws: WebSocket): void {
  const state = wakeStreamByWs.get(ws);
  if (state) {
    state.proc.kill('SIGTERM');
    wakeStreamByWs.delete(ws);
  }
}

export function getVoiceClients(): Set<WebSocket> {
  return voiceClients;
}

export function setupVoiceWebSocket(wss: WebSocketServer, app: ReturnType<typeof import('express')>): void {
  voiceClients = new Set<WebSocket>();

  wss.on('connection', (ws: WebSocket, _req: unknown) => {
    voiceClients.add(ws);
    logger.info('Voice client connected', { total: voiceClients.size });

    ws.on('message', async (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString()) as { type: string; audio?: string; text?: string; format?: string; pcm?: string };
        switch (message.type) {
          case 'ping':
            send(ws, { type: 'pong' });
            return;
          case 'wake_stream_start':
            logger.info('Wake stream start requested');
            if (startWakeListener(ws)) {
              logger.info('Wake listener started, sending wake_stream_ready');
              send(ws, { type: 'wake_stream_ready' });
            }
            return;
          case 'wake_stream_chunk':
            if (message.pcm) feedWakePcm(ws, message.pcm);
            return;
          case 'wake_stream_stop':
            stopWakeListener(ws);
            logger.info('Wake stream stop');
            return;
          case 'text_command': {
            const text = (message.text ?? '').trim();
            if (!text) {
              send(ws, { type: 'error', message: 'text_command requires text' });
              return;
            }
            logger.info('Voice text_command received', { text: text.slice(0, 80), len: text.length });
            await handleTextCommand(ws, text);
            return;
          }
          case 'audio_command': {
            const b64 = message.audio;
            const format = (message.format as string) || 'wav';
            if (!b64) {
              send(ws, { type: 'error', message: 'audio_command requires audio (base64)' });
              return;
            }
            let buffer: Buffer;
            try {
              buffer = Buffer.from(b64, 'base64');
            } catch {
              send(ws, { type: 'error', message: 'Invalid base64 audio' });
              return;
            }
            logger.info('Voice audio_command received', { bytes: buffer.length });
            if (format !== 'wav') {
              send(ws, { type: 'error', message: 'Only WAV audio is supported. Record as WAV in the client.' });
              return;
            }
            await handleAudioCommand(ws, buffer);
            return;
          }
          default:
            send(ws, { type: 'error', message: `Unknown message type: ${message.type}` });
        }
      } catch (err) {
        logger.error('Voice message error', { error: String(err) });
        send(ws, { type: 'error', message: err instanceof Error ? err.message : 'Processing failed' });
      }
    });

    ws.on('close', () => {
      stopWakeListener(ws);
      voiceClients.delete(ws);
      logger.info('Voice client disconnected', { total: voiceClients.size });
    });

    ws.on('error', () => {
      voiceClients.delete(ws);
    });

    // Send initial dashboard state
    getDashboardStatus()
      .then((status) => send(ws, { type: 'dashboard_update', data: status }))
      .catch(() => send(ws, { type: 'dashboard_update', data: { error: 'Homelab unavailable' } }));
  });

  // REST routes
  app.get('/api/voice/health', async (_req: Request, res: Response) => {
    try {
      const [piperOk, whisperOk] = await Promise.all([piperAvailable(), whisperAvailable()]);
      const wakePath = config.voice?.wakeModelPath ?? '';
      const wakeModel = !!wakePath && existsSync(wakePath);
      res.json({
        whisper: whisperOk ? 'online' : 'offline',
        piper: piperOk ? 'online' : 'offline',
        wakeModel,
      });
    } catch {
      res.json({ whisper: 'offline', piper: 'offline', wakeModel: false });
    }
  });

  app.get('/api/voice/wake-model', (_req: Request, res: Response) => {
    const path = config.voice?.wakeModelPath ?? '';
    if (!path || !existsSync(path)) {
      res.status(404).json({ error: 'Wake model not found' });
      return;
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    createReadStream(path).pipe(res);
  });

  const WAKE_TEST_THRESHOLD = 0.5; // match wake_listener.py
  app.post('/api/voice/test-wake', (req: Request, res: Response) => {
    const modelPath = config.voice?.wakeModelPath ?? '';
    if (!modelPath || !existsSync(modelPath)) {
      res.status(400).json({ error: 'Wake model not found' });
      return;
    }
    const pcmBase64 = typeof req.body?.pcm === 'string' ? req.body.pcm : '';
    if (!pcmBase64) {
      res.status(400).json({ error: 'Body must include { pcm: "<base64>" }' });
      return;
    }
    let buffer: Buffer;
    try {
      buffer = Buffer.from(pcmBase64, 'base64');
    } catch {
      res.status(400).json({ error: 'Invalid base64 pcm' });
      return;
    }
    const scriptPath = resolve(ROOT, 'scripts', 'wake_score_stdin.py');
    if (!existsSync(scriptPath)) {
      res.status(500).json({ error: 'wake_score_stdin.py not found' });
      return;
    }
    const venvPython = resolve(ROOT, 'scripts', 'venv', 'bin', 'python3');
    const pythonBin = existsSync(venvPython) ? venvPython : 'python3';
    const proc = spawn(pythonBin, [scriptPath, modelPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: ROOT,
      env: { ...process.env, ORT_EXECUTION_PROVIDERS: 'CPUExecutionProvider' }
    });
    let stdout = '';
    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on('data', () => {});
    proc.stdin?.end(buffer);
    proc.on('close', (code) => {
      const m = stdout.match(/MAX\s+([\d.]+)/);
      const maxScore = m ? parseFloat(m[1]) : 0;
      const wakeDetected = maxScore >= WAKE_TEST_THRESHOLD;
      res.json({ wakeDetected, maxScore, threshold: WAKE_TEST_THRESHOLD });
    });
    proc.on('error', (err) => {
      logger.warn('test-wake spawn error', { error: String(err) });
      res.status(500).json({ error: 'Wake test failed' });
    });
  });

  app.get('/api/voice/dashboard', async (_req: Request, res: Response) => {
    try {
      const status = await getDashboardStatus();
      res.json(status);
    } catch {
      res.json({ error: 'Homelab unavailable' });
    }
  });

  app.post('/api/voice/speak', async (req: Request, res: Response) => {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) {
      res.status(400).json({ error: 'Body must include { text: "..." }' });
      return;
    }
    try {
      const speakable = speakableForVoice(text);
      const wav = await synthesize(speakable);
      res.json({ audio: wav.toString('base64'), audioFormat: 'wav' });
    } catch (err) {
      logger.warn('Voice speak API failed', { error: String(err) });
      res.status(500).json({ error: err instanceof Error ? err.message : 'TTS failed' });
    }
  });

  app.get('/voice/test', (_req: Request, res: Response) => {
    res.sendFile(resolve(ROOT, 'web', 'voice-test.html'));
  });

  logger.info('Voice WebSocket and REST routes attached');
}

/** Return true if WAV PCM (after 44-byte header) is effectively silent. */
function isWavSilent(wav: Buffer): boolean {
  if (wav.length <= 46) return true;
  const pcm = wav.subarray(44);
  let sum = 0;
  let n = 0;
  const step = Math.max(2, Math.floor(pcm.length / 2000));
  for (let i = 0; i + 2 <= pcm.length; i += step) {
    sum += pcm.readInt16LE(i) * pcm.readInt16LE(i);
    n++;
  }
  const rms = n > 0 ? Math.sqrt(sum / n) / 32768 : 0;
  return rms < 0.002;
}

async function handleAudioCommand(ws: WebSocket, audioBuffer: Buffer): Promise<void> {
  const startTime = Date.now();
  const minWavBytes = 44 + 16000 * 0.5 * 2; // 0.5s of 16kHz mono 16-bit
  if (audioBuffer.length < minWavBytes) {
    logger.info('Voice audio too short, skipping STT', { bytes: audioBuffer.length, min: minWavBytes });
    send(ws, {
      type: 'voice_response',
      text: "Recording was too short. Hold the button for at least a second while speaking.",
      speakable: "Recording too short. Try again.",
      audio: '',
      audioFormat: 'wav',
      transcript: '',
      elapsed: Date.now() - startTime,
    });
    return;
  }
  if (isWavSilent(audioBuffer)) {
    logger.info('Voice audio silent (RMS check), skipping STT', { bytes: audioBuffer.length });
    send(ws, {
      type: 'voice_response',
      text: "The recording was silent. Check that your microphone is the correct device and not muted.",
      speakable: "Recording was silent. Check your mic.",
      audio: '',
      audioFormat: 'wav',
      transcript: '',
      elapsed: Date.now() - startTime,
    });
    return;
  }
  send(ws, { type: 'status', state: 'processing', stage: 'transcribing' });

  let transcript: string;
  try {
    transcript = await transcribe(audioBuffer);
  } catch (err) {
    logger.warn('Voice transcribe failed', { error: String(err) });
    send(ws, { type: 'error', message: err instanceof Error ? err.message : 'Transcription failed' });
    return;
  }
  logger.info('Voice transcript from Whisper', { transcript: transcript.slice(0, 80), len: transcript.length });
  send(ws, { type: 'transcript', text: transcript });

  const noSpeech = !transcript || /^\(no speech detected\)$/i.test(transcript.trim());
  if (noSpeech) {
    logger.info('Voice no-speech from Whisper, not calling Jeeves', { transcript: transcript.slice(0, 40) });
    send(ws, {
      type: 'voice_response',
      text: "I didn't hear anything. Try holding the button a bit longer and speaking clearly.",
      speakable: "I didn't hear anything. Try again.",
      audio: '',
      audioFormat: 'wav',
      transcript,
      elapsed: Date.now() - startTime,
    });
    return;
  }

  send(ws, { type: 'status', state: 'processing', stage: 'thinking' });
  logger.info('Voice running Jeeves (audio path)', { input: transcript.slice(0, 60) });
  const reply = await runJeeves(transcript);
  send(ws, { type: 'status', state: 'processing', stage: 'speaking' });

  let audioBase64: string;
  try {
    const speakable = shortenForTTS(reply);
    const wav = await synthesize(speakable);
    audioBase64 = wav.toString('base64');
  } catch (err) {
    send(ws, { type: 'error', message: err instanceof Error ? err.message : 'TTS failed' });
    return;
  }

  const elapsed = Date.now() - startTime;
  send(ws, {
    type: 'voice_response',
    text: reply,
    speakable: shortenForTTS(reply),
    audio: audioBase64,
    audioFormat: 'wav',
    transcript,
    elapsed,
  });
}

async function handleTextCommand(ws: WebSocket, text: string): Promise<void> {
  const startTime = Date.now();
  send(ws, { type: 'status', state: 'processing', stage: 'thinking' });
  logger.info('Voice running Jeeves (text path)', { input: text.slice(0, 60) });
  const reply = await runJeeves(text);
  logger.info('Voice got reply, sending text immediately', { replyLen: reply.length });

  // Send text immediately so UI shows the answer (don't block on TTS)
  const elapsed = Date.now() - startTime;
  send(ws, {
    type: 'voice_response',
    text: reply,
    speakable: shortenForTTS(reply),
    audio: '',
    audioFormat: 'wav',
    elapsed,
  });

  // TTS in background; use short phrase for long replies so voice returns quickly
  (async () => {
    const speakable = speakableForVoice(reply);
    logger.info('Voice TTS started', { speakableLen: speakable.length });
    try {
      const wav = await synthesize(speakable);
      if (ws.readyState === 1 && wav && wav.length > 0) {
        send(ws, { type: 'voice_audio', audio: wav.toString('base64'), audioFormat: 'wav' });
        logger.info('Voice TTS sent', { bytes: wav.length });
      }
    } catch (err) {
      logger.warn('Voice TTS failed (text already sent)', { error: String(err) });
    }
  })();
}

async function runJeeves(content: string): Promise<string> {
  const message: IncomingMessage = {
    id: randomUUID(),
    sender: 'tablet',
    content,
    timestamp: new Date(),
    interface: 'voice',
  };
  const response = await handleMessage(message);
  return response?.content?.trim() ?? 'I didn\'t catch that.';
}

/** Broadcast a notification to all connected voice/tablet clients. */
export function broadcastVoiceNotification(payload: { priority?: string; title?: string; message?: string; speakable?: string }): void {
  const data = JSON.stringify({ type: 'notification', ...payload, timestamp: Date.now() });
  for (const ws of voiceClients) {
    if (ws.readyState === 1) {
      try {
        ws.send(data);
      } catch {
        // ignore
      }
    }
  }
}
