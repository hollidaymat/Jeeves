/**
 * Layer 6: Runtime Context (Live State)
 * 
 * Real-time system state at the moment of the request.
 * Wraps existing homelab monitors (resource-monitor, health-checker).
 * Only queried for system/homelab operations, not chat.
 */

import { logger } from '../../../utils/logger.js';

// ==========================================
// TYPES
// ==========================================

export interface RuntimeSnapshot {
  ramAvailableMB: number;
  ramTotalMB: number;
  cpuPercent: number;
  diskUsedPercent: number;
  tempCelsius: number;
  containerCount: number;
  containersHealthy: number;
  containersUnhealthy: number;
  timestamp: number;
}

// ==========================================
// RUNTIME DATA COLLECTION
// ==========================================

/**
 * Get a snapshot of the current system state.
 * Wraps existing homelab monitors where available.
 * Returns null on non-Linux platforms.
 */
export async function getRuntimeSnapshot(): Promise<RuntimeSnapshot | null> {
  if (process.platform !== 'linux') {
    return null;
  }

  const snapshot: RuntimeSnapshot = {
    ramAvailableMB: 0,
    ramTotalMB: 0,
    cpuPercent: 0,
    diskUsedPercent: 0,
    tempCelsius: 0,
    containerCount: 0,
    containersHealthy: 0,
    containersUnhealthy: 0,
    timestamp: Date.now()
  };

  try {
    // Try to use existing resource monitor
    const resourceMon = await safeImport('../../../homelab/system/resource-monitor.js');

    if (resourceMon) {
      const [ram, cpu, disk, temp] = await Promise.allSettled([
        resourceMon.getRAM?.(),
        resourceMon.getCPU?.(),
        resourceMon.getDisk?.(),
        resourceMon.getTemperature?.()
      ]);

      if (ram.status === 'fulfilled' && ram.value) {
        snapshot.ramAvailableMB = ram.value.available || 0;
        snapshot.ramTotalMB = ram.value.total || 0;
      }

      if (cpu.status === 'fulfilled' && cpu.value) {
        snapshot.cpuPercent = cpu.value.usage || 0;
      }

      if (disk.status === 'fulfilled' && disk.value) {
        snapshot.diskUsedPercent = disk.value.usedPercent || 0;
      }

      if (temp.status === 'fulfilled' && temp.value) {
        snapshot.tempCelsius = temp.value.celsius || 0;
      }
    }
  } catch (error) {
    logger.debug('Resource monitor unavailable', { error: String(error) });
  }

  try {
    // Try to get container counts from health checker
    const healthChecker = await safeImport('../../../homelab/services/health-checker.js');

    if (healthChecker?.getHealthReport) {
      const report = await healthChecker.getHealthReport();
      if (report) {
        snapshot.containerCount = (report.healthy || 0) + (report.unhealthy || 0) + (report.degraded || 0);
        snapshot.containersHealthy = report.healthy || 0;
        snapshot.containersUnhealthy = (report.unhealthy || 0) + (report.degraded || 0);
      }
    }
  } catch (error) {
    logger.debug('Health checker unavailable', { error: String(error) });
  }

  return snapshot;
}

// ==========================================
// HELPERS
// ==========================================

async function safeImport(modulePath: string): Promise<any> {
  try {
    return await import(modulePath);
  } catch {
    return null;
  }
}
