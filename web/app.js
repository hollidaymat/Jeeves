/**
 * Signal Cursor Controller - Web UI Application
 */

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
    this.streamHadContent = false;  // Track if stream actually received content
    this.lastStreamId = null;  // Track last completed stream to suppress duplicate response
    this.lastStreamHadContent = false;  // Only suppress response if stream had content
    
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
    this.attachedFiles = [];  // Store attached files
    this.homelabDashboard = null;
    
    // Command history
    this.commandHistory = [];
    this.historyIndex = -1;
    this.currentInput = '';  // Store current input when navigating history
    this.maxHistorySize = 100;
    
    // Load history from localStorage
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
    // Don't add empty commands or duplicates of the last command
    if (!command.trim()) return;
    if (this.commandHistory.length > 0 && this.commandHistory[0] === command) return;
    
    // Add to beginning of history
    this.commandHistory.unshift(command);
    
    // Trim to max size
    if (this.commandHistory.length > this.maxHistorySize) {
      this.commandHistory = this.commandHistory.slice(0, this.maxHistorySize);
    }
    
    // Reset history navigation
    this.historyIndex = -1;
    this.currentInput = '';
    
    // Persist
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
        // Skip if we just finished streaming WITH actual content (avoid duplicate)
        // Only suppress if lastStreamId is set AND we actually received stream content
        if (this.lastStreamId && this.lastStreamHadContent) {
          this.lastStreamId = null;  // Reset for next time
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
    }
  }
  
  updatePrdStatus(status) {
    // Update PRD status in the UI (if we have a panel for it)
    if (status.active && status.plan) {
      const plan = status.plan;
      const completedCount = plan.phases.filter(p => p.status === 'completed').length;
      const currentPhase = plan.phases[plan.currentPhaseIndex];
      
      this.log('system', `PRD Execution: ${completedCount}/${plan.phases.length} phases | Current: ${currentPhase?.name || 'Complete'}`);
    }
  }
  
  handlePrdCheckpoint(checkpoint) {
    // Log the checkpoint with special formatting
    const icon = checkpoint.requiresResponse ? '🔔' : '✅';
    this.log('system', `${icon} **${checkpoint.phaseName}**: ${checkpoint.message}`);
    
    if (checkpoint.filesChanged && checkpoint.filesChanged.length > 0) {
      this.log('system', `Files changed: ${checkpoint.filesChanged.join(', ')}`);
    }
  }
  
  updateStatus(status) {
    this.startTime = Date.now() - (status.uptime_seconds * 1000);
    
    // Update interface statuses
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
    
    // Update agent status if included
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
    
    // Add click handlers
    this.elements.projectsList.querySelectorAll('.project-item').forEach(item => {
      item.addEventListener('click', () => {
        const name = item.dataset.name;
        this.sendCommand(`open ${name}`);
      });
    });
  }
  
  handleLog(log) {
    // Only show info and above in console
    if (log.level === 'debug') return;
    
    // Filter out noisy internal logs
    if (!log.message || log.message.trim() === '') return;
    if (/^Using .* model/i.test(log.message)) return;
    if (/^Prompt analysis/i.test(log.message)) return;
    
    const type = log.level === 'error' ? 'error' : 
                 log.level === 'warn' ? 'error' : 'system';
    this.log(type, log.message);
  }
  
  handleResponse(response) {
    // Only log the response - command was already logged when sent
    this.log('response', response.response);
  }
  
  // Streaming handlers for real-time AI responses
  handleStreamStart(payload) {
    this.activeStreamId = payload.streamId;
    this.streamContent = '';
    this.streamElement = null;
    this.streamHadContent = false;  // Reset - will be set true if chunks arrive
    
    // Create a new console line for streaming
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
    this.streamHadContent = true;  // Mark that we received actual content
    
    if (this.streamElement) {
      // For streaming, show raw text first, render markdown at end
      this.streamElement.textContent = this.streamContent;
      this.scrollToBottom();
    }
  }
  
  handleStreamEnd(payload) {
    if (payload.streamId !== this.activeStreamId) return;
    
    // If stream had no content, remove the empty element
    if (!this.streamHadContent && this.streamElement) {
      const line = this.streamElement.parentElement;
      if (line) {
        line.remove();
      }
    } else if (this.streamElement && this.streamContent) {
      // Final render with markdown
      const line = this.streamElement.parentElement;
      line.classList.remove('streaming');
      
      // Render final content with markdown and thinking extraction
      this.streamElement.innerHTML = '';
      
      // Extract thinking section
      let content = this.streamContent;
      const thinkingMatch = content.match(/\[Thinking\]\s*([^\n]+(?:\n(?!\n)[^\n]+)*)/i);
      
      if (thinkingMatch) {
        const thinkingDiv = document.createElement('div');
        thinkingDiv.className = 'thinking-block';
        thinkingDiv.innerHTML = `<span class="thinking-icon">💭</span> ${this.escapeHtml(thinkingMatch[1])}`;
        this.streamElement.appendChild(thinkingDiv);
        content = content.replace(thinkingMatch[0], '').trim();
      }
      
      // Render markdown if available
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
    
    this.lastStreamId = this.activeStreamId;  // Remember to suppress duplicate response
    this.lastStreamHadContent = this.streamHadContent;  // Only suppress if we actually got content
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
    // Command form submission
    this.elements.commandForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const command = this.elements.commandInput.value.trim();
      if (command) {
        this.sendCommand(command);
        this.elements.commandInput.value = '';
        this.autoResizeTextarea();
      }
    });
    
    // Textarea auto-resize and Enter key handling
    this.elements.commandInput.addEventListener('input', () => {
      this.autoResizeTextarea();
    });
    
    // Handle paste - resize after content is inserted
    this.elements.commandInput.addEventListener('paste', () => {
      // Use requestAnimationFrame for more reliable DOM update detection
      requestAnimationFrame(() => {
        this.autoResizeTextarea();
        // Double-check after a small delay for large pastes
        setTimeout(() => this.autoResizeTextarea(), 50);
      });
    });
    
    // Also handle drop events (drag and drop text)
    this.elements.commandInput.addEventListener('drop', () => {
      requestAnimationFrame(() => {
        this.autoResizeTextarea();
      });
    });
    
    this.elements.commandInput.addEventListener('keydown', (e) => {
      // Enter without Shift = submit, Shift+Enter = new line
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.elements.commandForm.dispatchEvent(new Event('submit'));
        return;
      }
      
      // Arrow Up = previous command in history
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.navigateHistory('up');
        return;
      }
      
      // Arrow Down = next command in history
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.navigateHistory('down');
        return;
      }
    });
    
    // Quick command buttons
    document.querySelectorAll('.cmd-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const command = btn.dataset.command;
        if (command) {
          this.sendCommand(command);
        }
      });
    });
    
    // Refresh projects
    this.elements.refreshProjects.addEventListener('click', () => {
      this.sendCommand('list projects');
    });
    
    // Apply/Reject buttons
    this.elements.applyBtn?.addEventListener('click', () => {
      this.sendCommand('apply');
    });
    
    this.elements.rejectBtn?.addEventListener('click', () => {
      this.sendCommand('reject');
    });
    
    // File attachment handling
    this.elements.attachBtn?.addEventListener('click', () => {
      this.elements.fileInput?.click();
    });
    
    this.elements.fileInput?.addEventListener('change', (e) => {
      this.handleFileSelection(e.target.files);
    });
    
    // Drag and drop support
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
  
  // Handle file selection
  async handleFileSelection(files) {
    for (const file of files) {
      // Check file size (max 5MB)
      if (file.size > 5 * 1024 * 1024) {
        this.log('error', `File ${file.name} is too large (max 5MB)`);
        continue;
      }
      
      // Check if already attached
      if (this.attachedFiles.some(f => f.name === file.name)) {
        continue;
      }
      
      const fileData = await this.readFile(file);
      if (fileData) {
        this.attachedFiles.push(fileData);
        this.renderAttachmentPreview();
      }
    }
    
    // Clear the file input
    if (this.elements.fileInput) {
      this.elements.fileInput.value = '';
    }
  }
  
  // Read file content
  async readFile(file) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      const isImage = file.type.startsWith('image/');
      
      reader.onload = (e) => {
        resolve({
          name: file.name,
          type: file.type,
          size: file.size,
          content: e.target.result,
          isImage: isImage
        });
      };
      
      reader.onerror = () => {
        this.log('error', `Failed to read file: ${file.name}`);
        resolve(null);
      };
      
      if (isImage) {
        reader.readAsDataURL(file);
      } else {
        reader.readAsText(file);
      }
    });
  }
  
  // Render attachment preview
  renderAttachmentPreview() {
    if (!this.elements.attachmentsPreview) return;
    
    this.elements.attachmentsPreview.innerHTML = this.attachedFiles.map((file, index) => {
      const icon = this.getFileIcon(file.name);
      const size = this.formatFileSize(file.size);
      
      if (file.isImage) {
        return `
          <div class="attachment-item" data-index="${index}">
            <img src="${file.content}" alt="${file.name}" class="attachment-image-preview">
            <span class="file-name">${file.name}</span>
            <span class="file-size">${size}</span>
            <button class="remove-btn" onclick="commandCenter.removeAttachment(${index})">×</button>
          </div>
        `;
      }
      
      return `
        <div class="attachment-item" data-index="${index}">
          <span class="file-icon">${icon}</span>
          <span class="file-name">${file.name}</span>
          <span class="file-size">${size}</span>
          <button class="remove-btn" onclick="commandCenter.removeAttachment(${index})">×</button>
        </div>
      `;
    }).join('');
  }
  
  // Get file icon based on extension
  getFileIcon(filename) {
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    const icons = {
      'md': '📝',
      'txt': '📄',
      'json': '📋',
      'xml': '📰',
      'csv': '📊',
      'doc': '📃',
      'docx': '📃',
      'png': '🖼️',
      'jpg': '🖼️',
      'jpeg': '🖼️',
      'gif': '🖼️',
      'webp': '🖼️'
    };
    return icons[ext] || '📎';
  }
  
  // Format file size
  formatFileSize(bytes) {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }
  
  // Remove attachment
  removeAttachment(index) {
    this.attachedFiles.splice(index, 1);
    this.renderAttachmentPreview();
  }
  
  // Clear all attachments
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
    
    // Render each file's changes
    let html = '';
    for (const change of this.pendingChanges) {
      const fileName = change.filePath.split(/[\\/]/).pop();
      const relativePath = change.filePath.replace(/.*YOUR_CURSOR_AI_DIRECTORY[\\/]/, '');
      
      html += `
        <div class="change-file">
          <div class="change-file-header">
            <span class="change-file-path">${fileName}</span>
            <span class="change-file-status">${relativePath}</span>
          </div>
          <div class="change-diff">
            ${this.renderDiff(change.originalContent, change.newContent)}
          </div>
        </div>
      `;
    }
    
    this.elements.changesContent.innerHTML = html;
  }
  
  renderDiff(original, modified) {
    const lines = [];
    
    if (original) {
      const origLines = original.split('\n');
      const newLines = modified.split('\n');
      
      // Simple line-by-line diff
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
      // New file
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
    // Store scroll position to prevent jump
    const scrollTop = textarea.scrollTop;
    
    // Reset height to get accurate scrollHeight measurement
    textarea.style.height = '0';
    
    // Calculate new height (minimum 24px for single line, max 200px)
    const newHeight = Math.max(24, Math.min(textarea.scrollHeight, 200));
    textarea.style.height = newHeight + 'px';
    
    // Restore scroll position
    textarea.scrollTop = scrollTop;
  }
  
  navigateHistory(direction) {
    if (this.commandHistory.length === 0) return;
    
    const input = this.elements.commandInput;
    
    if (direction === 'up') {
      // First up press - save current input
      if (this.historyIndex === -1) {
        this.currentInput = input.value;
      }
      
      // Move up in history
      if (this.historyIndex < this.commandHistory.length - 1) {
        this.historyIndex++;
        input.value = this.commandHistory[this.historyIndex];
        this.autoResizeTextarea();
        // Move cursor to end
        input.selectionStart = input.selectionEnd = input.value.length;
      }
    } else if (direction === 'down') {
      if (this.historyIndex > 0) {
        // Move down in history
        this.historyIndex--;
        input.value = this.commandHistory[this.historyIndex];
        this.autoResizeTextarea();
        input.selectionStart = input.selectionEnd = input.value.length;
      } else if (this.historyIndex === 0) {
        // Back to current input
        this.historyIndex = -1;
        input.value = this.currentInput;
        this.autoResizeTextarea();
        input.selectionStart = input.selectionEnd = input.value.length;
      }
    }
  }
  
  async sendCommand(command) {
    // Add to command history
    this.addToHistory(command);
    
    // Build command with attachments
    let fullCommand = command;
    const attachmentInfo = [];
    
    if (this.attachedFiles.length > 0) {
      for (const file of this.attachedFiles) {
        if (file.isImage) {
          attachmentInfo.push(`[Image: ${file.name}]`);
        } else {
          attachmentInfo.push(`[File: ${file.name}]`);
        }
      }
    }
    
    // Log command with attachment indicators
    const displayCommand = attachmentInfo.length > 0 
      ? `${command} ${attachmentInfo.join(' ')}`
      : command;
    this.log('command', displayCommand);
    
    try {
      // Prepare request body with attachments
      const requestBody = { 
        content: command,
        attachments: this.attachedFiles.map(f => ({
          name: f.name,
          type: f.type,
          content: f.content,
          isImage: f.isImage
        }))
      };
      
      const response = await fetch('/api/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });
      
      const data = await response.json();
      
      // Only log errors here - success responses come via WebSocket to avoid duplication
      if (!data.success) {
        this.log('error', data.error || 'Command failed');
      }
      
      // Update last command
      this.elements.lastCommand.textContent = `Last: ${command} at ${new Date().toLocaleTimeString()}`;
      
      // Clear attachments after successful send
      this.clearAttachments();
      
    } catch (error) {
      this.log('error', `Failed to send command: ${error.message}`);
    }
  }
  
  log(type, message) {
    // Skip empty messages
    if (!message || message.trim() === '') return;
    
    const line = document.createElement('div');
    line.className = `console-line ${type}`;
    
    const timestamp = document.createElement('span');
    timestamp.className = 'timestamp';
    timestamp.textContent = `[${new Date().toLocaleTimeString()}]`;
    
    const messageSpan = document.createElement('span');
    messageSpan.className = 'message';
    
    // Extract thinking section if present
    let processedMessage = message;
    let thinkingContent = null;
    
    const thinkingMatch = message.match(/\[Thinking\]\s*(.*?)(?=\n\n|$)/s);
    if (thinkingMatch) {
      thinkingContent = thinkingMatch[1].trim();
      processedMessage = message.replace(thinkingMatch[0], '').trim();
    }
    
    // Check for task labels and highlight them
    processedMessage = this.processTaskLabels(processedMessage);
    
    // Render markdown for AI responses (long messages with markdown syntax)
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
      contentDiv.innerHTML = processedMessage; // Already escaped via processTaskLabels
      messageSpan.appendChild(contentDiv);
    }
    
    line.appendChild(timestamp);
    line.appendChild(messageSpan);
    
    this.elements.consoleOutput.appendChild(line);
    
    // Auto-scroll to bottom
    this.elements.consoleOutput.scrollTop = this.elements.consoleOutput.scrollHeight;
    
    // Limit console history
    while (this.elements.consoleOutput.children.length > 100) {
      this.elements.consoleOutput.removeChild(this.elements.consoleOutput.firstChild);
    }
  }
  
  processTaskLabels(text) {
    // Escape HTML first
    text = this.escapeHtml(text);
    
    // Replace task status labels with styled badges
    // Active task: taskNameActive or [Active: taskName]
    text = text.replace(/\[(Active|In Progress):\s*([^\]]+)\]/gi, 
      '<span class="task-badge task-active">🔄 $2</span>');
    
    // Completed task: taskNameComplete or [Complete: taskName]  
    text = text.replace(/\[(Complete|Done):\s*([^\]]+)\]/gi,
      '<span class="task-badge task-complete">✅ $2</span>');
    
    // Change markers: <CHANGE> comments
    text = text.replace(/&lt;CHANGE&gt;\s*([^<\n]+)/gi,
      '<span class="change-marker">📝 $1</span>');
    
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

/**
 * Homelab Dashboard - Real-time service monitoring panel
 */
class HomelabDashboard {
  constructor(commandCenter) {
    this.cc = commandCenter;
    this.panel = document.getElementById('homelab-dashboard');
    this.refreshBtn = document.getElementById('homelab-refresh');
    this.serviceGrid = document.getElementById('service-grid');
    this.alertsContainer = document.getElementById('homelab-alerts');
    this.refreshInterval = null;
    this.lastData = null;

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
        this.panel.style.display = '';
        this.update(data);
        this.refreshInterval = setInterval(() => this.refresh(), 30000);
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
    if (resources.disk && resources.disk.length > 0) {
      setGauge('disk', resources.disk[0].usagePercent);
    }
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

    // Sort: running first, then by priority
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
      return `<div class="service-card" data-service="${svc.name}">
        <div class="service-card-header">
          <span class="service-status-dot ${stateClass}"></span>
          <span class="service-name" title="${svc.purpose || svc.name}">${svc.name}</span>
        </div>
        <div class="service-detail">${detail}</div>
        <div class="service-actions">
          ${svc.state === 'running' 
            ? `<button class="svc-action-btn danger" onclick="window.commandCenter.sendCommand('restart ${svc.name}')">R</button>
               <button class="svc-action-btn danger" onclick="window.commandCenter.sendCommand('stop ${svc.name}')">S</button>`
            : `<button class="svc-action-btn" onclick="window.commandCenter.sendCommand('start ${svc.name}')">&#9654;</button>`
          }
        </div>
      </div>`;
    }).join('');
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
        this.panel.style.display = '';
        this.update(data.payload);
      }
    }
  }
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  window.commandCenter = new CommandCenter();
  
  // Initialize homelab dashboard
  window.commandCenter.homelabDashboard = new HomelabDashboard(window.commandCenter);
  window.commandCenter.homelabDashboard.init();
  
  // Download buttons
  document.getElementById('download-json')?.addEventListener('click', () => {
    window.location.href = '/api/conversations/download?format=json';
  });
  
  document.getElementById('download-md')?.addEventListener('click', () => {
    window.location.href = '/api/conversations/download?format=markdown';
  });
});
