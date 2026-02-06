/**
 * Jeeves Homelab - Service Registry
 * 
 * Master registry of all homelab services running on the Beelink Mini S13.
 * 5 tiers: core, media, services, databases, monitoring.
 * Tracks runtime state, dependencies, ports, and RAM allocation.
 * 
 * Hard rule: Total RAM must fit within 14GB budget (16GB - 2GB OS/Jeeves).
 */

// ============================================================================
// Types (local interfaces - Agent 1 will reconcile with types/index.ts)
// ============================================================================

export type ServiceTier = 'core' | 'media' | 'services' | 'databases' | 'monitoring';
export type ServicePriority = 'critical' | 'high' | 'medium' | 'low';
export type ServiceState = 'running' | 'stopped' | 'error' | 'unknown';

export interface ServiceDefinition {
  name: string;
  tier: ServiceTier;
  image: string;
  ports: number[];
  ramMB: number;               // RAM limit in MB
  purpose: string;
  priority: ServicePriority;
  dependencies: string[];
  devices?: string[];           // e.g., ['/dev/dri:/dev/dri'] for GPU passthrough
  networkMode?: string;         // e.g., 'host' for Home Assistant
  type?: string;                // e.g., 'system-service' for Tailscale
  environment?: Record<string, string>;  // Default env vars for the service
  volumes?: string[];           // Volume mounts (e.g., 'config:/config')
  state: ServiceState;
  lastChecked?: string;
  lastStateChange?: string;
}

export interface ServiceRegistrySummary {
  totalServices: number;
  byTier: Record<ServiceTier, number>;
  byPriority: Record<ServicePriority, number>;
  byState: Record<ServiceState, number>;
  totalRAM_MB: number;
  budgetRAM_MB: number;
  ramHeadroom_MB: number;
  allPorts: number[];
}

// ============================================================================
// RAM Budget
// ============================================================================

const RAM_BUDGET_MB = 14 * 1024; // 14GB = 14336MB (16GB total, 2GB reserved for OS + Jeeves)

// ============================================================================
// Service Registry Data (ported from JEEVES_HOMELAB_BUILD.md)
// ============================================================================

/**
 * Parse RAM string like '64MB', '512MB', '1GB' to number of MB.
 */
function parseRAM(ram: string): number {
  const value = parseFloat(ram);
  if (ram.toUpperCase().includes('GB')) return value * 1024;
  return value; // default MB
}

/**
 * Internal registry storage. Initialized from the build spec.
 */
const registry: Map<string, ServiceDefinition> = new Map();

// ---- TIER 1: Core Infrastructure (always running) ----

function initRegistry(): void {
  if (registry.size > 0) return; // Already initialized

  const definitions: Array<Omit<ServiceDefinition, 'state'>> = [
    // =====================================================================
    // TIER 1: Core Infrastructure
    // =====================================================================
    {
      name: 'portainer',
      tier: 'core',
      image: 'portainer/portainer-ce:latest',
      ports: [9000, 9443],
      ramMB: parseRAM('64MB'),
      purpose: 'Docker management UI',
      priority: 'critical',
      dependencies: [],
    },
    {
      name: 'traefik',
      tier: 'core',
      image: 'traefik:v3.0',
      ports: [80, 443, 8080],
      ramMB: parseRAM('64MB'),
      purpose: 'Reverse proxy, SSL termination',
      priority: 'critical',
      dependencies: [],
    },
    {
      name: 'pihole',
      tier: 'core',
      image: 'pihole/pihole:latest',
      ports: [53, 8053],
      ramMB: parseRAM('128MB'),
      purpose: 'DNS blocking, local DNS',
      priority: 'critical',
      dependencies: [],
    },
    {
      name: 'tailscale',
      tier: 'core',
      image: '', // system-service, not a container image
      ports: [],
      ramMB: parseRAM('32MB'),
      purpose: 'VPN mesh network',
      priority: 'critical',
      dependencies: [],
      type: 'system-service',
    },

    // =====================================================================
    // TIER 2: Media Stack
    // =====================================================================
    {
      name: 'jellyfin',
      tier: 'media',
      image: 'jellyfin/jellyfin:latest',
      ports: [8096],
      ramMB: parseRAM('512MB'),
      purpose: 'Media server (hardware transcoding via QuickSync)',
      priority: 'high',
      dependencies: [],
      devices: ['/dev/dri:/dev/dri'], // GPU passthrough for transcoding
    },
    {
      name: 'sonarr',
      tier: 'media',
      image: 'lscr.io/linuxserver/sonarr:latest',
      ports: [8989],
      ramMB: parseRAM('256MB'),
      purpose: 'TV show management',
      priority: 'medium',
      dependencies: ['prowlarr'],
    },
    {
      name: 'radarr',
      tier: 'media',
      image: 'lscr.io/linuxserver/radarr:latest',
      ports: [7878],
      ramMB: parseRAM('256MB'),
      purpose: 'Movie management',
      priority: 'medium',
      dependencies: ['prowlarr'],
    },
    {
      name: 'prowlarr',
      tier: 'media',
      image: 'lscr.io/linuxserver/prowlarr:latest',
      ports: [9696],
      ramMB: parseRAM('128MB'),
      purpose: 'Indexer management',
      priority: 'medium',
      dependencies: [],
    },
    {
      name: 'lidarr',
      tier: 'media',
      image: 'lscr.io/linuxserver/lidarr:latest',
      ports: [8686],
      ramMB: parseRAM('256MB'),
      purpose: 'Music management',
      priority: 'low',
      dependencies: ['prowlarr'],
    },
    {
      name: 'bazarr',
      tier: 'media',
      image: 'lscr.io/linuxserver/bazarr:latest',
      ports: [6767],
      ramMB: parseRAM('128MB'),
      purpose: 'Subtitle management',
      priority: 'low',
      dependencies: ['sonarr', 'radarr'],
    },
    {
      name: 'overseerr',
      tier: 'media',
      image: 'lscr.io/linuxserver/overseerr:latest',
      ports: [5055],
      ramMB: parseRAM('128MB'),
      purpose: 'Media request management',
      priority: 'low',
      dependencies: ['jellyfin', 'sonarr', 'radarr'],
    },
    {
      name: 'tautulli',
      tier: 'media',
      image: 'lscr.io/linuxserver/tautulli:latest',
      ports: [8181],
      ramMB: parseRAM('128MB'),
      purpose: 'Media server analytics',
      priority: 'low',
      dependencies: ['jellyfin'],
    },

    // =====================================================================
    // TIER 3: Self-Hosted Services
    // =====================================================================
    {
      name: 'nextcloud',
      tier: 'services',
      image: 'nextcloud:latest',
      ports: [8443],
      ramMB: parseRAM('512MB'),
      purpose: 'Files, calendar, contacts',
      priority: 'high',
      dependencies: ['postgres'],
    },
    {
      name: 'vaultwarden',
      tier: 'services',
      image: 'vaultwarden/server:latest',
      ports: [8843],
      ramMB: parseRAM('64MB'),
      purpose: 'Password manager',
      priority: 'critical',
      dependencies: [],
      environment: { ROCKET_PORT: '8843' },
      volumes: ['vaultwarden_data:/data'],
    },
    {
      name: 'paperless',
      tier: 'services',
      image: 'ghcr.io/paperless-ngx/paperless-ngx:latest',
      ports: [8000],
      ramMB: parseRAM('512MB'),
      purpose: 'Document management',
      priority: 'medium',
      dependencies: ['postgres', 'redis'],
      environment: {
        PAPERLESS_REDIS: 'redis://redis:6379',
        PAPERLESS_DBHOST: 'postgres',
        PAPERLESS_DBUSER: 'jeeves',
        PAPERLESS_DBPASS: 'jeeves_db_2026',
        PAPERLESS_DBNAME: 'homelab',
      },
      volumes: ['paperless_data:/usr/src/paperless/data', 'paperless_media:/usr/src/paperless/media'],
    },
    {
      name: 'homeassistant',
      tier: 'services',
      image: 'ghcr.io/home-assistant/home-assistant:stable',
      ports: [8123],
      ramMB: parseRAM('512MB'),
      purpose: 'Home automation',
      priority: 'high',
      dependencies: [],
      networkMode: 'host',
    },

    // =====================================================================
    // TIER 4: Databases
    // =====================================================================
    {
      name: 'postgres',
      tier: 'databases',
      image: 'postgres:16-alpine',
      ports: [5432],
      ramMB: parseRAM('256MB'),
      purpose: 'Primary database',
      priority: 'critical',
      dependencies: [],
      environment: {
        POSTGRES_PASSWORD: 'jeeves_db_2026',
        POSTGRES_USER: 'jeeves',
        POSTGRES_DB: 'homelab',
      },
      volumes: ['postgres_data:/var/lib/postgresql/data'],
    },
    {
      name: 'redis',
      tier: 'databases',
      image: 'redis:7-alpine',
      ports: [6379],
      ramMB: parseRAM('64MB'),
      purpose: 'Cache, message broker',
      priority: 'high',
      dependencies: [],
    },

    // =====================================================================
    // TIER 5: Monitoring
    // =====================================================================
    {
      name: 'uptime_kuma',
      tier: 'monitoring',
      image: 'louislam/uptime-kuma:latest',
      ports: [3001],
      ramMB: parseRAM('128MB'),
      purpose: 'Service uptime monitoring',
      priority: 'high',
      dependencies: [],
    },
    {
      name: 'prometheus',
      tier: 'monitoring',
      image: 'prom/prometheus:latest',
      ports: [9090],
      ramMB: parseRAM('256MB'),
      purpose: 'Metrics collection',
      priority: 'medium',
      dependencies: [],
    },
    {
      name: 'grafana',
      tier: 'monitoring',
      image: 'grafana/grafana:latest',
      ports: [3000],
      ramMB: parseRAM('128MB'),
      purpose: 'Metrics dashboards',
      priority: 'medium',
      dependencies: ['prometheus'],
    },
    {
      name: 'node_exporter',
      tier: 'monitoring',
      image: 'prom/node-exporter:latest',
      ports: [9100],
      ramMB: parseRAM('32MB'),
      purpose: 'Hardware metrics export',
      priority: 'medium',
      dependencies: [],
    },
  ];

  for (const def of definitions) {
    registry.set(def.name, {
      ...def,
      state: 'unknown',
    });
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Get a single service definition by name.
 */
export function getService(name: string): ServiceDefinition | undefined {
  initRegistry();
  return registry.get(name);
}

/**
 * Get all services in a given tier.
 */
export function getServicesByTier(tier: ServiceTier): ServiceDefinition[] {
  initRegistry();
  return Array.from(registry.values()).filter(s => s.tier === tier);
}

/**
 * Get all services with a given priority level.
 */
export function getServicesByPriority(priority: ServicePriority): ServiceDefinition[] {
  initRegistry();
  return Array.from(registry.values()).filter(s => s.priority === priority);
}

/**
 * Get all registered services.
 */
export function getAllServices(): ServiceDefinition[] {
  initRegistry();
  return Array.from(registry.values());
}

/**
 * Get a flat list of all ports used across all services.
 */
export function getAllPorts(): number[] {
  initRegistry();
  const ports: Set<number> = new Set();
  for (const service of registry.values()) {
    for (const port of service.ports) {
      ports.add(port);
    }
  }
  return Array.from(ports).sort((a, b) => a - b);
}

/**
 * Calculate total RAM allocation across all services.
 */
export function getTotalRAM(): { totalMB: number; budgetMB: number; remainingMB: number; withinBudget: boolean } {
  initRegistry();
  let totalMB = 0;
  for (const service of registry.values()) {
    totalMB += service.ramMB;
  }
  return {
    totalMB,
    budgetMB: RAM_BUDGET_MB,
    remainingMB: RAM_BUDGET_MB - totalMB,
    withinBudget: totalMB <= RAM_BUDGET_MB,
  };
}

/**
 * Update the runtime state of a service.
 */
export function updateServiceState(
  name: string,
  state: ServiceState,
  timestamp?: string
): boolean {
  initRegistry();
  const service = registry.get(name);
  if (!service) return false;

  const now = timestamp || new Date().toISOString();
  if (service.state !== state) {
    service.lastStateChange = now;
  }
  service.state = state;
  service.lastChecked = now;
  return true;
}

/**
 * Get the full dependency chain for a service (recursive).
 * Returns services in dependency order (dependencies first).
 */
export function getServiceDependencies(name: string): string[] {
  initRegistry();
  const visited = new Set<string>();
  const result: string[] = [];

  function resolve(serviceName: string): void {
    if (visited.has(serviceName)) return;
    visited.add(serviceName);

    const service = registry.get(serviceName);
    if (!service) return;

    // Resolve dependencies first (depth-first)
    for (const dep of service.dependencies) {
      resolve(dep);
    }

    // Don't include the original service in its own dependency list
    if (serviceName !== name) {
      result.push(serviceName);
    }
  }

  resolve(name);
  return result;
}

/**
 * Get a summary of the entire registry.
 */
export function getRegistrySummary(): ServiceRegistrySummary {
  initRegistry();
  const services = getAllServices();

  const byTier: Record<ServiceTier, number> = { core: 0, media: 0, services: 0, databases: 0, monitoring: 0 };
  const byPriority: Record<ServicePriority, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  const byState: Record<ServiceState, number> = { running: 0, stopped: 0, error: 0, unknown: 0 };

  for (const svc of services) {
    byTier[svc.tier]++;
    byPriority[svc.priority]++;
    byState[svc.state]++;
  }

  const ram = getTotalRAM();

  return {
    totalServices: services.length,
    byTier,
    byPriority,
    byState,
    totalRAM_MB: ram.totalMB,
    budgetRAM_MB: ram.budgetMB,
    ramHeadroom_MB: ram.remainingMB,
    allPorts: getAllPorts(),
  };
}

/**
 * Get services that depend on a given service (reverse dependencies).
 * Useful for knowing what breaks if a service goes down.
 */
export function getDependents(name: string): string[] {
  initRegistry();
  const dependents: string[] = [];
  for (const [svcName, svc] of registry) {
    if (svc.dependencies.includes(name)) {
      dependents.push(svcName);
    }
  }
  return dependents;
}

/**
 * Check for port conflicts in the registry.
 * Returns array of conflict descriptions, empty if no conflicts.
 */
export function checkPortConflicts(): string[] {
  initRegistry();
  const portMap = new Map<number, string[]>();
  const conflicts: string[] = [];

  for (const svc of registry.values()) {
    for (const port of svc.ports) {
      const existing = portMap.get(port) || [];
      existing.push(svc.name);
      portMap.set(port, existing);
    }
  }

  for (const [port, services] of portMap) {
    if (services.length > 1) {
      conflicts.push(`Port ${port} used by: ${services.join(', ')}`);
    }
  }

  return conflicts;
}

/**
 * Verify the registry is valid: no port conflicts, RAM within budget, dependencies exist.
 */
export function validateRegistry(): { valid: boolean; errors: string[] } {
  initRegistry();
  const errors: string[] = [];

  // Check port conflicts
  const portConflicts = checkPortConflicts();
  errors.push(...portConflicts);

  // Check RAM budget
  const ram = getTotalRAM();
  if (!ram.withinBudget) {
    errors.push(`Total RAM ${ram.totalMB}MB exceeds budget ${ram.budgetMB}MB by ${ram.totalMB - ram.budgetMB}MB`);
  }

  // Check dependency references are valid
  for (const svc of registry.values()) {
    for (const dep of svc.dependencies) {
      if (!registry.has(dep)) {
        errors.push(`Service '${svc.name}' depends on unknown service '${dep}'`);
      }
    }
  }

  // Check for circular dependencies
  for (const svc of registry.values()) {
    const deps = getServiceDependencies(svc.name);
    if (deps.includes(svc.name)) {
      errors.push(`Circular dependency detected involving '${svc.name}'`);
    }
  }

  return { valid: errors.length === 0, errors };
}
