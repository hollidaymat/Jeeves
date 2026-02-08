/**
 * Vercel API Collector
 * 
 * Fetches deployment status, analytics, and domain info from Vercel.
 * Requires VERCEL_API_TOKEN environment variable.
 * Results cached for 5 minutes.
 */

import { logger } from '../utils/logger.js';

// ============================================================================
// Types
// ============================================================================

interface VercelProjectConfig {
  name: string;
  id: string;
}

interface VercelConfig {
  apiToken: string;
  teamId?: string;
  projects: VercelProjectConfig[];
  pollInterval: number;
}

interface DeployInfo {
  status: string;
  created: number;
  duration?: number;
  commit?: string;
  url?: string;
}

interface ProjectAnalytics {
  today: { visitors: number | string; pageViews: number | string; topPages?: Array<{ page: string; views: number }> };
  thisWeek: { visitors: number | string; pageViews: number | string; topReferrers?: Array<{ referrer: string; count: number }> };
}

interface ProjectStatus {
  name: string;
  production: {
    url: string;
    status: string;
    deployedAt?: number;
    commitMessage?: string;
  };
  recentDeploys: DeployInfo[];
  domains: string[];
  analytics: ProjectAnalytics;
  avgBuildTime?: number;
}

interface VercelStatus {
  enabled: boolean;
  projects: ProjectStatus[];
  summary?: string;
}

// ============================================================================
// Cache
// ============================================================================

let cachedStatus: VercelStatus | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 300000; // 5 minutes

// ============================================================================
// Config
// ============================================================================

function getConfig(): VercelConfig | null {
  const token = process.env.VERCEL_API_TOKEN;
  if (!token) return null;

  // Parse project config from environment or config file
  const projectsStr = process.env.VERCEL_PROJECTS; // JSON array string
  let projects: VercelProjectConfig[] = [];

  if (projectsStr) {
    try {
      projects = JSON.parse(projectsStr);
    } catch {
      logger.debug('Failed to parse VERCEL_PROJECTS env var');
    }
  }

  return {
    apiToken: token,
    teamId: process.env.VERCEL_TEAM_ID || undefined,
    projects,
    pollInterval: 300000,
  };
}

// ============================================================================
// HTTP Helper
// ============================================================================

async function vercelFetch(path: string, token: string, teamId?: string): Promise<unknown> {
  const url = new URL(`https://api.vercel.com${path}`);
  if (teamId) url.searchParams.set('teamId', teamId);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

// ============================================================================
// Collectors
// ============================================================================

async function collectProject(project: VercelProjectConfig, token: string, teamId?: string): Promise<ProjectStatus> {
  try {
    const [deploymentsData, domainsData] = await Promise.all([
      vercelFetch(`/v6/deployments?projectId=${project.id}&limit=5`, token, teamId),
      vercelFetch(`/v9/projects/${project.id}/domains`, token, teamId),
    ]);

    const deployments = ((deploymentsData as Record<string, unknown>)?.deployments as Array<Record<string, unknown>>) || [];
    const domains = ((domainsData as Record<string, unknown>)?.domains as Array<Record<string, unknown>>) || [];

    const latest = deployments[0];
    const production = {
      url: (latest?.url as string) || '',
      status: (latest?.readyState as string) || 'UNKNOWN',
      deployedAt: latest?.created as number,
      commitMessage: ((latest?.meta as Record<string, unknown>)?.githubCommitMessage as string) || '',
    };

    const recentDeploys: DeployInfo[] = deployments.map((d: Record<string, unknown>) => ({
      status: (d.readyState as string) || 'UNKNOWN',
      created: d.created as number,
      duration: d.buildingAt ? (d.ready as number) - (d.buildingAt as number) : undefined,
      commit: ((d.meta as Record<string, unknown>)?.githubCommitMessage as string)?.substring(0, 50) || '',
      url: d.url as string,
    }));

    // Calculate average build time
    const buildTimes = recentDeploys.filter(d => d.duration && d.duration > 0).map(d => d.duration!);
    const avgBuildTime = buildTimes.length > 0 ? Math.round(buildTimes.reduce((a, b) => a + b, 0) / buildTimes.length / 1000) : undefined;

    return {
      name: project.name,
      production,
      recentDeploys,
      domains: domains.map((d: Record<string, unknown>) => d.name as string),
      analytics: {
        today: { visitors: 'N/A', pageViews: 'N/A' },
        thisWeek: { visitors: 'N/A', pageViews: 'N/A' },
      },
      avgBuildTime,
    };
  } catch (error) {
    logger.debug(`Vercel collector failed for ${project.name}`, { error: String(error) });
    return {
      name: project.name,
      production: { url: '', status: 'ERROR' },
      recentDeploys: [],
      domains: [],
      analytics: {
        today: { visitors: 'N/A', pageViews: 'N/A' },
        thisWeek: { visitors: 'N/A', pageViews: 'N/A' },
      },
    };
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Auto-discover projects from Vercel team when no explicit projects configured.
 */
async function discoverTeamProjects(token: string, teamId: string): Promise<VercelProjectConfig[]> {
  try {
    const data = await vercelFetch('/v9/projects?limit=50', token, teamId) as Record<string, unknown>;
    const projectsList = (data?.projects as Array<Record<string, unknown>>) || [];
    return projectsList.map((p: Record<string, unknown>) => ({
      name: p.name as string,
      id: p.id as string,
    }));
  } catch (error) {
    logger.debug('Failed to discover Vercel projects from team', { error: String(error) });
    return [];
  }
}

/**
 * Get the production URL for a specific project (by name).
 * Searches discovered/configured projects and returns the production domain.
 */
export async function getProjectUrl(projectName: string): Promise<{ found: boolean; name?: string; url?: string; domains?: string[]; status?: string }> {
  const vercelStatus = await getVercelStatus();
  if (!vercelStatus.enabled) {
    return { found: false };
  }

  const lower = projectName.toLowerCase().trim();
  const match = vercelStatus.projects.find(p =>
    p.name.toLowerCase() === lower ||
    p.name.toLowerCase().includes(lower) ||
    lower.includes(p.name.toLowerCase())
  );

  if (!match) {
    return { found: false };
  }

  const primaryDomain = match.domains[0] || match.production.url;
  return {
    found: true,
    name: match.name,
    url: primaryDomain ? `https://${primaryDomain}` : undefined,
    domains: match.domains,
    status: match.production.status
  };
}

/**
 * Trigger a new deployment for a project by creating a deployment via the Vercel API.
 * Uses the project's latest git integration hook.
 */
export async function triggerDeployment(projectName: string): Promise<{ success: boolean; message: string; url?: string }> {
  const cfg = getConfig();
  if (!cfg) {
    return { success: false, message: 'Vercel not configured (missing VERCEL_API_TOKEN)' };
  }

  // Find the project ID
  const vercelStatus = await getVercelStatus();
  const lower = projectName.toLowerCase().trim();
  const match = vercelStatus.projects.find(p =>
    p.name.toLowerCase() === lower ||
    p.name.toLowerCase().includes(lower) ||
    lower.includes(p.name.toLowerCase())
  );

  if (!match) {
    return { success: false, message: `Project "${projectName}" not found on Vercel` };
  }

  try {
    // Trigger redeployment using the latest deployment as reference
    const latestDeploy = match.recentDeploys[0];
    if (!latestDeploy) {
      return { success: false, message: `No existing deployments found for ${match.name}` };
    }

    const url = new URL('https://api.vercel.com/v13/deployments');
    if (cfg.teamId) url.searchParams.set('teamId', cfg.teamId);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
      const res = await fetch(url.toString(), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: match.name,
          deploymentId: latestDeploy.url ? undefined : undefined,
          target: 'production',
          project: match.name,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text();
        // If redeploy via API fails, suggest using git push instead
        if (res.status === 400 || res.status === 403) {
          return {
            success: false,
            message: `Vercel API can't trigger deploy directly for git-connected projects. Push to the repo's main branch to trigger a new deploy. Project: ${match.name}`
          };
        }
        return { success: false, message: `Deploy failed (HTTP ${res.status}): ${body.substring(0, 200)}` };
      }

      const data = await res.json() as Record<string, unknown>;
      const deployUrl = data.url as string;
      return {
        success: true,
        message: `Deployment triggered for ${match.name}`,
        url: deployUrl ? `https://${deployUrl}` : undefined
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    return { success: false, message: `Deploy error: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * List all Vercel projects with their URLs.
 */
export async function listVercelProjects(): Promise<{ enabled: boolean; projects: Array<{ name: string; url: string; status: string; domains: string[] }> }> {
  const vercelStatus = await getVercelStatus();
  if (!vercelStatus.enabled) {
    return { enabled: false, projects: [] };
  }

  return {
    enabled: true,
    projects: vercelStatus.projects.map(p => ({
      name: p.name,
      url: p.domains[0] ? `https://${p.domains[0]}` : (p.production.url ? `https://${p.production.url}` : ''),
      status: p.production.status,
      domains: p.domains
    }))
  };
}

export async function getVercelStatus(): Promise<VercelStatus> {
  const config = getConfig();
  if (!config) {
    return { enabled: false, projects: [] };
  }

  // Return cached if fresh
  if (cachedStatus && (Date.now() - cacheTimestamp) < CACHE_TTL_MS) {
    return cachedStatus;
  }

  // Auto-discover projects from team if none explicitly configured
  let projectConfigs = config.projects;
  if (projectConfigs.length === 0 && config.teamId) {
    logger.debug('No VERCEL_PROJECTS set, auto-discovering from team...');
    projectConfigs = await discoverTeamProjects(config.apiToken, config.teamId);
    if (projectConfigs.length === 0) {
      return { enabled: true, projects: [], summary: 'No projects found in team' };
    }
    logger.debug(`Discovered ${projectConfigs.length} projects from team`);
  } else if (projectConfigs.length === 0) {
    return { enabled: true, projects: [], summary: 'No projects configured — set VERCEL_TEAM_ID or VERCEL_PROJECTS' };
  }

  const projects = await Promise.all(
    projectConfigs.map(p => collectProject(p, config.apiToken, config.teamId))
  );

  const healthyCount = projects.filter(p => p.production.status === 'READY').length;
  const summary = `TOTAL: ${projects.length} sites · ${healthyCount} healthy`;

  const status: VercelStatus = {
    enabled: true,
    projects,
    summary,
  };

  cachedStatus = status;
  cacheTimestamp = Date.now();

  return status;
}
