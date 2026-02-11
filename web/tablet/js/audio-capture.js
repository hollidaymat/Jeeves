function AudioCapture() {
  this.chunks = [];
  this.silenceTimeout = null;
  this.silenceThreshold = 0.01;
  this.silenceDuration = 1500;
  this.maxDuration = 15000;
  this.isRecording = false;
  this.sampleRate = 16000;
}
AudioCapture.prototype.encodeWAV = function(samples) {
  var buffer = new ArrayBuffer(44 + samples.length * 2);
  var view = new DataView(buffer);
  var writeStr = function(offset, str) { for (var i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, this.sampleRate, true);
  view.setUint32(28, this.sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (var i = 0; i < samples.length; i++) {
    var s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return buffer;
};
AudioCapture.prototype.capture = function() {
  var self = this;
  return new Promise(function(resolve) {
    self.chunks = [];
    self.isRecording = true;
    var audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: self.sampleRate });
    navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate: self.sampleRate } }).then(function(stream) {
      var source = audioContext.createMediaStreamSource(stream);
      var processor = audioContext.createScriptProcessor(4096, 1, 1);
      var maxTimer = setTimeout(function() {
        self.stopRecording(stream, processor, source, audioContext, resolve);
      }, self.maxDuration);
      processor.onaudioprocess = function(event) {
        if (!self.isRecording) return;
        var data = event.inputBuffer.getChannelData(0);
        self.chunks.push(new Float32Array(data));
        var amplitude = 0;
        for (var j = 0; j < data.length; j++) { amplitude = Math.max(amplitude, Math.abs(data[j])); }
        if (amplitude < self.silenceThreshold) {
          if (!self.silenceTimeout) {
            self.silenceTimeout = setTimeout(function() {
              clearTimeout(maxTimer);
              self.stopRecording(stream, processor, source, audioContext, resolve);
            }, self.silenceDuration);
          }
        } else {
          if (self.silenceTimeout) { clearTimeout(self.silenceTimeout); self.silenceTimeout = null; }
        }
      };
      source.connect(processor);
      processor.connect(audioContext.destination);
    });
  });
};
AudioCapture.prototype.stopRecording = function(stream, processor, source, audioContext, resolve) {
  this.isRecording = false;
  stream.getTracks().forEach(function(t) { t.stop(); });
  processor.disconnect();
  source.disconnect();
  audioContext.close();
  var totalLength = this.chunks.reduce(function(sum, c) { return sum + c.length; }, 0);
  var merged = new Float32Array(totalLength);
  var offset = 0;
  for (var i = 0; i < this.chunks.length; i++) {
    merged.set(this.chunks[i], offset);
    offset += this.chunks[i].length;
  }
  resolve(this.encodeWAV(merged));
};
