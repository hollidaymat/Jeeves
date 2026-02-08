/**
 * SMART Disk Health Monitor
 * Reads SMART data via smartctl to detect degrading drives.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { logger } from '../../utils/logger.js';

const execAsync = promisify(exec);

export interface DiskHealth {
  device: string;
  model: string;
  serial: string;
  healthy: boolean;
  temperature?: number;
  powerOnHours?: number;
  reallocatedSectors?: number;
  pendingSectors?: number;
  warnings: string[];
}

export interface SmartReport {
  disks: DiskHealth[];
  overallHealthy: boolean;
  summary: string;
}

/**
 * Get SMART health for all drives.
 */
export async function getSmartHealth(): Promise<SmartReport> {
  const disks: DiskHealth[] = [];
  const warnings: string[] = [];

  try {
    // Discover block devices
    const { stdout: lsblkOut } = await execAsync('lsblk -dn -o NAME,TYPE | grep disk', { timeout: 5000 });
    const devices = lsblkOut.trim().split('\n')
      .map(line => `/dev/${line.split(/\s+/)[0]}`)
      .filter(d => d && !d.includes('loop'));

    for (const device of devices) {
      try {
        const { stdout } = await execAsync(`sudo smartctl --json=c -a ${device} 2>/dev/null || smartctl --json=c -a ${device} 2>/dev/null`, { timeout: 10000 });
        const data = JSON.parse(stdout);

        const health: DiskHealth = {
          device,
          model: data.model_name || data.scsi_model_name || 'Unknown',
          serial: data.serial_number || 'Unknown',
          healthy: data.smart_status?.passed !== false,
          warnings: [],
        };

        // Parse temperature
        if (data.temperature?.current) {
          health.temperature = data.temperature.current;
          if (health.temperature && health.temperature > 55) {
            health.warnings.push(`High temp: ${health.temperature}C`);
          }
        }

        // Parse power-on hours
        const attrs = data.ata_smart_attributes?.table || [];
        for (const attr of attrs) {
          switch (attr.id) {
            case 5: { // Reallocated Sectors
              const realloc = attr.raw?.value || 0;
              health.reallocatedSectors = realloc;
              if (realloc > 0) {
                health.warnings.push(`${realloc} reallocated sectors`);
              }
              break;
            }
            case 9: // Power-On Hours
              health.powerOnHours = attr.raw?.value || 0;
              break;
            case 197: { // Current Pending Sectors
              const pending = attr.raw?.value || 0;
              health.pendingSectors = pending;
              if (pending > 0) {
                health.warnings.push(`${pending} pending sectors`);
              }
              break;
            }
          }
        }

        // NVMe attributes
        if (data.nvme_smart_health_information_log) {
          const nvme = data.nvme_smart_health_information_log;
          health.temperature = nvme.temperature;
          health.powerOnHours = nvme.power_on_hours;
          if (nvme.media_errors > 0) {
            health.warnings.push(`${nvme.media_errors} media errors`);
          }
          if (nvme.percentage_used > 90) {
            health.warnings.push(`${nvme.percentage_used}% life used`);
          }
        }

        if (!health.healthy) {
          health.warnings.push('SMART status: FAILED');
        }

        disks.push(health);
        warnings.push(...health.warnings);
      } catch {
        disks.push({
          device,
          model: 'Unknown',
          serial: 'Unknown',
          healthy: true,
          warnings: ['Could not read SMART data (may need sudo)'],
        });
      }
    }
  } catch (error) {
    logger.debug('[smart] Failed to discover disks', { error: String(error) });
  }

  const overallHealthy = disks.every(d => d.healthy && d.warnings.length === 0);
  const summary = disks.length === 0
    ? 'No disks detected (smartctl may not be installed)'
    : overallHealthy
      ? `${disks.length} disk(s) healthy`
      : `${warnings.length} warning(s) across ${disks.length} disk(s)`;

  return { disks, overallHealthy, summary };
}

/**
 * Format SMART report for display.
 */
export function formatSmartReport(report: SmartReport): string {
  if (report.disks.length === 0) {
    return 'No disks detected. Is smartctl installed? (`sudo apt install smartmontools`)';
  }

  const lines: string[] = ['## Disk Health (SMART)', ''];
  for (const disk of report.disks) {
    const status = disk.healthy && disk.warnings.length === 0 ? 'HEALTHY' : 'WARNING';
    const icon = status === 'HEALTHY' ? '🟢' : '🟡';
    lines.push(`${icon} **${disk.device}** — ${disk.model} (${status})`);
    if (disk.temperature) lines.push(`   Temp: ${disk.temperature}C`);
    if (disk.powerOnHours) lines.push(`   Power-on: ${Math.round(disk.powerOnHours / 24)} days`);
    if (disk.reallocatedSectors !== undefined) lines.push(`   Reallocated sectors: ${disk.reallocatedSectors}`);
    for (const w of disk.warnings) {
      lines.push(`   ⚠️ ${w}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
