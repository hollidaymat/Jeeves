/**
 * Service Dependency Map
 * Static mapping of which services depend on which.
 */

export interface DependencyInfo {
  service: string;
  dependsOn: string[];
  dependedBy: string[];
}

// Static dependency graph based on known service relationships
const DEPENDENCIES: Record<string, string[]> = {
  // Media stack depends on prowlarr for indexing, qbittorrent for downloads
  sonarr: ['prowlarr', 'qbittorrent'],
  radarr: ['prowlarr', 'qbittorrent'],
  lidarr: ['prowlarr', 'qbittorrent', 'nzbget'],
  bazarr: ['sonarr', 'radarr'],
  overseerr: ['sonarr', 'radarr'],
  tautulli: ['jellyfin'],
  prowlarr: [],
  gluetun: [],
  qbittorrent: [],
  nzbget: [],
  jellyfin: [],
  // Monitoring stack
  grafana: ['prometheus'],
  prometheus: ['node_exporter'],
  node_exporter: [],
  uptime_kuma: [],
  // Core services
  traefik: [],
  portainer: [],
  pihole: [],
  tailscale: [],
  // Self-hosted services
  nextcloud: ['postgres', 'redis'],
  paperless: ['postgres', 'redis'],
  vaultwarden: [],
  homeassistant: [],
  // Databases
  postgres: [],
  redis: [],
};

/**
 * Get dependency info for a specific service.
 */
export function getServiceDependencies(service: string): DependencyInfo {
  const lower = service.toLowerCase().replace(/[-_\s]/g, '');

  // Find matching service
  const key = Object.keys(DEPENDENCIES).find(k =>
    k.toLowerCase().replace(/[-_\s]/g, '') === lower
  ) || service;

  const dependsOn = DEPENDENCIES[key] || [];

  // Find reverse dependencies (what depends on this service)
  const dependedBy: string[] = [];
  for (const [svc, deps] of Object.entries(DEPENDENCIES)) {
    if (deps.includes(key)) {
      dependedBy.push(svc);
    }
  }

  return { service: key, dependsOn, dependedBy };
}

/**
 * Get impact analysis: if a service goes down, what else is affected?
 */
export function getImpactAnalysis(service: string): string[] {
  const info = getServiceDependencies(service);
  const affected = new Set<string>();

  // Recursive: find all transitive dependents
  const queue = [...info.dependedBy];
  while (queue.length > 0) {
    const svc = queue.pop()!;
    if (affected.has(svc)) continue;
    affected.add(svc);
    const svcInfo = getServiceDependencies(svc);
    queue.push(...svcInfo.dependedBy);
  }

  return Array.from(affected);
}

/**
 * Format dependency info for display.
 */
export function formatDependencies(service: string): string {
  const info = getServiceDependencies(service);
  const lines: string[] = [`## Dependencies: ${info.service}`, ''];

  if (info.dependsOn.length > 0) {
    lines.push(`Depends on: ${info.dependsOn.join(', ')}`);
  } else {
    lines.push('Depends on: nothing (standalone)');
  }

  if (info.dependedBy.length > 0) {
    lines.push(`Required by: ${info.dependedBy.join(', ')}`);
    const impact = getImpactAnalysis(service);
    if (impact.length > info.dependedBy.length) {
      lines.push(`Full impact if down: ${impact.join(', ')}`);
    }
  } else {
    lines.push('Required by: nothing');
  }

  return lines.join('\n');
}
