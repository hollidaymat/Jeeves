#!/usr/bin/env python3
"""Read 16kHz 16-bit LE mono PCM from stdin; print MAX <score> for wake model. Used by server."""
import os
import sys

os.environ.setdefault("ORT_EXECUTION_PROVIDERS", "CPUExecutionProvider")
import warnings
warnings.filterwarnings("ignore", message=".*Specified provider.*")

import numpy as np
from openwakeword.model import Model

def main():
    model_path = sys.argv[1] if len(sys.argv) > 1 else None
    if not model_path:
        print("MAX 0.0", flush=True)
        sys.exit(1)
    try:
        model = Model([model_path])
    except Exception:
        print("MAX 0.0", flush=True)
        sys.exit(1)
    model_name = list(model.models.keys())[0]
    chunk_bytes = 2560
    max_score = 0.0
    while True:
        raw = sys.stdin.buffer.read(chunk_bytes)
        if not raw or len(raw) < chunk_bytes:
            break
        samples = np.frombuffer(raw, dtype=np.int16)
        if len(samples) != 1280:
            continue
        samples_f = samples.astype(np.float32) / 32768.0
        pred = model.predict(samples_f)
        score = pred.get(model_name, 0.0)
        if score > max_score:
            max_score = score
    print(f"MAX {max_score}", flush=True)

if __name__ == "__main__":
    main()
