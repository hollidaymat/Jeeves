# Hey Jeeves – Fix and Test Plan

## Goal
Get server-side "Hey Jeeves" wake-word detection working end-to-end: browser streams 16 kHz PCM → server runs `scripts/wake_listener.py` → on detection server sends `wake_detected` → client records ~4 s and sends as `audio_command`.

## Current Flow (reference)
1. **Client:** User enables "Listen for Hey Jeeves" in voice panel → sends `wake_stream_start` on voice WebSocket.
2. **Server:** On `wake_stream_start`, spawns `scripts/wake_listener.py` with `models/wake/hey_jeeves.onnx`, sends `wake_stream_ready` if successful.
3. **Client:** On `wake_stream_ready`, starts `VoiceWakeStream` (mic → 16 kHz PCM, 1280-sample chunks), sends `wake_stream_chunk` (base64 PCM).
4. **Server:** Buffers chunks to 2560-byte blocks, pipes to Python stdin. When Python prints `WAKE`, sends `wake_detected`.
5. **Client:** On `wake_detected`, records ~4 s, sends `audio_command` (WAV).

## Diagnosis (why it didn’t work)
- **No server logging** for the wake path: we can’t see if `wake_stream_start` is received, if the model/script/venv are found, or if the Python process fails.
- **Unclear failure point:** Could be (a) client never sends `wake_stream_start`, (b) server rejects (model/script/venv missing), (c) Python fails to load or run, (d) model never fires (audio format/threshold), (e) client doesn’t handle `wake_detected` or mic fails.

## Plan

### Phase 1: Observability
1. **Server (voice-server.ts)**  
   - Log when `wake_stream_start` is received.  
   - In `startWakeListener`: log model path, script path, python binary, and whether spawn succeeded or which check failed (no model, no script, no venv).  
   - Log Python stderr lines (already partially there; ensure they’re visible at INFO or WARN).  
   - Optionally log `wake_stream_stop` and `wake_detected` for trace.

2. **Client (optional debug)**  
   - In development, optional console.log when "Listen for Hey Jeeves" is toggled on and when `wake_stream_start` is sent; when `wake_stream_ready` or wake-related `error` is received. (Can be behind a flag or only in dev.)

### Phase 2: Standalone test (no browser)
3. **Script: `scripts/test-wake-stream.mjs`**  
   - Connect to `ws://host:port/voice` (reuse .env loading from `voice-test-ws.mjs`).  
   - Send `wake_stream_start`.  
   - Expect either `wake_stream_ready` or `error` (with message).  
   - If `wake_stream_ready`: send a few seconds of `wake_stream_chunk` (base64-encoded 2560-byte silent PCM, 16-bit LE 16 kHz mono) in a loop (e.g. 50 chunks = 4 s).  
   - Optionally listen for `wake_detected` (would require real “Hey Jeeves” PCM to trigger).  
   - Exit with 0 if `wake_stream_ready` received, non-zero on error or timeout.  
   - This verifies: server receives wake message, finds model/script/venv, spawns Python, and accepts PCM without crashing.

### Phase 3: Python / model sanity check
4. **Run wake_listener.py by hand**  
   - `echo -n '' | scripts/venv/bin/python3 scripts/wake_listener.py models/wake/hey_jeeves.onnx` (or pipe 10×2560 bytes of silence).  
   - Should not print `WAKE` (silence); should exit 0 when stdin closes.  
   - If it prints `WAKE_LISTENER_ERROR`, fix venv/deps or model path.

5. **Optional: trigger with real audio**  
   - Record “Hey Jeeves” as 16 kHz mono 16-bit PCM (e.g. with sox/ffmpeg), pipe 2560-byte chunks into the script; confirm it prints `WAKE` once.  
   - Validates model and threshold.

### Phase 4: Browser/client checks
6. **UI**  
   - Confirm voice panel is visible (VOICE_ENABLED=true and status reports voice.enabled).  
   - Confirm “Listen for Hey Jeeves” checkbox is present and that toggling it sends `wake_stream_start` (observable via server logs after Phase 1).  
   - If server sends `error`, client should uncheck and show message (already implemented).

7. **Mic / sample rate**  
   - Client already resamples to 16 kHz when browser uses a different rate.  
   - If detection is flaky, consider logging actual `AudioContext.sampleRate` once when starting the wake stream (optional).

### Phase 5: End-to-end test
8. **Manual E2E**  
   - Enable "Listen for Hey Jeeves", allow mic, say “Hey Jeeves” clearly.  
   - Expect: status → “LISTENING…”, then recording, then “THINKING…” and a voice response.  
   - Watch `journalctl -u jeeves -f` for new wake logs and any Python stderr.

## Verification checklist (server)
- [ ] `VOICE_ENABLED=true` in `.env`.
- [ ] `models/wake/hey_jeeves.onnx` exists.
- [ ] `scripts/wake_listener.py` exists.
- [ ] `scripts/venv/bin/python3` exists and `scripts/venv/bin/pip install openwakeword onnxruntime numpy` has been run.
- [ ] `node scripts/test-wake-stream.mjs` gets `wake_stream_ready` (and no error).

## Files to touch
| File | Change |
|------|--------|
| `src/integrations/voice/voice-server.ts` | Add INFO/WARN logs for wake_stream_start, startWakeListener (paths, spawn), wake_detected, wake_stream_stop. |
| `scripts/test-wake-stream.mjs` | New script: WS connect, wake_stream_start, expect wake_stream_ready, send silent PCM chunks, exit. |
| `web/app.js` | Optional: console.debug when wake toggle on and wake_stream_start sent (or when wake_stream_ready/error). |
| `docs/hey-jeeves-fix-plan.md` | This plan. |

## Success criteria
- `journalctl -u jeeves -f` shows a log line when the user enables Hey Jeeves (wake_stream_start received) and either “Wake listener started” or a clear error (model/script/venv).
- `node scripts/test-wake-stream.mjs` exits 0 and logs “wake_stream_ready”.
- In the browser, enabling Hey Jeeves and saying “Hey Jeeves” leads to recording and a voice response (or a clear client/server error message).
