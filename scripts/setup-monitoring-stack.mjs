#!/usr/bin/env node
/**
 * One-off: install/update monitoring stack so Prometheus scrapes all Dockers and Grafana has datasource.
 * Run from repo root on the homelab (where Docker and /opt/stacks live):
 *   node scripts/setup-monitoring-stack.mjs
 * Or: npm run build && node -e "import('./dist/homelab/services/installer.js').then(m => Promise.all([m.installService('node_exporter'), m.installService('cadvisor'), m.installService('prometheus'), m.installService('grafana')]).then(r => console.log(r)))"
 */
import { installService } from '../dist/homelab/services/installer.js';

const services = ['node_exporter', 'cadvisor', 'prometheus', 'grafana'];
console.log('Installing monitoring stack:', services.join(' → '));
for (const name of services) {
  const r = await installService(name);
  console.log(`${name}: ${r.success ? 'OK' : 'FAIL'} ${r.message}`);
  if (r.warnings?.length) r.warnings.forEach((w) => console.log('  ⚠', w));
  if (!r.success) process.exitCode = 1;
}
