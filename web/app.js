/**
 * Signal Cursor Controller - Web UI Application
 */

class CommandCenter {
  constructor() {
    this.ws = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.startTime = null;
    
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
      rejectBtn: document.getElementById('reject-btn')
    };
    
    this.pendingChanges = [];
    
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
        this.handleResponse(message.payload);
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
    
    const type = log.level === 'error' ? 'error' : 
                 log.level === 'warn' ? 'error' : 'system';
    this.log(type, log.message);
  }
  
  handleResponse(response) {
    // Only log the response - command was already logged when sent
    this.log('response', response.response);
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
  
  async sendCommand(command) {
    this.log('command', command);
    
    try {
      const response = await fetch('/api/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: command })
      });
      
      const data = await response.json();
      
      // Only log errors here - success responses come via WebSocket to avoid duplication
      if (!data.success) {
        this.log('error', data.error || 'Command failed');
      }
      
      // Update last command
      this.elements.lastCommand.textContent = `Last: ${command} at ${new Date().toLocaleTimeString()}`;
      
    } catch (error) {
      this.log('error', `Failed to send command: ${error.message}`);
    }
  }
  
  log(type, message) {
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
});
