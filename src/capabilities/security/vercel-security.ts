/**
 * Vercel Security Guardian — Vercel API Wrapper
 *
 * Raw-fetch wrapper for security-related Vercel endpoints.
 * Uses VERCEL_API_TOKEN and optional VERCEL_TEAM_ID from environment.
 *
 * Designed to degrade gracefully: if an endpoint returns 404 or is
 * unavailable the function returns null instead of throwing.
 */

import { logger } from '../../utils/logger.js';

// ============================================================================
// Config helpers
// ============================================================================

function getToken(): string | undefined {
  return process.env.VERCEL_API_TOKEN;
}

function getTeamId(): string | undefined {
  return process.env.VERCEL_TEAM_ID;
}

/** Returns true when Vercel credentials are present. */
export function isSecurityEnabled(): boolean {
  return !!getToken();
}

// ============================================================================
// HTTP helper
// ============================================================================

/**
 * Authenticated fetch against the Vercel API.
 * Automatically appends the teamId query parameter when available.
 */
async function vercelSecFetch(
  path: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' = 'GET',
  body?: unknown,
): Promise<unknown | null> {
  const token = getToken();
  if (!token) {
    logger.debug('[vercel-security] No VERCEL_API_TOKEN — skipping request');
    return null;
  }

  const url = new URL(`https://api.vercel.com${path}`);
  const teamId = getTeamId();
  if (teamId) url.searchParams.set('teamId', teamId);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };

    const res = await fetch(url.toString(), {
      method,
      headers,
      signal: controller.signal,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    if (!res.ok) {
      // 404 / 403 are expected for endpoints the plan may not support
      if (res.status === 404 || res.status === 403) {
        logger.debug(`[vercel-security] ${method} ${path} → ${res.status} (not available)`);
        return null;
      }
      logger.warn(`[vercel-security] ${method} ${path} → ${res.status} ${res.statusText}`);
      return null;
    }

    return await res.json();
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      logger.warn(`[vercel-security] ${method} ${path} timed out`);
    } else {
      logger.error(`[vercel-security] ${method} ${path} failed`, { error: String(error) });
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Fetch recent deployments for a project.
 *
 * @see https://vercel.com/docs/rest-api/endpoints/deployments#list-deployments
 */
export async function getDeployments(
  projectId: string,
  limit: number = 10,
): Promise<unknown[] | null> {
  const data = await vercelSecFetch(`/v6/deployments?projectId=${encodeURIComponent(projectId)}&limit=${limit}`);
  if (!data) return null;
  return ((data as Record<string, unknown>)?.deployments as unknown[]) ?? [];
}

/**
 * Fetch the WAF / firewall configuration for a project.
 *
 * NOTE: This endpoint may not be available on all Vercel plans.
 * Returns null gracefully when unavailable.
 *
 * @see https://vercel.com/docs/rest-api/endpoints/security
 */
export async function getFirewallConfig(projectId: string): Promise<unknown | null> {
  return vercelSecFetch(`/v1/security/firewall/config?projectId=${encodeURIComponent(projectId)}`);
}

/**
 * Enable or disable Vercel Attack Challenge Mode for a project.
 *
 * Vercel's challenge mode shows a CAPTCHA to suspected bot traffic,
 * acting as a first-line DDoS mitigation measure.
 *
 * Returns the API response or null if the endpoint is unavailable.
 */
export async function setAttackMode(
  projectId: string,
  enabled: boolean,
): Promise<unknown | null> {
  // Vercel uses the security/attack-challenge-mode endpoint
  const result = await vercelSecFetch(
    `/v1/security/attack-challenge-mode?projectId=${encodeURIComponent(projectId)}`,
    'PUT',
    { enabled },
  );

  if (result) {
    logger.info(`[vercel-security] Attack mode ${enabled ? 'ENABLED' : 'DISABLED'} for project ${projectId}`);
  }

  return result;
}

/**
 * Fetch basic project-level analytics (request counts, bandwidth, etc.)
 *
 * NOTE: Analytics endpoints may require Pro/Enterprise plans.
 * Returns null if unavailable.
 */
export async function getProjectAnalytics(projectId: string): Promise<unknown | null> {
  // Try the web analytics endpoint first
  const now = Date.now();
  const oneDayAgo = now - 86_400_000;
  return vercelSecFetch(
    `/v1/web/insights?projectId=${encodeURIComponent(projectId)}&from=${oneDayAgo}&to=${now}`,
  );
}
