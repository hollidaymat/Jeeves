/**
 * Nextcloud Integration
 * Storage info, upload files, create share links.
 */

import { logger } from '../../utils/logger.js';

const NC_URL = process.env.NEXTCLOUD_URL || 'http://localhost:8080';
const NC_USER = process.env.NEXTCLOUD_USER || '';
const NC_PASS = process.env.NEXTCLOUD_PASS || '';

function authHeaders(): Record<string, string> {
  return {
    'Authorization': 'Basic ' + Buffer.from(`${NC_USER}:${NC_PASS}`).toString('base64'),
    'OCS-APIRequest': 'true',
    'Accept': 'application/json',
  };
}

export interface NextcloudStorage {
  used: number;
  total: number;
  usedPercent: number;
  usedFormatted: string;
  totalFormatted: string;
}

function formatSize(bytes: number): string {
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1)} TB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e3).toFixed(1)} KB`;
}

/**
 * Get storage usage from Nextcloud.
 */
export async function getStorageInfo(): Promise<NextcloudStorage | null> {
  if (!NC_USER || !NC_PASS) {
    logger.debug('[nextcloud] No credentials configured');
    return null;
  }

  try {
    const res = await fetch(`${NC_URL}/ocs/v1.php/cloud/users/${NC_USER}?format=json`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(10000),
    });

    const data = await res.json() as Record<string, unknown>;
    const quota = (data as Record<string, Record<string, Record<string, Record<string, number>>>>).ocs?.data?.quota;

    if (quota) {
      const used = quota.used || 0;
      const total = quota.total || 0;
      return {
        used,
        total,
        usedPercent: total > 0 ? Math.round((used / total) * 100) : 0,
        usedFormatted: formatSize(used),
        totalFormatted: total > 0 ? formatSize(total) : 'unlimited',
      };
    }
  } catch (error) {
    logger.debug('[nextcloud] API call failed', { error: String(error) });
  }
  return null;
}

/**
 * Upload a file to Nextcloud via WebDAV.
 */
export async function uploadFile(localPath: string, remotePath: string): Promise<boolean> {
  if (!NC_USER || !NC_PASS) return false;

  try {
    const { readFileSync } = await import('fs');
    const content = readFileSync(localPath);

    const res = await fetch(
      `${NC_URL}/remote.php/dav/files/${NC_USER}/${remotePath}`,
      {
        method: 'PUT',
        headers: {
          ...authHeaders(),
          'Content-Type': 'application/octet-stream',
        },
        body: content,
        signal: AbortSignal.timeout(30000),
      }
    );

    return res.status === 201 || res.status === 204;
  } catch (error) {
    logger.debug('[nextcloud] Upload failed', { error: String(error) });
    return false;
  }
}

/**
 * Create a public share link for a file.
 */
export async function createShareLink(path: string): Promise<string | null> {
  if (!NC_USER || !NC_PASS) return null;

  try {
    const res = await fetch(`${NC_URL}/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json`, {
      method: 'POST',
      headers: {
        ...authHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        path,
        shareType: 3, // Public link
        permissions: 1, // Read-only
      }),
      signal: AbortSignal.timeout(10000),
    });

    const data = await res.json() as Record<string, Record<string, Record<string, string>>>;
    return data.ocs?.data?.url || null;
  } catch (error) {
    logger.debug('[nextcloud] Share link failed', { error: String(error) });
    return null;
  }
}

export function formatStorageInfo(info: NextcloudStorage | null): string {
  if (!info) return 'Nextcloud not configured or unreachable. Set NEXTCLOUD_URL, NEXTCLOUD_USER, NEXTCLOUD_PASS in .env.';
  return [
    '## Nextcloud Storage',
    '',
    `Used: ${info.usedFormatted} / ${info.totalFormatted} (${info.usedPercent}%)`,
  ].join('\n');
}
