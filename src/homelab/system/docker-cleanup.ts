/**
 * Docker Cleanup
 * Prunes unused images, volumes, and build cache.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { logger } from '../../utils/logger.js';

const execAsync = promisify(exec);

export interface CleanupResult {
  success: boolean;
  danglingImages: number;
  reclaimedSpace: string;
  details: string[];
  message: string;
}

/**
 * Check how much can be cleaned without actually pruning.
 */
export async function getCleanupPreview(): Promise<{ danglingImages: number; stoppedContainers: number; unusedVolumes: number }> {
  let danglingImages = 0;
  let stoppedContainers = 0;
  let unusedVolumes = 0;

  try {
    const { stdout: imgOut } = await execAsync('docker images -f dangling=true -q | wc -l', { timeout: 10000 });
    danglingImages = parseInt(imgOut.trim(), 10) || 0;
  } catch { /* ignore */ }

  try {
    const { stdout: ctrOut } = await execAsync('docker ps -f status=exited -q | wc -l', { timeout: 10000 });
    stoppedContainers = parseInt(ctrOut.trim(), 10) || 0;
  } catch { /* ignore */ }

  try {
    const { stdout: volOut } = await execAsync('docker volume ls -f dangling=true -q | wc -l', { timeout: 10000 });
    unusedVolumes = parseInt(volOut.trim(), 10) || 0;
  } catch { /* ignore */ }

  return { danglingImages, stoppedContainers, unusedVolumes };
}

/**
 * Run docker system prune and report what was cleaned.
 */
export async function runCleanup(): Promise<CleanupResult> {
  const details: string[] = [];
  let reclaimedSpace = '0B';

  try {
    // Prune stopped containers, dangling images, unused networks, build cache
    const { stdout } = await execAsync('docker system prune -f 2>&1', { timeout: 60000 });
    details.push(stdout.trim());

    // Extract space reclaimed
    const spaceMatch = stdout.match(/Total reclaimed space:\s*(.+)/i);
    if (spaceMatch) reclaimedSpace = spaceMatch[1].trim();

    // Also prune dangling volumes
    try {
      const { stdout: volOut } = await execAsync('docker volume prune -f 2>&1', { timeout: 30000 });
      const volMatch = volOut.match(/Total reclaimed space:\s*(.+)/i);
      if (volMatch) details.push(`Volumes: ${volMatch[1].trim()}`);
    } catch { /* optional */ }

    const preview = await getCleanupPreview();

    logger.info('[docker-cleanup] Cleanup completed', { reclaimedSpace });

    return {
      success: true,
      danglingImages: preview.danglingImages,
      reclaimedSpace,
      details,
      message: `Docker cleanup complete. Reclaimed ${reclaimedSpace}.`,
    };
  } catch (error) {
    return {
      success: false,
      danglingImages: 0,
      reclaimedSpace: '0B',
      details: [String(error)],
      message: `Cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
