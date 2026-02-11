#!/usr/bin/env node
/**
 * Test Piper Wyoming TCP: connect, send synthesize, read response.
 * Usage: node scripts/test-piper-wyoming.mjs [host] [port]
 * Default: 127.0.0.1 10200
 */
import net from 'net';

const host = process.argv[2] || '127.0.0.1';
const port = parseInt(process.argv[3] || '10200', 10);
const text = 'Test.';

function writeWyoming(socket, type, data) {
  socket.write(JSON.stringify({ type, data }) + '\n');
}

function readOneMessage(socket, state) {
  return new Promise((resolve, reject) => {
    const tryParse = () => {
      const newline = state.buf.indexOf('\n');
      if (newline === -1) return;
      const line = state.buf.subarray(0, newline).toString('utf8');
      state.buf = state.buf.subarray(newline + 1);
      let header;
      try {
        header = JSON.parse(line);
      } catch (e) {
        reject(e);
        return;
      }
      const dataLen = header.data_length ?? 0;
      const payloadLen = header.payload_length ?? 0;
      const need = dataLen + payloadLen;
      const finish = () => {
        socket.removeListener('data', onData);
        socket.removeListener('error', onErr);
        const data = dataLen > 0
          ? JSON.parse(state.buf.subarray(0, dataLen).toString('utf8'))
          : (header.data ?? {});
        const payload = payloadLen > 0 ? state.buf.subarray(dataLen, dataLen + payloadLen) : null;
        state.buf = state.buf.subarray(need);
        resolve({ type: header.type, data, payload });
      };
      if (state.buf.length >= need) {
        finish();
        return;
      }
      const onMore = (chunk) => {
        state.buf = Buffer.concat([state.buf, chunk]);
        if (state.buf.length >= need) {
          socket.removeListener('data', onMore);
          socket.removeListener('error', onErr);
          const data = dataLen > 0
            ? JSON.parse(state.buf.subarray(0, dataLen).toString('utf8'))
            : (header.data ?? {});
          const payload = payloadLen > 0 ? state.buf.subarray(dataLen, dataLen + payloadLen) : null;
          state.buf = state.buf.subarray(need);
          resolve({ type: header.type, data, payload });
        }
      };
      socket.removeListener('data', onData);
      socket.on('data', onMore);
    };
    const onData = (chunk) => {
      state.buf = Buffer.concat([state.buf, chunk]);
      tryParse();
    };
    const onErr = (e) => {
      socket.removeListener('data', onData);
      reject(e);
    };
    socket.on('data', onData);
    socket.on('error', onErr);
    tryParse();
  });
}

async function main() {
  console.log('Connecting to', host + ':' + port, '...');
  const socket = net.createConnection({ host, port }, async () => {
    console.log('Connected. Sending synthesize:', text);
    writeWyoming(socket, 'synthesize', { text });
    const state = { buf: Buffer.alloc(0) };
    let audioChunks = 0;
    let rate, width, channels;
    try {
      while (true) {
        const msg = await readOneMessage(socket, state);
        console.log('<-', msg.type, msg.data && Object.keys(msg.data).length ? JSON.stringify(msg.data).slice(0, 100) : '');
        if (msg.type === 'error') {
          console.error('Piper error:', msg.data?.text || msg.data?.message || msg.data);
          break;
        }
        if (msg.type === 'audio-start') {
          rate = msg.data?.rate;
          width = msg.data?.width;
          channels = msg.data?.channels;
        }
        if (msg.type === 'audio-chunk' && msg.payload) audioChunks++;
        if (msg.type === 'audio-stop') {
          console.log('OK: audio-stop, rate=%s width=%s channels=%s chunks=%d', rate, width, channels, audioChunks);
          break;
        }
      }
    } catch (e) {
      console.error('Error:', e.message);
    }
    socket.destroy();
    process.exit(0);
  });
  socket.on('error', (e) => {
    console.error('Socket error:', e.message);
    process.exit(1);
  });
  socket.setTimeout(15000, () => {
    console.error('Timeout 15s');
    socket.destroy();
    process.exit(1);
  });
}

main();
