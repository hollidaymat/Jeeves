/**
 * Jeeves Homelab - System Resource Monitor
 * 
 * Monitors CPU, RAM, disk, temperature, and network stats on the Beelink Mini S13.
 * Uses /proc and /sys file reads where possible, falls back to shell commands.
 * Gracefully handles missing files (Windows dev environment).
 */

import { spawn } from 'child_process';
import { readFileSync, existsSync } from 'fs';

// ============================================================================
// Types (local interfaces - Agent 1 will reconcile with types/index.ts)
// ============================================================================

export interface CPUStatus {
  usagePercent: number;       // 0-100
  loadAverage: number[];      // [1min, 5min, 15min]
  cores: number;
}

export interface RAMStatus {
  totalMB: number;
  usedMB: number;
  freeMB: number;
  availableMB: number;
  usagePercent: number;       // 0-100
  swapTotalMB: number;
  swapUsedMB: number;
}

export interface DiskPartition {
  filesystem: string;
  sizeMB: number;
  usedMB: number;
  availableMB: number;
  usagePercent: number;
  mountpoint: string;
}

export interface DiskStatus {
  partitions: DiskPartition[];
  rootUsagePercent: number;   // Quick access to / usage
}

export interface TemperatureStatus {
  celcius: number;
  fahrenheit: number;
  source: string;             // Which thermal zone
}

export interface NetworkInterfaceStats {
  name: string;
  rxBytes: number;
  txBytes: number;
  rxPackets: number;
  txPackets: number;
  rxErrors: number;
  txErrors: number;
  state: string;              // UP/DOWN
}

export interface NetworkStatus {
  interfaces: NetworkInterfaceStats[];
}

export interface HomelabSystemStatus {
  cpu: CPUStatus;
  ram: RAMStatus;
  disk: DiskStatus;
  temperature: TemperatureStatus;
  network: NetworkStatus;
  timestamp: string;
}

export type ThresholdLevel = 'ok' | 'warning' | 'critical';

export interface ThresholdResult {
  metric: string;
  level: ThresholdLevel;
  value: number;
  warningAt: number;
  criticalAt: number;
  message: string;
}

export interface ThresholdConfig {
  cpu: { warning: number; critical: number };
  ram: { warning: number; critical: number };
  disk: { warning: number; critical: number };
  temp: { warning: number; critical: number };
}

// ============================================================================
// Default Thresholds (from JEEVES_HOMELAB_BUILD.md / OPERATIONS.md)
// ============================================================================

const DEFAULT_THRESHOLDS: ThresholdConfig = {
  cpu:  { warning: 80, critical: 95 },
  ram:  { warning: 85, critical: 95 },   // 14GB of 16GB hard limit
  disk: { warning: 80, critical: 90 },
  temp: { warning: 75, critical: 85 },   // N150 throttles at ~90C
};

// ============================================================================
// Helpers
// ============================================================================

/**
 * Run a shell command and capture stdout. Returns empty string on failure.
 */
function runCommand(cmd: string, args: string[], timeoutMs: number = 5000): Promise<string> {
  return new Promise((resolve) => {
    try {
      const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
      }, timeoutMs);

      proc.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut || code !== 0) {
          resolve('');
        } else {
          resolve(stdout);
        }
      });

      proc.on('error', () => {
        clearTimeout(timer);
        resolve('');
      });
    } catch {
      resolve('');
    }
  });
}

/**
 * Safely read a file. Returns null if it doesn't exist or can't be read.
 */
function safeReadFile(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Parse a size string like "1.5G", "512M", "100K" to MB.
 */
function parseSizeToMB(sizeStr: string): number {
  const cleaned = sizeStr.trim();
  const value = parseFloat(cleaned);
  if (isNaN(value)) return 0;

  const unit = cleaned.replace(/[\d.]/g, '').toUpperCase();
  switch (unit) {
    case 'T': return value * 1024 * 1024;
    case 'G': return value * 1024;
    case 'M': return value;
    case 'K': return value / 1024;
    case 'B': return value / (1024 * 1024);
    default:  return value; // assume MB
  }
}

// ============================================================================
// CPU Monitoring
// ============================================================================

// Previous CPU sample for delta calculation
let prevCPUIdle = 0;
let prevCPUTotal = 0;

/**
 * Read CPU usage from /proc/stat.
 * Format: cpu user nice system idle iowait irq softirq steal
 * Usage = 1 - (idle_delta / total_delta)
 */
export async function getCPU(): Promise<CPUStatus> {
  const defaultResult: CPUStatus = { usagePercent: 0, loadAverage: [0, 0, 0], cores: 0 };

  // --- CPU usage from /proc/stat ---
  const statContent = safeReadFile('/proc/stat');
  let usagePercent = 0;
  let cores = 0;

  if (statContent) {
    const lines = statContent.split('\n');

    // Count cores (lines starting with "cpu" followed by a digit)
    cores = lines.filter(l => /^cpu\d+/.test(l)).length;

    // Parse aggregate cpu line
    const cpuLine = lines.find(l => l.startsWith('cpu '));
    if (cpuLine) {
      const parts = cpuLine.trim().split(/\s+/).slice(1).map(Number);
      // user, nice, system, idle, iowait, irq, softirq, steal
      const idle = parts[3] + (parts[4] || 0); // idle + iowait
      const total = parts.reduce((sum, v) => sum + v, 0);

      if (prevCPUTotal > 0) {
        const idleDelta = idle - prevCPUIdle;
        const totalDelta = total - prevCPUTotal;
        usagePercent = totalDelta > 0
          ? Math.round((1 - idleDelta / totalDelta) * 1000) / 10
          : 0;
      }

      prevCPUIdle = idle;
      prevCPUTotal = total;
    }
  }

  // --- Load average from /proc/loadavg ---
  let loadAverage = [0, 0, 0];
  const loadContent = safeReadFile('/proc/loadavg');
  if (loadContent) {
    const parts = loadContent.trim().split(/\s+/);
    loadAverage = parts.slice(0, 3).map(Number);
  }

  // Fallback: use uptime command if /proc files not available (Windows)
  if (!statContent) {
    const uptimeOutput = await runCommand('uptime', []);
    if (uptimeOutput) {
      const loadMatch = uptimeOutput.match(/load average[s]?:\s*([\d.]+),?\s*([\d.]+),?\s*([\d.]+)/);
      if (loadMatch) {
        loadAverage = [parseFloat(loadMatch[1]), parseFloat(loadMatch[2]), parseFloat(loadMatch[3])];
      }
    }
  }

  return {
    usagePercent: Math.max(0, Math.min(100, usagePercent)),
    loadAverage,
    cores: cores || 4, // N150 has 4 cores
  };
}

// ============================================================================
// RAM Monitoring
// ============================================================================

/**
 * Get RAM usage via `free -m` command output.
 * Output format:
 *               total    used    free   shared  buff/cache  available
 * Mem:          15884    4321    8765     234      2798       11120
 * Swap:          2047     123    1924
 */
export async function getRAM(): Promise<RAMStatus> {
  const defaultResult: RAMStatus = {
    totalMB: 0, usedMB: 0, freeMB: 0, availableMB: 0,
    usagePercent: 0, swapTotalMB: 0, swapUsedMB: 0,
  };

  const output = await runCommand('free', ['-m']);
  if (!output) return defaultResult;

  const lines = output.trim().split('\n');

  // Parse Mem line
  const memLine = lines.find(l => l.startsWith('Mem:'));
  if (!memLine) return defaultResult;

  const memParts = memLine.trim().split(/\s+/).map((v, i) => i === 0 ? v : Number(v));
  const totalMB = memParts[1] as number;
  const usedMB = memParts[2] as number;
  const freeMB = memParts[3] as number;
  const availableMB = (memParts[6] as number) || freeMB;

  // Parse Swap line
  let swapTotalMB = 0;
  let swapUsedMB = 0;
  const swapLine = lines.find(l => l.startsWith('Swap:'));
  if (swapLine) {
    const swapParts = swapLine.trim().split(/\s+/).map((v, i) => i === 0 ? v : Number(v));
    swapTotalMB = swapParts[1] as number;
    swapUsedMB = swapParts[2] as number;
  }

  const usagePercent = totalMB > 0 ? Math.round((usedMB / totalMB) * 1000) / 10 : 0;

  return {
    totalMB,
    usedMB,
    freeMB,
    availableMB,
    usagePercent,
    swapTotalMB,
    swapUsedMB,
  };
}

// ============================================================================
// Disk Monitoring
// ============================================================================

/**
 * Get disk usage via `df -h` command.
 * Output format:
 * Filesystem      Size  Used Avail Use% Mounted on
 * /dev/sda1       476G  123G  329G  28% /
 */
export async function getDisk(): Promise<DiskStatus> {
  const defaultResult: DiskStatus = { partitions: [], rootUsagePercent: 0 };

  const output = await runCommand('df', ['-h']);
  if (!output) return defaultResult;

  const lines = output.trim().split('\n');
  const partitions: DiskPartition[] = [];

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].trim().split(/\s+/);
    if (parts.length < 6) continue;

    // Skip pseudo filesystems
    const fs = parts[0];
    if (fs === 'tmpfs' || fs === 'devtmpfs' || fs === 'udev' || fs === 'overlay') continue;
    if (!fs.startsWith('/dev/') && fs !== 'none') continue;

    const usageStr = parts[4].replace('%', '');
    const usagePercent = parseInt(usageStr, 10) || 0;

    partitions.push({
      filesystem: fs,
      sizeMB: parseSizeToMB(parts[1]),
      usedMB: parseSizeToMB(parts[2]),
      availableMB: parseSizeToMB(parts[3]),
      usagePercent,
      mountpoint: parts[5],
    });
  }

  const rootPartition = partitions.find(p => p.mountpoint === '/');

  return {
    partitions,
    rootUsagePercent: rootPartition?.usagePercent ?? 0,
  };
}

// ============================================================================
// Temperature Monitoring
// ============================================================================

/**
 * Read CPU temperature from /sys/class/thermal/thermal_zone0/temp.
 * The file contains temperature in millidegrees Celsius (e.g., 52000 = 52.0°C).
 */
export async function getTemperature(): Promise<TemperatureStatus> {
  const defaultResult: TemperatureStatus = { celcius: 0, fahrenheit: 32, source: 'unknown' };

  // Try primary thermal zone
  const thermalPaths = [
    '/sys/class/thermal/thermal_zone0/temp',
    '/sys/class/thermal/thermal_zone1/temp',
    '/sys/class/thermal/thermal_zone2/temp',
  ];

  for (const path of thermalPaths) {
    const content = safeReadFile(path);
    if (content) {
      const millidegrees = parseInt(content.trim(), 10);
      if (!isNaN(millidegrees)) {
        const celcius = millidegrees / 1000;
        return {
          celcius: Math.round(celcius * 10) / 10,
          fahrenheit: Math.round((celcius * 9 / 5 + 32) * 10) / 10,
          source: path,
        };
      }
    }
  }

  // Fallback: try sensors command
  const sensorsOutput = await runCommand('sensors', ['-u']);
  if (sensorsOutput) {
    const tempMatch = sensorsOutput.match(/temp1_input:\s*([\d.]+)/);
    if (tempMatch) {
      const celcius = parseFloat(tempMatch[1]);
      return {
        celcius: Math.round(celcius * 10) / 10,
        fahrenheit: Math.round((celcius * 9 / 5 + 32) * 10) / 10,
        source: 'sensors',
      };
    }
  }

  return defaultResult;
}

// ============================================================================
// Network Monitoring
// ============================================================================

/**
 * Get network interface stats via `ip -s link`.
 * Parses interface name, RX/TX bytes, packets, errors, and state.
 */
export async function getNetwork(): Promise<NetworkStatus> {
  const defaultResult: NetworkStatus = { interfaces: [] };

  const output = await runCommand('ip', ['-s', 'link']);
  if (!output) return defaultResult;

  const interfaces: NetworkInterfaceStats[] = [];
  const blocks = output.split(/(?=^\d+:)/m);

  for (const block of blocks) {
    if (!block.trim()) continue;

    // Parse interface name and state
    const headerMatch = block.match(/^\d+:\s+(\S+?)(?:@\S+)?:\s+<([^>]*)>/);
    if (!headerMatch) continue;

    const name = headerMatch[1];
    const flags = headerMatch[2];

    // Skip loopback
    if (name === 'lo') continue;

    const state = flags.includes('UP') ? 'UP' : 'DOWN';

    // Parse RX stats (line after "RX: bytes")
    let rxBytes = 0, rxPackets = 0, rxErrors = 0;
    let txBytes = 0, txPackets = 0, txErrors = 0;

    const lines = block.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.startsWith('RX:') && line.includes('bytes')) {
        // Next line has the values
        const valuesLine = lines[i + 1]?.trim();
        if (valuesLine) {
          const parts = valuesLine.split(/\s+/).map(Number);
          rxBytes = parts[0] || 0;
          rxPackets = parts[1] || 0;
          rxErrors = parts[2] || 0;
        }
      }

      if (line.startsWith('TX:') && line.includes('bytes')) {
        const valuesLine = lines[i + 1]?.trim();
        if (valuesLine) {
          const parts = valuesLine.split(/\s+/).map(Number);
          txBytes = parts[0] || 0;
          txPackets = parts[1] || 0;
          txErrors = parts[2] || 0;
        }
      }
    }

    interfaces.push({
      name,
      rxBytes,
      txBytes,
      rxPackets,
      txPackets,
      rxErrors,
      txErrors,
      state,
    });
  }

  return { interfaces };
}

// ============================================================================
// Threshold Checking
// ============================================================================

/**
 * Check all system metrics against configured thresholds.
 * Returns array of any metrics that are at warning or critical levels.
 */
export function checkThresholds(
  status: HomelabSystemStatus,
  thresholds: ThresholdConfig = DEFAULT_THRESHOLDS
): ThresholdResult[] {
  const results: ThresholdResult[] = [];

  // CPU check
  const cpuLevel = getLevel(status.cpu.usagePercent, thresholds.cpu);
  results.push({
    metric: 'cpu',
    level: cpuLevel,
    value: status.cpu.usagePercent,
    warningAt: thresholds.cpu.warning,
    criticalAt: thresholds.cpu.critical,
    message: cpuLevel === 'ok'
      ? `CPU at ${status.cpu.usagePercent}%`
      : `CPU ${cpuLevel.toUpperCase()}: ${status.cpu.usagePercent}% (threshold: ${cpuLevel === 'critical' ? thresholds.cpu.critical : thresholds.cpu.warning}%)`,
  });

  // RAM check
  const ramLevel = getLevel(status.ram.usagePercent, thresholds.ram);
  results.push({
    metric: 'ram',
    level: ramLevel,
    value: status.ram.usagePercent,
    warningAt: thresholds.ram.warning,
    criticalAt: thresholds.ram.critical,
    message: ramLevel === 'ok'
      ? `RAM at ${status.ram.usagePercent}% (${status.ram.usedMB}MB/${status.ram.totalMB}MB)`
      : `RAM ${ramLevel.toUpperCase()}: ${status.ram.usagePercent}% (${status.ram.usedMB}MB/${status.ram.totalMB}MB)`,
  });

  // Disk check (root partition)
  const diskLevel = getLevel(status.disk.rootUsagePercent, thresholds.disk);
  results.push({
    metric: 'disk',
    level: diskLevel,
    value: status.disk.rootUsagePercent,
    warningAt: thresholds.disk.warning,
    criticalAt: thresholds.disk.critical,
    message: diskLevel === 'ok'
      ? `Disk at ${status.disk.rootUsagePercent}%`
      : `Disk ${diskLevel.toUpperCase()}: ${status.disk.rootUsagePercent}% (threshold: ${diskLevel === 'critical' ? thresholds.disk.critical : thresholds.disk.warning}%)`,
  });

  // Temperature check
  const tempLevel = getLevel(status.temperature.celcius, thresholds.temp);
  results.push({
    metric: 'temperature',
    level: tempLevel,
    value: status.temperature.celcius,
    warningAt: thresholds.temp.warning,
    criticalAt: thresholds.temp.critical,
    message: tempLevel === 'ok'
      ? `Temp at ${status.temperature.celcius}°C`
      : `Temp ${tempLevel.toUpperCase()}: ${status.temperature.celcius}°C (N150 throttles at ~90°C)`,
  });

  return results;
}

function getLevel(value: number, bounds: { warning: number; critical: number }): ThresholdLevel {
  if (value >= bounds.critical) return 'critical';
  if (value >= bounds.warning) return 'warning';
  return 'ok';
}

// ============================================================================
// Aggregated System Status
// ============================================================================

/**
 * Get complete system status - CPU, RAM, disk, temperature, and network.
 * This is the primary entry point for system monitoring.
 */
export async function getSystemStatus(): Promise<HomelabSystemStatus> {
  // Run all checks in parallel for speed
  const [cpu, ram, disk, temperature, network] = await Promise.all([
    getCPU(),
    getRAM(),
    getDisk(),
    getTemperature(),
    getNetwork(),
  ]);

  return {
    cpu,
    ram,
    disk,
    temperature,
    network,
    timestamp: new Date().toISOString(),
  };
}

// ============================================================================
// Convenience: Format status as human-readable string (for Signal messages)
// ============================================================================

export function formatStatusReport(status: HomelabSystemStatus): string {
  const thresholds = checkThresholds(status);
  const alerts = thresholds.filter(t => t.level !== 'ok');

  const lines = [
    'Daemon Status:',
    `  CPU: ${status.cpu.usagePercent}% | Load: ${status.cpu.loadAverage.join(', ')}`,
    `  RAM: ${status.ram.usedMB}MB/${status.ram.totalMB}MB (${status.ram.usagePercent}%)`,
    `  Disk: ${status.disk.rootUsagePercent}%`,
    `  Temp: ${status.temperature.celcius}°C`,
    `  Network: ${status.network.interfaces.filter(i => i.state === 'UP').length} interfaces up`,
  ];

  if (alerts.length > 0) {
    lines.push('');
    lines.push('Alerts:');
    for (const alert of alerts) {
      lines.push(`  [${alert.level.toUpperCase()}] ${alert.message}`);
    }
  } else {
    lines.push('  Alerts: None');
  }

  return lines.join('\n');
}
