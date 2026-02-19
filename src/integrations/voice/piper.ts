/**
 * Piper TTS client. Supports:
 * - Wyoming protocol over TCP (default for port 10200): connect, send synthesize with text, read audio-start/chunk/stop, return WAV.
 * - HTTP API: POST /api/text-to-speech with JSON { text }, returns WAV.
 */

import * as net from 'net';
import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';

const PIPER_MAX_CHARS = 500; // Shorten for voice
const DEFAULT_PIPER_URL = 'http://127.0.0.1:10200';

function parsePiperUrl(url: string): { host: string; port: number } | null {
  try {
    const u = new URL(url);
    const port = u.port ? parseInt(u.port, 10) : 10200;
    if (u.pathname && u.pathname !== '/' && u.pathname !== '') return null;
    return { host: u.hostname, port: Number.isFinite(port) ? port : 10200 };
  } catch {
    return null;
  }
}

/** Wyoming: one JSONL message. Header line \n, then optional payload. */
function writeWyomingMessage(socket: net.Socket, type: string, data: Record<string, unknown>, payload?: Buffer): void {
  const payloadLength = payload ? payload.length : 0;
  const header = { type, data, ...(payloadLength > 0 && { payload_length: payloadLength }) };
  socket.write(JSON.stringify(header) + '\n');
  if (payload && payload.length > 0) socket.write(payload);
}

/** Persistent buffer for Wyoming reads so we don't lose data between messages. */
type WyomingReadState = { buffer: Buffer };

/** Read one Wyoming message (header line + optional payload). Leaves leftover bytes in state.buffer. */
function readWyomingMessage(socket: net.Socket, state: WyomingReadState): Promise<{ type: string; data: Record<string, unknown>; payload?: Buffer }> {
  return new Promise((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      state.buffer = Buffer.concat([state.buffer, chunk]);
      const newline = state.buffer.indexOf('\n');
      if (newline === -1) return;
      const line = state.buffer.subarray(0, newline).toString('utf8');
      state.buffer = state.buffer.subarray(newline + 1);
      try {
        const header = JSON.parse(line) as { type: string; data?: Record<string, unknown>; data_length?: number; payload_length?: number };
        const dataLength = header.data_length ?? 0;
        const payloadLength = header.payload_length ?? 0;
        const need = dataLength + payloadLength;
        const consumed = need;
        const parseData = (): Record<string, unknown> => {
          if (dataLength <= 0) return header.data ?? {};
          try {
            const dataJson = state.buffer.subarray(0, dataLength).toString('utf8');
            return JSON.parse(dataJson) as Record<string, unknown>;
          } catch {
            return header.data ?? {};
          }
        };
        const finish = () => {
          socket.removeListener('data', onData);
          socket.removeListener('error', onErr);
          const data = parseData();
          const payload = payloadLength > 0 ? Buffer.from(state.buffer.subarray(dataLength, dataLength + payloadLength)) : undefined;
          state.buffer = state.buffer.subarray(consumed);
          resolve({
            type: header.type,
            data,
            ...(payload && { payload })
          });
        };
        if (state.buffer.length >= need) {
          finish();
          return;
        }
        socket.removeListener('data', onData);
        const onMore = (chunk: Buffer) => {
          state.buffer = Buffer.concat([state.buffer, chunk]);
          if (state.buffer.length >= need) {
            socket.removeListener('data', onMore);
            socket.removeListener('error', onErr);
            const data = parseData();
            const payload = payloadLength > 0 ? Buffer.from(state.buffer.subarray(dataLength, dataLength + payloadLength)) : undefined;
            state.buffer = state.buffer.subarray(consumed);
            resolve({
              type: header.type,
              data,
              ...(payload && { payload })
            });
          }
        };
        socket.on('data', onMore);
      } catch (e) {
        socket.removeListener('data', onData);
        socket.removeListener('error', onErr);
        reject(e);
      }
    };
    const onErr = (e: Error) => {
      socket.removeListener('data', onData);
      reject(e);
    };
    socket.on('data', onData);
    socket.on('error', onErr);
    // Process any data already in the buffer (e.g. from same TCP packet as previous message)
    if (state.buffer.length > 0) {
      onData(Buffer.alloc(0));
    }
  });
}

/** Build 16-bit mono WAV from PCM. */
function pcmToWav(pcm: Buffer, sampleRate: number, channels: number): Buffer {
  const dataLen = pcm.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataLen, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataLen, 40);
  return Buffer.concat([header, pcm]);
}

/** Synthesize via Wyoming protocol over TCP. */
async function synthesizeWyoming(text: string): Promise<Buffer> {
  const speakable = text.slice(0, PIPER_MAX_CHARS).trim() || 'Okay.';
  const baseUrl = config.voice?.piperUrl?.replace(/\/$/, '') || DEFAULT_PIPER_URL;
  const addr = parsePiperUrl(baseUrl);
  if (!addr) throw new Error(`Invalid PIPER_URL for Wyoming: ${baseUrl}`);

  // Don't send voice in the request — let Piper use its server default (--voice from container).
  // Sending voice: { name } can cause Piper to load a different voice and fail if not present.
  const synthesizeData: Record<string, unknown> = { text: speakable };

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(addr, () => {
      socket.removeAllListeners('error');
      socket.on('error', (e) => logger.warn('Piper Wyoming socket error', { error: String(e) }));

      writeWyomingMessage(socket, 'synthesize', synthesizeData);

      let rate = 22050;
      let width = 2;
      let channels = 1;
      const chunks: Buffer[] = [];
      const readState: WyomingReadState = { buffer: Buffer.alloc(0) };

      const readNext = (): Promise<void> => {
        return readWyomingMessage(socket, readState).then((msg) => {
          if (msg.type === 'audio-start') {
            logger.debug('Piper Wyoming audio-start', { rate: msg.data?.rate, channels: msg.data?.channels });
            rate = (msg.data?.rate as number) ?? 22050;
            width = (msg.data?.width as number) ?? 2;
            channels = (msg.data?.channels as number) ?? 1;
            return readNext();
          }
          if (msg.type === 'audio-chunk' && msg.payload && msg.payload.length > 0) {
            chunks.push(msg.payload);
            return readNext();
          }
          if (msg.type === 'audio-chunk') {
            return readNext();
          }
          if (msg.type === 'audio-stop') {
            socket.destroy();
            const pcm = Buffer.concat(chunks);
            logger.debug('Piper Wyoming audio-stop', { chunks: chunks.length, pcmBytes: pcm.length });
            if (pcm.length === 0) {
              reject(new Error('Piper returned no audio'));
              return;
            }
            resolve(pcmToWav(pcm, rate, channels));
            return;
          }
          if (msg.type === 'error') {
            const errText = (msg.data?.text as string) || (msg.data?.message as string) || 'Piper error';
            socket.destroy();
            reject(new Error(String(errText)));
            return;
          }
          logger.warn('Piper Wyoming unexpected message', { type: msg.type });
          return readNext();
        });
      };
      readNext().catch((e) => {
        socket.destroy();
        reject(e);
      });
    });
    socket.once('error', reject);
    socket.setTimeout(120000, () => {
      socket.destroy();
      reject(new Error('Piper Wyoming timeout'));
    });
  });
}

/** Synthesize via HTTP API (POST /api/text-to-speech). */
async function synthesizeHttp(text: string): Promise<Buffer> {
  const speakable = text.slice(0, PIPER_MAX_CHARS).trim() || 'Okay.';
  const baseUrl = config.voice?.piperUrl?.replace(/\/$/, '') || 'http://127.0.0.1:5000';
  const url = `${baseUrl}/api/text-to-speech`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: speakable }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Piper TTS ${res.status}: ${body || res.statusText}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

export async function synthesize(text: string): Promise<Buffer> {
  const baseUrl = config.voice?.piperUrl?.replace(/\/$/, '') || DEFAULT_PIPER_URL;
  const addr = parsePiperUrl(baseUrl);
  try {
    if (addr) {
      return await synthesizeWyoming(text);
    }
    return await synthesizeHttp(text);
  } catch (err) {
    logger.warn('Piper TTS failed', { error: String(err), url: baseUrl });
    throw err;
  }
}

export async function isAvailable(): Promise<boolean> {
  const baseUrl = config.voice?.piperUrl?.replace(/\/$/, '') || DEFAULT_PIPER_URL;
  const addr = parsePiperUrl(baseUrl);
  if (!addr) {
    try {
      const res = await fetch(`${baseUrl}/health`, { method: 'GET' });
      return res.ok;
    } catch {
      return false;
    }
  }
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection(addr, () => {
      writeWyomingMessage(socket, 'describe', {});
      readWyomingMessage(socket, { buffer: Buffer.alloc(0) })
        .then((msg) => {
          socket.destroy();
          resolve(msg.type === 'info');
        })
        .catch(() => {
          socket.destroy();
          resolve(false);
        });
    });
    socket.once('error', () => resolve(false));
    socket.setTimeout(3000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}
