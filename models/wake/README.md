# Wake word: Hey Jeeves

Place your trained **hey_jeeves.onnx** in this folder. Jeeves serves it at GET /api/voice/wake-model for the tablet.

**Why isn’t “Hey Jeeves” working?**  
The server only **serves** the ONNX file. Wake word detection has to run **in the browser**: the page must download the model, stream the microphone through it, and when the score passes a threshold, start recording. Right now the tablet and main UI use **push-to-talk only** (Hold to Talk); no client script runs the wake model yet.

To add “Hey Jeeves” later you’d need a browser script that: (1) fetches `/api/voice/wake-model`, (2) runs it with ONNX Runtime Web, and (3) feeds it the same **preprocessed** audio the Python openWakeWord pipeline uses (mel spectrogram from 16 kHz mono, 1280-sample frames). The ONNX model expects those features, not raw PCM, so the preprocessor logic would need to be reimplemented in JS or the model exported with preprocessing baked in.

## Train with OpenWakeWord (easiest)

1. Go to https://openwakeword.com
2. Click Start Training
3. Enter phrase: **Hey Jeeves**
4. Generate samples (variations, accents, backgrounds)
5. Train (cloud, about 10–45 min)
6. Download the ONNX file
7. Rename to **hey_jeeves.onnx** and copy here

No account required for one-off training.

## Train locally (Colab)

Open the notebook:  
https://github.com/dscripka/openWakeWord/blob/main/notebooks/training_models.ipynb  

Open in Google Colab and follow the steps. Replace the example phrase with "Hey Jeeves" (generate positive clips with TTS or recordings). Export ONNX and save as hey_jeeves.onnx here.

## Server-side "Hey Jeeves" (Phase 4)

The server can run wake word detection in Python so the browser doesn’t need to run the ONNX model. Use a **virtual environment** so you don’t hit Ubuntu’s “externally-managed-environment” block on `pip install`:

1. **Create a venv and install deps** (from the repo root):
   ```bash
   python3 -m venv scripts/venv
   scripts/venv/bin/pip install openwakeword onnxruntime numpy
   ```
   Jeeves will use `scripts/venv/bin/python3` to run `scripts/wake_listener.py` when that path exists; otherwise it falls back to system `python3`. The listener calls `Model([model_path])` with no extra kwargs so the installed `AudioFeatures` (which only accepts melspec/embedding paths, `sr`, `ncpu`) is not given `inference_framework` or `wakeword_models`. If you see those errors, ensure you’re on the script from this repo; pinning `openwakeword==0.5.0` often fails on Linux (no `tflite-runtime` wheel).

2. **Enable voice** in `.env`: `VOICE_ENABLED=true`, and ensure `hey_jeeves.onnx` is in this folder (or set `VOICE_WAKE_MODEL_PATH`).
3. In the **main web UI** (or tablet), turn on **Listen for "Hey Jeeves"**. The browser streams 16 kHz PCM to the server; Node spawns `scripts/wake_listener.py` and pipes audio into it. When the Python process prints `WAKE`, the server sends `wake_detected` to the client, which then records ~4 s and sends it as a voice command.

No browser-side ONNX or mel preprocessing is required.

## Without a wake model

If you leave this folder empty, the tablet and /voice/test still work with push-to-talk only.
