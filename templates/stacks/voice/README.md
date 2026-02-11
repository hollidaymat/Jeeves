# Voice Stack (Piper TTS + Whisper STT)

Used by the Jeeves tablet/voice integration for local speech-to-text and text-to-speech. No cloud dependencies.

## Services

| Service     | Port  | Protocol | Notes |
|------------|-------|----------|--------|
| Piper TTS  | 10200 | Wyoming TCP | Some images also expose HTTP on 5000 |
| Whisper STT| 10300 | Wyoming TCP | Speech-to-text |

## Model choices

**Piper voices** (set in `command: --voice ...` and optionally `PIPER_VOICE` in Jeeves `.env`):

- `en_GB-alan-medium` – British male (default for Jeeves; Hugh Laurie–style)
- `en_GB-northern_english_male-medium` – British male, Northern
- `en_GB-alba-medium` – British female
- `en_US-lessac-medium` – US, good balance
- `en_US-ryan-medium` – US male

**Whisper models** (set in `command: --model ...`):

- `tiny.en` – Fast, lower accuracy
- `base.en` – Good for commands (default)
- `small.en` – Better accuracy, more RAM

## Deploy

1. Copy this folder to your host (e.g. `/opt/stacks/voice/`).
2. Run: `docker compose up -d`.
3. In Jeeves `.env` set (if using same host):
   - `VOICE_ENABLED=true`
   - `PIPER_URL=http://127.0.0.1:5000` (or `http://127.0.0.1:10200` if your client uses Wyoming)
   - `WHISPER_URL=http://127.0.0.1:10300`
4. If Piper/Whisper only expose Wyoming TCP (no HTTP), use a Wyoming-to-HTTP proxy or point Jeeves at an HTTP wrapper; see [JEEVES_TABLET_VOICE_INTEGRATION.md](../../../docs/JEEVES_TABLET_VOICE_INTEGRATION.md).

## Health

- Piper: `curl -s http://localhost:5000/health` (if HTTP is available).
- Whisper: Wyoming TCP on 10300; no HTTP by default.
