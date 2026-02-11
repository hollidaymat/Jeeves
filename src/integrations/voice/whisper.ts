/**
 * Whisper STT client. Supports:
 * - Wyoming protocol over TCP (default for port 10300): connect, send WAV as PCM, read transcript.
 * - HTTP API: POST /api/speech-to-text with audio/wav, JSON { text }.
 */

import * as net from 'net';
import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';

const DEFAULT_WHISPER_URL = 'http://127.0.0.1:10300';

function parseWhisperUrl(url: string): { host: string; port: number } | null {
  try {
    const u = new URL(url);
    const port = u.port ? parseInt(u.port, 10) : 10300;
    return { host: u.hostname, port: Number.isFinite(port) ? port : 10300 };
  } catch {
    return null;
  }
}

/** Strip WAV header (44 bytes), return { sampleRate, channels, pcm } or null. */
function wavToPcm(wav: Buffer): { sampleRate: number; channels: number; pcm: Buffer } | null {
  if (wav.length < 44) return null;
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') return null;
  const channels = wav.readUInt16LE(22);
  const sampleRate = wav.readUInt32LE(24);
  const bitsPerSample = wav.readUInt16LE(34);
  if (bitsPerSample !== 16) return null;
  const dataOffset = 44;
  const pcm = wav.subarray(dataOffset);
  return { sampleRate, channels, pcm };
}

/** Wyoming: one JSONL message. Header line \n, then optional payload. */
function writeWyomingMessage(socket: net.Socket, type: string, data: Record<string, unknown>, payload?: Buffer): void {
  const payloadLength = payload ? payload.length : 0;
  const header = { type, data, ...(payloadLength > 0 && { payload_length: payloadLength }) };
  socket.write(JSON.stringify(header) + '\n');
  if (payload && payload.length > 0) socket.write(payload);
}

/** Read one Wyoming message (header line + optional payload). Resolves to { type, data, payload }. */
function readWyomingMessage(socket: net.Socket): Promise<{ type: string; data: Record<string, unknown>; payload?: Buffer }> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const line = buffer.subarray(0, newline).toString('utf8');
      buffer = buffer.subarray(newline + 1);
      try {
        const header = JSON.parse(line) as { type: string; data?: Record<string, unknown>; data_length?: number; payload_length?: number };
        const dataLength = header.data_length ?? 0;
        const payloadLength = header.payload_length ?? 0;
        const need = dataLength + payloadLength;
        const finish = () => {
          socket.removeListener('data', onData);
          socket.removeListener('error', onErr);
          resolve({
            type: header.type,
            data: header.data ?? {},
            ...(payloadLength > 0 && { payload: Buffer.from(buffer.subarray(dataLength, dataLength + payloadLength)) })
          });
        };
        if (buffer.length >= need) {
          finish();
          return;
        }
        socket.removeListener('data', onData);
        const onMore = (chunk: Buffer) => {
          buffer = Buffer.concat([buffer, chunk]);
          if (buffer.length >= need) {
            socket.removeListener('data', onMore);
            socket.removeListener('error', onErr);
            resolve({
              type: header.type,
              data: header.data ?? {},
              ...(payloadLength > 0 && { payload: Buffer.from(buffer.subarray(dataLength, dataLength + payloadLength)) })
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
  });
}

/** Transcribe via Wyoming protocol over TCP. */
async function transcribeWyoming(audioBuffer: Buffer): Promise<string> {
  const parsed = wavToPcm(audioBuffer);
  if (!parsed) throw new Error('Invalid WAV: need 16-bit PCM');
  const { sampleRate, channels, pcm } = parsed;
  const width = 2;

  const url = config.voice?.whisperUrl?.replace(/\/$/, '') || DEFAULT_WHISPER_URL;
  const addr = parseWhisperUrl(url);
  if (!addr) throw new Error(`Invalid WHISPER_URL: ${url}`);

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(addr, () => {
      socket.removeAllListeners('error');
      socket.on('error', (e) => logger.warn('Whisper Wyoming socket error', { error: String(e) }));

      writeWyomingMessage(socket, 'transcribe', {});
      writeWyomingMessage(socket, 'audio-start', { rate: sampleRate, width, channels });
      writeWyomingMessage(socket, 'audio-chunk', { rate: sampleRate, width, channels }, pcm);
      writeWyomingMessage(socket, 'audio-stop', {});

      const readUntilTranscript = (): Promise<void> => {
        return readWyomingMessage(socket).then((msg) => {
          if (msg.type === 'transcript') {
            const text = (msg.data?.text as string) ?? '';
            socket.destroy();
            resolve((text as string).trim() || '(no speech detected)');
          } else {
            return readUntilTranscript();
          }
        });
      };
      readUntilTranscript().catch((e) => {
        socket.destroy();
        reject(e);
      });
    });
    socket.once('error', reject);
    socket.setTimeout(30000, () => {
      socket.destroy();
      reject(new Error('Whisper Wyoming timeout'));
    });
  });
}

/** Transcribe via HTTP API (POST /api/speech-to-text). */
async function transcribeHttp(audioBuffer: Buffer): Promise<string> {
  const baseUrl = config.voice?.whisperUrl?.replace(/\/$/, '') || DEFAULT_WHISPER_URL;
  const url = `${baseUrl}/api/speech-to-text`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'audio/wav' },
    body: audioBuffer,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Whisper STT ${res.status}: ${body || res.statusText}`);
  }
  const data = (await res.json()) as { text?: string };
  const text = (data.text ?? '').trim();
  return text || '(no speech detected)';
}

export async function transcribe(audioBuffer: Buffer): Promise<string> {
  const url = config.voice?.whisperUrl?.replace(/\/$/, '') || DEFAULT_WHISPER_URL;
  const addr = parseWhisperUrl(url);

  try {
    if (addr) {
      return await transcribeWyoming(audioBuffer);
    }
    return await transcribeHttp(audioBuffer);
  } catch (err) {
    logger.warn('Whisper STT failed', { error: String(err), url });
    throw err;
  }
}

export async function isAvailable(): Promise<boolean> {
  const url = config.voice?.whisperUrl?.replace(/\/$/, '') || DEFAULT_WHISPER_URL;
  const addr = parseWhisperUrl(url);
  if (!addr) {
    try {
      const res = await fetch(`${url}/health`, { method: 'GET' });
      return res.ok;
    } catch {
      return false;
    }
  }
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection(addr, () => {
      writeWyomingMessage(socket, 'describe', {});
      readWyomingMessage(socket)
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
