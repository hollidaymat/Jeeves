/**
 * Backup Manager
 * 
 * TypeScript orchestrator for homelab backups.
 * Invokes backup.sh for the actual work, monitors results,
 * tracks backup history, and integrates with the 6-layer context system.
 * 
 * Commands:
 *   "backup now"           -- trigger a full backup
 *   "backup postgres"      -- postgres-only backup
 *   "backup volumes"       -- volumes-only backup
 *   "backup status"        -- show last backup info + health
 *   "backup list"          -- list available backups
 *   "backup restore <svc>" -- restore a service's data from latest backup
 */

import { execHomelab } from '../shell.js';
import { logger } from '../../utils/logger.js';
import { join } from 'path';
import { existsSync, readdirSync, statSync, readFileSync } from 'fs';

// ==========================================
// TYPES
// ==========================================

export interface BackupResult {
  success: boolean;
  message: string;
  mode: 'full' | 'postgres' | 'volumes' | 'cleanup';
  durationMs: number;
  errors: string[];
}

export interface BackupInfo {
  date: string;        // YYYY-MM-DD
  path: string;        // Full directory path
  sizeBytes: number;
  hasPostgres: boolean;
  hasVolumes: boolean;
  hasStacks: boolean;
  volumeNames: string[];
  ageHours: number;
}

export interface BackupHealth {
  lastBackupDate: string | null;
  lastBackupAgeHours: number;
  totalBackups: number;
  totalSizeMB: number;
  diskUsagePercent: number;
  isHealthy: boolean;
  warnings: string[];
}

export interface RestoreResult {
  success: boolean;
  message: string;
  volumeName: string;
  backupDate: string;
  durationMs: number;
}

// ==========================================
// CONFIGURATION
// ==========================================

const BACKUP_DIR = '/data/backups';
const BACKUP_SCRIPT = join(process.cwd(), 'backup.sh');
const MAX_BACKUP_AGE_HOURS = 48; // Warn if no backup in 48h

// Critical volumes (must always be backed up)
const CRITICAL_VOLUMES = [
  'vaultwarden_data',
  'postgres_data',
  'nextcloud_data',
  'paperless_data',
  'paperless_media'
];

// ==========================================
// BACKUP EXECUTION
// ==========================================

/**
 * Run a backup using the backup.sh script.
 */
export async function runBackup(
  mode: 'full' | 'postgres' | 'volumes' | 'cleanup' = 'full'
): Promise<BackupResult> {
  const startTime = Date.now();
  const errors: string[] = [];

  logger.info('Starting backup', { mode });

  // Check script exists
  if (!existsSync(BACKUP_SCRIPT)) {
    return {
      success: false,
      message: `Backup script not found at ${BACKUP_SCRIPT}. Run git pull to get the latest.`,
      mode,
      durationMs: Date.now() - startTime,
      errors: ['Script not found']
    };
  }

  // Execute backup.sh
  const result = await execHomelab('bash', [BACKUP_SCRIPT, mode], {
    timeout: 600000 // 10 minute timeout for full backups
  });

  const durationMs = Date.now() - startTime;

  if (!result.success) {
    errors.push(result.stderr || result.stdout || 'Unknown error');
    logger.error('Backup failed', { mode, error: result.stderr });
  } else {
    logger.info('Backup completed', { mode, durationMs });
  }

  // Parse log for any warnings
  const logOutput = result.stdout || '';
  const warnLines = logOutput.split('\n').filter(l => l.includes('[WARN]') || l.includes('[ERROR]'));
  errors.push(...warnLines);

  // Build friendly message
  let message: string;
  if (result.success) {
    const info = getLatestBackupInfo();
    const sizeStr = info ? formatSize(info.sizeBytes) : 'unknown size';
    message = `Backup complete (${mode}): ${sizeStr} in ${(durationMs / 1000).toFixed(0)}s`;
  } else {
    message = `Backup failed (${mode}): ${errors[0] || 'Check logs'}`;
  }

  return { success: result.success, message, mode, durationMs, errors };
}

// ==========================================
// BACKUP STATUS & LISTING
// ==========================================

/**
 * List all available backups.
 */
export function listBackups(): BackupInfo[] {
  if (!existsSync(BACKUP_DIR)) return [];

  const entries = readdirSync(BACKUP_DIR)
    .filter(e => /^\d{4}-\d{2}-\d{2}$/.test(e))
    .sort()
    .reverse();

  const backups: BackupInfo[] = [];

  for (const entry of entries) {
    const dirPath = join(BACKUP_DIR, entry);
    try {
      const stat = statSync(dirPath);
      if (!stat.isDirectory()) continue;

      const pgDir = join(dirPath, 'postgres');
      const volDir = join(dirPath, 'volumes');
      const stackDir = join(dirPath, 'stacks');

      const hasPostgres = existsSync(pgDir);
      const hasVolumes = existsSync(volDir);
      const hasStacks = existsSync(stackDir);

      // List volume backup files
      let volumeNames: string[] = [];
      if (hasVolumes) {
        volumeNames = readdirSync(volDir)
          .filter(f => f.endsWith('.tar.gz'))
          .map(f => f.replace(/_\d{8}_\d{6}\.tar\.gz$/, ''));
      }

      // Calculate directory size
      const sizeBytes = getDirSize(dirPath);
      const ageHours = (Date.now() - stat.mtime.getTime()) / (1000 * 60 * 60);

      backups.push({
        date: entry,
        path: dirPath,
        sizeBytes,
        hasPostgres,
        hasVolumes,
        hasStacks,
        volumeNames,
        ageHours
      });
    } catch (error) {
      logger.debug('Failed to read backup dir', { dir: entry, error: String(error) });
    }
  }

  return backups;
}

/**
 * Get the most recent backup info.
 */
export function getLatestBackupInfo(): BackupInfo | null {
  const backups = listBackups();
  return backups.length > 0 ? backups[0] : null;
}

/**
 * Get backup health status.
 */
export function getBackupHealth(): BackupHealth {
  const backups = listBackups();
  const warnings: string[] = [];

  const latest = backups.length > 0 ? backups[0] : null;
  const lastBackupDate = latest?.date || null;
  const lastBackupAgeHours = latest ? latest.ageHours : Infinity;

  // Check age
  if (lastBackupAgeHours > MAX_BACKUP_AGE_HOURS) {
    warnings.push(`No backup in ${Math.round(lastBackupAgeHours)}h (max: ${MAX_BACKUP_AGE_HOURS}h)`);
  }

  // Check critical volumes are in latest backup
  if (latest) {
    for (const vol of CRITICAL_VOLUMES) {
      if (!latest.volumeNames.includes(vol)) {
        warnings.push(`Critical volume "${vol}" missing from latest backup`);
      }
    }
    if (!latest.hasPostgres) {
      warnings.push('PostgreSQL dump missing from latest backup');
    }
  }

  // Total size
  const totalSizeBytes = backups.reduce((sum, b) => sum + b.sizeBytes, 0);
  const totalSizeMB = Math.round(totalSizeBytes / (1024 * 1024));

  // Disk usage
  let diskUsagePercent = 0;
  try {
    // Use df to check /data usage
    // This is sync but fast
    const { execSync } = require('child_process');
    const dfOutput = execSync('df /data --output=pcent 2>/dev/null | tail -1', { encoding: 'utf-8' });
    diskUsagePercent = parseInt(dfOutput.trim().replace('%', ''), 10) || 0;
  } catch {
    // Can't check disk usage
  }

  if (diskUsagePercent >= 85) {
    warnings.push(`/data disk at ${diskUsagePercent}% -- backups may fail soon`);
  }

  const isHealthy = warnings.length === 0;

  return {
    lastBackupDate,
    lastBackupAgeHours: Math.round(lastBackupAgeHours),
    totalBackups: backups.length,
    totalSizeMB,
    diskUsagePercent,
    isHealthy,
    warnings
  };
}

// ==========================================
// RESTORE
// ==========================================

/**
 * Restore a Docker volume from the latest backup.
 */
export async function restoreVolume(
  volumeName: string,
  backupDate?: string
): Promise<RestoreResult> {
  const startTime = Date.now();

  // Find the backup
  const backups = listBackups();
  let targetBackup: BackupInfo | undefined;

  if (backupDate) {
    targetBackup = backups.find(b => b.date === backupDate);
  } else {
    // Find latest backup that contains this volume
    targetBackup = backups.find(b => b.volumeNames.includes(volumeName));
  }

  if (!targetBackup) {
    return {
      success: false,
      message: `No backup found for volume "${volumeName}"${backupDate ? ` on ${backupDate}` : ''}`,
      volumeName,
      backupDate: backupDate || 'none',
      durationMs: Date.now() - startTime
    };
  }

  // Find the actual archive file
  const volDir = join(targetBackup.path, 'volumes');
  const archives = readdirSync(volDir)
    .filter(f => f.startsWith(volumeName + '_') && f.endsWith('.tar.gz'));

  if (archives.length === 0) {
    return {
      success: false,
      message: `Archive file for "${volumeName}" not found in ${targetBackup.date} backup`,
      volumeName,
      backupDate: targetBackup.date,
      durationMs: Date.now() - startTime
    };
  }

  const archiveFile = archives[archives.length - 1]; // Latest timestamp
  const archivePath = join(volDir, archiveFile);

  // Verify checksum if available
  const checksumPath = archivePath + '.sha256';
  if (existsSync(checksumPath)) {
    const verifyResult = await execHomelab('sha256sum', ['-c', checksumPath], {
      timeout: 30000
    });
    if (!verifyResult.success) {
      return {
        success: false,
        message: `Checksum verification failed for ${archiveFile}. Backup may be corrupt.`,
        volumeName,
        backupDate: targetBackup.date,
        durationMs: Date.now() - startTime
      };
    }
  }

  logger.warn('Restoring volume from backup', { volumeName, backup: targetBackup.date, archive: archiveFile });

  // Restore: docker run --rm -v <volume>:/volume -v <backup_dir>:/backup alpine sh -c "rm -rf /volume/* && tar xzf /backup/<file> -C /volume"
  const result = await execHomelab('docker', [
    'run', '--rm',
    '-v', `${volumeName}:/volume`,
    '-v', `${volDir}:/backup:ro`,
    'alpine',
    'sh', '-c', `cd /volume && tar xzf /backup/${archiveFile}`
  ], { timeout: 300000 }); // 5 min timeout

  const durationMs = Date.now() - startTime;

  if (result.success) {
    logger.info('Volume restored successfully', { volumeName, backup: targetBackup.date, durationMs });
    return {
      success: true,
      message: `Restored "${volumeName}" from ${targetBackup.date} backup (${formatSize(statSync(archivePath).size)}) in ${(durationMs / 1000).toFixed(0)}s`,
      volumeName,
      backupDate: targetBackup.date,
      durationMs
    };
  } else {
    return {
      success: false,
      message: `Restore failed: ${result.stderr || result.stdout || 'Unknown error'}`,
      volumeName,
      backupDate: targetBackup.date,
      durationMs
    };
  }
}

/**
 * Restore PostgreSQL from the latest backup.
 */
export async function restorePostgres(backupDate?: string): Promise<RestoreResult> {
  const startTime = Date.now();

  const backups = listBackups();
  let targetBackup: BackupInfo | undefined;

  if (backupDate) {
    targetBackup = backups.find(b => b.date === backupDate && b.hasPostgres);
  } else {
    targetBackup = backups.find(b => b.hasPostgres);
  }

  if (!targetBackup) {
    return {
      success: false,
      message: 'No PostgreSQL backup found',
      volumeName: 'postgres',
      backupDate: backupDate || 'none',
      durationMs: Date.now() - startTime
    };
  }

  const pgDir = join(targetBackup.path, 'postgres');
  const dumps = readdirSync(pgDir).filter(f => f.endsWith('.sql.gz'));

  if (dumps.length === 0) {
    return {
      success: false,
      message: `No SQL dump found in ${targetBackup.date} backup`,
      volumeName: 'postgres',
      backupDate: targetBackup.date,
      durationMs: Date.now() - startTime
    };
  }

  const dumpFile = dumps[dumps.length - 1];
  const dumpPath = join(pgDir, dumpFile);

  logger.warn('Restoring PostgreSQL from backup', { backup: targetBackup.date, dump: dumpFile });

  // Decompress and pipe into psql
  // gunzip -c <file> | docker exec -i postgres psql -U jeeves
  const result = await execHomelab('bash', [
    '-c',
    `gunzip -c "${dumpPath}" | docker exec -i postgres psql -U jeeves 2>&1`
  ], { timeout: 300000 });

  const durationMs = Date.now() - startTime;

  if (result.success) {
    return {
      success: true,
      message: `PostgreSQL restored from ${targetBackup.date} backup in ${(durationMs / 1000).toFixed(0)}s`,
      volumeName: 'postgres',
      backupDate: targetBackup.date,
      durationMs
    };
  } else {
    return {
      success: false,
      message: `PostgreSQL restore failed: ${result.stderr || 'Unknown error'}`,
      volumeName: 'postgres',
      backupDate: targetBackup.date,
      durationMs
    };
  }
}

// ==========================================
// FORMATTED OUTPUT
// ==========================================

/**
 * Format backup status for display via Signal.
 */
export function formatBackupStatus(): string {
  const health = getBackupHealth();
  const latest = getLatestBackupInfo();

  let output = '## Backup Status\n\n';

  if (!latest) {
    output += '**No backups found.** Run `backup now` to create one.\n';
    return output;
  }

  const healthIcon = health.isHealthy ? '✅' : '⚠️';
  output += `${healthIcon} **Health:** ${health.isHealthy ? 'Healthy' : 'Needs attention'}\n`;
  output += `**Last backup:** ${latest.date} (${Math.round(latest.ageHours)}h ago)\n`;
  output += `**Last size:** ${formatSize(latest.sizeBytes)}\n`;
  output += `**Total backups:** ${health.totalBackups} (${health.totalSizeMB}MB total)\n`;
  output += `**Disk usage:** ${health.diskUsagePercent}%\n`;

  if (latest.hasPostgres) output += '✅ PostgreSQL dump\n';
  else output += '❌ PostgreSQL dump missing\n';

  if (latest.hasVolumes) output += `✅ ${latest.volumeNames.length} volumes backed up\n`;
  else output += '❌ Volume backups missing\n';

  if (latest.hasStacks) output += '✅ Compose stacks\n';

  if (health.warnings.length > 0) {
    output += '\n### Warnings\n';
    for (const w of health.warnings) {
      output += `⚠️ ${w}\n`;
    }
  }

  return output;
}

/**
 * Format backup list for display.
 */
export function formatBackupList(): string {
  const backups = listBackups();

  if (backups.length === 0) {
    return 'No backups found. Run `backup now` to create one.';
  }

  let output = '## Available Backups\n\n';
  output += '| Date | Size | PG | Volumes | Stacks | Age |\n';
  output += '|------|------|----|---------|--------|-----|\n';

  for (const b of backups) {
    const pg = b.hasPostgres ? '✅' : '❌';
    const vols = b.hasVolumes ? `✅ ${b.volumeNames.length}` : '❌';
    const stacks = b.hasStacks ? '✅' : '❌';
    const age = b.ageHours < 24 ? `${Math.round(b.ageHours)}h` : `${Math.round(b.ageHours / 24)}d`;
    output += `| ${b.date} | ${formatSize(b.sizeBytes)} | ${pg} | ${vols} | ${stacks} | ${age} |\n`;
  }

  output += `\nRestore with: \`restore <volume_name>\` or \`restore postgres\``;

  return output;
}

// ==========================================
// SCHEDULED CHECK (called from health-checker)
// ==========================================

/**
 * Check if backups are healthy (for integration with health-checker).
 * Returns warnings if backup is stale.
 */
export function checkBackupAge(): string[] {
  const health = getBackupHealth();
  return health.warnings;
}

// ==========================================
// HELPERS
// ==========================================

function getDirSize(dirPath: string): number {
  let totalSize = 0;

  try {
    const entries = readdirSync(dirPath);
    for (const entry of entries) {
      const fullPath = join(dirPath, entry);
      const stat = statSync(fullPath);
      if (stat.isFile()) {
        totalSize += stat.size;
      } else if (stat.isDirectory()) {
        totalSize += getDirSize(fullPath);
      }
    }
  } catch {
    // Permission or read error
  }

  return totalSize;
}

function formatSize(bytes: number): string {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)}GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}
