/**
 * Knowledge Scout - Source Registry
 * Defines all intelligence sources Jeeves monitors
 */

import { logger } from '../../utils/logger.js';

export interface ScoutSource {
  name: string;
  type: 'github_release' | 'security' | 'tech' | 'business';
  /** How to check: 'github_api' for releases, 'command' for local commands, 'web' for URLs */
  checkMethod: 'github_api' | 'command' | 'web';
  /** For github_api: owner/repo. For command: the command string. For web: the URL */
  target: string;
  /** Check interval in ms */
  intervalMs: number;
  /** Last checked timestamp */
  lastChecked: number;
  /** Whether this source is currently enabled */
  enabled: boolean;
}

export interface ScoutFinding {
  id: string;
  sourceId: string;
  type: 'security' | 'release' | 'tech' | 'business';
  severity: 'high' | 'medium' | 'low' | 'info';
  title: string;
  summary: string;
  detail?: string;
  url?: string;
  relevanceScore: number; // 0-100
  actionable: boolean;
  recommendedAction?: string;
  timestamp: string;
  acknowledged: boolean;
}

// Default sources
export function getDefaultSources(): ScoutSource[] {
  logger.debug('Loading default scout sources');

  return [
    // Services running on Daemon
    { name: 'Jellyfin releases', type: 'github_release', checkMethod: 'github_api', target: 'jellyfin/jellyfin', intervalMs: 86400000, lastChecked: 0, enabled: true },
    { name: 'Radarr releases', type: 'github_release', checkMethod: 'github_api', target: 'Radarr/Radarr', intervalMs: 86400000, lastChecked: 0, enabled: true },
    { name: 'Sonarr releases', type: 'github_release', checkMethod: 'github_api', target: 'Sonarr/Sonarr', intervalMs: 86400000, lastChecked: 0, enabled: true },
    { name: 'Prowlarr releases', type: 'github_release', checkMethod: 'github_api', target: 'Prowlarr/Prowlarr', intervalMs: 86400000, lastChecked: 0, enabled: true },
    { name: 'Nextcloud releases', type: 'github_release', checkMethod: 'github_api', target: 'nextcloud/server', intervalMs: 86400000, lastChecked: 0, enabled: true },
    { name: 'Pi-hole releases', type: 'github_release', checkMethod: 'github_api', target: 'pi-hole/pi-hole', intervalMs: 86400000, lastChecked: 0, enabled: true },
    // Tech stack
    { name: 'Next.js releases', type: 'tech', checkMethod: 'github_api', target: 'vercel/next.js', intervalMs: 86400000, lastChecked: 0, enabled: true },
    { name: 'Tailwind releases', type: 'tech', checkMethod: 'github_api', target: 'tailwindlabs/tailwindcss', intervalMs: 86400000, lastChecked: 0, enabled: true },
    // Security
    { name: 'npm audit', type: 'security', checkMethod: 'command', target: 'npm audit --json 2>/dev/null || echo "{}"', intervalMs: 86400000, lastChecked: 0, enabled: process.platform === 'linux' },
    { name: 'Docker CVEs', type: 'security', checkMethod: 'command', target: 'docker scout cves --format json 2>/dev/null || echo "[]"', intervalMs: 86400000, lastChecked: 0, enabled: process.platform === 'linux' },
  ];
}
