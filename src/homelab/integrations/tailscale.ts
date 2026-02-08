/**
 * VPN / Tailscale Status
 * Reads Tailscale status from local API.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { logger } from '../../utils/logger.js';

const execAsync = promisify(exec);

export interface TailscaleDevice {
  name: string;
  ip: string;
  online: boolean;
  os: string;
  lastSeen: string;
  isSelf: boolean;
}

export interface TailscaleStatus {
  connected: boolean;
  selfIP: string;
  devices: TailscaleDevice[];
  networkName: string;
}

/**
 * Get Tailscale status using the CLI.
 */
export async function getTailscaleStatus(): Promise<TailscaleStatus | null> {
  try {
    const { stdout } = await execAsync('tailscale status --json 2>/dev/null', { timeout: 10000 });
    const data = JSON.parse(stdout);

    const selfNode = data.Self;
    const devices: TailscaleDevice[] = [];

    // Add self
    if (selfNode) {
      devices.push({
        name: selfNode.HostName || 'this machine',
        ip: selfNode.TailscaleIPs?.[0] || '',
        online: selfNode.Online !== false,
        os: selfNode.OS || '',
        lastSeen: selfNode.LastSeen || '',
        isSelf: true,
      });
    }

    // Add peers
    const peers = data.Peer || {};
    for (const peer of Object.values(peers) as Array<Record<string, unknown>>) {
      devices.push({
        name: String(peer.HostName || peer.DNSName || 'Unknown'),
        ip: (peer.TailscaleIPs as string[])?.[0] || '',
        online: peer.Online === true,
        os: String(peer.OS || ''),
        lastSeen: String(peer.LastSeen || ''),
        isSelf: false,
      });
    }

    return {
      connected: selfNode?.Online !== false,
      selfIP: selfNode?.TailscaleIPs?.[0] || '',
      devices,
      networkName: data.MagicDNSSuffix || '',
    };
  } catch (error) {
    logger.debug('[tailscale] Status check failed', { error: String(error) });
    return null;
  }
}

export function formatTailscaleStatus(status: TailscaleStatus | null): string {
  if (!status) {
    return 'Tailscale status unavailable. Is Tailscale installed and running?';
  }

  const lines = [
    '## Tailscale VPN',
    '',
    `Status: ${status.connected ? '🟢 Connected' : '🔴 Disconnected'}`,
    `My IP: ${status.selfIP}`,
    `Network: ${status.networkName}`,
    '',
    '**Devices:**',
  ];

  for (const device of status.devices) {
    const icon = device.online ? '🟢' : '⚫';
    const self = device.isSelf ? ' (this machine)' : '';
    lines.push(`  ${icon} ${device.name}${self} — ${device.ip} (${device.os})`);
  }

  const online = status.devices.filter(d => d.online).length;
  lines.push('', `${online}/${status.devices.length} devices online`);

  return lines.join('\n');
}
