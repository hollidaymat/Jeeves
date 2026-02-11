// Jeeves Voice WebSocket client
function JeevesWebSocket(url, onMessage, onStatusChange) {
  this.url = url;
  this.onMessage = onMessage;
  this.onStatusChange = onStatusChange;
  this.ws = null;
  this.reconnectInterval = 3000;
  this.pingInterval = null;
}

JeevesWebSocket.prototype.connect = function() {
  var that = this;
  this.ws = new WebSocket(this.url);
  this.ws.onopen = function() {
    that.onStatusChange('connected');
    that.pingInterval = setInterval(function() {
      if (that.ws && that.ws.readyState === 1)
        that.ws.send(JSON.stringify({ type: 'ping' }));
    }, 30000);
  };
  this.ws.onmessage = function(event) {
    try { that.onMessage(JSON.parse(event.data)); } catch (e) {}
  };
  this.ws.onclose = function() {
    that.onStatusChange('disconnected');
    clearInterval(that.pingInterval);
    setTimeout(function() { that.connect(); }, that.reconnectInterval);
  };
  this.ws.onerror = function() { if (that.ws) that.ws.close(); };
};

JeevesWebSocket.prototype.sendAudio = function(audioBuffer) {
  if (!this.ws || this.ws.readyState !== 1) return false;
  var bytes = new Uint8Array(audioBuffer);
  var binary = '';
  for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  this.ws.send(JSON.stringify({ type: 'audio_command', audio: btoa(binary), format: 'wav', timestamp: Date.now() }));
  return true;
};

JeevesWebSocket.prototype.sendText = function(text) {
  if (!this.ws || this.ws.readyState !== 1) return false;
  this.ws.send(JSON.stringify({ type: 'text_command', text: text, timestamp: Date.now() }));
  return true;
};
