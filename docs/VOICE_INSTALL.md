# Voice + Tablet Install (Finish Checklist)

Use this after the main Jeeves install. Covers wake word, voice stack, and verification.

---

## 1. Wake word: "Hey Jeeves"

- **Option A (recommended):** Use the web trainer.
  1. Go to **https://openwakeword.com** → **Start Training**.
  2. Phrase: **Hey Jeeves**.
  3. Generate samples → Train → Download ONNX.
  4. Save the file as:
     ```text
     signal-cursor-controller/models/wake/hey_jeeves.onnx
     ```
  5. See **models/wake/README.md** for more detail.

- **Option B:** Train via the OpenWakeWord Colab notebook (see same README).

- **Skip:** If you only want push-to-talk, leave this directory empty. The tablet and `/voice/test` will work without a wake word.

---

## 2. Voice stack (Piper TTS + Whisper STT)

Jeeves expects **HTTP** endpoints for Piper and Whisper. The Wyoming images use TCP by default; use one of these approaches.

### A. Use the provided stack (TCP; add HTTP if needed)

1. Copy the voice stack to your server:
   ```bash
   sudo mkdir -p /opt/stacks/voice
   sudo cp -r /home/jeeves/signal-cursor-controller/templates/stacks/voice/* /opt/stacks/voice/
   cd /opt/stacks/voice
   ```
2. Start the stack:
   ```bash
   docker compose up -d
   ```
3. If the images only expose Wyoming TCP, run an HTTP wrapper (or use images that expose HTTP) and set in **signal-cursor-controller/.env**:
   - `PIPER_URL=http://<host>:<port>` (e.g. Piper HTTP on 5000)
   - `WHISPER_URL=http://<host>:<port>` (e.g. your Whisper HTTP wrapper)

### B. Point at existing Piper/Whisper HTTP services

If you already run Piper and Whisper behind HTTP:

- In **signal-cursor-controller/.env** set:
  - `PIPER_URL=http://your-piper-host:port`
  - `WHISPER_URL=http://your-whisper-host:port`

---

## 3. .env (signal-cursor-controller)

In **signal-cursor-controller/.env** you should have:

```env
VOICE_ENABLED=true
PIPER_URL=http://127.0.0.1:10200
WHISPER_URL=http://127.0.0.1:10300
VOICE_WAKE_MODEL_PATH=/home/jeeves/signal-cursor-controller/models/wake/hey_jeeves.onnx
```

Adjust URLs if Piper/Whisper run on another host or port.

---

## 4. Restart Jeeves

```bash
cd /home/jeeves/signal-cursor-controller
npm run build
# Restart your process (e.g. systemd, pm2, or node dist/index.js)
```

---

## 5. Verify

1. **Health:**  
   `curl -s http://localhost:3847/api/voice/health`  
   Expect something like: `{"piper":"online"|"offline","whisper":"online"|"offline","wakeModel":true|false}`.

2. **Phase 0 test page:**  
   Open **http://\<jeeves-host\>:3847/voice/test** in a browser. Allow mic, use "Hold to talk", speak a command. You should see transcript and hear TTS (if Piper/Whisper are online).

3. **Tablet PWA:**  
   Open **http://\<jeeves-host\>:3847/tablet/** on a phone or tablet. Same host/port as the main Jeeves UI.

4. **Wake model (if installed):**  
   `curl -sI http://localhost:3847/api/voice/wake-model` should return 200 and binary content when `hey_jeeves.onnx` is in place.

---

## 6. Optional

- **Firewall:** If the tablet is on another subnet, allow the Jeeves port (e.g. 3847) from that network.
- **HTTPS:** If the main UI is HTTPS, use the same URL for the tablet (wss will be used automatically).
- **Chimes:** Add sound files under `web/audio/` and reference them in the tablet app for "listening" / "complete" chimes (see JEEVES_TABLET_VOICE_INTEGRATION.md).
