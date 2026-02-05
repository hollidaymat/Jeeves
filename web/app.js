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
    
    this.init();
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
    
    this.elements.commandInput.addEventListener('keydown', (e) => {
      // Enter without Shift = submit, Shift+Enter = new line
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.elements.commandForm.dispatchEvent(new Event('submit'));
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
    // Reset height to auto to get the correct scrollHeight
    textarea.style.height = 'auto';
    // Set height to scrollHeight (capped by max-height in CSS)
    textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
  }
  
  async sendCommand(command) {
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

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  window.commandCenter = new CommandCenter();
  
  // Download buttons
  document.getElementById('download-json')?.addEventListener('click', () => {
    window.location.href = '/api/conversations/download?format=json';
  });
  
  document.getElementById('download-md')?.addEventListener('click', () => {
    window.location.href = '/api/conversations/download?format=markdown';
  });
});
