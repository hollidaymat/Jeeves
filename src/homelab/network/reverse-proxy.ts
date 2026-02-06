/**
 * Jeeves Homelab - Traefik Reverse Proxy Configuration
 *
 * Generates Traefik labels for Docker containers, queries the Traefik API
 * for route information, and provides proxy status checks.
 *
 * Traefik runs on ports 80/443 (HTTP/HTTPS) + 8080 (dashboard/API).
 */

import { execHomelab } from '../shell.js';
import { logger } from '../../utils/logger.js';

// ============================================================================
// Types
// ============================================================================

export interface TraefikRoute {
  name: string;
  rule: string;
  service: string;
  status: string;
  tls: boolean;
}

// ============================================================================
// Constants
// ============================================================================

const TRAEFIK_API_URL = 'http://localhost:8080/api/http/routers';

// ============================================================================
// Public API
// ============================================================================

/**
 * Generate Docker labels for Traefik reverse proxy routing.
 * Pure function — no side effects.
 *
 * @param serviceName - Name of the service (used as router/service identifier)
 * @param port - Container port Traefik should route traffic to
 * @param domain - Hostname for the routing rule (e.g., "sonarr.home.local")
 * @returns Record of Docker label key-value pairs
 */
export function generateTraefikLabels(
  serviceName: string,
  port: number,
  domain: string,
): Record<string, string> {
  return {
    'traefik.enable': 'true',
    [`traefik.http.routers.${serviceName}.rule`]: `Host(\`${domain}\`)`,
    [`traefik.http.routers.${serviceName}.tls`]: 'true',
    [`traefik.http.routers.${serviceName}.tls.certresolver`]: 'letsencrypt',
    [`traefik.http.services.${serviceName}.loadbalancer.server.port`]: String(port),
  };
}

/**
 * Query the Traefik API for all configured HTTP routers.
 * Returns an empty array on error (non-critical).
 */
export async function getTraefikRoutes(): Promise<TraefikRoute[]> {
  try {
    const result = await execHomelab('curl', ['-s', TRAEFIK_API_URL]);

    if (!result.success || !result.stdout.trim()) {
      logger.warn('Failed to query Traefik API', { stderr: result.stderr });
      return [];
    }

    const raw = JSON.parse(result.stdout) as Array<Record<string, unknown>>;

    return raw.map((router) => ({
      name: String(router.name ?? ''),
      rule: String(router.rule ?? ''),
      service: String(router.service ?? ''),
      status: String(router.status ?? ''),
      tls: router.tls != null,
    }));
  } catch (error) {
    logger.error('Error parsing Traefik routes', { error: String(error) });
    return [];
  }
}

/**
 * Get overall Traefik proxy status: whether the container is running and its routes.
 */
export async function getProxyStatus(): Promise<{
  running: boolean;
  routeCount: number;
  routes: TraefikRoute[];
}> {
  // Check if the Traefik container is running
  const containerCheck = await execHomelab('docker', [
    'ps', '-q', '-f', 'name=traefik',
  ]);

  const running = containerCheck.success && containerCheck.stdout.trim().length > 0;

  if (!running) {
    return { running: false, routeCount: 0, routes: [] };
  }

  const routes = await getTraefikRoutes();
  return { running: true, routeCount: routes.length, routes };
}

/**
 * Get the default local domain for a service.
 * Convention: {serviceName}.home.local
 */
export function getDefaultDomain(serviceName: string): string {
  return `${serviceName}.home.local`;
}
