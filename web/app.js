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
      lastCommand: document.getElementById('last-command')
    };
    
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
      this.log('system', 'Connected to Signal Cursor Controller');
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
    if (response.request) {
      this.log('command', response.request);
    }
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
      
      if (data.success) {
        this.log('response', data.response);
      } else {
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
    messageSpan.textContent = message;
    
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
