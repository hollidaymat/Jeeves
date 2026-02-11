(function() {
  var protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  var wsUrl = protocol + '//' + window.location.host + '/voice';
  var state = 'idle';
  var ws = null;
  var audioCapture = new AudioCapture();
  var conversationEl = document.getElementById('conversation');
  var statusIndicator = document.getElementById('status-indicator');
  var textInput = document.getElementById('text-input');
  var sendBtn = document.getElementById('send-btn');
  var talkBtn = document.getElementById('talk-btn');

  function setState(s) {
    state = s;
    document.body.setAttribute('data-state', s);
    if (statusIndicator) {
      statusIndicator.className = 'status ' + s;
      statusIndicator.textContent = s === 'idle' ? 'Ready' : s === 'listening' ? 'Listening...' : s === 'processing' ? 'Thinking...' : s === 'speaking' ? 'Speaking...' : s;
    }
  }
  function addBubble(role, text) {
    if (!conversationEl) return;
    var p = document.createElement('div');
    p.className = 'bubble ' + role;
    p.textContent = text;
    conversationEl.appendChild(p);
    conversationEl.scrollTop = conversationEl.scrollHeight;
  }
  function onMessage(msg) {
    if (msg.type === 'transcript') addBubble('user', msg.text || '');
    if (msg.type === 'status') setState('processing');
    if (msg.type === 'voice_response') {
      addBubble('jeeves', msg.text || '');
      if (msg.audio) {
        var bytes = Uint8Array.from(atob(msg.audio), function(c) { return c.charCodeAt(0); });
        var ctx = new (window.AudioContext || window.webkitAudioContext)();
        ctx.decodeAudioData(bytes.buffer.slice(0)).then(function(decoded) {
          var src = ctx.createBufferSource();
          src.buffer = decoded;
          src.connect(ctx.destination);
          src.start(0);
          src.onended = function() { setState('idle'); };
        }).catch(function() { setState('idle'); });
      } else setState('idle');
    }
    if (msg.type === 'dashboard_update' && msg.data) updateDashboard(msg.data);
    if (msg.type === 'notification') {
      addBubble('jeeves', (msg.title ? msg.title + ': ' : '') + (msg.message || ''));
    }
    if (msg.type === 'error') {
      addBubble('jeeves', 'Error: ' + (msg.message || 'Unknown'));
      setState('idle');
    }
  }
  function onStatusChange(status) {
    var conn = document.getElementById('connection-status');
    if (conn) conn.textContent = status === 'connected' ? '● CONNECTED' : '○ DISCONNECTED';
  }
  function doSendText() {
    var text = (textInput && textInput.value || '').trim();
    if (!text || !ws) return;
    setState('processing');
    addBubble('user', text);
    ws.sendText(text);
    if (textInput) textInput.value = '';
  }
  ws = new JeevesWebSocket(wsUrl, onMessage, onStatusChange);
  ws.connect();
  if (sendBtn && textInput) {
    sendBtn.addEventListener('click', doSendText);
    textInput.addEventListener('keydown', function(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSendText(); } });
  }
  if (talkBtn) {
    talkBtn.addEventListener('mousedown', function() {
      if (!ws.ws || ws.ws.readyState !== 1) {
        setState('idle');
        addBubble('jeeves', 'Voice not connected. Check connection and refresh.');
        return;
      }
      setState('listening');
      audioCapture.capture().then(function(wavBuffer) {
        if (ws.sendAudio(wavBuffer)) setState('processing');
        else {
          setState('idle');
          addBubble('jeeves', 'Voice connection lost. Refresh and try again.');
        }
      }).catch(function(err) {
        setState('idle');
        addBubble('jeeves', err && err.name === 'NotAllowedError' ? 'Microphone access denied. Allow mic for this site and try again.' : 'Recording failed.');
      });
    });
    talkBtn.addEventListener('touchstart', function(e) { e.preventDefault(); talkBtn.dispatchEvent(new MouseEvent('mousedown')); });
  }
  if (typeof KeepAlive !== 'undefined') {
    var keepAlive = new KeepAlive();
    keepAlive.requestWakeLock();
    keepAlive.setupVisibilityHandler();
  }
  setState('idle');
})();
