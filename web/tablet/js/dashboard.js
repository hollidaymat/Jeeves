function updateDashboard(data) {
  if (!data) return;
  if (data.services) {
    var el = document.getElementById('service-count');
    if (el) el.textContent = (data.services.healthy || 0) + '/' + (data.services.total || 0);
  }
  if (data.system) {
    var cpu = document.getElementById('cpu-usage');
    if (cpu) cpu.textContent = (data.system.cpu != null ? data.system.cpu : '--') + '%';
    var ram = document.getElementById('ram-usage');
    if (ram) ram.textContent = (data.system.ram != null ? data.system.ram : '--') + '%';
    var temp = document.getElementById('temp');
    if (temp) temp.textContent = (data.system.temp != null ? data.system.temp : '--') + '°C';
  }
}
