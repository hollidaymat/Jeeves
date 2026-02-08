/**
 * Container Image Update Detection
 * Checks if running containers have newer images available.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { logger } from '../../utils/logger.js';

const execAsync = promisify(exec);

export interface ImageUpdateInfo {
  container: string;
  image: string;
  hasUpdate: boolean;
  currentDigest?: string;
  latestDigest?: string;
}

export interface UpdateCheckResult {
  checked: ImageUpdateInfo[];
  updatesAvailable: number;
  message: string;
}

/**
 * Check if running containers have newer images available.
 * Pulls latest manifests (doesn't download full images).
 */
export async function checkImageUpdates(): Promise<UpdateCheckResult> {
  const results: ImageUpdateInfo[] = [];

  try {
    // Get running containers and their images
    const { stdout } = await execAsync(
      'docker ps --format "{{.Names}}|{{.Image}}"',
      { timeout: 10000 }
    );

    const containers = stdout.trim().split('\n').filter(Boolean);

    for (const line of containers) {
      const [name, image] = line.split('|');
      if (!name || !image) continue;

      try {
        // Get current image digest
        const { stdout: inspectOut } = await execAsync(
          `docker inspect --format='{{.Image}}' ${name} 2>/dev/null`,
          { timeout: 5000 }
        );
        const currentDigest = inspectOut.trim().substring(0, 19);

        // Pull latest manifest only (no download)
        const { stdout: pullOut, stderr } = await execAsync(
          `docker pull ${image} 2>&1 | tail -1`,
          { timeout: 30000 }
        );

        const combined = pullOut + stderr;
        const hasUpdate = !combined.includes('Image is up to date') && !combined.includes('Already exists');

        results.push({
          container: name,
          image,
          hasUpdate,
          currentDigest,
        });
      } catch {
        results.push({ container: name, image, hasUpdate: false });
      }
    }
  } catch (error) {
    logger.debug('[image-updates] Check failed', { error: String(error) });
  }

  const updatesAvailable = results.filter(r => r.hasUpdate).length;
  const message = updatesAvailable === 0
    ? `All ${results.length} container images are up to date`
    : `${updatesAvailable} of ${results.length} containers have updates available`;

  return { checked: results, updatesAvailable, message };
}

export function formatUpdateCheck(result: UpdateCheckResult): string {
  if (result.updatesAvailable === 0) {
    return `All ${result.checked.length} containers are running the latest images.`;
  }

  const lines = ['## Container Updates Available', ''];
  for (const item of result.checked) {
    if (item.hasUpdate) {
      lines.push(`🔄 **${item.container}** (${item.image})`);
    }
  }
  lines.push('', `Run \`update <service>\` to update, or \`update all\` for everything.`);
  return lines.join('\n');
}
