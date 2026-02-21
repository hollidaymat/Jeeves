/**
 * Signal Cursor Controller - Web UI Application
 */

// ============================================================================
// Tab Controller
// ============================================================================
class TabController {
  constructor() {
    this.tabs = document.querySelectorAll('.tab-btn');
    this.contents = document.querySelectorAll('.tab-content');
    this.activeTab = localStorage.getItem('jeeves-active-tab') || 'console';
    this.callbacks = {};
    this.init();
  }

  init() {
    // Set initial active tab
    this.switchTo(this.activeTab);

    this.tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        this.switchTo(tab.dataset.tab);
      });
    });
  }

  switchTo(tabName) {
    this.tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
    this.contents.forEach(c => c.classList.toggle('active', c.dataset.tab === tabName));
    this.activeTab = tabName;
    localStorage.setItem('jeeves-active-tab', tabName);

    // Fire callback for lazy loading
    if (this.callbacks[tabName]) {
      this.callbacks[tabName]();
    }
  }

  onActivate(tabName, fn) {
    this.callbacks[tabName] = fn;
  }
}

// ============================================================================
// VoiceRecorder - hold-to-talk: start() then stop() returns Promise<ArrayBuffer> (WAV)
// Uses MediaRecorder + decodeAudioData (reliable on Chrome/Windows vs ScriptProcessor).
// ============================================================================
class VoiceRecorder {
  constructor() {
    this.sampleRate = 16000;
    this.stream = null;
    this.mediaRecorder = null;
    this.recordedChunks = [];
  }

  static encodeWAV(samples, sampleRate) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    const writeStr = (offset, str) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    return buffer;
  }

  /** Resample to 16 kHz for server/STT (linear interpolation). */
  static resampleTo16k(samples, fromRate) {
    if (fromRate === 16000) return samples;
    const outLen = Math.floor(samples.length * 16000 / fromRate);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const src = (i * fromRate) / 16000;
      const j = Math.floor(src);
      const t = src - j;
      out[i] = j + 1 < samples.length
        ? samples[j] * (1 - t) + samples[j + 1] * t
        : samples[Math.min(j, samples.length - 1)];
    }
    return out;
  }

  start(deviceId) {
    this.recordedChunks = [];
    const constraints = { audio: { channelCount: 1 } };
    if (deviceId && deviceId.length) constraints.audio.deviceId = { exact: deviceId };
    return new Promise((resolve, reject) => {
      navigator.mediaDevices.getUserMedia(constraints)
        .then((stream) => {
          this.stream = stream;
          const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
          this.mediaRecorder = new MediaRecorder(stream);
          this.mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) this.recordedChunks.push(e.data); };
          this.mediaRecorder.start(100); // 100ms chunks so we get data even if final flush is empty (Chrome/Windows)
          if (this.mediaRecorder.state === 'recording') resolve();
          else this.mediaRecorder.onstart = () => resolve();
        })
        .catch(reject);
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.stream || !this.mediaRecorder || this.mediaRecorder.state === 'inactive') {
        if (this.stream) this.stream.getTracks().forEach(t => t.stop());
        this.stream = null;
        this.mediaRecorder = null;
        resolve(null);
        return;
      }
      const stream = this.stream;
      this.stream = null;
      const mime = this.mediaRecorder.mimeType || 'audio/webm';
      this.mediaRecorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        const chunks = this.recordedChunks;
        this.mediaRecorder = null;
        if (chunks.length === 0) {
          resolve(null);
          return;
        }
        const blob = new Blob(chunks, { type: mime });
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        blob.arrayBuffer()
          .then((buf) => ctx.decodeAudioData(buf))
          .then((audioBuffer) => {
            ctx.close();
            const ch = audioBuffer.getChannelData(0);
            const samples = new Float32Array(ch.length);
            samples.set(ch);
            const resampled = VoiceRecorder.resampleTo16k(samples, audioBuffer.sampleRate);
            resolve(resampled.length ? VoiceRecorder.encodeWAV(resampled, this.sampleRate) : null);
          })
          .catch(() => { ctx.close(); resolve(null); });
      };
      this.mediaRecorder.stop();
    });
  }
}

// ============================================================================
// VoiceWakeStream - streams 16kHz PCM 1280-sample chunks for server-side wake word
// ScriptProcessor requires power-of-two buffer (256–16384); use 2048 then slice to 1280.
// Resamples to 16kHz if the browser uses a different rate (e.g. 48kHz).
// ============================================================================
class VoiceWakeStream {
  constructor(sendChunk) {
    this.targetRate = 16000;
    this.sendChunk = sendChunk;
    this.ctx = null;
    this.stream = null;
    this.processor = null;
    this.source = null;
    this.buffer = []; // float32 [-1,1], drained and resampled to 16kHz 1280-sample chunks
  }

  start(deviceId) {
    return new Promise((resolve, reject) => {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: this.targetRate });
      const constraints = { audio: { channelCount: 1, sampleRate: this.targetRate } };
      if (deviceId && deviceId.length) constraints.audio.deviceId = { exact: deviceId };
      navigator.mediaDevices.getUserMedia(constraints)
        .then((stream) => {
          this.stream = stream;
          this.buffer = [];
          const inputRate = this.ctx.sampleRate;
          const ratio = inputRate / this.targetRate; // e.g. 48000/16000 = 3
          const needInput = Math.ceil(1280 * ratio);
          const source = this.ctx.createMediaStreamSource(stream);
          const processor = this.ctx.createScriptProcessor(2048, 1, 1); // must be power of two
          processor.onaudioprocess = (e) => {
            const float32 = e.inputBuffer.getChannelData(0);
            for (let i = 0; i < float32.length; i++) {
              this.buffer.push(Math.max(-1, Math.min(1, float32[i])));
            }
            while (this.buffer.length >= needInput) {
              const input = this.buffer.splice(0, needInput);
              const out = new Float32Array(1280);
              for (let i = 0; i < 1280; i++) {
                const srcIdx = i * ratio;
                const j = Math.floor(srcIdx);
                const frac = srcIdx - j;
                const a = input[j];
                const b = j + 1 < input.length ? input[j + 1] : a;
                out[i] = a + frac * (b - a);
              }
              const int16 = new Int16Array(1280);
              for (let i = 0; i < 1280; i++) {
                const s = out[i];
                int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
              }
              const b64 = btoa(String.fromCharCode.apply(null, new Uint8Array(int16.buffer)));
              this.sendChunk(b64);
            }
          };
          source.connect(processor);
          processor.connect(this.ctx.destination);
          this.processor = processor;
          this.source = source;
          resolve();
        })
        .catch(reject);
    });
  }

  stop() {
    if (!this.stream || !this.ctx) return;
    this.stream.getTracks().forEach(t => t.stop());
    this.processor?.disconnect();
    this.source?.disconnect();
    this.ctx.close();
    this.stream = null;
    this.ctx = null;
    this.processor = null;
    this.source = null;
  }
}

// Record N ms from mic at 16kHz mono, resample if needed, return Int16Array PCM.
function recordTestPCM(durationMs) {
  const targetRate = 16000;
  const targetSamples = Math.floor((durationMs / 1000) * targetRate);
  return new Promise((resolve, reject) => {
    const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: targetRate });
    const constraints = { audio: { channelCount: 1, sampleRate: targetRate } };
    navigator.mediaDevices.getUserMedia(constraints)
      .then((stream) => {
        const inputRate = ctx.sampleRate;
        const ratio = inputRate / targetRate;
        const needInput = Math.ceil(1280 * ratio);
        const source = ctx.createMediaStreamSource(stream);
        const processor = ctx.createScriptProcessor(2048, 1, 1);
        const buffer = [];
        const outSamples = [];
        let done = false;
        const finish = (int16) => {
          if (done) return;
          done = true;
          processor.disconnect();
          source.disconnect();
          stream.getTracks().forEach((t) => t.stop());
          ctx.close();
          resolve(int16);
        };
        processor.onaudioprocess = (e) => {
          const float32 = e.inputBuffer.getChannelData(0);
          for (let i = 0; i < float32.length; i++) buffer.push(Math.max(-1, Math.min(1, float32[i])));
          while (buffer.length >= needInput && outSamples.length < targetSamples) {
            const input = buffer.splice(0, needInput);
            const out = new Float32Array(1280);
            for (let i = 0; i < 1280; i++) {
              const srcIdx = i * ratio;
              const j = Math.floor(srcIdx);
              const frac = srcIdx - j;
              const a = input[j];
              const b = j + 1 < input.length ? input[j + 1] : a;
              out[i] = a + frac * (b - a);
            }
            for (let i = 0; i < 1280 && outSamples.length < targetSamples; i++) outSamples.push(out[i]);
          }
          if (outSamples.length >= targetSamples) {
            const int16 = new Int16Array(outSamples.length);
            for (let i = 0; i < outSamples.length; i++) {
              const s = outSamples[i];
              int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
            }
            finish(int16);
          }
        };
        source.connect(processor);
        processor.connect(ctx.destination);
        setTimeout(() => {
          if (done) return;
          const int16 = new Int16Array(outSamples.length);
          for (let i = 0; i < outSamples.length; i++) {
            const s = outSamples[i];
            int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
          }
          finish(int16);
        }, durationMs + 500);
      })
      .catch(reject);
  });
}

// ============================================================================
// CommandCenter
// ============================================================================
class CommandCenter {
  constructor() {
    this.ws = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.startTime = null;
    
    // Streaming state
    this.activeStreamId = null;
    this.streamContent = '';
    this.streamElement = null;
    this.streamHadContent = false;
    this.lastStreamId = null;
    this.lastStreamHadContent = false;
    
    this.elements = {
      connectionStatus: document.getElementById('connection-status'),
      uptime: document.getElementById('uptime'),
      consoleOutput: document.getElementById('console-output'),
      commandForm: document.getElementById('command-form'),
      commandInput: document.getElementById('command-input'),
      signalStatus: document.getElementById('signal-status'),
      webStatus: document.getElementById('web-status'),
      projectsCount: document.getElementById('projects-count'),
      messagesCount: document.getElementById('messages-count'),
      projectsList: document.getElementById('projects-list'),
      refreshProjects: document.getElementById('refresh-projects'),
      lastCommand: document.getElementById('last-command'),
      agentState: document.getElementById('agent-state'),
      agentInfo: document.getElementById('agent-info'),
      agentIndicator: document.getElementById('agent-indicator'),
      agentStopBtn: document.getElementById('agent-stop-btn'),
      changesPanel: document.getElementById('changes-panel'),
      changesCount: document.getElementById('changes-count'),
      changesContent: document.getElementById('changes-content'),
      changesActions: document.getElementById('changes-actions'),
      applyBtn: document.getElementById('apply-btn'),
      rejectBtn: document.getElementById('reject-btn'),
      fileInput: document.getElementById('file-input'),
      attachBtn: document.getElementById('attach-btn'),
      attachmentsPreview: document.getElementById('attachments-preview'),
      voicePanel: document.getElementById('voice-panel'),
      voiceStatus: document.getElementById('voice-status'),
      voiceHoldBtn: document.getElementById('voice-hold-btn'),
      voiceMicSelect: document.getElementById('voice-mic-select'),
      voiceWakeToggle: document.getElementById('voice-wake-toggle'),
      voiceSpeakToggle: document.getElementById('voice-speak-toggle')
    };
    
    this.pendingChanges = [];
    this.voiceInitialized = false;
    this.voiceWs = null;
    this.voiceRecorder = null;
    this.voiceWakeStream = null;
    this.voiceWakeStreamPending = false;
    this.wakeStreamRequestedWhenReady = false;
    this.recordingAfterWake = false;
    this.attachedFiles = [];
    this.homelabDashboard = null;
    this.activityPanel = null;
    this.costDashboard = null;
    this.projectTracker = null;
    this.sitesPanel = null;
    this.cursorPanel = null;
    
    // Command history
    this.commandHistory = [];
    this.historyIndex = -1;
    this.currentInput = '';
    this.maxHistorySize = 100;
    
    this.loadCommandHistory();
    this.init();
  }
  
  loadCommandHistory() {
    try {
      const saved = localStorage.getItem('jeeves-command-history');
      if (saved) {
        this.commandHistory = JSON.parse(saved);
      }
    } catch (e) {
      console.warn('Failed to load command history:', e);
    }
  }
  
  saveCommandHistory() {
    try {
      localStorage.setItem('jeeves-command-history', JSON.stringify(this.commandHistory));
    } catch (e) {
      console.warn('Failed to save command history:', e);
    }
  }
  
  addToHistory(command) {
    if (!command.trim()) return;
    if (this.commandHistory.length > 0 && this.commandHistory[0] === command) return;
    
    this.commandHistory.unshift(command);
    
    if (this.commandHistory.length > this.maxHistorySize) {
      this.commandHistory = this.commandHistory.slice(0, this.maxHistorySize);
    }
    
    this.historyIndex = -1;
    this.currentInput = '';
    this.saveCommandHistory();
  }
  
  init() {
    this.connectWebSocket();
    this.setupEventListeners();
    this.startUptimeTimer();
    this.log('system', 'Command center initialized');
  }
  
  connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;
    
    this.ws = new WebSocket(wsUrl);
    
    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.updateConnectionStatus('connected');
      this.log('system', 'Connected to Jeeves');
    };
    
    this.ws.onclose = () => {
      this.updateConnectionStatus('disconnected');
      this.log('error', 'Connection lost. Reconnecting...');
      this.attemptReconnect();
    };
    
    this.ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
    
    this.ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        this.handleMessage(message);
      } catch (error) {
        console.error('Failed to parse message:', error);
      }
    };
  }
  
  attemptReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.log('error', 'Max reconnection attempts reached. Please refresh the page.');
      return;
    }
    
    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    
    setTimeout(() => {
      this.connectWebSocket();
    }, delay);
  }
  
  handleMessage(message) {
    switch (message.type) {
      case 'status':
        this.updateStatus(message.payload);
        break;
      case 'projects':
        this.updateProjects(message.payload);
        break;
      case 'log':
        this.handleLog(message.payload);
        break;
      case 'response':
        if (this.lastStreamId && this.lastStreamHadContent) {
          this.lastStreamId = null;
          this.lastStreamHadContent = false;
        } else if (!this.activeStreamId) {
          this.handleResponse(message.payload);
        }
        break;
      case 'stream_start':
        this.handleStreamStart(message.payload);
        break;
      case 'stream_chunk':
        this.handleStreamChunk(message.payload);
        break;
      case 'stream_end':
        this.handleStreamEnd(message.payload);
        break;
      case 'agent_status':
        this.updateAgentStatus(message.payload);
        break;
      case 'pending_changes':
        this.updatePendingChanges(message.payload);
        break;
      case 'prd_status':
        this.updatePrdStatus(message.payload);
        break;
      case 'prd_checkpoint':
        this.handlePrdCheckpoint(message.payload);
        break;
      case 'homelab_status':
        if (this.homelabDashboard) {
          this.homelabDashboard.handleWSMessage(message);
        }
        break;
      case 'cost_update':
        if (this.costDashboard) {
          this.costDashboard.update(message.payload);
        }
        break;
      case 'activity_update':
        if (this.activityPanel) {
          this.activityPanel.update(message.payload);
        }
        break;
      case 'project_update':
        if (this.projectTracker) {
          this.projectTracker.update(message.payload);
        }
        break;
      case 'task:started':
      case 'task:progress':
      case 'task:completed':
      case 'task:failed':
      case 'queue:updated':
        if (this.activityPanel) {
          this.activityPanel.handleEvent(message.type, message.payload);
        }
        break;
      case 'cursor:task:started':
      case 'cursor:task:progress':
      case 'cursor:task:completed':
      case 'cursor:task:stuck':
      case 'cursor:task:error':
        if (this.cursorPanel) {
          this.cursorPanel.handleEvent(message.type, message.payload);
        }
        break;
      case 'orchestration_phase':
        if (this.orchestrationPanel) {
          this.orchestrationPanel.handleEvent(message.payload);
        }
        break;
    }
  }
  
  updatePrdStatus(status) {
    // PRD phase updates not shown in console (view in Activity if needed).
  }
  
  handlePrdCheckpoint(checkpoint) {
    // PRD checkpoints not shown in console to reduce noise.
  }
  
  updateStatus(status) {
    this.startTime = Date.now() - (status.uptime_seconds * 1000);
    
    this.elements.signalStatus.textContent = status.interfaces.signal.toUpperCase();
    this.elements.signalStatus.className = `status-value ${status.interfaces.signal === 'connected' ? 'connected' : ''}`;
    
    this.elements.webStatus.textContent = status.interfaces.web.toUpperCase();
    this.elements.webStatus.className = 'status-value connected';
    
    this.elements.projectsCount.textContent = status.projects_loaded;
    this.elements.messagesCount.textContent = status.messages_today;
    
    if (status.last_command) {
      const time = new Date(status.last_command.timestamp).toLocaleTimeString();
      this.elements.lastCommand.textContent = `Last: ${status.last_command.action} at ${time}`;
    }
    
    if (status.agent) {
      this.updateAgentStatus(status.agent);
    }
    if (status.voice?.enabled && this.elements.voicePanel) {
      this.elements.voicePanel.style.display = '';
      this.initVoice();
    }
  }
  
  updateAgentStatus(agent) {
    if (agent.active) {
      this.elements.agentState.textContent = 'ACTIVE';
      this.elements.agentState.classList.add('active');
      this.elements.agentIndicator.classList.add('active');
      this.elements.agentStopBtn.disabled = false;
      
      const dir = agent.workingDir ? agent.workingDir.split(/[\\/]/).pop() : 'Unknown';
      const uptime = agent.uptime ? `${Math.floor(agent.uptime / 60)}m ${agent.uptime % 60}s` : '';
      this.elements.agentInfo.textContent = `${dir} ${uptime ? '| ' + uptime : ''}`;
    } else {
      this.elements.agentState.textContent = 'INACTIVE';
      this.elements.agentState.classList.remove('active');
      this.elements.agentIndicator.classList.remove('active');
      this.elements.agentStopBtn.disabled = true;
      this.elements.agentInfo.textContent = 'No active session';
    }
  }

  getPreferredVoiceDeviceId() {
    const sel = this.elements.voiceMicSelect;
    if (sel && sel.value) return sel.value;
    try {
      const saved = localStorage.getItem('jeeves_voice_device_id');
      return saved || '';
    } catch { return ''; }
  }

  populateVoiceMicSelect() {
    const sel = this.elements.voiceMicSelect;
    if (!sel) return;
    const saved = (function () { try { return localStorage.getItem('jeeves_voice_device_id') || ''; } catch { return ''; } })();
    navigator.mediaDevices.enumerateDevices().then((devices) => {
      const inputs = devices.filter(d => d.kind === 'audioinput');
      sel.innerHTML = '';
      const opt0 = document.createElement('option');
      opt0.value = '';
      opt0.textContent = 'Default (system)';
      sel.appendChild(opt0);
      inputs.forEach((d) => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || 'Microphone ' + (sel.options.length);
        sel.appendChild(opt);
      });
      if (saved && inputs.some(d => d.deviceId === saved)) sel.value = saved;
      else if (saved) sel.value = '';
    }).catch(() => {});
  }

  initVoice() {
    if (this.voiceInitialized || !this.elements.voicePanel || !this.elements.voiceHoldBtn) return;
    this.voiceInitialized = true;
    this.populateVoiceMicSelect();
    if (this.elements.voiceMicSelect) {
      this.elements.voiceMicSelect.addEventListener('change', () => {
        try {
          if (this.elements.voiceMicSelect.value) localStorage.setItem('jeeves_voice_device_id', this.elements.voiceMicSelect.value);
          else localStorage.removeItem('jeeves_voice_device_id');
        } catch (_) {}
      });
      this.elements.voiceMicSelect.addEventListener('focus', () => this.populateVoiceMicSelect());
    }
    if (this.elements.voiceSpeakToggle) {
      try {
        this.elements.voiceSpeakToggle.checked = localStorage.getItem('jeeves_voice_speak') === '1';
      } catch (_) {}
      this.elements.voiceSpeakToggle.addEventListener('change', () => {
        try {
          localStorage.setItem('jeeves_voice_speak', this.elements.voiceSpeakToggle.checked ? '1' : '0');
        } catch (_) {}
      });
    }
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = protocol + '//' + window.location.host + '/voice';
    const setVoiceStatus = (text, state) => {
      if (this.elements.voiceStatus) {
        this.elements.voiceStatus.textContent = text;
        this.elements.voiceStatus.className = 'voice-status ' + (state || 'ready');
      }
    };
    const setVoiceStatusReady = () => {
      if (this.elements.voiceWakeToggle?.checked && this.voiceWakeStream)
        setVoiceStatus('Listening for Hey Jeeves…', 'listening');
      else
        setVoiceStatus('READY', 'ready');
    };
    const wakeWaitHint = document.getElementById('voice-wake-wait-hint');
    if (this.elements.voiceWakeToggle) {
      this.elements.voiceWakeToggle.disabled = true;
      if (wakeWaitHint) wakeWaitHint.style.display = 'inline';
      console.log('[Voice] Hey Jeeves checkbox disabled until voice READY');
    }
    setVoiceStatus('CONNECTING…', '');
    this.voiceWs = new WebSocket(wsUrl);
    this.voiceWs.onopen = () => {
      setVoiceStatus('READY', 'ready');
      if (this.elements.voiceWakeToggle) {
        this.elements.voiceWakeToggle.disabled = false;
        if (wakeWaitHint) wakeWaitHint.style.display = 'none';
        console.log('[Voice] READY – Hey Jeeves checkbox enabled');
      }
      if (this.wakeStreamRequestedWhenReady) {
        this.wakeStreamRequestedWhenReady = false;
        this.voiceWakeStream = new VoiceWakeStream((b64) => {
          if (this.voiceWs && this.voiceWs.readyState === 1)
            this.voiceWs.send(JSON.stringify({ type: 'wake_stream_chunk', pcm: b64 }));
        });
        this.voiceWakeStreamPending = true;
        this.voiceWs.send(JSON.stringify({ type: 'wake_stream_start' }));
        console.log('[Voice] Sending wake_stream_start (deferred from before READY)');
      }
    };
    this.voiceWs.onclose = () => {
      setVoiceStatus('DISCONNECTED', 'error');
      if (this.elements.voiceWakeToggle) {
        this.elements.voiceWakeToggle.disabled = true;
        this.elements.voiceWakeToggle.checked = false;
        if (wakeWaitHint) wakeWaitHint.style.display = 'inline';
      }
      this.wakeStreamRequestedWhenReady = false;
    };
    this.voiceWs.onerror = () => {
      setVoiceStatus('CONNECTION FAILED', 'error');
      this.log('error', 'Voice: could not connect to /voice. Check that voice is enabled (VOICE_ENABLED=true) and refresh.');
      if (this.elements.voiceWakeToggle) {
        this.elements.voiceWakeToggle.disabled = true;
        this.elements.voiceWakeToggle.checked = false;
        if (wakeWaitHint) wakeWaitHint.style.display = 'inline';
      }
      this.wakeStreamRequestedWhenReady = false;
      if (this.voiceWs) this.voiceWs.close();
    };
    this.voiceWs.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'transcript' && msg.text) {
          // User voice input; not logged to console to reduce noise.
        }
        if (msg.type === 'status') setVoiceStatus('THINKING…', 'processing');
        if (msg.type === 'voice_response') {
          if (msg.text) this.log('response', msg.text);
          if (msg.audio) {
            const bytes = new Uint8Array(atob(msg.audio).split('').map(c => c.charCodeAt(0)));
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)).then(decoded => {
              const src = ctx.createBufferSource();
              src.buffer = decoded;
              src.connect(ctx.destination);
              src.start(0);
              src.onended = () => setVoiceStatusReady();
            }).catch(() => setVoiceStatusReady());
          } else setVoiceStatusReady();
        }
        if (msg.type === 'voice_audio' && msg.audio) {
          setVoiceStatus('SPEAKING…', 'processing');
          const bytes = new Uint8Array(atob(msg.audio).split('').map(c => c.charCodeAt(0)));
          const ctx = new (window.AudioContext || window.webkitAudioContext)();
          ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)).then(decoded => {
            const src = ctx.createBufferSource();
            src.buffer = decoded;
            src.connect(ctx.destination);
            src.start(0);
            src.onended = () => setVoiceStatusReady();
          }).catch(() => setVoiceStatusReady());
        }
        if (msg.type === 'error') {
          if (msg.message && !/Wake model not found|wake.*script|Wake listener failed/.test(msg.message))
            this.log('error', msg.message || 'Voice error');
          setVoiceStatusReady();
          const wakeErr = msg.message && (msg.message.includes('Wake') || msg.message.includes('wake'));
          if (wakeErr && this.elements.voiceWakeToggle?.checked) {
            this.elements.voiceWakeToggle.checked = false;
            if (this.voiceWakeStream) {
              this.voiceWakeStream.stop();
              this.voiceWakeStream = null;
            }
            this.voiceWakeStreamPending = false;
            this.voiceWs.send(JSON.stringify({ type: 'wake_stream_stop' }));
          }
        }
        if (msg.type === 'wake_stream_ready') {
          if (this.voiceWakeStream && this.voiceWakeStreamPending) {
            this.voiceWakeStream.start(this.getPreferredVoiceDeviceId()).then(() => {
              setVoiceStatus('Listening for Hey Jeeves…', 'listening');
            }).catch(() => {
              this.voiceWakeStreamPending = false;
            });
            this.voiceWakeStreamPending = false;
          }
        }
        if (msg.type === 'wake_detected') {
          if (!this.voiceWakeStream || this.recordingAfterWake) return;
          this.recordingAfterWake = true;
          setVoiceStatus('LISTENING…', 'listening');
          this.elements.voiceHoldBtn?.classList.add('recording');
          this.voiceRecorder.start(this.getPreferredVoiceDeviceId()).catch(() => {
            this.recordingAfterWake = false;
            this.elements.voiceHoldBtn?.classList.remove('recording');
            setVoiceStatusReady();
          });
          setTimeout(() => {
            this.elements.voiceHoldBtn?.classList.remove('recording');
            this.voiceRecorder.stop().then((wavBuffer) => {
              const minBytes = 44 + 16000 * 0.5 * 2; // 0.5s 16kHz mono
              if (wavBuffer && wavBuffer.byteLength >= minBytes && this.voiceWs && this.voiceWs.readyState === 1) {
                const bytes = new Uint8Array(wavBuffer);
                let binary = '';
                for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
                this.voiceWs.send(JSON.stringify({ type: 'audio_command', audio: btoa(binary), format: 'wav', timestamp: Date.now() }));
                setVoiceStatus('THINKING…', 'processing');
              } else {
                setVoiceStatusReady();
              }
              setTimeout(() => { this.recordingAfterWake = false; }, 500);
            }).catch(() => { setVoiceStatusReady(); this.recordingAfterWake = false; });
          }, 4000);
        }
      } catch (e) { /* ignore */ }
    };
    this.voiceRecorder = new VoiceRecorder();
    const UseBrowserSTT = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
    let browserRecognition = null;
    if (UseBrowserSTT) {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      browserRecognition = new SR();
      browserRecognition.continuous = false;
      browserRecognition.interimResults = false;
      browserRecognition.lang = 'en-US';
      browserRecognition.onresult = (event) => {
        const result = event.results[event.results.length - 1];
        const transcript = (result && result[0] && result[0].transcript) ? result[0].transcript.trim() : '';
        if (transcript && this.voiceWs && this.voiceWs.readyState === 1) {
          this.voiceWs.send(JSON.stringify({ type: 'text_command', text: transcript, timestamp: Date.now() }));
          setVoiceStatus('THINKING…', 'processing');
        } else {
          setVoiceStatus('READY', 'ready');
        }
      };
      browserRecognition.onerror = (event) => {
        if (event.error !== 'aborted') this.log('error', 'Voice: ' + (event.error || 'recognition error'));
        setVoiceStatusReady();
      };
      browserRecognition.onend = () => {
        this.elements.voiceHoldBtn?.classList.remove('recording');
      };
    }
    let voiceHoldStartedAt = 0;
    const MIN_HOLD_MS = 400;
    const onHoldStart = () => {
      if (!this.voiceWs || this.voiceWs.readyState !== 1) {
        setVoiceStatus('NOT CONNECTED', 'error');
        this.log('error', 'Voice: not connected. Refresh the page and allow the connection, or check VOICE_ENABLED on the server.');
        return;
      }
      voiceHoldStartedAt = 0;
      setVoiceStatus('LISTENING…', 'listening');
      this.elements.voiceHoldBtn?.classList.add('recording');
      if (UseBrowserSTT && browserRecognition) {
        try {
          browserRecognition.start();
          voiceHoldStartedAt = Date.now();
        } catch (e) {
          this.elements.voiceHoldBtn?.classList.remove('recording');
          this.log('error', 'Voice: ' + (e && e.message ? e.message : 'Speech recognition failed'));
          setVoiceStatusReady();
        }
        return;
      }
      this.voiceRecorder.start(this.getPreferredVoiceDeviceId()).then(() => {
        voiceHoldStartedAt = Date.now();
      }).catch((err) => {
        voiceHoldStartedAt = 0;
        this.elements.voiceHoldBtn?.classList.remove('recording');
        const msg = (err && err.name === 'NotAllowedError') ? 'Microphone access denied. Use the lock/site icon in the address bar to allow mic.' : (err && err.message) ? err.message : 'Microphone error';
        setVoiceStatus('MIC DENIED', 'error');
        this.log('error', 'Voice: ' + msg);
      });
    };
    const MIN_WAV_BYTES = 44 + 16000 * 0.5 * 2;
    const onHoldEnd = () => {
      if (UseBrowserSTT && browserRecognition) {
        try { browserRecognition.stop(); } catch (_) {}
        return;
      }
      this.elements.voiceHoldBtn?.classList.remove('recording');
      const heldLongEnough = voiceHoldStartedAt > 0 && (Date.now() - voiceHoldStartedAt) >= MIN_HOLD_MS;
      this.voiceRecorder.stop().then((wavBuffer) => {
        if (wavBuffer && wavBuffer.byteLength >= MIN_WAV_BYTES && this.voiceWs && this.voiceWs.readyState === 1) {
          const bytes = new Uint8Array(wavBuffer);
          let binary = '';
          for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
          this.voiceWs.send(JSON.stringify({ type: 'audio_command', audio: btoa(binary), format: 'wav', timestamp: Date.now() }));
          setVoiceStatus('THINKING…', 'processing');
        } else {
          setVoiceStatusReady();
        }
      }).catch(() => setVoiceStatusReady());
    };
    this.elements.voiceHoldBtn.addEventListener('mousedown', onHoldStart);
    this.elements.voiceHoldBtn.addEventListener('mouseup', onHoldEnd);
    this.elements.voiceHoldBtn.addEventListener('mouseleave', onHoldEnd);
    this.elements.voiceHoldBtn.addEventListener('touchstart', (e) => { e.preventDefault(); onHoldStart(); });
    this.elements.voiceHoldBtn.addEventListener('touchend', (e) => { e.preventDefault(); onHoldEnd(); });

    if (this.elements.voiceWakeToggle) {
      this.elements.voiceWakeToggle.addEventListener('change', () => {
        if (this.elements.voiceWakeToggle.checked) {
          if (!this.voiceWs || this.voiceWs.readyState !== 1) {
            this.wakeStreamRequestedWhenReady = true;
            console.log('[Voice] Hey Jeeves checked before READY – will send when connected');
            return;
          }
          this.voiceWakeStream = new VoiceWakeStream((b64) => {
            if (this.voiceWs && this.voiceWs.readyState === 1)
              this.voiceWs.send(JSON.stringify({ type: 'wake_stream_chunk', pcm: b64 }));
          });
          this.voiceWakeStreamPending = true;
          this.voiceWs.send(JSON.stringify({ type: 'wake_stream_start' }));
          console.log('[Voice] Sending wake_stream_start');
        } else {
          this.wakeStreamRequestedWhenReady = false;
          if (this.voiceWakeStream) {
            this.voiceWakeStream.stop();
            this.voiceWakeStream = null;
          }
          this.voiceWakeStreamPending = false;
          if (this.voiceWs && this.voiceWs.readyState === 1)
            this.voiceWs.send(JSON.stringify({ type: 'wake_stream_stop' }));
          setVoiceStatus('READY', 'ready');
        }
      });
    }
    const recordTestPcmBtn = document.getElementById('voice-record-test-pcm');
    if (recordTestPcmBtn) {
      recordTestPcmBtn.addEventListener('click', () => {
        recordTestPcmBtn.disabled = true;
        recordTestPcmBtn.textContent = 'Recording 2s…';
        recordTestPCM(2000)
          .then((pcm) => {
            const bytes = new Uint8Array(pcm.buffer);
            let binary = '';
            for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
            const pcmBase64 = btoa(binary);
            const apiUrl = window.location.origin + '/api/voice/test-wake';
            return fetch(apiUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ pcm: pcmBase64 })
            }).then((r) => r.json()).then((result) => ({ result, pcm }));
          })
          .then(({ result, pcm }) => {
            if (result.error) {
              this.log('error', 'Wake test: ' + result.error);
              return;
            }
            const now = new Date();
            const stamp = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0') + '_' + String(now.getHours()).padStart(2, '0') + '-' + String(now.getMinutes()).padStart(2, '0') + '-' + String(now.getSeconds()).padStart(2, '0');
            const filename = 'hey_jeeves_test_' + stamp + '.pcm';
            const blob = new Blob([pcm.buffer], { type: 'application/octet-stream' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = filename;
            a.click();
            URL.revokeObjectURL(a.href);
          })
          .catch((err) => this.log('error', 'Record/test failed: ' + (err && err.message ? err.message : 'allow microphone')))
          .finally(() => {
            recordTestPcmBtn.disabled = false;
            recordTestPcmBtn.textContent = 'Record test PCM (2s)';
          });
      });
    }
  }
  
  updateProjects(projects) {
    this.elements.projectsCount.textContent = projects.length;
    
    if (projects.length === 0) {
      this.elements.projectsList.innerHTML = '<div class="loading">No projects found</div>';
      return;
    }
    
    this.elements.projectsList.innerHTML = projects.map(project => `
      <div class="project-item" data-path="${project.path}" data-name="${project.name}">
        <div class="project-name">${project.name}</div>
        <div class="project-type">${project.type}</div>
      </div>
    `).join('');
    
    this.elements.projectsList.querySelectorAll('.project-item').forEach(item => {
      item.addEventListener('click', () => {
        const name = item.dataset.name;
        this.sendCommand(`open ${name}`);
      });
    });
  }
  
  handleLog(log) {
    if (log.level === 'debug') return;
    if (!log.message || log.message.trim() === '') return;
    // Only show server errors in the UI; skip info/warn to reduce noise.
    if (log.level !== 'error') return;
    const msg = log.message;
    const SUPPRESSED = [
      /^\[security-monitor\]/i,
      /^\[security-response\]/i,
      /^\[vercel-security\]/i,
    ];
    if (SUPPRESSED.some(p => p.test(msg))) return;
    this.log('error', log.message);
  }
  
  handleResponse(response) {
    this.log('response', response.response);
    if (this.elements.voiceSpeakToggle?.checked && response.response?.trim()) {
      this.requestSpeak(response.response.trim());
    }
  }
  
  handleStreamStart(payload) {
    this.activeStreamId = payload.streamId;
    this.streamContent = '';
    this.streamElement = null;
    this.streamHadContent = false;
    
    const line = document.createElement('div');
    line.className = 'console-line response streaming';
    line.id = `stream-${payload.streamId}`;
    
    const timestamp = document.createElement('span');
    timestamp.className = 'timestamp';
    timestamp.textContent = `[${new Date().toLocaleTimeString()}]`;
    
    const message = document.createElement('span');
    message.className = 'message stream-content';
    
    line.appendChild(timestamp);
    line.appendChild(message);
    this.elements.consoleOutput.appendChild(line);
    this.scrollToBottom();
    
    this.streamElement = message;
  }
  
  handleStreamChunk(payload) {
    if (payload.streamId !== this.activeStreamId) return;
    
    this.streamContent += payload.chunk;
    this.streamHadContent = true;
    
    if (this.streamElement) {
      this.streamElement.textContent = this.streamContent;
      this.scrollToBottom();
    }
  }
  
  handleStreamEnd(payload) {
    if (payload.streamId !== this.activeStreamId) return;
    
    if (!this.streamHadContent && this.streamElement) {
      const line = this.streamElement.parentElement;
      if (line) line.remove();
    } else if (this.streamElement && this.streamContent) {
      const line = this.streamElement.parentElement;
      line.classList.remove('streaming');
      
      this.streamElement.innerHTML = '';
      
      let content = this.streamContent;
      const thinkingMatch = content.match(/\[Thinking\]\s*([^\n]+(?:\n(?!\n)[^\n]+)*)/i);
      
      if (thinkingMatch) {
        const thinkingDiv = document.createElement('div');
        thinkingDiv.className = 'thinking-block';
        thinkingDiv.innerHTML = `<span class="thinking-icon">💭</span> ${this.escapeHtml(thinkingMatch[1])}`;
        this.streamElement.appendChild(thinkingDiv);
        content = content.replace(thinkingMatch[0], '').trim();
      }
      
      if (typeof marked !== 'undefined' && (content.includes('##') || content.includes('**') || content.includes('```'))) {
        const contentDiv = document.createElement('div');
        contentDiv.innerHTML = marked.parse(content);
        contentDiv.classList.add('markdown-content');
        this.streamElement.appendChild(contentDiv);
      } else {
        const textNode = document.createTextNode(content);
        this.streamElement.appendChild(textNode);
      }
    }
    
    if (this.elements.voiceSpeakToggle?.checked && this.streamContent.trim()) {
      this.requestSpeak(this.streamContent.trim());
    }
    this.lastStreamId = this.activeStreamId;
    this.lastStreamHadContent = this.streamHadContent;
    this.activeStreamId = null;
    this.streamContent = '';
    this.streamElement = null;
    this.streamHadContent = false;
  }

  requestSpeak(text) {
    if (!text) return;
    fetch('/api/voice/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    }).then(r => {
      if (!r.ok) return r.json().then(d => { throw new Error(d.error || r.statusText); });
      return r.json();
    }).then(data => {
      if (!data.audio) return;
      const bytes = new Uint8Array(atob(data.audio).split('').map(c => c.charCodeAt(0)));
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)).then(decoded => {
        const src = ctx.createBufferSource();
        src.buffer = decoded;
        src.connect(ctx.destination);
        src.start(0);
      }).catch(() => {});
    }).catch(() => {});
  }
  
  scrollToBottom() {
    this.elements.consoleOutput.scrollTop = this.elements.consoleOutput.scrollHeight;
  }
  
  updateConnectionStatus(status) {
    const badge = this.elements.connectionStatus;
    const statusText = badge.querySelector('.status-text');
    badge.className = `status-badge ${status}`;
    statusText.textContent = status.toUpperCase();
  }
  
  setupEventListeners() {
    this.elements.commandForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const command = this.elements.commandInput.value.trim();
      if (command) {
        this.sendCommand(command);
        this.elements.commandInput.value = '';
        this.autoResizeTextarea();
      }
    });
    
    this.elements.commandInput.addEventListener('input', () => {
      this.autoResizeTextarea();
    });
    
    this.elements.commandInput.addEventListener('paste', () => {
      requestAnimationFrame(() => {
        this.autoResizeTextarea();
        setTimeout(() => this.autoResizeTextarea(), 50);
      });
    });
    
    this.elements.commandInput.addEventListener('drop', () => {
      requestAnimationFrame(() => {
        this.autoResizeTextarea();
      });
    });
    
    this.elements.commandInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.elements.commandForm.dispatchEvent(new Event('submit'));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.navigateHistory('up');
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.navigateHistory('down');
        return;
      }
    });
    
    document.querySelectorAll('.cmd-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const command = btn.dataset.command;
        if (command) this.sendCommand(command);
      });
    });
    
    this.elements.refreshProjects.addEventListener('click', () => {
      this.sendCommand('list projects');
    });
    
    this.elements.applyBtn?.addEventListener('click', () => {
      this.sendCommand('apply');
    });
    
    this.elements.rejectBtn?.addEventListener('click', () => {
      this.sendCommand('reject');
    });
    
    this.elements.attachBtn?.addEventListener('click', () => {
      this.elements.fileInput?.click();
    });
    
    this.elements.fileInput?.addEventListener('change', (e) => {
      this.handleFileSelection(e.target.files);
    });
    
    this.elements.commandInput?.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.currentTarget.style.borderColor = 'var(--accent-purple)';
    });
    
    this.elements.commandInput?.addEventListener('dragleave', (e) => {
      e.currentTarget.style.borderColor = '';
    });
    
    this.elements.commandInput?.addEventListener('drop', (e) => {
      e.preventDefault();
      e.currentTarget.style.borderColor = '';
      if (e.dataTransfer.files.length > 0) {
        this.handleFileSelection(e.dataTransfer.files);
      }
    });
  }
  
  async handleFileSelection(files) {
    for (const file of files) {
      if (file.size > 5 * 1024 * 1024) {
        this.log('error', `File ${file.name} is too large (max 5MB)`);
        continue;
      }
      if (this.attachedFiles.some(f => f.name === file.name)) continue;
      
      const fileData = await this.readFile(file);
      if (fileData) {
        this.attachedFiles.push(fileData);
        this.renderAttachmentPreview();
      }
    }
    if (this.elements.fileInput) this.elements.fileInput.value = '';
  }
  
  async readFile(file) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      const isImage = file.type.startsWith('image/');
      
      reader.onload = (e) => {
        resolve({ name: file.name, type: file.type, size: file.size, content: e.target.result, isImage });
      };
      reader.onerror = () => {
        this.log('error', `Failed to read file: ${file.name}`);
        resolve(null);
      };
      
      if (isImage) reader.readAsDataURL(file);
      else reader.readAsText(file);
    });
  }
  
  renderAttachmentPreview() {
    if (!this.elements.attachmentsPreview) return;
    this.elements.attachmentsPreview.innerHTML = this.attachedFiles.map((file, index) => {
      const icon = this.getFileIcon(file.name);
      const size = this.formatFileSize(file.size);
      if (file.isImage) {
        return `<div class="attachment-item" data-index="${index}">
          <img src="${file.content}" alt="${file.name}" class="attachment-image-preview">
          <span class="file-name">${file.name}</span>
          <span class="file-size">${size}</span>
          <button class="remove-btn" onclick="commandCenter.removeAttachment(${index})">×</button>
        </div>`;
      }
      return `<div class="attachment-item" data-index="${index}">
        <span class="file-icon">${icon}</span>
        <span class="file-name">${file.name}</span>
        <span class="file-size">${size}</span>
        <button class="remove-btn" onclick="commandCenter.removeAttachment(${index})">×</button>
      </div>`;
    }).join('');
  }
  
  getFileIcon(filename) {
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    const icons = { 'md':'📝','txt':'📄','json':'📋','xml':'📰','csv':'📊','doc':'📃','docx':'📃','png':'🖼️','jpg':'🖼️','jpeg':'🖼️','gif':'🖼️','webp':'🖼️' };
    return icons[ext] || '📎';
  }
  
  formatFileSize(bytes) {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }
  
  removeAttachment(index) {
    this.attachedFiles.splice(index, 1);
    this.renderAttachmentPreview();
  }
  
  clearAttachments() {
    this.attachedFiles = [];
    this.renderAttachmentPreview();
  }
  
  updatePendingChanges(changes) {
    this.pendingChanges = changes || [];
    if (this.pendingChanges.length === 0) {
      this.elements.changesCount.textContent = '0 files';
      this.elements.changesContent.innerHTML = '<div class="no-changes">No pending changes</div>';
      this.elements.changesActions.style.display = 'none';
      return;
    }
    this.elements.changesCount.textContent = `${this.pendingChanges.length} file(s)`;
    this.elements.changesActions.style.display = 'flex';
    
    let html = '';
    for (const change of this.pendingChanges) {
      const fileName = change.filePath.split(/[\\/]/).pop();
      const relativePath = change.filePath.replace(/.*YOUR_CURSOR_AI_DIRECTORY[\\/]/, '');
      html += `<div class="change-file">
        <div class="change-file-header">
          <span class="change-file-path">${fileName}</span>
          <span class="change-file-status">${relativePath}</span>
        </div>
        <div class="change-diff">${this.renderDiff(change.originalContent, change.newContent)}</div>
      </div>`;
    }
    this.elements.changesContent.innerHTML = html;
  }
  
  renderDiff(original, modified) {
    const lines = [];
    if (original) {
      const origLines = original.split('\n');
      const newLines = modified.split('\n');
      const maxLen = Math.max(origLines.length, newLines.length);
      for (let i = 0; i < maxLen; i++) {
        if (i < origLines.length && origLines[i]) {
          lines.push(`<div class="diff-line removed">- ${this.escapeHtml(origLines[i])}</div>`);
        }
      }
      for (let i = 0; i < newLines.length; i++) {
        if (newLines[i]) {
          lines.push(`<div class="diff-line added">+ ${this.escapeHtml(newLines[i])}</div>`);
        }
      }
    } else {
      const newLines = modified.split('\n');
      for (const line of newLines) {
        lines.push(`<div class="diff-line added">+ ${this.escapeHtml(line)}</div>`);
      }
    }
    return lines.join('');
  }
  
  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
  
  autoResizeTextarea() {
    const textarea = this.elements.commandInput;
    const scrollTop = textarea.scrollTop;
    textarea.style.height = '0';
    const newHeight = Math.max(24, Math.min(textarea.scrollHeight, 200));
    textarea.style.height = newHeight + 'px';
    textarea.scrollTop = scrollTop;
  }
  
  navigateHistory(direction) {
    if (this.commandHistory.length === 0) return;
    const input = this.elements.commandInput;
    
    if (direction === 'up') {
      if (this.historyIndex === -1) this.currentInput = input.value;
      if (this.historyIndex < this.commandHistory.length - 1) {
        this.historyIndex++;
        input.value = this.commandHistory[this.historyIndex];
        this.autoResizeTextarea();
        input.selectionStart = input.selectionEnd = input.value.length;
      }
    } else if (direction === 'down') {
      if (this.historyIndex > 0) {
        this.historyIndex--;
        input.value = this.commandHistory[this.historyIndex];
        this.autoResizeTextarea();
        input.selectionStart = input.selectionEnd = input.value.length;
      } else if (this.historyIndex === 0) {
        this.historyIndex = -1;
        input.value = this.currentInput;
        this.autoResizeTextarea();
        input.selectionStart = input.selectionEnd = input.value.length;
      }
    }
  }
  
  async sendCommand(command) {
    this.addToHistory(command);
    
    // Show the command in chat
    this.log('command', command);
    
    // Show attached files as visual previews in chat
    if (this.attachedFiles.length > 0) {
      for (const file of this.attachedFiles) {
        if (file.isImage && file.content) {
          // Show image thumbnail in chat
          this.logAttachment(file.name, file.content);
        }
      }
    }
    
    try {
      const requestBody = { 
        content: command,
        attachments: this.attachedFiles.map(f => ({ name: f.name, type: f.type, content: f.content, isImage: f.isImage }))
      };
      
      const response = await fetch('/api/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });
      
      const data = await response.json();
      if (!data.success) {
        this.log('error', data.error || 'Command failed');
      }
      this.elements.lastCommand.textContent = `Last: ${command} at ${new Date().toLocaleTimeString()}`;
      this.clearAttachments();
    } catch (error) {
      this.log('error', `Failed to send command: ${error.message}`);
    }
  }
  
  logAttachment(name, dataUrl) {
    const line = document.createElement('div');
    line.className = 'console-line system';
    
    const timestamp = document.createElement('span');
    timestamp.className = 'timestamp';
    timestamp.textContent = `[${new Date().toLocaleTimeString()}]`;
    
    const messageSpan = document.createElement('span');
    messageSpan.className = 'message';
    
    const label = document.createElement('div');
    label.textContent = `Attached: ${name}`;
    label.style.marginBottom = '4px';
    messageSpan.appendChild(label);
    
    const img = document.createElement('img');
    img.src = dataUrl;
    img.alt = name;
    img.style.maxWidth = '300px';
    img.style.maxHeight = '200px';
    img.style.borderRadius = '4px';
    img.style.border = '1px solid rgba(0, 240, 255, 0.3)';
    messageSpan.appendChild(img);
    
    line.appendChild(timestamp);
    line.appendChild(messageSpan);
    this.elements.consoleOutput.appendChild(line);
    this.elements.consoleOutput.scrollTop = this.elements.consoleOutput.scrollHeight;
  }
  
  formatFileSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  
  log(type, message) {
    if (!message || message.trim() === '') return;
    
    const line = document.createElement('div');
    line.className = `console-line ${type}`;
    
    const timestamp = document.createElement('span');
    timestamp.className = 'timestamp';
    timestamp.textContent = `[${new Date().toLocaleTimeString()}]`;
    
    const messageSpan = document.createElement('span');
    messageSpan.className = 'message';
    
    let processedMessage = message;
    let thinkingContent = null;
    
    const thinkingMatch = message.match(/\[Thinking\]\s*(.*?)(?=\n\n|$)/s);
    if (thinkingMatch) {
      thinkingContent = thinkingMatch[1].trim();
      processedMessage = message.replace(thinkingMatch[0], '').trim();
    }
    
    processedMessage = this.processTaskLabels(processedMessage);
    
    const isMarkdown = type === 'response' && 
      (processedMessage.includes('##') || processedMessage.includes('**') || 
       processedMessage.includes('```') || processedMessage.length > 200);
    
    if (thinkingContent) {
      const thinkingDiv = document.createElement('div');
      thinkingDiv.className = 'thinking-block';
      thinkingDiv.innerHTML = `<span class="thinking-icon">💭</span> ${this.escapeHtml(thinkingContent)}`;
      messageSpan.appendChild(thinkingDiv);
    }
    
    if (isMarkdown && typeof marked !== 'undefined') {
      const contentDiv = document.createElement('div');
      contentDiv.innerHTML = marked.parse(processedMessage);
      contentDiv.classList.add('markdown-content');
      messageSpan.appendChild(contentDiv);
    } else {
      const contentDiv = document.createElement('div');
      contentDiv.innerHTML = processedMessage;
      messageSpan.appendChild(contentDiv);
    }
    
    line.appendChild(timestamp);
    line.appendChild(messageSpan);
    this.elements.consoleOutput.appendChild(line);
    this.elements.consoleOutput.scrollTop = this.elements.consoleOutput.scrollHeight;
    
    while (this.elements.consoleOutput.children.length > 100) {
      this.elements.consoleOutput.removeChild(this.elements.consoleOutput.firstChild);
    }
  }
  
  processTaskLabels(text) {
    text = this.escapeHtml(text);
    text = text.replace(/\[(Active|In Progress):\s*([^\]]+)\]/gi, '<span class="task-badge task-active">🔄 $2</span>');
    text = text.replace(/\[(Complete|Done):\s*([^\]]+)\]/gi, '<span class="task-badge task-complete">✅ $2</span>');
    text = text.replace(/&lt;CHANGE&gt;\s*([^<\n]+)/gi, '<span class="change-marker">📝 $1</span>');
    return text;
  }
  
  startUptimeTimer() {
    setInterval(() => {
      if (this.startTime) {
        const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
        const hours = Math.floor(elapsed / 3600).toString().padStart(2, '0');
        const minutes = Math.floor((elapsed % 3600) / 60).toString().padStart(2, '0');
        const seconds = (elapsed % 60).toString().padStart(2, '0');
        this.elements.uptime.textContent = `UPTIME: ${hours}:${minutes}:${seconds}`;
      }
    }, 1000);
  }
}

// ============================================================================
// Homelab Dashboard
// ============================================================================
class HomelabDashboard {
  constructor(commandCenter) {
    this.cc = commandCenter;
    this.panel = document.getElementById('homelab-dashboard');
    this.refreshBtn = document.getElementById('homelab-refresh');
    this.serviceGrid = document.getElementById('service-grid');
    this.alertsContainer = document.getElementById('homelab-alerts');
    this.refreshInterval = null;
    this.lastData = null;
    this.expandedService = null;

    if (this.refreshBtn) {
      this.refreshBtn.addEventListener('click', () => this.refresh());
    }
  }

  async init() {
    try {
      const res = await fetch('/api/homelab/status');
      if (!res.ok) return;
      const data = await res.json();
      if (data.enabled) {
        this.update(data);
        this.refreshInterval = setInterval(() => this.refresh(), 300000);
      }
    } catch {
      // Homelab not available
    }
  }

  async refresh() {
    try {
      const res = await fetch('/api/homelab/status');
      if (res.ok) {
        const data = await res.json();
        this.update(data);
      }
    } catch { /* ignore */ }
  }

  update(data) {
    this.lastData = data;
    this.updateGauges(data.resources);
    this.updateHealth(data.health);
    this.updateServices(data.services);
    this.updateAlerts(data.alerts);
  }

  updateGauges(resources) {
    if (!resources) return;
    const setGauge = (id, percent, label) => {
      const fill = document.getElementById('gauge-fill-' + id);
      const value = document.getElementById('gauge-value-' + id);
      if (!fill || !value) return;
      const pct = Math.min(100, Math.max(0, percent));
      fill.style.width = pct + '%';
      fill.className = 'gauge-fill' + (pct >= 95 ? ' critical' : pct >= 80 ? ' warning' : '');
      value.textContent = label || Math.round(pct) + '%';
    };
    if (resources.cpu) setGauge('cpu', resources.cpu.usagePercent);
    if (resources.ram) setGauge('ram', resources.ram.usagePercent);
    if (resources.disk && resources.disk.length > 0) setGauge('disk', resources.disk[0].usagePercent);
    if (resources.temperature) {
      const t = resources.temperature.celsius;
      const tempPct = Math.min(100, (t / 100) * 100);
      setGauge('temp', tempPct, t + '\u00B0C');
    }
  }

  updateHealth(health) {
    if (!health) return;
    const ok = document.getElementById('health-ok');
    const bad = document.getElementById('health-bad');
    const unk = document.getElementById('health-unknown');
    if (ok) ok.textContent = health.healthy;
    if (bad) bad.textContent = health.unhealthy;
    if (unk) unk.textContent = health.unknown;
  }

  updateServices(services) {
    if (!services || !this.serviceGrid) return;
    const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    const sorted = [...services].sort((a, b) => {
      if (a.state === 'running' && b.state !== 'running') return -1;
      if (a.state !== 'running' && b.state === 'running') return 1;
      return (priorityOrder[a.priority] || 9) - (priorityOrder[b.priority] || 9);
    });

    // Homelab services serve HTTP on their port; use http so we don't force HTTPS (ERR_SSL_PROTOCOL_ERROR)
    const host = window.location.hostname;
    const getServiceUrl = (svc) => {
      if (!svc.ports || svc.ports.length === 0) return null;
      const first = svc.ports[0];
      const hostPort = typeof first === 'number' ? first : parseInt(String(first).split(':')[0], 10);
      return isNaN(hostPort) ? null : `http://${host}:${hostPort}`;
    };

    this.serviceGrid.innerHTML = sorted.map(svc => {
      const running = svc.state === 'running';
      const hasCollector = svc.hasCollector === true;
      const apiOk = svc.apiConfigured === true && svc.apiReachable === true;
      const stateClass = running && (!hasCollector || apiOk) ? 'running' : (running && hasCollector ? 'running-no-api' : (svc.state || 'unknown'));
      const dotTitle = stateClass === 'running-no-api' ? ' API not configured or unreachable. Set env in .env and ensure service is reachable.' : '';
      const detail = svc.state === 'running'
        ? (svc.memUsage || svc.ramMB + 'MB') 
        : svc.state;
      const isExpanded = this.expandedService === svc.name;
      const serviceUrl = getServiceUrl(svc);
      const nameEl = serviceUrl
        ? `<a href="${serviceUrl}" target="_blank" rel="noopener" class="service-name service-name-link" title="${svc.purpose || svc.name} (open in browser)">${svc.name}</a>`
        : `<span class="service-name" title="${svc.purpose || svc.name}">${svc.name}</span>`;
      return `<div class="service-card ${isExpanded ? 'expanded' : ''}" data-service="${svc.name}">
        <div class="service-card-header">
          <span class="service-status-dot ${stateClass}" title="${dotTitle}"></span>
          ${nameEl}
          ${isExpanded ? '<button class="service-collapse-btn" data-collapse="true">&#9660;</button>' : ''}
        </div>
        <div class="service-detail">${detail}</div>
        <div class="service-deep-dive" id="deep-dive-${svc.name}">
          ${isExpanded ? '<div class="loading">Loading details...</div>' : ''}
        </div>
        <div class="service-actions">
          ${svc.state === 'running' 
            ? `<button class="svc-action-btn danger" onclick="event.stopPropagation();window.commandCenter.sendCommand('restart ${svc.name}')">R</button>
               <button class="svc-action-btn danger" onclick="event.stopPropagation();window.commandCenter.sendCommand('stop ${svc.name}')">S</button>`
            : `<button class="svc-action-btn" onclick="event.stopPropagation();window.commandCenter.sendCommand('start ${svc.name}')">&#9654;</button>`
          }
        </div>
      </div>`;
    }).join('');

    // Add click handlers for expansion
    this.serviceGrid.querySelectorAll('.service-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.svc-action-btn') || e.target.closest('.service-name-link')) return;
        const name = card.dataset.service;
        if (e.target.dataset.collapse) {
          this.collapseService();
          return;
        }
        if (this.expandedService === name) {
          this.collapseService();
        } else {
          this.expandService(name);
        }
      });
    });
  }

  async expandService(name) {
    this.expandedService = name;
    if (this.lastData) this.updateServices(this.lastData.services);

    // Fetch deep-dive data
    try {
      const res = await fetch(`/api/homelab/service/${name}`);
      if (res.ok) {
        const data = await res.json();
        this.renderDeepDive(name, data);
      } else {
        this.renderDeepDive(name, null);
      }
    } catch {
      this.renderDeepDive(name, null);
    }
  }

  collapseService() {
    this.expandedService = null;
    if (this.lastData) this.updateServices(this.lastData.services);
  }

  renderDeepDive(name, data) {
    const container = document.getElementById(`deep-dive-${name}`);
    if (!container) return;

    if (!data || data.error) {
      container.innerHTML = `<div class="deep-dive-unavailable">${data?.error || 'No detailed data available for this service'}</div>`;
      return;
    }

    let html = '';
    // Render key-value pairs from data
    const skipKeys = ['name', 'type'];
    for (const [key, value] of Object.entries(data)) {
      if (skipKeys.includes(key)) continue;
      if (Array.isArray(value)) {
        html += `<div class="deep-dive-section"><h4>${key.toUpperCase()}</h4>`;
        for (const item of value.slice(0, 50)) {
          if (typeof item === 'object') {
            const label = item.title || item.name || item.message || JSON.stringify(item);
            const statusPart = item.status ? String(item.status) : '';
            const progressPart = item.progress != null ? `${item.progress || 0}%` : '';
            const extra = [statusPart, progressPart].filter(Boolean).join(' · ');
            const subtext = item.extra ?? item.image;
            html += `<div class="deep-dive-list-item"><span>${this.cc.escapeHtml(String(label))}</span><span>${this.cc.escapeHtml(extra)}</span></div>`;
            if (subtext) {
              html += `<div class="deep-dive-list-subtext">${this.cc.escapeHtml(String(subtext))}</div>`;
            }
            if (item.progress != null) {
              html += `<div class="deep-dive-progress"><div class="deep-dive-progress-fill" style="width:${item.progress}%"></div></div>`;
            }
          } else {
            html += `<div class="deep-dive-list-item"><span>${this.cc.escapeHtml(String(item))}</span></div>`;
          }
        }
        html += '</div>';
      } else if (typeof value === 'object' && value !== null) {
        html += `<div class="deep-dive-section"><h4>${key.toUpperCase()}</h4>`;
        for (const [k, v] of Object.entries(value)) {
          html += `<div class="deep-dive-row"><span class="dd-label">${k}</span><span class="dd-value">${v}</span></div>`;
        }
        html += '</div>';
      } else {
        html += `<div class="deep-dive-row"><span class="dd-label">${key}</span><span class="dd-value">${value}</span></div>`;
      }
    }
    container.innerHTML = html || '<div class="deep-dive-unavailable">No detailed data available</div>';
  }

  updateAlerts(alerts) {
    if (!this.alertsContainer) return;
    if (!alerts || alerts.length === 0) {
      this.alertsContainer.innerHTML = '';
      return;
    }
    this.alertsContainer.innerHTML = alerts.map(a => {
      const cls = a.toLowerCase().includes('critical') ? 'critical' : 'warning';
      return `<div class="homelab-alert ${cls}">${a}</div>`;
    }).join('');
  }

  handleWSMessage(data) {
    if (data.type === 'homelab_status' && data.payload) {
      if (data.payload.enabled) {
        this.update(data.payload);
      }
    }
  }
}

// ============================================================================
// Activity Panel
// ============================================================================
class ActivityPanel {
  constructor(commandCenter) {
    this.cc = commandCenter;
    this.currentBody = document.getElementById('activity-current-body');
    this.queueList = document.getElementById('activity-queue-list');
    this.standingList = document.getElementById('activity-standing-list');
    this.recentList = document.getElementById('activity-recent-list');
    this.summaryEl = document.getElementById('activity-summary');
    this.queueCount = document.getElementById('queue-count');
    this.pauseBtn = document.getElementById('activity-pause-btn');
    this.data = null;

    if (this.pauseBtn) {
      this.pauseBtn.addEventListener('click', () => {
        fetch('/api/activity/pause', { method: 'POST' }).catch(() => {});
      });
    }
  }

  async init() {
    try {
      const res = await fetch('/api/activity');
      if (res.ok) {
        const data = await res.json();
        this.update(data);
      }
    } catch { /* ignore */ }
  }

  update(data) {
    if (!data) return;
    this.data = data;
    this.renderCurrentTask(data.currentTask);
    this.renderQueue(data.queue);
    this.renderStandingOrders(data.standingOrders);
    this.renderRecent(data.history);
    this.renderSummary(data.summary);
  }

  handleEvent(type, payload) {
    // Re-fetch full state on any event
    this.init();
  }

  renderCurrentTask(task) {
    if (!this.currentBody) return;
    if (!task) {
      this.currentBody.innerHTML = '<div class="no-changes">No active task</div>';
      return;
    }
    this.currentBody.innerHTML = `
      <div class="activity-task-name">${this.cc.escapeHtml(task.name)}</div>
      <div class="activity-task-phase">Phase ${task.phase || 1}/${task.totalPhases || 1}: ${this.cc.escapeHtml(task.phaseName || '')}</div>
      <div class="activity-progress-bar"><div class="activity-progress-fill" style="width:${task.progress || 0}%"></div></div>
      <div class="activity-task-meta">
        <span>Started: ${task.startedAt ? new Date(task.startedAt).toLocaleTimeString() : '--'}</span>
        <span>Cost so far: $${(task.cost || 0).toFixed(3)}</span>
      </div>`;
  }

  renderQueue(queue) {
    if (!this.queueList) return;
    if (!queue || queue.length === 0) {
      this.queueList.innerHTML = '<div class="no-changes">Queue empty</div>';
      if (this.queueCount) this.queueCount.textContent = '0';
      return;
    }
    if (this.queueCount) this.queueCount.textContent = queue.length;
    this.queueList.innerHTML = queue.map((item, i) => `
      <div class="activity-item">
        <span class="activity-item-icon">${i + 1}.</span>
        <span class="activity-item-name">${this.cc.escapeHtml(item.name)}</span>
        <span class="activity-item-status ${item.status}">${item.status}</span>
      </div>`).join('');
  }

  renderStandingOrders(orders) {
    if (!this.standingList) return;
    if (!orders || orders.length === 0) {
      this.standingList.innerHTML = '<div class="no-changes">No standing orders</div>';
      return;
    }
    this.standingList.innerHTML = orders.map(order => `
      <div class="activity-item">
        <span class="activity-item-icon">${order.status === 'active' ? '●' : '○'}</span>
        <span class="activity-item-name">${this.cc.escapeHtml(order.name)}</span>
        <span class="activity-item-time">${order.interval || ''}</span>
        <span class="activity-item-status ${order.status}">${order.status}</span>
      </div>`).join('');
  }

  renderRecent(history) {
    if (!this.recentList) return;
    if (!history || history.length === 0) {
      this.recentList.innerHTML = '<div class="no-changes">No recent activity</div>';
      return;
    }
    this.recentList.innerHTML = history.slice(0, 20).map(item => {
      const icon = item.status === 'success' ? '✓' : item.status === 'retried' ? '↻' : '✗';
      const iconClass = item.status === 'success' ? 'color:var(--success)' : item.status === 'failed' ? 'color:var(--error)' : 'color:var(--warning)';
      return `<div class="activity-item">
        <span class="activity-item-icon" style="${iconClass}">${icon}</span>
        <span class="activity-item-name">${this.cc.escapeHtml(item.name)}</span>
        <span class="activity-item-time">${item.completedAt ? new Date(item.completedAt).toLocaleTimeString() : ''}</span>
        <span class="activity-item-cost">$${(item.cost || 0).toFixed(3)}</span>
      </div>`;
    }).join('');
  }

  renderSummary(summary) {
    if (!this.summaryEl || !summary) return;
    this.summaryEl.textContent = `TODAY: ${summary.tasks || 0} tasks · $${(summary.cost || 0).toFixed(3)} spent · ${summary.failures || 0} failures`;
  }
}

// ============================================================================
// Cost Dashboard
// ============================================================================
class CostDashboard {
  constructor() {
    this.data = null;
  }

  async init() {
    try {
      const [costsRes, budgetRes] = await Promise.all([
        fetch('/api/costs'),
        fetch('/api/costs/budget'),
      ]);
      if (costsRes.ok) {
        const data = await costsRes.json();
        this.update(data);
      }
      if (budgetRes.ok) {
        const budgetData = await budgetRes.json();
        this.updateBudget(budgetData);
      }
    } catch { /* ignore */ }
  }

  update(data) {
    if (!data) return;
    this.data = data;

    // Period bars
    this.setPeriod('daily', data.today, data.limits?.daily);
    this.setPeriod('weekly', data.week, data.limits?.weekly);
    this.setPeriod('monthly', data.month, data.limits?.monthly);

    // By model
    const modelList = document.getElementById('cost-by-model-list');
    if (modelList && data.byModel) {
      const entries = Object.entries(data.byModel);
      if (entries.length === 0) {
        modelList.innerHTML = '<div class="no-changes">No cost data yet</div>';
      } else {
        const total = entries.reduce((s, [, v]) => s + v, 0);
        modelList.innerHTML = entries.map(([name, cost]) => {
          const pct = total > 0 ? Math.round((cost / total) * 100) : 0;
          const shortName = name.includes('haiku') ? 'Haiku' : name.includes('sonnet') ? 'Sonnet' : name.includes('opus') ? 'Opus' : name;
          return `<div class="cost-breakdown-item">
            <span class="cost-breakdown-name">${shortName}</span>
            <span><span class="cost-breakdown-value">$${cost.toFixed(3)}</span><span class="cost-breakdown-pct">(${pct}%)</span></span>
          </div>`;
        }).join('');
      }
    }

    // By category
    const catList = document.getElementById('cost-by-category-list');
    if (catList && data.byCategory) {
      const entries = Object.entries(data.byCategory);
      if (entries.length === 0) {
        catList.innerHTML = '<div class="no-changes">No cost data yet</div>';
      } else {
        catList.innerHTML = entries.map(([name, cost]) => {
          return `<div class="cost-breakdown-item">
            <span class="cost-breakdown-name">${name}</span>
            <span class="cost-breakdown-value">$${cost.toFixed(3)}</span>
          </div>`;
        }).join('');
      }
    }

    // Trend
    const trendEl = document.getElementById('cost-trend');
    if (trendEl && data.trend != null) {
      const arrow = data.trend > 0 ? '▲' : data.trend < 0 ? '▼' : '';
      const cls = data.trend > 0 ? 'trend-up' : 'trend-down';
      trendEl.innerHTML = `TREND: <span class="${cls}">${arrow} ${Math.abs(data.trend)}%</span> vs last week`;
    }
  }

  setPeriod(id, value, limit) {
    const valEl = document.getElementById(`cost-${id === 'daily' ? 'today' : id === 'weekly' ? 'week' : 'month'}`);
    const limitEl = document.getElementById(`cost-limit-${id}`);
    const fillEl = document.getElementById(`cost-fill-${id}`);

    if (valEl) valEl.textContent = `$${(value || 0).toFixed(3)}`;
    if (limitEl) limitEl.textContent = `$${(limit || 0).toFixed(2)}`;
    if (fillEl) {
      const pct = limit > 0 ? Math.min(100, ((value || 0) / limit) * 100) : 0;
      fillEl.style.width = pct + '%';
      fillEl.className = 'gauge-fill' + (pct >= 95 ? ' critical' : pct >= 80 ? ' warning' : '');
    }
  }

  updateBudget(data) {
    if (!data) return;

    const dailyEl = document.getElementById('budget-daily-status');
    const hourlyEl = document.getElementById('budget-hourly-status');
    const circuitEl = document.getElementById('budget-circuit');
    const featuresEl = document.getElementById('budget-features');

    if (dailyEl && data.global) {
      const pct = data.global.dailyCap > 0 ? Math.round((data.global.dailyUsed / data.global.dailyCap) * 100) : 0;
      dailyEl.textContent = `$${data.global.dailyUsed.toFixed(3)} / $${data.global.dailyCap.toFixed(2)} (${pct}%)`;
      dailyEl.className = pct >= 95 ? 'budget-critical' : pct >= 80 ? 'budget-warning' : 'budget-ok';
    }
    if (hourlyEl && data.global) {
      const pct = data.global.hourlyCap > 0 ? Math.round((data.global.hourlyUsed / data.global.hourlyCap) * 100) : 0;
      hourlyEl.textContent = `$${data.global.hourlyUsed.toFixed(3)} / $${data.global.hourlyCap.toFixed(2)} (${pct}%)`;
      hourlyEl.className = pct >= 80 ? 'budget-warning' : 'budget-ok';
    }
    if (circuitEl && data.global) {
      circuitEl.textContent = data.global.circuitBreakerOpen ? 'OPEN (paused)' : 'OK';
      circuitEl.className = data.global.circuitBreakerOpen ? 'budget-critical' : 'budget-ok';
    }
    if (featuresEl && data.features) {
      const entries = Object.entries(data.features);
      if (entries.length === 0) {
        featuresEl.innerHTML = '<div class="no-changes">No feature budgets configured</div>';
      } else {
        featuresEl.innerHTML = entries.map(([name, fb]) => {
          const callPct = fb.maxCalls > 0 ? Math.round((fb.calls / fb.maxCalls) * 100) : 0;
          const costPct = fb.dailyCap > 0 ? Math.round((fb.costUsed / fb.dailyCap) * 100) : 0;
          const status = (costPct >= 95 || callPct >= 95) ? 'budget-critical' : (costPct >= 80 || callPct >= 80) ? 'budget-warning' : 'budget-ok';
          return `<div class="budget-feature-row ${status}">
            <span class="budget-feature-name">${name}</span>
            <span class="budget-feature-calls">${fb.calls}${fb.maxCalls > 0 ? '/' + fb.maxCalls : ''} calls</span>
            <span class="budget-feature-cost">$${fb.costUsed.toFixed(3)}${fb.dailyCap > 0 ? ' / $' + fb.dailyCap.toFixed(2) : ''}</span>
          </div>`;
        }).join('');
      }
    }
  }
}

// ============================================================================
// Project Tracker (Kanban)
// ============================================================================
class ProjectTracker {
  constructor(commandCenter) {
    this.cc = commandCenter;
    this.projects = [];
    this.activeProject = null;
    this.tabsEl = document.getElementById('project-tabs');
    this.boardEl = document.getElementById('kanban-board');
    this.footerEl = document.getElementById('kanban-footer');
    this.addBtn = document.getElementById('add-project-btn');

    if (this.addBtn) {
      this.addBtn.addEventListener('click', () => this.promptNewProject());
    }

    this.setupDragDrop();
  }

  async init() {
    try {
      const res = await fetch('/api/projects-board');
      if (res.ok) {
        const data = await res.json();
        this.projects = data.projects || [];
        if (this.projects.length > 0 && !this.activeProject) {
          this.activeProject = this.projects[0].id;
        }
        this.render();
      }
    } catch { /* ignore */ }
  }

  update(data) {
    if (data && data.projects) {
      this.projects = data.projects;
      this.render();
    }
  }

  render() {
    this.renderTabs();
    this.renderBoard();
    this.renderFooter();
  }

  renderTabs() {
    if (!this.tabsEl) return;
    this.tabsEl.innerHTML = this.projects.map(p => {
      const active = p.id === this.activeProject ? 'active' : '';
      return `<button class="project-tab ${active}" data-project="${p.id}">
        ${this.cc.escapeHtml(p.name)}
        <span class="project-tab-progress"><span class="project-tab-progress-fill" style="width:${p.progress || 0}%"></span></span>
      </button>`;
    }).join('');

    this.tabsEl.querySelectorAll('.project-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        this.activeProject = tab.dataset.project;
        this.render();
      });
    });
  }

  renderBoard() {
    const project = this.projects.find(p => p.id === this.activeProject);
    const tasks = project?.tasks || [];
    const statuses = ['backlog', 'in_progress', 'review', 'done'];

    statuses.forEach(status => {
      const container = this.boardEl.querySelector(`.kanban-cards[data-status="${status}"]`);
      const countEl = document.getElementById(`kanban-count-${status}`);
      if (!container) return;

      const statusTasks = tasks.filter(t => t.status === status);
      if (countEl) countEl.textContent = statusTasks.length;

      if (statusTasks.length === 0) {
        container.innerHTML = '';
        return;
      }

      container.innerHTML = statusTasks.map(t => `
        <div class="kanban-card" draggable="true" data-task="${t.id}">
          <div class="kanban-card-title">${this.cc.escapeHtml(t.title)}</div>
          <div class="kanban-card-meta">
            <span class="kanban-card-priority ${(t.priority || '').toLowerCase()}">${t.priority || ''}</span>
            <span class="kanban-card-points">${t.points || 0} pts</span>
          </div>
        </div>`).join('');

      // Drag handlers
      container.querySelectorAll('.kanban-card').forEach(card => {
        card.addEventListener('dragstart', (e) => {
          e.dataTransfer.setData('text/plain', card.dataset.task);
          card.classList.add('dragging');
        });
        card.addEventListener('dragend', () => {
          card.classList.remove('dragging');
        });
      });
    });
  }

  renderFooter() {
    if (!this.footerEl) return;
    const project = this.projects.find(p => p.id === this.activeProject);
    if (project) {
      const vel = project.velocity != null ? project.velocity + ' pts/week' : '-- pts/week';
      const est = project.estimatedCompletion || '--';
      this.footerEl.textContent = `VELOCITY: ${vel} · Est. completion: ${est}`;
    } else {
      this.footerEl.textContent = 'VELOCITY: -- pts/week';
    }
  }

  setupDragDrop() {
    if (!this.boardEl) return;
    this.boardEl.querySelectorAll('.kanban-cards').forEach(col => {
      col.addEventListener('dragover', (e) => {
        e.preventDefault();
        col.classList.add('drag-over');
      });
      col.addEventListener('dragleave', () => {
        col.classList.remove('drag-over');
      });
      col.addEventListener('drop', (e) => {
        e.preventDefault();
        col.classList.remove('drag-over');
        const taskId = e.dataTransfer.getData('text/plain');
        const newStatus = col.dataset.status;
        if (taskId && newStatus) {
          this.moveTask(taskId, newStatus);
        }
      });
    });
  }

  async moveTask(taskId, newStatus) {
    if (!this.activeProject) return;
    try {
      await fetch(`/api/projects-board/${this.activeProject}/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus })
      });
      this.init(); // Refresh
    } catch { /* ignore */ }
  }

  promptNewProject() {
    const name = prompt('Project name:');
    if (!name) return;
    fetch('/api/projects-board', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    }).then(() => this.init()).catch(() => {});
  }
}

// ============================================================================
// Sites Panel (Vercel)
// ============================================================================
class SitesPanel {
  constructor(commandCenter) {
    this.cc = commandCenter;
    this.gridEl = document.getElementById('sites-grid');
    this.summaryEl = document.getElementById('sites-summary');
  }

  async init() {
    try {
      const res = await fetch('/api/vercel/status');
      if (res.ok) {
        const data = await res.json();
        this.update(data);
      }
    } catch { /* ignore */ }
  }

  update(data) {
    if (!data || !data.enabled) {
      if (this.gridEl) this.gridEl.innerHTML = '<div class="no-changes">Configure VERCEL_API_TOKEN to enable site monitoring</div>';
      return;
    }

    if (!data.projects || data.projects.length === 0) {
      if (this.gridEl) this.gridEl.innerHTML = '<div class="no-changes">No Vercel projects configured</div>';
      return;
    }

    if (this.gridEl) {
      this.gridEl.innerHTML = data.projects.map(p => this.renderSiteCard(p)).join('');
    }

    if (this.summaryEl && data.summary) {
      this.summaryEl.textContent = data.summary;
    }
  }

  renderSiteCard(project) {
    const statusClass = project.production?.status === 'READY' ? 'live' : 'error';
    const statusText = project.production?.status === 'READY' ? 'LIVE' : (project.production?.status || 'UNKNOWN');

    const analytics = project.analytics || {};
    const today = analytics.today || {};
    const week = analytics.thisWeek || {};

    let deploysHtml = '';
    if (project.recentDeploys && project.recentDeploys.length > 0) {
      deploysHtml = `<div class="site-deploys"><h4>RECENT DEPLOYS</h4>
        ${project.recentDeploys.slice(0, 3).map(d => {
          const icon = d.status === 'READY' ? '✓' : '✗';
          const ago = d.created ? this.timeAgo(new Date(d.created)) : '';
          return `<div class="site-deploy-item">
            <span class="site-deploy-icon">${icon}</span>
            <span class="site-deploy-msg">${this.cc.escapeHtml(d.commit || 'No message')}</span>
            <span class="site-deploy-time">${ago}</span>
          </div>`;
        }).join('')}
      </div>`;
    }

    return `<div class="site-card">
      <div class="site-card-header">
        <div>
          <div class="site-card-name">${this.cc.escapeHtml(project.name)}</div>
          <div class="site-card-url">${project.production?.url || ''}</div>
        </div>
        <div class="site-card-status ${statusClass}">● ${statusText}</div>
      </div>
      <div class="site-card-body">
        <div class="site-stats">
          <div class="site-stat"><div class="site-stat-value">${today.visitors ?? 'N/A'}</div><div class="site-stat-label">Visitors Today</div></div>
          <div class="site-stat"><div class="site-stat-value">${week.visitors ?? 'N/A'}</div><div class="site-stat-label">Visitors This Week</div></div>
          <div class="site-stat"><div class="site-stat-value">${today.pageViews ?? 'N/A'}</div><div class="site-stat-label">Views Today</div></div>
          <div class="site-stat"><div class="site-stat-value">${week.pageViews ?? 'N/A'}</div><div class="site-stat-label">Views This Week</div></div>
        </div>
        ${deploysHtml}
      </div>
    </div>`;
  }

  timeAgo(date) {
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }
}

// ============================================================================
// Cursor Tasks Panel
// ============================================================================
class CursorPanel {
  constructor(commandCenter) {
    this.cc = commandCenter;
    this.gridEl = document.getElementById('cursor-tasks-grid');
    this.refreshBtn = document.getElementById('cursor-refresh-btn');
    this.data = { active: [], completed: [] };
    this.loaded = false;

    if (this.refreshBtn) {
      this.refreshBtn.addEventListener('click', () => this.init());
    }
  }

  async init() {
    try {
      const res = await fetch('/api/cursor/tasks');
      if (res.ok) {
        this.data = await res.json();
        this.loaded = true;
        this.render();
      }
    } catch { /* ignore */ }
  }

  handleEvent(type, payload) {
    switch (type) {
      case 'cursor:task:started':
        this.data.active.push({
          id: payload.taskId,
          agentId: payload.agentId,
          spec: { summary: payload.summary, project: payload.project, branch: payload.branch },
          status: 'running',
          startedAt: new Date().toISOString(),
          pollCount: 0,
        });
        this.render();
        break;

      case 'cursor:task:progress': {
        const task = this.data.active.find(t => t.id === payload.taskId);
        if (task) {
          task.lastMessage = payload.lastMessage;
          task.pollCount = payload.pollCount;
        }
        this.render();
        break;
      }

      case 'cursor:task:completed': {
        const idx = this.data.active.findIndex(t => t.id === payload.taskId);
        if (idx !== -1) {
          const task = this.data.active.splice(idx, 1)[0];
          task.status = 'completed';
          task.prUrl = payload.prUrl;
          task.completedAt = new Date().toISOString();
          this.data.completed.unshift(task);
        }
        this.render();
        break;
      }

      case 'cursor:task:stuck': {
        const task = this.data.active.find(t => t.id === payload.taskId);
        if (task) task.status = 'stuck';
        this.render();
        break;
      }

      case 'cursor:task:error': {
        const idx = this.data.active.findIndex(t => t.id === payload.taskId);
        if (idx !== -1) {
          const task = this.data.active.splice(idx, 1)[0];
          task.status = 'error';
          task.error = payload.error;
          this.data.completed.unshift(task);
        }
        this.render();
        break;
      }
    }
  }

  render() {
    if (!this.gridEl) return;
    const { active, completed } = this.data;

    if (active.length === 0 && completed.length === 0) {
      this.gridEl.innerHTML = '<div class="no-changes">No Cursor agents. Use "cursor build X for project" to launch one.</div>';
      return;
    }

    let html = '';

    // Active tasks
    for (const task of active) {
      const elapsed = this.formatElapsed(new Date(task.startedAt));
      const statusClass = task.status === 'running' ? 'cursor-running' : task.status === 'stuck' ? 'cursor-stuck' : '';
      const cursorUrl = task.cursorUrl || (task.agentId ? `https://cursor.com/agents?id=${task.agentId}` : '');
      html += `
        <div class="cursor-task-card ${statusClass}" data-task-id="${task.id}">
          <div class="cursor-task-header">
            <span class="cursor-task-status">
              <span class="cursor-status-dot ${task.status}"></span>
              ${task.status.toUpperCase()}
            </span>
            <span class="cursor-task-elapsed" data-started="${task.startedAt}">${elapsed}</span>
          </div>
          <div class="cursor-task-summary">${this.cc.escapeHtml(task.spec?.summary || 'Untitled task')}</div>
          <div class="cursor-task-meta">
            <span>Project: ${this.cc.escapeHtml(task.spec?.project || '-')}</span>
            <span>Agent: ${task.agentId ? task.agentId.substring(0, 12) + '...' : 'pending'}</span>
            ${cursorUrl ? `<a href="${cursorUrl}" target="_blank" class="cursor-web-link" title="View on cursor.com">CURSOR.COM</a>` : ''}
          </div>
          ${task.lastMessage ? `<div class="cursor-task-lastmsg">${this.cc.escapeHtml(task.lastMessage.substring(0, 200))}${task.lastMessage.length > 200 ? '...' : ''}</div>` : '<div class="cursor-task-lastmsg cursor-waiting">Waiting for agent output...</div>'}
          <div class="cursor-task-actions">
            <button class="cmd-btn cursor-followup-btn" data-task-id="${task.id}">FOLLOW-UP</button>
            <button class="cmd-btn cursor-stop-btn" data-task-id="${task.id}">STOP</button>
            <button class="cmd-btn cursor-view-btn" data-task-id="${task.id}" data-agent-id="${task.agentId || ''}">VIEW LOG</button>
          </div>
          <div class="cursor-conversation-panel" id="conv-${task.id}" style="display:none;"></div>
        </div>`;
    }

    // Completed tasks (last 5)
    for (const task of completed.slice(0, 5)) {
      const statusClass = task.status === 'completed' ? 'cursor-completed' : task.status === 'error' ? 'cursor-error' : 'cursor-stopped';
      const icon = task.status === 'completed' ? '✓' : task.status === 'error' ? '✗' : '■';
      const cursorUrl = task.cursorUrl || (task.agentId ? `https://cursor.com/agents?id=${task.agentId}` : '');
      html += `
        <div class="cursor-task-card ${statusClass}">
          <div class="cursor-task-header">
            <span class="cursor-task-status">
              <span class="cursor-status-icon">${icon}</span>
              ${task.status.toUpperCase()}
            </span>
            <span class="cursor-task-elapsed">${task.completedAt ? this.timeAgo(new Date(task.completedAt)) : ''}</span>
          </div>
          <div class="cursor-task-summary">${this.cc.escapeHtml(task.spec?.summary || 'Untitled task')}</div>
          <div class="cursor-task-meta">
            <span>Project: ${this.cc.escapeHtml(task.spec?.project || '-')}</span>
            ${task.prUrl ? `<a href="${task.prUrl}" target="_blank" class="cursor-pr-link">VIEW PR</a>` : ''}
            ${cursorUrl ? `<a href="${cursorUrl}" target="_blank" class="cursor-web-link">CURSOR.COM</a>` : ''}
          </div>
          ${task.error ? `<div class="cursor-task-error">${this.cc.escapeHtml(task.error.substring(0, 200))}</div>` : ''}
        </div>`;
    }

    this.gridEl.innerHTML = html;
    this.bindActions();
    this.startElapsedTimers();
  }

  bindActions() {
    // Follow-up buttons
    this.gridEl.querySelectorAll('.cursor-followup-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const taskId = btn.dataset.taskId;
        const instruction = prompt('Follow-up instruction for Cursor agent:');
        if (instruction) {
          btn.textContent = 'SENDING...';
          btn.disabled = true;
          fetch(`/api/cursor/tasks/${taskId}/followup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ instruction })
          }).then(r => r.json()).then(result => {
            btn.textContent = result.success ? 'SENT' : 'FAILED';
            setTimeout(() => { btn.textContent = 'FOLLOW-UP'; btn.disabled = false; }, 2000);
          }).catch(() => { btn.textContent = 'ERROR'; btn.disabled = false; });
        }
      });
    });

    // Stop buttons
    this.gridEl.querySelectorAll('.cursor-stop-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const taskId = btn.dataset.taskId;
        if (confirm('Stop this Cursor agent?')) {
          btn.textContent = 'STOPPING...';
          fetch(`/api/cursor/tasks/${taskId}/stop`, { method: 'POST' })
            .then(r => r.json()).then(result => {
              if (result.success) this.init();
              else { btn.textContent = 'FAILED'; }
            }).catch(() => { btn.textContent = 'ERROR'; });
        }
      });
    });

    // View Log buttons — toggle inline conversation panel
    this.gridEl.querySelectorAll('.cursor-view-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const taskId = btn.dataset.taskId;
        const panel = document.getElementById(`conv-${taskId}`);
        if (!panel) return;

        // Toggle panel
        if (panel.style.display !== 'none') {
          panel.style.display = 'none';
          btn.textContent = 'VIEW LOG';
          return;
        }

        panel.style.display = 'block';
        panel.innerHTML = '<div class="cursor-conv-loading">Loading conversation...</div>';
        btn.textContent = 'HIDE LOG';

        fetch(`/api/cursor/tasks/${taskId}/conversation`)
          .then(r => r.json()).then(result => {
            if (result.success && result.message) {
              // Convert markdown-ish text to simple HTML
              const formatted = this.cc.escapeHtml(result.message)
                .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
                .replace(/\n/g, '<br>');
              panel.innerHTML = `<div class="cursor-conv-content">${formatted}</div>`;
            } else {
              panel.innerHTML = `<div class="cursor-conv-error">${result.message || 'No conversation data available'}</div>`;
            }
          }).catch(err => {
            panel.innerHTML = `<div class="cursor-conv-error">Failed to load: ${err.message}</div>`;
          });
      });
    });
  }

  startElapsedTimers() {
    // Update elapsed times every 5 seconds for running tasks
    if (this._elapsedTimer) clearInterval(this._elapsedTimer);
    this._elapsedTimer = setInterval(() => {
      this.gridEl.querySelectorAll('.cursor-task-elapsed[data-started]').forEach(el => {
        el.textContent = this.formatElapsed(new Date(el.dataset.started));
      });
    }, 5000);
  }

  formatElapsed(start) {
    const sec = Math.floor((Date.now() - start.getTime()) / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    const remSec = sec % 60;
    if (min < 60) return `${min}m ${remSec}s`;
    const hr = Math.floor(min / 60);
    return `${hr}h ${min % 60}m`;
  }

  timeAgo(date) {
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }
}

// ============================================================================
// Orchestration Panel (Antigravity)
// ============================================================================
class OrchestrationPanel {
  constructor(commandCenter) {
    this.commandCenter = commandCenter;
    this.qaBrowserEl = document.getElementById('orchestration-qa-browser');
    this.activeEl = document.getElementById('orchestration-active');
    this.statsEl = document.getElementById('orchestration-stats');
    this.logsEl = document.getElementById('orchestration-logs');
    this.recentListEl = document.getElementById('orchestration-recent-list');
    this.escalatedEl = document.getElementById('orchestration-escalated');
    this.serveWebUrl = null;
    this._logs = [];
    this._pollTimer = null;
  }

  esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; }

  async init() {
    try {
      const [orchestrationRes, statusRes, tasksRes, playbooksRes] = await Promise.all([
        fetch('/api/orchestration'),
        fetch('/api/orchestration/status'),
        fetch('/api/orchestration/tasks?days=7'),
        fetch('/api/orchestration/playbooks').catch(() => null),
      ]);
      const data = orchestrationRes.ok ? await orchestrationRes.json() : {};
      if (data.serve_web_url) this.serveWebUrl = data.serve_web_url;
      const status = statusRes.ok ? await statusRes.json() : {};
      const tasks = tasksRes.ok ? await tasksRes.json() : {};
      const playbooks = playbooksRes?.ok ? await playbooksRes.json() : null;
      this.render(data.active, data.recent || [], { status, tasks, playbooks });
    } catch { this.render(null, [], {}); }
  }

  handleEvent(payload) {
    if (payload && payload.serve_web_url) this.serveWebUrl = payload.serve_web_url;
    if (payload && payload.phase) {
      this._logs.unshift(`[${new Date().toLocaleTimeString()}] ${payload.phase}${payload.task_id ? ' | ' + payload.task_id : ''}${payload.iteration ? ' | iter ' + payload.iteration : ''}`);
      if (this._logs.length > 20) this._logs.pop();
      if (this.activeEl) {
        this.activeEl.innerHTML = `<div class="orchestration-phase"><strong>Phase:</strong> ${payload.phase}${payload.task_id ? ' | Task: ' + payload.task_id : ''}${payload.iteration ? ' | Iteration ' + payload.iteration : ''}</div>`;
      }
      this.init();
    }
  }

  formatTaskTitle(prd) {
    if (!prd) return '—';
    try {
      const o = typeof prd === 'string' ? JSON.parse(prd) : prd;
      return o.title || o.description?.slice(0, 60) || prd.slice(0, 80);
    } catch {
      return prd.slice(0, 80) + (prd.length > 80 ? '…' : '');
    }
  }

  render(active, recent, { status = {}, tasks = {}, playbooks = null } = {}) {
    if (this.qaBrowserEl) {
      if (this.serveWebUrl) {
        this.qaBrowserEl.style.display = 'block';
        this.qaBrowserEl.innerHTML = `<a href="${this.serveWebUrl}" target="_blank" rel="noopener" class="orchestration-qa-link">Open QA browser (Antigravity)</a>`;
      } else {
        this.qaBrowserEl.style.display = 'none';
        this.qaBrowserEl.innerHTML = '';
      }
    }
    if (this.activeEl) {
      if (active) {
        const title = active.prd_title || this.formatTaskTitle(active.prd) || active.task_id || '—';
        const phase = active.phase ? `${active.phase}${active.iteration ? ` (iteration ${active.iteration})` : ''}` : '';
        this.activeEl.innerHTML = `<div class="orchestration-active-task"><div class="orchestration-active-title">${this.esc(title)}</div>${phase ? `<div class="orchestration-active-phase">${phase}</div>` : ''}</div>`;
      } else {
        this.activeEl.innerHTML = '<div class="orchestration-idle">No active orchestration. Use the console: e.g. "build add hello endpoint" or "orchestrate add rate limiting".</div>';
      }
    }
    if (this.statsEl) {
      const t = tasks.total ?? 0;
      const c = tasks.completed ?? 0;
      const e = tasks.escalated ?? 0;
      const pb = playbooks?.total ?? 0;
      this.statsEl.innerHTML = `<span class="orchestration-stat"><strong>Tasks (7d):</strong> ${t}</span><span class="orchestration-stat"><strong>Completed:</strong> ${c}</span><span class="orchestration-stat"><strong>Escalated:</strong> ${e}</span><span class="orchestration-stat"><strong>Playbooks:</strong> ${pb}</span>`;
    }
    if (this.logsEl) {
      const lines = this._logs.length ? this._logs.map(l => `<div class="orchestration-log-line">${this.esc(l)}</div>`).join('') : '<div class="orchestration-log-line">No agent logs yet. Start a build to see phases.</div>';
      this.logsEl.innerHTML = lines;
    }
    if (this.recentListEl) {
      if (!recent.length) {
        this.recentListEl.innerHTML = '<li class="orchestration-empty">No tasks yet.</li>';
      } else {
        this.recentListEl.innerHTML = recent.map(t => {
          const date = t.created_at ? new Date(t.created_at * 1000).toLocaleString() : '—';
          const title = this.formatTaskTitle(t.prd);
          return `<li class="orchestration-recent-item"><span class="orchestration-status ${t.status}">${t.status}</span> <span class="orchestration-recent-title">${this.esc(title)}</span> <span class="orchestration-recent-date">${date}</span></li>`;
        }).join('');
      }
    }
    const escalated = (recent || []).filter(t => t.status === 'escalated');
    if (this.escalatedEl) {
      if (!escalated.length) {
        this.escalatedEl.innerHTML = '';
      } else {
        this.escalatedEl.innerHTML = `<h3>Escalated (${escalated.length})</h3><ul class="orchestration-recent-list">${escalated.map(t => {
          const date = t.created_at ? new Date(t.created_at * 1000).toLocaleString() : '—';
          return `<li class="orchestration-recent-item"><span class="orchestration-status escalated">${t.status}</span> ${this.esc(this.formatTaskTitle(t.prd))} <span class="orchestration-recent-date">${date}</span></li>`;
        }).join('')}</ul>`;
      }
    }
  }
}

// ============================================================================
// Scout Panel
// ============================================================================
class ScoutPanel {
  constructor() {
    this.briefingEl = document.getElementById('scout-briefing');
    this.statsEl = document.getElementById('scout-stats');
    this.nextScanEl = document.getElementById('scout-next-scan');
    this.refreshBtn = document.getElementById('scout-refresh-btn');
    if (this.refreshBtn) {
      this.refreshBtn.addEventListener('click', () => this.init());
    }
  }

  async init() {
    try {
      const res = await fetch('/api/scout/status');
      if (res.ok) {
        const data = await res.json();
        this.update(data);
      }
    } catch { /* ignore */ }
  }

  update(data) {
    if (!data) return;

    // Next scan info
    if (this.nextScanEl) {
      this.nextScanEl.textContent = data.lastRun ? `Last run: ${new Date(data.lastRun).toLocaleTimeString()}` : 'Not yet run';
    }

    // Stats bar
    if (this.statsEl) {
      this.statsEl.innerHTML = `
        <span>Sources: ${data.totalSources || 0}</span>
        <span>Findings: ${data.totalFindings || 0}</span>
        <span>Digest queue: ${(data.digestQueue || []).length}</span>
      `;
    }

    // Briefing — group findings by type
    if (this.briefingEl) {
      const findings = data.findings || [];
      if (findings.length === 0) {
        this.briefingEl.innerHTML = '<div class="no-changes">No findings yet. Scout is monitoring sources.</div>';
        return;
      }

      const groups = { security: [], release: [], tech: [], business: [] };
      findings.forEach(f => {
        const g = groups[f.type] || groups.tech;
        g.push(f);
      });

      let html = '';
      const labels = { security: 'SECURITY', release: 'UPDATES', tech: 'TECH', business: 'BUSINESS' };
      for (const [type, items] of Object.entries(groups)) {
        if (items.length === 0) continue;
        html += `<div class="scout-category">
          <div class="scout-category-header">
            <span>${labels[type] || type.toUpperCase()} (${items.length})</span>
          </div>`;
        items.forEach(f => {
          html += `<div class="scout-finding severity-${f.severity}">
            <div class="scout-finding-title">${this.esc(f.title)}</div>
            <div class="scout-finding-detail">${this.esc(f.summary)}</div>
          </div>`;
        });
        html += '</div>';
      }
      this.briefingEl.innerHTML = html;
    }
  }

  esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }
}

// ============================================================================
// Reasoning Panel (REASONING tab)
// ============================================================================
class ReasoningPanel {
  constructor() {
    this.refreshBtn = document.getElementById('reasoning-refresh-btn');
    this.daysSelect = document.getElementById('reasoning-days');
    if (this.refreshBtn) this.refreshBtn.addEventListener('click', () => this.init());
    if (this.daysSelect) this.daysSelect.addEventListener('change', () => this.init());
  }

  getDays() {
    const v = this.daysSelect?.value;
    return v === '' ? '' : `days=${v}`;
  }

  async init() {
    const q = this.getDays();
    const suffix = q ? '?' + q : '';
    try {
      const [metricsRes, tasksRes, confidenceRes, errorsRes, timelineRes] = await Promise.all([
        fetch('/api/reasoning/metrics' + suffix),
        fetch('/api/reasoning/tasks' + suffix),
        fetch('/api/reasoning/confidence' + suffix),
        fetch('/api/reasoning/errors' + suffix),
        fetch('/api/reasoning/timeline' + suffix),
      ]);
      const metrics = metricsRes.ok ? await metricsRes.json() : {};
      const tasks = tasksRes.ok ? await tasksRes.json() : [];
      const confidence = confidenceRes.ok ? await confidenceRes.json() : [];
      const errors = errorsRes.ok ? await errorsRes.json() : [];
      const timeline = timelineRes.ok ? await timelineRes.json() : [];
      this.update(metrics, tasks, confidence, errors, timeline);
    } catch {
      this.update({}, [], [], [], []);
    }
  }

  update(metrics, tasks, confidence, errors, timeline) {
    const total = metrics.totalTasks ?? 0;
    const noData = total === 0;

    // Stat cards
    const successCount = total ? Math.round((metrics.successRate / 100) * total) : 0;
    document.getElementById('reasoning-success-rate').textContent = noData ? '--' : metrics.successRate + '%';
    document.getElementById('reasoning-success-detail').textContent = noData ? '--' : `(${successCount} of ${total} tasks)`;
    document.getElementById('reasoning-test-rate').textContent = noData ? '--' : (metrics.testPassRate ?? 0) + '%';
    document.getElementById('reasoning-test-detail').textContent = noData ? '--' : '(with tests)';
    document.getElementById('reasoning-avg-conf').textContent = noData ? '--' : (metrics.avgConfidence ?? 0) + ' / 10';
    document.getElementById('reasoning-conf-detail').textContent = noData ? '--' : '';
    const totalErr = metrics.totalErrors ?? 0;
    const applied = metrics.learningApplied ?? 0;
    document.getElementById('reasoning-learning').textContent = noData ? '--' : String(applied);
    document.getElementById('reasoning-learning-detail').textContent = noData ? '--' : (totalErr ? `${applied} of ${totalErr} errors (${Math.round((applied / totalErr) * 100)}%)` : 'errors fixed');

    // Task type table
    const tasksTbody = document.querySelector('#reasoning-tasks-table tbody');
    const tasksEmpty = document.getElementById('reasoning-tasks-empty');
    if (tasksTbody && tasksEmpty) {
      if (tasks.length === 0) {
        tasksTbody.innerHTML = '';
        tasksEmpty.classList.add('visible');
      } else {
        tasksEmpty.classList.remove('visible');
        tasksTbody.innerHTML = tasks.map(t => `
          <tr><td>${this.esc(t.taskType)}</td><td>${t.total}</td><td>${t.successRate}%</td><td>${t.avgIterations}</td><td>${t.testPassRate}%</td><td>${t.avgConfidence}</td></tr>
        `).join('');
      }
    }

    // Confidence table (bucket labels 1-3, 4-6, 7-10)
    const confLabels = ['1-3', '4-6', '7-10'];
    const statusLabels = ['Underconfident', 'Accurate', 'Overconfident'];
    const confidenceTbody = document.querySelector('#reasoning-confidence-table tbody');
    const confidenceEmpty = document.getElementById('reasoning-confidence-empty');
    if (confidenceTbody && confidenceEmpty) {
      if (confidence.length === 0) {
        confidenceTbody.innerHTML = '';
        confidenceEmpty.classList.add('visible');
      } else {
        confidenceEmpty.classList.remove('visible');
        confidenceTbody.innerHTML = confidence.map((c, i) => `
          <tr><td>${confLabels[i]}</td><td>${c.tasksAtLevel}</td><td>${c.actualSuccessRate}%</td><td>${c.deviation}</td><td>${statusLabels[i]}</td></tr>
        `).join('');
      }
    }

    // Errors table
    const errorsTbody = document.querySelector('#reasoning-errors-table tbody');
    const errorsEmpty = document.getElementById('reasoning-errors-empty');
    if (errorsTbody && errorsEmpty) {
      if (errors.length === 0) {
        errorsTbody.innerHTML = '';
        errorsEmpty.classList.add('visible');
      } else {
        errorsEmpty.classList.remove('visible');
        errorsTbody.innerHTML = errors.map(e => `
          <tr><td>${this.esc(e.errorType)}</td><td>${e.firstSeen}</td><td>${e.occurrences}</td><td>${e.fixedByLearning ? 'Yes' : 'No'}</td><td>${e.lastSeen}</td></tr>
        `).join('');
      }
    }

    // Timeline (simple bar list)
    const timelineWrap = document.getElementById('reasoning-timeline');
    if (timelineWrap) {
      if (timeline.length === 0) {
        timelineWrap.innerHTML = '<div class="reasoning-empty visible" id="reasoning-timeline-empty">Not yet run</div>';
      } else {
        timelineWrap.innerHTML = timeline.map(d => `
          <div class="reasoning-timeline-day">
            <span style="min-width:100px">${d.date}</span>
            <span style="min-width:60px">${d.successRate}%</span>
            <span style="min-width:80px">${d.tasksCompleted} tasks</span>
            <div class="reasoning-timeline-bar" style="flex:1;max-width:200px"><div class="reasoning-timeline-fill" style="width:${d.successRate}%"></div></div>
          </div>
        `).join('');
      }
    }
  }

  esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; }
}

// ============================================================================
// Performance Panel (PERFORMANCE tab)
// ============================================================================
class PerformancePanel {
  constructor() {
    this.refreshBtn = document.getElementById('performance-refresh-btn');
    this.daysSelect = document.getElementById('performance-days');
    if (this.refreshBtn) this.refreshBtn.addEventListener('click', () => this.init());
    if (this.daysSelect) this.daysSelect.addEventListener('change', () => this.init());
  }

  getDays() {
    const v = this.daysSelect?.value;
    return v === '90' ? 90 : v === '30' ? 30 : 7;
  }

  async init() {
    const days = this.getDays();
    const q = `days=${days}`;
    try {
      const [summaryRes, bottlenecksRes, responseTimesRes, snapshotsRes, recsRes] = await Promise.all([
        fetch('/api/performance/summary?' + q),
        fetch('/api/performance/bottlenecks?' + q),
        fetch('/api/performance/response-times?' + q),
        fetch('/api/performance/snapshots?days=1'),
        fetch('/api/performance/recommendations'),
      ]);
      const summary = summaryRes.ok ? await summaryRes.json() : {};
      const bottlenecks = bottlenecksRes.ok ? await bottlenecksRes.json() : [];
      const responseTimes = responseTimesRes.ok ? await responseTimesRes.json() : [];
      const snapshots = snapshotsRes.ok ? await snapshotsRes.json() : [];
      const recommendations = recsRes.ok ? await recsRes.json() : [];
      this.update(summary, bottlenecks, responseTimes, snapshots, recommendations);
    } catch {
      this.update({}, [], [], [], []);
    }
  }

  update(summary, bottlenecks, responseTimes, snapshots, recommendations) {
    const noSummary = summary.avgResponseMs === undefined;
    document.getElementById('perf-avg-response').textContent = noSummary ? '--' : (summary.avgResponseMs / 1000).toFixed(2) + 's';
    document.getElementById('perf-avg-detail').textContent = noSummary ? '--' : (summary.responseTimeTrend !== 0 ? (summary.responseTimeTrend > 0 ? '+' : '') + summary.responseTimeTrend + 's vs prev' : '');
    document.getElementById('perf-load').textContent = noSummary ? '--' : (summary.systemLoad ?? 0).toFixed(2);
    document.getElementById('perf-load-detail').textContent = noSummary ? '--' : ' / ' + (summary.totalCores || 4) + ' cores';
    const memPct = summary.memoryTotalMb ? Math.round((summary.memoryUsedMb / summary.memoryTotalMb) * 100) : 0;
    document.getElementById('perf-memory').textContent = noSummary ? '--' : (summary.memoryUsedMb ?? 0) + ' / ' + (summary.memoryTotalMb ?? 0) + ' MB';
    document.getElementById('perf-memory-detail').textContent = noSummary ? '--' : (memPct ? memPct + '% used' : '');
    document.getElementById('perf-containers').textContent = noSummary ? '--' : (summary.containersRunning ?? 0);
    document.getElementById('perf-containers-detail').textContent = noSummary ? '--' : (summary.containersUnhealthy ? summary.containersUnhealthy + ' unhealthy' : '');

    const bottlenecksTbody = document.querySelector('#performance-bottlenecks-table tbody');
    const bottlenecksEmpty = document.getElementById('performance-bottlenecks-empty');
    if (bottlenecksTbody && bottlenecksEmpty) {
      const active = bottlenecks.filter(b => !b.resolved);
      if (active.length === 0) {
        bottlenecksTbody.innerHTML = '';
        bottlenecksEmpty.classList.add('visible');
      } else {
        bottlenecksEmpty.classList.remove('visible');
        bottlenecksTbody.innerHTML = active.map(b => `
          <tr><td>${b.severity}</td><td>${this.esc(b.source)}</td><td>${this.esc(b.description)}</td><td>${this.esc(b.recommendation)}</td><td>${b.resolved ? 'Resolved' : 'Active'}</td></tr>
        `).join('');
      }
    }

    const rtTbody = document.querySelector('#performance-response-times-table tbody');
    const rtEmpty = document.getElementById('performance-response-times-empty');
    if (rtTbody && rtEmpty) {
      if (responseTimes.length === 0) {
        rtTbody.innerHTML = '';
        rtEmpty.classList.add('visible');
      } else {
        rtEmpty.classList.remove('visible');
        rtTbody.innerHTML = responseTimes.map(r => `
          <tr><td>${this.esc(r.source)}</td><td>${r.avg_ms}</td><td>${r.p50_ms}</td><td>${r.p95_ms}</td><td>${r.p99_ms}</td><td>${r.count}</td></tr>
        `).join('');
      }
    }

    const resourceWrap = document.getElementById('performance-resource-chart');
    if (resourceWrap) {
      if (snapshots.length === 0) {
        resourceWrap.innerHTML = '<div class="reasoning-empty visible" id="performance-resource-empty">No snapshot data (24h)</div>';
      } else {
        resourceWrap.innerHTML = '<div class="reasoning-empty" id="performance-resource-empty">' + snapshots.length + ' snapshots in last 24h</div>';
      }
    }

    const recTbody = document.querySelector('#performance-recommendations-table tbody');
    const recEmpty = document.getElementById('performance-recommendations-empty');
    if (recTbody && recEmpty) {
      if (recommendations.length === 0) {
        recTbody.innerHTML = '';
        recEmpty.classList.add('visible');
      } else {
        recEmpty.classList.remove('visible');
        recTbody.innerHTML = recommendations.map(r => `
          <tr>
            <td>${r.priority}</td><td>${this.esc(r.title)}</td><td>${this.esc(r.impact)}</td><td>${r.status}</td>
            <td>${r.status === 'pending' ? '<button class="cmd-btn small dismiss-rec" data-id="' + this.esc(r.id) + '">Dismiss</button> <button class="cmd-btn small apply-rec" data-id="' + this.esc(r.id) + '">Apply</button>' : ''}</td>
          </tr>
        `).join('');
        recTbody.querySelectorAll('.dismiss-rec').forEach(btn => {
          btn.addEventListener('click', () => this.dismiss(btn.dataset.id));
        });
        recTbody.querySelectorAll('.apply-rec').forEach(btn => {
          btn.addEventListener('click', () => this.apply(btn.dataset.id));
        });
      }
    }
  }

  async dismiss(id) {
    try {
      await fetch('/api/performance/recommendations/' + encodeURIComponent(id) + '/dismiss', { method: 'POST' });
      this.init();
    } catch { /* ignore */ }
  }

  async apply(id) {
    try {
      await fetch('/api/performance/recommendations/' + encodeURIComponent(id) + '/apply', { method: 'POST' });
      this.init();
    } catch { /* ignore */ }
  }

  esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; }
}

// ============================================================================
// Security Panel
// ============================================================================
class SecurityPanel {
  constructor() {
    this.cardsEl = document.getElementById('security-cards');
    this.projectsEl = document.getElementById('security-projects');
    this.eventListEl = document.getElementById('security-event-list');
  }

  async init() {
    try {
      const res = await fetch('/api/security/dashboard');
      if (res.ok) {
        const data = await res.json();
        this.update(data);
      }
    } catch { /* ignore */ }
  }

  update(data) {
    if (!data) return;

    // Portfolio cards
    if (this.cardsEl && data.portfolio) {
      const p = data.portfolio;
      this.cardsEl.innerHTML = `
        <div class="security-stat-card"><div class="stat-value">${p.totalProjects}</div><div class="stat-label">Monitored</div></div>
        <div class="security-stat-card"><div class="stat-value">${p.incidents24h}</div><div class="stat-label">Incidents 24h</div></div>
        <div class="security-stat-card"><div class="stat-value">${p.totalBlocked}</div><div class="stat-label">Blocked Today</div></div>
        <div class="security-stat-card"><div class="stat-value">${p.allHealthy ? 'YES' : 'NO'}</div><div class="stat-label">All Healthy</div></div>
      `;
    }

    // Per-project rows
    if (this.projectsEl && data.projects) {
      if (data.projects.length === 0) {
        this.projectsEl.innerHTML = '<div class="no-changes">No projects being monitored</div>';
      } else {
        this.projectsEl.innerHTML = data.projects.map(p => {
          const cls = p.status === 'secure' ? 'sec-healthy' : p.status === 'warning' ? 'sec-warning' : 'sec-critical';
          return `<div class="security-project-row">
            <span>${this.esc(p.projectName)}</span>
            <span class="${cls}">${p.status.toUpperCase()}</span>
            <span>${p.errorRate}% err</span>
            <span>${p.responseTime}ms</span>
            <span>${p.attackMode ? 'ATTACK MODE' : ''}</span>
          </div>`;
        }).join('');
      }
    }

    // Recent events
    if (this.eventListEl && data.recentEvents) {
      if (data.recentEvents.length === 0) {
        this.eventListEl.innerHTML = '<div class="no-changes">No security events</div>';
      } else {
        this.eventListEl.innerHTML = data.recentEvents.slice(0, 20).map(e => {
          const time = new Date(e.timestamp).toLocaleTimeString();
          return `<div class="security-event-item">
            <span class="sec-time">[${time}]</span>
            <span class="sec-msg">${this.esc(e.message)}</span>
          </div>`;
        }).join('');
      }
    }
  }

  esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }
}

// ============================================================================
// Notes Panel
// ============================================================================
class NotesPanel {
  constructor() {
    this.listEl = document.getElementById('notes-list');
    this.countEl = document.getElementById('notes-count');
    this.searchEl = document.getElementById('notes-search');
    this.formEl = document.getElementById('notes-add-form');
    this.inputEl = document.getElementById('notes-add-input');
    this.refreshBtn = document.getElementById('notes-refresh');
    this.searchTimeout = null;
  }

  async init() {
    await this.fetchNotes();
    if (this.formEl && this.inputEl) {
      this.formEl.addEventListener('submit', (e) => {
        e.preventDefault();
        this.addNote();
      });
    }
    if (this.refreshBtn) {
      this.refreshBtn.addEventListener('click', () => this.fetchNotes());
    }
    if (this.searchEl) {
      this.searchEl.addEventListener('input', () => {
        clearTimeout(this.searchTimeout);
        this.searchTimeout = setTimeout(() => this.fetchNotes(), 200);
      });
    }
  }

  async fetchNotes() {
    if (!this.listEl) return;
    const q = this.searchEl?.value?.trim() || '';
    const url = q ? `/api/notes?q=${encodeURIComponent(q)}` : '/api/notes';
    try {
      const res = await fetch(url);
      const data = await res.ok ? res.json() : { notes: [] };
      this.render(data.notes || []);
    } catch {
      this.render([]);
    }
  }

  render(notes) {
    if (!this.listEl) return;
    if (this.countEl) this.countEl.textContent = notes.length;
    if (notes.length === 0) {
      this.listEl.innerHTML = '<div class="no-changes">No notes yet. Add one above or say "add a note that ..." in the console.</div>';
      return;
    }
    const sorted = [...notes].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    this.listEl.innerHTML = sorted.map(n => {
      const date = new Date(n.createdAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
      const tags = (n.tags && n.tags.length) ? n.tags.map(t => `<span class="note-tag">#${this.esc(t)}</span>`).join(' ') : '';
      const content = this.esc(n.content).replace(/\n/g, '<br>');
      return `<div class="note-card" data-id="${this.esc(n.id)}">
        <div class="note-content">${content}</div>
        <div class="note-meta">${tags} <span class="note-date">${this.esc(date)}</span></div>
        <div class="note-actions"><button type="button" class="cmd-btn danger note-delete-btn" data-id="${this.esc(n.id)}">DELETE</button></div>
      </div>`;
    }).join('');
    this.listEl.querySelectorAll('.note-delete-btn').forEach(btn => {
      btn.addEventListener('click', () => this.deleteNote(btn.dataset.id));
    });
  }

  async addNote() {
    const content = this.inputEl?.value?.trim();
    if (!content) return;
    try {
      const res = await fetch('/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content })
      });
      if (res.ok) {
        this.inputEl.value = '';
        await this.fetchNotes();
      } else {
        const data = await res.json().catch(() => ({}));
        window.commandCenter?.log('error', data.error || 'Failed to add note');
      }
    } catch (err) {
      window.commandCenter?.log('error', 'Failed to add note: ' + err);
    }
  }

  async deleteNote(id) {
    if (!id || !confirm('Delete this note?')) return;
    try {
      const res = await fetch(`/api/notes/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (data.success) await this.fetchNotes();
      else window.commandCenter?.log('error', 'Failed to delete note');
    } catch (err) {
      window.commandCenter?.log('error', 'Failed to delete note: ' + err);
    }
  }

  esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; }
}

// ============================================================================
// Clients Panel
// ============================================================================
class ClientsPanel {
  constructor() {
    this.gridEl = document.getElementById('clients-grid');
    this.newBtn = document.getElementById('new-client-btn');
  }

  async init() {
    try {
      const res = await fetch('/api/clients');
      if (res.ok) {
        const data = await res.json();
        this.update(data);
      }
    } catch { /* ignore */ }
  }

  update(data) {
    if (!this.gridEl || !data) return;
    const clients = data.clients || [];
    if (clients.length === 0) {
      this.gridEl.innerHTML = '<div class="no-changes">No clients yet. Use "new client &lt;name&gt;" to create one.</div>';
      return;
    }
    this.gridEl.innerHTML = clients.map(c => {
      const dotCls = c.status === 'live' ? 'live' : c.status === 'building' ? 'building' : 'paused';
      return `<div class="client-card">
        <span class="client-name">${this.esc(c.businessName)}</span>
        <span class="client-domain">${this.esc(c.subdomain || c.repoName)}</span>
        <span class="client-status"><span class="client-status-dot ${dotCls}"></span> ${c.status.toUpperCase()}</span>
        <span>${c.businessType || '--'}</span>
        <span>${c.location || '--'}</span>
        <span class="client-actions">
          <button class="cmd-btn" onclick="window.open('https://github.com/hollidaymat/${this.esc(c.repoName)}','_blank')">REPO</button>
        </span>
      </div>`;
    }).join('');
  }

  esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }
}

// ============================================================================
// Initialize
// ============================================================================
document.addEventListener('DOMContentLoaded', () => {
  // Tab controller
  window.tabController = new TabController();

  // Command center
  window.commandCenter = new CommandCenter();
  
  // Homelab dashboard
  window.commandCenter.homelabDashboard = new HomelabDashboard(window.commandCenter);
  window.commandCenter.homelabDashboard.init();

  // Activity panel
  window.commandCenter.activityPanel = new ActivityPanel(window.commandCenter);

  // Cost dashboard
  window.commandCenter.costDashboard = new CostDashboard();

  // Project tracker
  window.commandCenter.projectTracker = new ProjectTracker(window.commandCenter);

  // Sites panel
  window.commandCenter.sitesPanel = new SitesPanel(window.commandCenter);

  // Cursor panel
  window.commandCenter.cursorPanel = new CursorPanel(window.commandCenter);
  window.commandCenter.orchestrationPanel = new OrchestrationPanel(window.commandCenter);

  // Scout panel
  window.scoutPanel = new ScoutPanel();
  window.reasoningPanel = new ReasoningPanel();
  window.performancePanel = new PerformancePanel();

  // Security panel
  window.securityPanel = new SecurityPanel();

  // Clients panel
  window.clientsPanel = new ClientsPanel();

  // Notes panel
  window.notesPanel = new NotesPanel();

  // Lazy-load tab data on first activation
  const loaded = {};
  window.tabController.onActivate('activity', () => {
    if (!loaded.activity) {
      loaded.activity = true;
      window.commandCenter.activityPanel.init();
      window.commandCenter.cursorPanel.init();
    }
  });
  window.tabController.onActivate('costs', () => {
    if (!loaded.costs) { loaded.costs = true; window.commandCenter.costDashboard.init(); }
  });
  window.tabController.onActivate('projects', () => {
    if (!loaded.projects) { loaded.projects = true; window.commandCenter.projectTracker.init(); }
  });
  window.tabController.onActivate('sites', () => {
    if (!loaded.sites) { loaded.sites = true; window.commandCenter.sitesPanel.init(); }
  });
  window.tabController.onActivate('scout', () => {
    if (!loaded.scout) { loaded.scout = true; window.scoutPanel.init(); }
  });
  window.tabController.onActivate('orchestration', () => {
    if (!loaded.orchestration) { loaded.orchestration = true; window.commandCenter.orchestrationPanel.init(); }
  });
  window.tabController.onActivate('reasoning', () => {
    if (!loaded.reasoning) { loaded.reasoning = true; window.reasoningPanel.init(); }
  });
  window.tabController.onActivate('performance', () => {
    if (!loaded.performance) { loaded.performance = true; window.performancePanel.init(); }
  });
  window.tabController.onActivate('security', () => {
    if (!loaded.security) { loaded.security = true; window.securityPanel.init(); }
  });
  window.tabController.onActivate('clients', () => {
    if (!loaded.clients) { loaded.clients = true; window.clientsPanel.init(); }
  });
  window.tabController.onActivate('notes', () => {
    if (!loaded.notes) { loaded.notes = true; window.notesPanel.init(); }
  });

  // Download buttons
  document.getElementById('download-json')?.addEventListener('click', () => {
    window.location.href = '/api/conversations/download?format=json';
  });
  document.getElementById('download-md')?.addEventListener('click', () => {
    window.location.href = '/api/conversations/download?format=markdown';
  });

  // Clear history button
  document.getElementById('clear-history')?.addEventListener('click', async () => {
    if (!confirm('Clear all conversation history? This cannot be undone. Exported files are not affected.')) return;
    try {
      const res = await fetch('/api/conversations', { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        // History cleared; no console message to reduce noise.
      }
    } catch (err) {
      window.commandCenter?.log('error', `Failed to clear history: ${err}`);
    }
  });
});
