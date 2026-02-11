function KeepAlive() {
  this.wakeLock = null;
}
KeepAlive.prototype.requestWakeLock = function() {
  var self = this;
  if (!navigator.wakeLock) return;
  navigator.wakeLock.request('screen').then(function(lock) {
    self.wakeLock = lock;
    lock.addEventListener('release', function() { self.requestWakeLock(); });
  }).catch(function() {});
};
KeepAlive.prototype.setupVisibilityHandler = function() {
  var self = this;
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'visible') self.requestWakeLock();
  });
};
