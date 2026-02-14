#!/usr/bin/env python3
"""
Server-side wake word listener for "Hey Jeeves".
Reads 16-bit PCM 16kHz mono from stdin in 1280-sample (80ms) chunks,
runs openWakeWord, prints WAKE to stdout when detected (debounced).

Usage:
  python3 scripts/wake_listener.py [path/to/hey_jeeves.onnx]
  Audio: stdin, raw PCM 16-bit LE, 16kHz, mono (2560 bytes = 1280 samples per chunk).

Requires: pip install openwakeword onnxruntime numpy
"""

import os
import sys
import time

# Prefer CPU to avoid CUDA provider warning when GPU not available
os.environ.setdefault("ORT_EXECUTION_PROVIDERS", "CPUExecutionProvider")
import warnings
warnings.filterwarnings("ignore", message=".*Specified provider.*is not in available provider names.*")

def main():
    model_path = sys.argv[1] if len(sys.argv) > 1 else None
    if not model_path:
        print("WAKE_LISTENER_ERROR: need model path (e.g. scripts/wake_listener.py models/wake/hey_jeeves.onnx)", file=sys.stderr)
        sys.exit(1)

    try:
        import numpy as np
        from openwakeword.model import Model
    except ImportError as e:
        print("WAKE_LISTENER_ERROR: install openwakeword and numpy: pip install openwakeword onnxruntime numpy", file=sys.stderr)
        sys.exit(1)

    try:
        # Model() passes **kwargs to AudioFeatures; installed AudioFeatures only accepts
        # melspec_onnx_model_path, embedding_onnx_model_path, sr, ncpu. So pass no kwargs.
        model = Model([model_path])
    except Exception as e:
        print(f"WAKE_LISTENER_ERROR: failed to load model: {e}", file=sys.stderr)
        sys.exit(1)

    # Model name is basename without extension
    model_name = "hey_jeeves"
    for name in model.models.keys():
        model_name = name
        break

    chunk_bytes = 2560  # 1280 samples * 2 bytes
    threshold = 0.5  # Must retrain model at openwakeword.com for "Hey Jeeves" to trigger; lower = false triggers
    debounce_seconds = 2.5
    last_wake = 0.0

    try:
        while True:
            raw = sys.stdin.buffer.read(chunk_bytes)
            if not raw or len(raw) < chunk_bytes:
                break
            samples = np.frombuffer(raw, dtype=np.int16)
            if len(samples) != 1280:
                continue
            # openWakeWord preprocessor may expect float32 [-1, 1]; convert if needed
            samples_f = samples.astype(np.float32) / 32768.0
            predictions = model.predict(samples_f)
            score = predictions.get(model_name, 0.0)
            if score >= threshold and (time.time() - last_wake) >= debounce_seconds:
                last_wake = time.time()
                print("WAKE", flush=True)
    except (BrokenPipeError, KeyboardInterrupt):
        pass
    except Exception as e:
        print(f"WAKE_LISTENER_ERROR: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
