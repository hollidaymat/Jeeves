# Jeeves Tablet + Voice Integration

## Overview

Turn a tablet into Jeeves' physical interface. Wall-mounted or handheld, always listening
on local WiFi, voice in/out, visual dashboard. No cloud dependencies. No Alexa.

## Architecture

```
TABLET (Android/iPad, local WiFi)
├── Browser (fullscreen PWA)
│   ├── OpenWakeWord (in-browser, ONNX model, "Hey Jeeves")
│   ├── Web Speech API / Whisper.cpp WASM (speech-to-text)
│   ├── Jeeves Dashboard UI (status, controls, conversation)
│   └── Audio playback (TTS responses from Daemon)
│
└── Microphone + Speaker (built-in hardware)
         │
         │  WebSocket (persistent connection)
         │
         ▼
DAEMON (192.168.1.50)
├── Jeeves Core (existing command parser + cognitive engine)
├── Piper TTS (local text-to-speech, Docker container)
├── Whisper.cpp (local speech-to-text, Docker container)
└── WebSocket Server (real-time bidirectional comms)
```

## Data Flow

```
1. WAKE WORD DETECTION (runs on tablet, in browser)
   Tablet mic → OpenWakeWord ONNX model → detects "Hey Jeeves"
   Cost: 0 (runs locally in browser, sub-100KB model)
   Latency: <200ms detection

2. AUDIO CAPTURE (runs on tablet)
   After wake word → record audio until silence detected (1.5s pause)
   Send raw PCM audio to Daemon via WebSocket

3. SPEECH-TO-TEXT (runs on Daemon)
   Daemon receives audio buffer
   → Whisper.cpp transcribes to text
   Latency: 1-3 seconds for typical command

4. COMMAND PROCESSING (runs on Daemon, existing Jeeves pipeline)
   Text → Registry match / Fuzzy match / Cognitive path
   → Execute command
   → Generate text response

5. TEXT-TO-SPEECH (runs on Daemon)
   Text response → Piper TTS → WAV audio buffer
   Send WAV back to tablet via WebSocket
   Latency: <1 second for typical response

6. PLAYBACK + DISPLAY (runs on tablet)
   Play WAV through tablet speaker
   Update dashboard UI with response text + any data
```

## Total round-trip target: < 5 seconds (wake word to voice response)

---

## Component 1: OpenWakeWord Custom Model

### Train the wake word

Go to https://openwakeword.com
- Wake phrase: "Hey Jeeves"
- Generate samples (thousands of variations, accents, backgrounds)
- Train model (~45 min)
- Download ONNX file (~50-100KB)

### Alternative: Train locally via Google Colab

Use the openWakeWord training notebook:
https://github.com/dscripka/openWakeWord/tree/main/notebooks

### Output

File: `hey_jeeves.onnx` (~50-100KB)
Place at: `/home/jeeves/models/wake/hey_jeeves.onnx`
Also serve via: `GET /api/voice/wake-model` (tablet downloads on load)

---

## Component 2: Daemon Voice Services (Docker)

### Piper TTS Container

```yaml
# Add to /opt/stacks/voice/docker-compose.yml

services:
  piper-tts:
    image: rhasspy/piper:latest
    container_name: piper-tts
    restart: unless-stopped
    ports:
      - "10200:10200"
    volumes:
      - /home/jeeves/models/tts:/data/models
    command: >
      --voice en_US-lessac-medium
      --length-scale 0.95
      --sentence-silence 0.3
    networks:
      - jeeves

  whisper-stt:
    image: rhasspy/wyoming-whisper:latest
    container_name: whisper-stt
    restart: unless-stopped
    ports:
      - "10300:10300"
    volumes:
      - /home/jeeves/models/stt:/data
    command: >
      --model base.en
      --language en
      --beam-size 1
    networks:
      - jeeves

networks:
  jeeves:
    external: true
```

### Voice model selection

| Piper Voice | Quality | Speed | Size | Notes |
|-------------|---------|-------|------|-------|
| en_US-lessac-medium | Good | Fast | 75MB | Best balance for Daemon hardware |
| en_US-lessac-high | Better | Slower | 150MB | If N150 can handle it |
| en_US-ryan-medium | Good | Fast | 75MB | Male voice alternative |
| en_GB-alba-medium | Good | Fast | 75MB | British accent (fits Jeeves persona) |

Recommendation: Start with `en_GB-alba-medium` for British Jeeves persona.
Fall back to `en_US-lessac-medium` if quality is poor.

### Whisper model selection

| Model | Size | VRAM | Speed | Accuracy |
|-------|------|------|-------|----------|
| tiny.en | 75MB | <1GB | Very fast | Decent for short commands |
| base.en | 150MB | <1GB | Fast | Good for commands |
| small.en | 500MB | ~2GB | Medium | Best accuracy |

Recommendation: `base.en` for N150 hardware. Upgrade to `small.en` if accuracy is poor.

---

## Component 3: Daemon Voice API

### WebSocket endpoint for voice

```javascript
// src/integrations/voice/websocket-handler.js

const WebSocket = require('ws');
const fs = require('fs');

class VoiceWebSocketHandler {
  constructor(jeevesCore, wss) {
    this.jeeves = jeevesCore;
    this.whisperUrl = 'http://whisper-stt:10300';
    this.piperUrl = 'http://piper-tts:10200';

    wss.on('connection', (ws) => this.handleConnection(ws));
  }

  handleConnection(ws) {
    console.log('[Voice] Tablet connected');

    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data);

        switch (message.type) {
          case 'audio_command':
            await this.handleAudioCommand(ws, message);
            break;
          case 'text_command':
            await this.handleTextCommand(ws, message);
            break;
          case 'ping':
            ws.send(JSON.stringify({ type: 'pong' }));
            break;
        }
      } catch (err) {
        console.error('[Voice] Error:', err.message);
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Processing failed',
          error: err.message
        }));
      }
    });

    ws.on('close', () => console.log('[Voice] Tablet disconnected'));

    // Send initial state on connect
    this.sendDashboardState(ws);
  }

  async handleAudioCommand(ws, message) {
    const startTime = Date.now();

    // 1. Acknowledge receipt
    ws.send(JSON.stringify({
      type: 'status',
      state: 'processing',
      stage: 'transcribing'
    }));

    // 2. Speech-to-text via Whisper
    const audioBuffer = Buffer.from(message.audio, 'base64');
    const transcript = await this.transcribe(audioBuffer);

    ws.send(JSON.stringify({
      type: 'transcript',
      text: transcript
    }));

    // 3. Process command through Jeeves core (existing pipeline)
    ws.send(JSON.stringify({
      type: 'status',
      state: 'processing',
      stage: 'thinking'
    }));

    const result = await this.jeeves.processCommand(transcript, {
      channel: 'voice',
      respondShort: true  // Voice responses should be concise
    });

    // 4. Text-to-speech via Piper
    ws.send(JSON.stringify({
      type: 'status',
      state: 'processing',
      stage: 'speaking'
    }));

    const audioResponse = await this.synthesize(result.speakable || result.text);

    // 5. Send response
    const elapsed = Date.now() - startTime;

    ws.send(JSON.stringify({
      type: 'voice_response',
      text: result.text,
      speakable: result.speakable || result.text,
      audio: audioResponse.toString('base64'),
      audioFormat: 'wav',
      data: result.data || null,
      elapsed: elapsed
    }));
  }

  async handleTextCommand(ws, message) {
    // Same as audio but skip transcription (typed command from tablet UI)
    const result = await this.jeeves.processCommand(message.text, {
      channel: 'voice',
      respondShort: true
    });

    const audioResponse = await this.synthesize(result.speakable || result.text);

    ws.send(JSON.stringify({
      type: 'voice_response',
      text: result.text,
      speakable: result.speakable || result.text,
      audio: audioResponse.toString('base64'),
      audioFormat: 'wav',
      data: result.data || null
    }));
  }

  async transcribe(audioBuffer) {
    // Send PCM audio to Whisper Wyoming protocol
    const response = await fetch(`${this.whisperUrl}/api/speech-to-text`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: audioBuffer
    });
    const result = await response.json();
    return result.text.trim();
  }

  async synthesize(text) {
    // Send text to Piper Wyoming protocol
    const response = await fetch(`${this.piperUrl}/api/text-to-speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    return Buffer.from(await response.arrayBuffer());
  }

  async sendDashboardState(ws) {
    // Send current homelab status for dashboard display
    const status = await this.jeeves.getHomelabStatus();
    ws.send(JSON.stringify({
      type: 'dashboard_update',
      data: status
    }));
  }
}

module.exports = VoiceWebSocketHandler;
```

### REST endpoints for tablet

```javascript
// src/integrations/voice/routes.js

// Serve wake word model to tablet
app.get('/api/voice/wake-model', (req, res) => {
  res.sendFile('/home/jeeves/models/wake/hey_jeeves.onnx');
});

// Health check for voice services
app.get('/api/voice/health', async (req, res) => {
  const whisperOk = await checkService('http://whisper-stt:10300/health');
  const piperOk = await checkService('http://piper-tts:10200/health');

  res.json({
    whisper: whisperOk ? 'online' : 'offline',
    piper: piperOk ? 'online' : 'offline',
    wakeModel: fs.existsSync('/home/jeeves/models/wake/hey_jeeves.onnx')
  });
});

// Dashboard data endpoint (polled by tablet when WebSocket drops)
app.get('/api/voice/dashboard', async (req, res) => {
  const status = await jeeves.getHomelabStatus();
  res.json(status);
});
```

---

## Component 4: Tablet Web App (PWA)

### File structure

```
src/tablet/
├── index.html            # PWA entry point
├── manifest.json         # PWA manifest (fullscreen, standalone)
├── service-worker.js     # Offline support, caches wake model
├── css/
│   └── tablet.css        # Responsive tablet styles, cyberpunk theme
├── js/
│   ├── app.js            # Main app controller
│   ├── wake-word.js      # OpenWakeWord ONNX integration
│   ├── audio-capture.js  # Microphone capture + silence detection
│   ├── websocket.js      # Persistent WebSocket to Daemon
│   ├── dashboard.js      # Dashboard rendering + updates
│   └── tts-playback.js   # Audio playback of TTS responses
└── models/
    └── (wake model cached by service worker)
```

### PWA Manifest

```json
{
  "name": "Jeeves",
  "short_name": "Jeeves",
  "description": "Voice-enabled homelab assistant",
  "start_url": "/tablet",
  "display": "standalone",
  "orientation": "any",
  "background_color": "#0a0e27",
  "theme_color": "#00e5ff",
  "icons": [
    {
      "src": "/icons/jeeves-192.png",
      "sizes": "192x192",
      "type": "image/png"
    },
    {
      "src": "/icons/jeeves-512.png",
      "sizes": "512x512",
      "type": "image/png"
    }
  ]
}
```

### Wake Word Detection (browser-side)

```javascript
// src/tablet/js/wake-word.js

class WakeWordDetector {
  constructor(onDetected) {
    this.onDetected = onDetected;
    this.model = null;
    this.audioContext = null;
    this.isListening = false;
  }

  async initialize() {
    // Load ONNX model from Daemon
    const modelResponse = await fetch('/api/voice/wake-model');
    const modelBuffer = await modelResponse.arrayBuffer();

    // Initialize ONNX runtime in browser
    const ort = await import('https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/ort.min.js');
    this.session = await ort.InferenceSession.create(modelBuffer);

    // Set up audio capture
    this.audioContext = new AudioContext({ sampleRate: 16000 });
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true
      }
    });

    const source = this.audioContext.createMediaStreamSource(stream);
    this.processor = this.audioContext.createScriptProcessor(1280, 1, 1);

    // Buffer for 80ms frames (16000 Hz * 0.08 = 1280 samples)
    this.frameBuffer = new Float32Array(1280);

    this.processor.onaudioprocess = (event) => {
      if (!this.isListening) return;

      const inputData = event.inputBuffer.getChannelData(0);
      this.frameBuffer.set(inputData);
      this.processFrame(this.frameBuffer);
    };

    source.connect(this.processor);
    this.processor.connect(this.audioContext.destination);
    this.isListening = true;

    console.log('[WakeWord] Initialized, listening for "Hey Jeeves"');
  }

  async processFrame(audioFrame) {
    // Run inference on audio frame
    const inputTensor = new ort.Tensor('float32', audioFrame, [1, audioFrame.length]);
    const results = await this.session.run({ input: inputTensor });
    const score = results.output.data[0];

    // Threshold for activation (tune based on testing)
    if (score > 0.6) {
      console.log(`[WakeWord] Detected! Score: ${score.toFixed(3)}`);
      this.onDetected();
    }
  }

  pause() {
    this.isListening = false;
  }

  resume() {
    this.isListening = true;
  }
}
```

### Audio Capture (after wake word)

```javascript
// src/tablet/js/audio-capture.js

class AudioCapture {
  constructor() {
    this.chunks = [];
    this.silenceTimeout = null;
    this.silenceThreshold = 0.01;  // Amplitude threshold for silence
    this.silenceDuration = 1500;    // 1.5 seconds of silence = stop
    this.maxDuration = 15000;       // 15 second max recording
    this.isRecording = false;
  }

  async capture() {
    return new Promise((resolve) => {
      this.chunks = [];
      this.isRecording = true;

      const audioContext = new AudioContext({ sampleRate: 16000 });

      navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, sampleRate: 16000 }
      }).then((stream) => {
        const source = audioContext.createMediaStreamSource(stream);
        const processor = audioContext.createScriptProcessor(4096, 1, 1);

        const maxTimer = setTimeout(() => {
          this.stopRecording(stream, processor, source, audioContext, resolve);
        }, this.maxDuration);

        processor.onaudioprocess = (event) => {
          if (!this.isRecording) return;

          const data = event.inputBuffer.getChannelData(0);
          this.chunks.push(new Float32Array(data));

          // Check for silence
          const amplitude = Math.max(...data.map(Math.abs));

          if (amplitude < this.silenceThreshold) {
            if (!this.silenceTimeout) {
              this.silenceTimeout = setTimeout(() => {
                clearTimeout(maxTimer);
                this.stopRecording(stream, processor, source, audioContext, resolve);
              }, this.silenceDuration);
            }
          } else {
            if (this.silenceTimeout) {
              clearTimeout(this.silenceTimeout);
              this.silenceTimeout = null;
            }
          }
        };

        source.connect(processor);
        processor.connect(audioContext.destination);
      });
    });
  }

  stopRecording(stream, processor, source, audioContext, resolve) {
    this.isRecording = false;
    stream.getTracks().forEach(t => t.stop());
    processor.disconnect();
    source.disconnect();
    audioContext.close();

    // Merge chunks into single buffer
    const totalLength = this.chunks.reduce((sum, c) => sum + c.length, 0);
    const merged = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of this.chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }

    // Convert to 16-bit PCM WAV
    const wavBuffer = this.encodeWAV(merged);
    resolve(wavBuffer);
  }

  encodeWAV(samples) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);

    // WAV header
    const writeString = (offset, string) => {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    };

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);        // PCM
    view.setUint16(22, 1, true);        // Mono
    view.setUint32(24, 16000, true);    // Sample rate
    view.setUint32(28, 32000, true);    // Byte rate
    view.setUint16(32, 2, true);        // Block align
    view.setUint16(34, 16, true);       // Bits per sample
    writeString(36, 'data');
    view.setUint32(40, samples.length * 2, true);

    // Convert float32 to int16
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }

    return buffer;
  }
}
```

### WebSocket Client

```javascript
// src/tablet/js/websocket.js

class JeevesWebSocket {
  constructor(url, onMessage, onStatusChange) {
    this.url = url;
    this.onMessage = onMessage;
    this.onStatusChange = onStatusChange;
    this.ws = null;
    this.reconnectInterval = 3000;
    this.pingInterval = null;
  }

  connect() {
    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      console.log('[WS] Connected to Daemon');
      this.onStatusChange('connected');

      // Keep alive
      this.pingInterval = setInterval(() => {
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, 30000);
    };

    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      this.onMessage(message);
    };

    this.ws.onclose = () => {
      console.log('[WS] Disconnected, reconnecting...');
      this.onStatusChange('disconnected');
      clearInterval(this.pingInterval);
      setTimeout(() => this.connect(), this.reconnectInterval);
    };

    this.ws.onerror = (err) => {
      console.error('[WS] Error:', err);
      this.ws.close();
    };
  }

  sendAudio(audioBuffer) {
    if (this.ws.readyState !== WebSocket.OPEN) return false;

    const base64 = btoa(String.fromCharCode(...new Uint8Array(audioBuffer)));
    this.ws.send(JSON.stringify({
      type: 'audio_command',
      audio: base64,
      timestamp: Date.now()
    }));
    return true;
  }

  sendText(text) {
    if (this.ws.readyState !== WebSocket.OPEN) return false;

    this.ws.send(JSON.stringify({
      type: 'text_command',
      text: text,
      timestamp: Date.now()
    }));
    return true;
  }
}
```

### Main App Controller

```javascript
// src/tablet/js/app.js

class JeevesTablet {
  constructor() {
    this.state = 'idle';  // idle, listening, processing, speaking
    this.wakeWord = null;
    this.audioCapture = new AudioCapture();
    this.ws = null;
    this.conversationHistory = [];
  }

  async initialize() {
    // Connect WebSocket to Daemon
    this.ws = new JeevesWebSocket(
      `ws://${window.location.hostname}:3847/voice`,
      (msg) => this.handleMessage(msg),
      (status) => this.updateConnectionStatus(status)
    );
    this.ws.connect();

    // Initialize wake word detection
    this.wakeWord = new WakeWordDetector(() => this.onWakeWordDetected());
    await this.wakeWord.initialize();

    // Set initial UI state
    this.setState('idle');
    console.log('[Jeeves Tablet] Ready');
  }

  async onWakeWordDetected() {
    // Pause wake word listening while processing
    this.wakeWord.pause();
    this.setState('listening');

    // Play subtle chime to indicate listening
    this.playChime('listening');

    // Capture audio until silence
    const audioBuffer = await this.audioCapture.capture();

    // Send to Daemon
    this.setState('processing');
    this.ws.sendAudio(audioBuffer);
  }

  handleMessage(message) {
    switch (message.type) {
      case 'transcript':
        this.updateTranscript(message.text);
        break;

      case 'status':
        this.updateProcessingStage(message.stage);
        break;

      case 'voice_response':
        this.handleVoiceResponse(message);
        break;

      case 'dashboard_update':
        this.updateDashboard(message.data);
        break;

      case 'notification':
        this.showNotification(message);
        break;

      case 'pong':
        break;
    }
  }

  async handleVoiceResponse(message) {
    this.setState('speaking');

    // Display text response on screen
    this.addToConversation('jeeves', message.text);

    // Play audio response
    if (message.audio) {
      const audioBlob = this.base64ToBlob(message.audio, 'audio/wav');
      const audioUrl = URL.createObjectURL(audioBlob);
      const audio = new Audio(audioUrl);

      audio.onended = () => {
        URL.revokeObjectURL(audioUrl);
        this.setState('idle');
        this.wakeWord.resume();  // Resume wake word listening
      };

      await audio.play();
    } else {
      this.setState('idle');
      this.wakeWord.resume();
    }

    // Update dashboard if data was returned
    if (message.data) {
      this.updateDashboard(message.data);
    }
  }

  setState(state) {
    this.state = state;
    document.body.setAttribute('data-state', state);

    // Update status indicator
    const indicator = document.getElementById('status-indicator');
    switch (state) {
      case 'idle':
        indicator.className = 'status idle';
        indicator.textContent = 'Ready';
        break;
      case 'listening':
        indicator.className = 'status listening';
        indicator.textContent = 'Listening...';
        break;
      case 'processing':
        indicator.className = 'status processing';
        indicator.textContent = 'Thinking...';
        break;
      case 'speaking':
        indicator.className = 'status speaking';
        indicator.textContent = 'Speaking...';
        break;
    }
  }

  // Manual text input (tap to type on tablet)
  async sendTextCommand(text) {
    this.wakeWord.pause();
    this.setState('processing');
    this.addToConversation('user', text);
    this.ws.sendText(text);
  }

  addToConversation(role, text) {
    this.conversationHistory.push({ role, text, timestamp: Date.now() });

    const container = document.getElementById('conversation');
    const bubble = document.createElement('div');
    bubble.className = `bubble ${role}`;
    bubble.textContent = text;
    container.appendChild(bubble);
    container.scrollTop = container.scrollHeight;
  }

  updateDashboard(data) {
    // Update homelab status cards
    if (data.services) {
      document.getElementById('service-count').textContent =
        `${data.services.healthy}/${data.services.total}`;
    }
    if (data.system) {
      document.getElementById('cpu-usage').textContent = `${data.system.cpu}%`;
      document.getElementById('ram-usage').textContent = `${data.system.ram}%`;
      document.getElementById('temp').textContent = `${data.system.temp}C`;
    }
  }

  playChime(type) {
    const chimes = {
      listening: '/audio/chime-listen.wav',
      error: '/audio/chime-error.wav',
      complete: '/audio/chime-complete.wav'
    };
    const audio = new Audio(chimes[type]);
    audio.volume = 0.3;
    audio.play().catch(() => {});
  }

  base64ToBlob(base64, mimeType) {
    const bytes = atob(base64);
    const buffer = new ArrayBuffer(bytes.length);
    const view = new Uint8Array(buffer);
    for (let i = 0; i < bytes.length; i++) {
      view[i] = bytes.charCodeAt(i);
    }
    return new Blob([buffer], { type: mimeType });
  }
}

// Boot
const jeeves = new JeevesTablet();
jeeves.initialize();
```

---

## Component 5: Tablet UI Layout

### Modes

The UI has two modes based on how the tablet is being used:

**Docked Mode (wall-mounted, landscape)**
- Full dashboard visible: services, system stats, conversation history
- Large status indicator
- Always-on display
- Ambient dashboard updates every 10 seconds

**Handheld Mode (picked up, portrait)**
- Conversation focused
- Large text input button
- Minimal dashboard (compact status bar at top)
- Voice indicator prominent

Mode detection: use accelerometer + orientation API.
If landscape and stable for 30+ seconds = docked.
If portrait or moving = handheld.

### Layout: Docked (Landscape)

```
┌────────────────────────────────────────────────────────────────┐
│  JEEVES  ● CONNECTED               READY           12:45 PM   │
├──────────────────────────────────┬─────────────────────────────┤
│                                  │                             │
│  CONVERSATION                    │  HOMELAB                    │
│  ┌────────────────────────────┐  │  ┌───────┐ ┌───────┐       │
│  │ You: check homelab status  │  │  │CPU 12%│ │RAM 8% │       │
│  │                            │  │  └───────┘ └───────┘       │
│  │ Jeeves: All 9 services     │  │  ┌───────┐ ┌───────┐       │
│  │ running. CPU 12%, RAM 8%,  │  │  │DSK 15%│ │TMP 42C│       │
│  │ 42C. No issues.            │  │  └───────┘ └───────┘       │
│  │                            │  │                             │
│  │ You: download inception    │  │  SERVICES                   │
│  │                            │  │  ● jellyfin    ● redis      │
│  │ Jeeves: Found Inception    │  │  ● radarr      ● sonarr     │
│  │ (2010). Added to Radarr.   │  │  ● prowlarr    ● pihole     │
│  │ Downloading 1080p.         │  │  ● prometheus  ● grafana    │
│  │                            │  │  ● piper-tts   ● whisper    │
│  └────────────────────────────┘  │                             │
│                                  │  MEDIA QUEUE                │
│  ┌────────────────────────────┐  │  Inception (2010) ███░ 72%  │
│  │  Say "Hey Jeeves" or type  │  │                             │
│  └────────────────────────────┘  │  NOTIFICATIONS              │
│  ┌────────────────────────────┐  │  Quiet until 11:59 PM       │
│  │ Type a command...     SEND │  │                             │
│  └────────────────────────────┘  │                             │
├──────────────────────────────────┴─────────────────────────────┤
│  ● Voice Ready  │  9/9 Services  │  Uptime: 4d 12h  │  $0.42  │
└────────────────────────────────────────────────────────────────┘
```

### Layout: Handheld (Portrait)

```
┌──────────────────────────┐
│ JEEVES  ● CONNECTED      │
│ CPU 12%  RAM 8%  42C     │
├──────────────────────────┤
│                          │
│  CONVERSATION            │
│                          │
│  ┌────────────────────┐  │
│  │ You:               │  │
│  │ check status       │  │
│  └────────────────────┘  │
│                          │
│  ┌────────────────────┐  │
│  │ Jeeves:            │  │
│  │ All 9 services     │  │
│  │ running. No issues.│  │
│  └────────────────────┘  │
│                          │
│  ┌────────────────────┐  │
│  │ You:               │  │
│  │ download inception │  │
│  └────────────────────┘  │
│                          │
│  ┌────────────────────┐  │
│  │ Jeeves:            │  │
│  │ Found. Added to    │  │
│  │ queue. 1080p.      │  │
│  └────────────────────┘  │
│                          │
│                          │
│  ┌────────────────────┐  │
│  │                    │  │
│  │    ◉ LISTENING     │  │
│  │                    │  │
│  │  Say "Hey Jeeves"  │  │
│  │                    │  │
│  └────────────────────┘  │
│                          │
│  ┌────────────────────┐  │
│  │ Type command  SEND │  │
│  └────────────────────┘  │
└──────────────────────────┘
```

### CSS Theme (cyberpunk, matches existing Web UI)

```css
/* src/tablet/css/tablet.css */

:root {
  --bg-primary: #0a0e27;
  --bg-secondary: #0d1117;
  --bg-card: #161b22;
  --border: #1a2332;
  --cyan: #00e5ff;
  --cyan-glow: 0 0 10px rgba(0, 229, 255, 0.3);
  --green: #00ff88;
  --red: #ff4444;
  --yellow: #ffaa00;
  --purple: #a855f7;
  --text-primary: #e0e0e0;
  --text-secondary: #8b949e;
  --font-mono: 'JetBrains Mono', 'Fira Code', monospace;
}

* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  background: var(--bg-primary);
  color: var(--text-primary);
  font-family: var(--font-mono);
  overflow: hidden;
  height: 100vh;
  width: 100vw;
  user-select: none;
  -webkit-user-select: none;
}

/* Status indicator - changes color based on state */
.status {
  padding: 8px 16px;
  border-radius: 4px;
  font-size: 14px;
  text-transform: uppercase;
  letter-spacing: 1px;
}

.status.idle {
  color: var(--cyan);
  border: 1px solid var(--cyan);
  box-shadow: var(--cyan-glow);
}

.status.listening {
  color: var(--green);
  border: 1px solid var(--green);
  box-shadow: 0 0 10px rgba(0, 255, 136, 0.3);
  animation: pulse 1.5s ease-in-out infinite;
}

.status.processing {
  color: var(--yellow);
  border: 1px solid var(--yellow);
  box-shadow: 0 0 10px rgba(255, 170, 0, 0.3);
  animation: pulse 0.8s ease-in-out infinite;
}

.status.speaking {
  color: var(--purple);
  border: 1px solid var(--purple);
  box-shadow: 0 0 10px rgba(168, 85, 247, 0.3);
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

/* Conversation bubbles */
.bubble {
  padding: 12px 16px;
  border-radius: 8px;
  margin: 8px 0;
  max-width: 85%;
  font-size: 15px;
  line-height: 1.5;
}

.bubble.user {
  background: var(--bg-card);
  border: 1px solid var(--cyan);
  color: var(--cyan);
  margin-left: auto;
  text-align: right;
}

.bubble.jeeves {
  background: var(--bg-card);
  border: 1px solid var(--border);
  color: var(--text-primary);
}

/* Dashboard cards */
.stat-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  text-align: center;
}

.stat-card .value {
  font-size: 24px;
  font-weight: bold;
  color: var(--cyan);
}

.stat-card .label {
  font-size: 11px;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 1px;
}

/* Service indicators */
.service {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  font-size: 13px;
}

.service .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.service .dot.healthy { background: var(--green); }
.service .dot.unhealthy { background: var(--red); }
.service .dot.unknown { background: var(--yellow); }

/* Text input */
.command-input {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 16px;
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 15px;
  width: 100%;
}

.command-input:focus {
  outline: none;
  border-color: var(--cyan);
  box-shadow: var(--cyan-glow);
}

/* Touch-friendly sizes */
button, .command-input {
  min-height: 48px;
}

/* Landscape (docked) layout */
@media (orientation: landscape) {
  .main-layout {
    display: grid;
    grid-template-columns: 1fr 320px;
    grid-template-rows: 48px 1fr 48px;
    height: 100vh;
    gap: 1px;
  }

  .header { grid-column: 1 / -1; }
  .conversation-panel { grid-column: 1; grid-row: 2; overflow-y: auto; }
  .dashboard-panel { grid-column: 2; grid-row: 2; overflow-y: auto; }
  .footer { grid-column: 1 / -1; }
}

/* Portrait (handheld) layout */
@media (orientation: portrait) {
  .main-layout {
    display: flex;
    flex-direction: column;
    height: 100vh;
  }

  .dashboard-panel {
    display: none;  /* Hide full dashboard in portrait */
  }

  .compact-stats {
    display: flex;  /* Show compact stats bar instead */
  }

  .conversation-panel {
    flex: 1;
    overflow-y: auto;
  }
}

/* Wake word visual indicator (large circle) */
.wake-indicator {
  width: 120px;
  height: 120px;
  border-radius: 50%;
  border: 2px solid var(--cyan);
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 20px auto;
  transition: all 0.3s ease;
}

[data-state="idle"] .wake-indicator {
  border-color: var(--cyan);
  box-shadow: var(--cyan-glow);
}

[data-state="listening"] .wake-indicator {
  border-color: var(--green);
  box-shadow: 0 0 30px rgba(0, 255, 136, 0.5);
  transform: scale(1.1);
}

[data-state="processing"] .wake-indicator {
  border-color: var(--yellow);
  box-shadow: 0 0 30px rgba(255, 170, 0, 0.5);
  animation: spin 2s linear infinite;
}

[data-state="speaking"] .wake-indicator {
  border-color: var(--purple);
  box-shadow: 0 0 30px rgba(168, 85, 247, 0.5);
  animation: pulse 0.5s ease-in-out infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* Keep screen on (prevents tablet sleep) */
/* Handled by Wake Lock API in JavaScript */

/* Fullscreen mode (no browser chrome) */
body.fullscreen {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
}
```

---

## Component 6: Screen Wake Lock + Keep Alive

The tablet must stay awake when wall-mounted.

```javascript
// src/tablet/js/keep-alive.js

class KeepAlive {
  constructor() {
    this.wakeLock = null;
  }

  async requestWakeLock() {
    try {
      this.wakeLock = await navigator.wakeLock.request('screen');
      console.log('[KeepAlive] Screen wake lock acquired');

      this.wakeLock.addEventListener('release', () => {
        console.log('[KeepAlive] Wake lock released, re-acquiring...');
        this.requestWakeLock();
      });
    } catch (err) {
      console.error('[KeepAlive] Wake lock failed:', err);
    }
  }

  // Re-acquire on visibility change (tab switch, etc)
  setupVisibilityHandler() {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        this.requestWakeLock();
      }
    });
  }
}
```

---

## Component 7: Notification Push (Daemon to Tablet)

Jeeves pushes notifications to the tablet via WebSocket.
Tablet displays as overlay + optional voice announcement.

```javascript
// On Daemon side, when notification triggers:
async pushToTablet(notification) {
  // Send to all connected tablet clients
  this.voiceClients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'notification',
        priority: notification.priority,
        title: notification.title,
        message: notification.message,
        speakable: notification.speakable,
        timestamp: Date.now()
      }));
    }
  });
}

// On tablet side:
showNotification(notification) {
  // Visual overlay
  const overlay = document.getElementById('notification-overlay');
  overlay.textContent = notification.message;
  overlay.className = `notification ${notification.priority}`;
  overlay.classList.add('visible');

  // Auto-hide after 10 seconds
  setTimeout(() => overlay.classList.remove('visible'), 10000);

  // Voice announcement for high priority
  if (notification.priority === 'high' && notification.speakable) {
    // Interrupt current state, speak the notification
    this.wakeWord.pause();
    const audio = new Audio(`data:audio/wav;base64,${notification.audio}`);
    audio.onended = () => this.wakeWord.resume();
    audio.play();
  }
}
```

---

## Tablet Hardware Recommendation

| Device | Cost | Pros | Cons |
|--------|------|------|------|
| Samsung Galaxy Tab A9 | $150-180 | Good speakers, Android PWA support | Heavier |
| Amazon Fire HD 10 | $100-140 | Cheapest option, decent screen | Locked ecosystem |
| iPad 9th Gen (used) | $180-250 | Best display, best speakers | Slightly more expensive |
| Lenovo Tab M10 | $130-170 | Good value, clean Android | Average speakers |

Recommendation: Samsung Galaxy Tab A9 or used iPad 9th Gen.
Both have good microphones, decent speakers, and support PWA fullscreen mode.

### Wall Mount

| Mount | Cost | Notes |
|-------|------|-------|
| Magnetic tablet mount | $15-25 | Easy on/off, pick up and carry |
| Elago tablet stand | $20-30 | Desktop/counter use |
| Custom 3D printed bracket | $5-10 | If you have a 3D printer |
| Velcro command strips | $5 | Cheapest, works fine |

Recommendation: Magnetic mount. Mount the plate on the wall, tablet snaps on/off.
Pick it up to use on couch, snap it back when done.

### Power

Keep tablet plugged in when docked via USB-C cable routed behind mount.
When handheld, runs on battery (8-10 hours typical for modern tablets).

---

## Build Order

### Phase 0: Windows Desktop Validation (BEFORE buying a tablet)

Test the entire voice pipeline using a Windows PC with speakers, webcam mic, and Chrome browser.
The browser's Web Audio API handles mic/speaker access on Windows identically to a tablet.
If it works on Windows, it works on the tablet. No code changes needed between them.

**Hardware mapping:**

```
WINDOWS PC (Chrome browser, same local WiFi as Daemon)
├── Webcam microphone → Web Audio API captures audio (same as tablet mic)
├── Computer speakers → Browser plays TTS audio (same as tablet speaker)
├── Chrome fullscreen → F11 simulates tablet fullscreen mode
└── Browser DevTools → Test portrait mode via device emulation
         │
         │  WebSocket (ws://daemon.local:3847/voice)
         │
         ▼
DAEMON (192.168.1.50)
├── Whisper STT (receives audio from Windows mic via WebSocket)
├── Jeeves Core (processes command)
└── Piper TTS (sends audio back to Windows speakers via WebSocket)
```

**Why this works:** The browser abstracts the hardware. `navigator.mediaDevices.getUserMedia()`
captures audio from whatever mic the OS provides (webcam mic, USB mic, built-in mic).
`AudioContext.decodeAudioData()` plays through whatever speakers the OS uses.
Daemon doesn't care if the client is Windows, Android, or iPad.

**Phase 0 steps:**

1. Deploy Piper TTS + Whisper STT Docker containers on Daemon (Phase 1 below)
2. Deploy WebSocket handler + voice API on Daemon (Phase 2 below)
3. Skip wake word for now (Phase 0 uses a push-to-talk button instead)
4. Open Chrome on Windows, navigate to `http://daemon.local:3847/voice`
5. Browser prompts for microphone access - allow (select webcam mic)
6. Click "push to talk" button, speak command, release
7. Audio streams to Daemon via WebSocket
8. Whisper transcribes, Jeeves processes, Piper generates TTS
9. WAV audio streams back to Chrome, plays through computer speakers
10. Verify full round-trip works

**Phase 0 test interface (temporary, stripped-down):**

```javascript
// src/integrations/voice/test-client.html
// Serve at GET /voice/test (desktop testing only)

const testUI = `
<!DOCTYPE html>
<html>
<head>
  <title>Jeeves Voice Test</title>
  <style>
    body {
      background: #0a0e27;
      color: #00ffcc;
      font-family: monospace;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100vh;
      margin: 0;
    }
    #status {
      font-size: 24px;
      margin-bottom: 40px;
    }
    #talk-btn {
      width: 200px;
      height: 200px;
      border-radius: 50%;
      border: 3px solid #00ffcc;
      background: transparent;
      color: #00ffcc;
      font-size: 18px;
      font-family: monospace;
      cursor: pointer;
      transition: all 0.2s;
    }
    #talk-btn:hover {
      background: rgba(0, 255, 204, 0.1);
    }
    #talk-btn.recording {
      border-color: #ff3366;
      color: #ff3366;
      box-shadow: 0 0 30px rgba(255, 51, 102, 0.4);
      animation: pulse 1s infinite;
    }
    #talk-btn.processing {
      border-color: #ffaa00;
      color: #ffaa00;
    }
    @keyframes pulse {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.05); }
    }
    #transcript {
      margin-top: 40px;
      max-width: 600px;
      text-align: center;
    }
    #transcript .you { color: #00ffcc; }
    #transcript .jeeves { color: #ffffff; }
    #latency {
      margin-top: 20px;
      font-size: 12px;
      color: #666;
    }
    #volume-meter {
      width: 200px;
      height: 4px;
      background: #1a1e3a;
      margin-top: 20px;
      border-radius: 2px;
    }
    #volume-level {
      height: 100%;
      background: #00ffcc;
      border-radius: 2px;
      width: 0%;
      transition: width 0.1s;
    }
  </style>
</head>
<body>
  <div id="status">Connecting to Daemon...</div>
  <button id="talk-btn">HOLD TO TALK</button>
  <div id="volume-meter"><div id="volume-level"></div></div>
  <div id="transcript"></div>
  <div id="latency"></div>

  <script>
    const DAEMON_WS = 'ws://' + window.location.hostname + ':3847/voice';
    let ws;
    let mediaStream;
    let audioContext;
    let recorder;
    let isRecording = false;
    let commandStart;

    const statusEl = document.getElementById('status');
    const talkBtn = document.getElementById('talk-btn');
    const transcriptEl = document.getElementById('transcript');
    const latencyEl = document.getElementById('latency');
    const volumeLevel = document.getElementById('volume-level');

    // Connect WebSocket
    function connect() {
      ws = new WebSocket(DAEMON_WS);

      ws.onopen = () => {
        statusEl.textContent = 'Connected - Hold button and speak';
        ws.send(JSON.stringify({ type: 'register', client: 'desktop-test' }));
      };

      ws.onmessage = async (event) => {
        const msg = JSON.parse(event.data);

        if (msg.type === 'voice_response') {
          // Show transcript
          transcriptEl.innerHTML +=
            '<p class="you">You: ' + msg.transcript + '</p>' +
            '<p class="jeeves">Jeeves: ' + msg.text + '</p>';

          // Play TTS audio through speakers
          if (msg.audio) {
            const audioData = Uint8Array.from(atob(msg.audio), c => c.charCodeAt(0));
            const audioBuffer = await audioContext.decodeAudioData(audioData.buffer);
            const source = audioContext.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(audioContext.destination);
            source.start(0);
          }

          // Show latency
          const latency = Date.now() - commandStart;
          latencyEl.textContent = 'Round-trip: ' + latency + 'ms';

          talkBtn.className = '';
          talkBtn.textContent = 'HOLD TO TALK';
          statusEl.textContent = 'Ready';
        }

        if (msg.type === 'error') {
          statusEl.textContent = 'Error: ' + msg.message;
          talkBtn.className = '';
          talkBtn.textContent = 'HOLD TO TALK';
        }
      };

      ws.onclose = () => {
        statusEl.textContent = 'Disconnected. Reconnecting...';
        setTimeout(connect, 3000);
      };
    }

    // Initialize audio
    async function initAudio() {
      audioContext = new AudioContext({ sampleRate: 16000 });
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true
        }
      });

      // Volume meter (visual feedback that mic is working)
      const analyser = audioContext.createAnalyser();
      const micSource = audioContext.createMediaStreamSource(mediaStream);
      micSource.connect(analyser);
      analyser.fftSize = 256;
      const dataArray = new Uint8Array(analyser.frequencyBinCount);

      function updateMeter() {
        analyser.getByteFrequencyData(dataArray);
        const avg = dataArray.reduce((a, b) => a + b) / dataArray.length;
        volumeLevel.style.width = Math.min(100, avg * 2) + '%';
        requestAnimationFrame(updateMeter);
      }
      updateMeter();
    }

    // Push-to-talk handlers
    talkBtn.addEventListener('mousedown', startRecording);
    talkBtn.addEventListener('mouseup', stopRecording);
    talkBtn.addEventListener('mouseleave', stopRecording);
    // Touch support (for when tested on actual tablet later)
    talkBtn.addEventListener('touchstart', (e) => { e.preventDefault(); startRecording(); });
    talkBtn.addEventListener('touchend', (e) => { e.preventDefault(); stopRecording(); });

    async function startRecording() {
      if (isRecording) return;
      isRecording = true;
      commandStart = Date.now();

      talkBtn.className = 'recording';
      talkBtn.textContent = 'LISTENING...';
      statusEl.textContent = 'Recording...';

      // Record audio chunks
      recorder = new MediaRecorder(mediaStream, { mimeType: 'audio/webm;codecs=opus' });
      const chunks = [];
      recorder.ondataavailable = (e) => chunks.push(e.data);
      recorder.onstop = async () => {
        const blob = new Blob(chunks, { type: 'audio/webm' });
        const buffer = await blob.arrayBuffer();
        const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));

        talkBtn.className = 'processing';
        talkBtn.textContent = 'PROCESSING...';
        statusEl.textContent = 'Sending to Jeeves...';

        ws.send(JSON.stringify({
          type: 'audio_command',
          audio: base64,
          format: 'webm',
          sampleRate: 16000,
          timestamp: Date.now()
        }));
      };
      recorder.start();
    }

    function stopRecording() {
      if (!isRecording) return;
      isRecording = false;
      if (recorder && recorder.state === 'recording') {
        recorder.stop();
      }
    }

    // Boot
    initAudio().then(connect).catch(err => {
      statusEl.textContent = 'Mic access denied: ' + err.message;
    });
  </script>
</body>
</html>
`;
```

**Phase 0 test checklist:**

```
[ ] Piper TTS container running on Daemon
[ ] Whisper STT container running on Daemon
[ ] WebSocket server running on port 3847/voice
[ ] Test page served at http://daemon.local:3847/voice/test
[ ] Open Chrome on Windows PC
[ ] Chrome prompts for mic access - allowed
[ ] Volume meter shows mic input levels (green bar moves when you speak)
[ ] Hold button, say "check homelab status", release
[ ] Status shows "Sending to Jeeves..."
[ ] Transcript shows: You: check homelab status
[ ] Transcript shows: Jeeves: [actual response]
[ ] Audio plays through computer speakers (Jeeves speaks)
[ ] Latency displayed (target < 5 seconds)
[ ] Test 5 different commands:
    [ ] "check homelab status"
    [ ] "what services are running"
    [ ] "how much memory is free"
    [ ] "check vercel deployments"
    [ ] "what are you working on"
[ ] All 5 commands recognized correctly by Whisper
[ ] All 5 responses play through speakers
[ ] Average latency acceptable (< 5 sec)
```

**Phase 0 pass criteria:**
- Mic captures cleanly (volume meter confirms)
- Whisper transcribes commands accurately (4/5 minimum)
- Jeeves responds with real data (not hallucinated)
- TTS plays through speakers clearly
- Average round-trip under 5 seconds
- WebSocket reconnects after disconnect

**Phase 0 failure modes and fixes:**

| Problem | Likely Cause | Fix |
|---------|-------------|-----|
| No mic access | Chrome blocked | chrome://settings/content/microphone, allow daemon.local |
| Mic captures but no transcription | Whisper container down | `docker logs whisper-stt`, check port 10300 |
| Transcription wrong | Whisper model too small | Upgrade from tiny.en to base.en |
| No audio playback | Browser autoplay blocked | User interaction (button click) required first, already handled |
| Audio plays but garbled | Sample rate mismatch | Ensure 16kHz capture matches Whisper expectation |
| High latency (>8s) | Whisper slow on N150 | Try tiny.en model, accept lower accuracy |
| WebSocket won't connect | Firewall | Check UFW allows 3847 from Windows IP |

**IMPORTANT: Phase 0 must pass before proceeding to Phase 1.**
If voice works on Windows with webcam mic and computer speakers,
it will work identically on any tablet, phone, or device with a browser.
No code changes between Phase 0 and tablet deployment.

---

### Phase 1: Voice Services on Daemon
1. Deploy Piper TTS Docker container (en_GB-alba-medium voice)
2. Deploy Whisper STT Docker container (base.en model)
3. Verify both containers healthy
4. Test TTS: `curl -X POST http://localhost:10200/api/text-to-speech -d '{"text":"Hello sir"}'`
5. Test STT: `curl -X POST http://localhost:10300/api/speech-to-text -H 'Content-Type: audio/wav' --data-binary @test.wav`

### Phase 2: Voice WebSocket + API
6. Add WebSocket handler to Jeeves server (port 3847, path /voice)
7. Add REST routes: /api/voice/wake-model, /api/voice/health, /api/voice/dashboard
8. Wire audio_command handler: receive base64 → Whisper → Jeeves core → Piper → respond
9. Wire text_command handler: receive text → Jeeves core → Piper → respond
10. Test via wscat: `wscat -c ws://daemon.local:3847/voice`
11. Run Phase 0 test checklist on Windows PC (MUST PASS before continuing)

### Phase 3: Wake Word Model
12. Go to https://openwakeword.com, train "Hey Jeeves" model
13. Download ONNX file, place at /home/jeeves/models/wake/hey_jeeves.onnx
14. Serve via /api/voice/wake-model endpoint
15. Test model loads in browser via ONNX runtime
16. Test wake word detection on Windows with webcam mic

### Phase 4: Tablet PWA
17. Build tablet web app (index.html, manifest.json, service worker)
18. Implement WebSocket client with auto-reconnect
19. Implement OpenWakeWord detection in browser
20. Implement audio capture with silence detection
21. Implement TTS playback from base64 WAV
22. Implement dashboard rendering (landscape + portrait)
23. Implement conversation view
24. Implement keep-alive (wake lock API)
25. Style with cyberpunk theme matching existing Web UI

### Phase 5: Integration Testing
26. Full loop test: wake word → capture → transcribe → process → TTS → playback
27. Measure round-trip latency (target < 5 seconds)
28. Test notification push from Daemon to tablet
29. Test docked vs handheld mode switching
30. Test reconnection after WiFi drop

### Phase 6: Polish
31. Add chime sounds for state changes
32. Add subtle animations for processing states
33. Optimize audio capture buffer sizes for latency
34. Add typed command fallback when voice fails
35. Cache wake word model in service worker for offline boot
