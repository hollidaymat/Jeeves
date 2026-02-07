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
      attachmentsPreview: document.getElementById('attachments-preview')
    };
    
    this.pendingChanges = [];
    this.attachedFiles = [];
    this.homelabDashboard = null;
    this.activityPanel = null;
    this.costDashboard = null;
    this.projectTracker = null;
    this.sitesPanel = null;
    
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
    }
  }
  
  updatePrdStatus(status) {
    if (status.active && status.plan) {
      const plan = status.plan;
      const completedCount = plan.phases.filter(p => p.status === 'completed').length;
      const currentPhase = plan.phases[plan.currentPhaseIndex];
      this.log('system', `PRD Execution: ${completedCount}/${plan.phases.length} phases | Current: ${currentPhase?.name || 'Complete'}`);
    }
  }
  
  handlePrdCheckpoint(checkpoint) {
    const icon = checkpoint.requiresResponse ? '🔔' : '✅';
    this.log('system', `${icon} **${checkpoint.phaseName}**: ${checkpoint.message}`);
    
    if (checkpoint.filesChanged && checkpoint.filesChanged.length > 0) {
      this.log('system', `Files changed: ${checkpoint.filesChanged.join(', ')}`);
    }
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
    if (/^Using .* model/i.test(log.message)) return;
    if (/^Prompt analysis/i.test(log.message)) return;
    
    const type = log.level === 'error' ? 'error' : 
                 log.level === 'warn' ? 'error' : 'system';
    this.log(type, log.message);
  }
  
  handleResponse(response) {
    this.log('response', response.response);
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
    
    this.lastStreamId = this.activeStreamId;
    this.lastStreamHadContent = this.streamHadContent;
    this.activeStreamId = null;
    this.streamContent = '';
    this.streamElement = null;
    this.streamHadContent = false;
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
    
    let fullCommand = command;
    const attachmentInfo = [];
    if (this.attachedFiles.length > 0) {
      for (const file of this.attachedFiles) {
        attachmentInfo.push(file.isImage ? `[Image: ${file.name}]` : `[File: ${file.name}]`);
      }
    }
    
    const displayCommand = attachmentInfo.length > 0 
      ? `${command} ${attachmentInfo.join(' ')}` : command;
    this.log('command', displayCommand);
    
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

    this.serviceGrid.innerHTML = sorted.map(svc => {
      const stateClass = svc.state || 'unknown';
      const detail = svc.state === 'running' 
        ? (svc.memUsage || svc.ramMB + 'MB') 
        : svc.state;
      const isExpanded = this.expandedService === svc.name;
      return `<div class="service-card ${isExpanded ? 'expanded' : ''}" data-service="${svc.name}">
        <div class="service-card-header">
          <span class="service-status-dot ${stateClass}"></span>
          <span class="service-name" title="${svc.purpose || svc.name}">${svc.name}</span>
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
        if (e.target.closest('.svc-action-btn')) return;
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
        for (const item of value.slice(0, 8)) {
          if (typeof item === 'object') {
            const label = item.title || item.name || item.message || JSON.stringify(item);
            const extra = item.status || item.progress != null ? `${item.progress || 0}%` : '';
            html += `<div class="deep-dive-list-item"><span>${this.cc.escapeHtml(String(label))}</span><span>${extra}</span></div>`;
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
      const res = await fetch('/api/costs');
      if (res.ok) {
        const data = await res.json();
        this.update(data);
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

  // Lazy-load tab data on first activation
  const loaded = {};
  window.tabController.onActivate('activity', () => {
    if (!loaded.activity) { loaded.activity = true; window.commandCenter.activityPanel.init(); }
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

  // Download buttons
  document.getElementById('download-json')?.addEventListener('click', () => {
    window.location.href = '/api/conversations/download?format=json';
  });
  document.getElementById('download-md')?.addEventListener('click', () => {
    window.location.href = '/api/conversations/download?format=markdown';
  });
});
