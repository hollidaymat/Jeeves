/**
 * Backup Scheduling Setup
 * 
 * Creates a systemd timer for automated daily backups.
 * Runs backup.sh as the jeeves user at 2 AM daily.
 */

import { execHomelab } from '../shell.js';
import { logger } from '../../utils/logger.js';
import { existsSync } from 'fs';
import { join } from 'path';

const SERVICE_NAME = 'jeeves-backup';
const BACKUP_SCRIPT = join(process.cwd(), 'backup.sh');

const SERVICE_UNIT = `[Unit]
Description=Jeeves Homelab Backup
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
User=jeeves
Group=jeeves
ExecStart=/bin/bash ${BACKUP_SCRIPT} full
StandardOutput=journal
StandardError=journal
TimeoutStartSec=600
Nice=19
IOSchedulingClass=idle
`;

const TIMER_UNIT = `[Unit]
Description=Daily Jeeves Homelab Backup

[Timer]
OnCalendar=*-*-* 02:00:00
RandomizedDelaySec=1800
Persistent=true

[Install]
WantedBy=timers.target
`;

/**
 * Install the systemd timer for automated backups.
 */
export async function installBackupSchedule(): Promise<{ success: boolean; message: string }> {
  if (!existsSync(BACKUP_SCRIPT)) {
    return { success: false, message: `Backup script not found at ${BACKUP_SCRIPT}` };
  }

  try {
    // Write service unit
    const svcResult = await execHomelab('sudo', [
      'bash', '-c',
      `cat > /etc/systemd/system/${SERVICE_NAME}.service << 'UNIT'\n${SERVICE_UNIT}UNIT`
    ], { timeout: 10000 });

    if (!svcResult.success) {
      return { success: false, message: `Failed to create service unit: ${svcResult.stderr}` };
    }

    // Write timer unit
    const timerResult = await execHomelab('sudo', [
      'bash', '-c',
      `cat > /etc/systemd/system/${SERVICE_NAME}.timer << 'UNIT'\n${TIMER_UNIT}UNIT`
    ], { timeout: 10000 });

    if (!timerResult.success) {
      return { success: false, message: `Failed to create timer unit: ${timerResult.stderr}` };
    }

    // Reload systemd and enable timer
    await execHomelab('sudo', ['systemctl', 'daemon-reload'], { timeout: 10000 });
    await execHomelab('sudo', ['systemctl', 'enable', `${SERVICE_NAME}.timer`], { timeout: 10000 });
    const startResult = await execHomelab('sudo', ['systemctl', 'start', `${SERVICE_NAME}.timer`], { timeout: 10000 });

    if (!startResult.success) {
      return { success: false, message: `Timer created but failed to start: ${startResult.stderr}` };
    }

    logger.info('Backup schedule installed', { timer: `${SERVICE_NAME}.timer` });
    return {
      success: true,
      message: `Backup timer installed and started.\nRuns daily at 2:00 AM (±30min jitter).\nCheck with: \`systemctl status ${SERVICE_NAME}.timer\``
    };
  } catch (error) {
    return { success: false, message: `Failed to install schedule: ${String(error)}` };
  }
}

/**
 * Check if the backup timer is active.
 */
export async function getScheduleStatus(): Promise<{ active: boolean; nextRun: string | null; lastRun: string | null }> {
  const result = await execHomelab('systemctl', [
    'show', `${SERVICE_NAME}.timer`,
    '--property=ActiveState,NextElapseUSecRealtime,LastTriggerUSec'
  ], { timeout: 5000 });

  if (!result.success) {
    return { active: false, nextRun: null, lastRun: null };
  }

  const output = result.stdout || '';
  const active = output.includes('ActiveState=active');
  const nextMatch = output.match(/NextElapseUSecRealtime=(.+)/);
  const lastMatch = output.match(/LastTriggerUSec=(.+)/);

  return {
    active,
    nextRun: nextMatch ? nextMatch[1] : null,
    lastRun: lastMatch ? lastMatch[1] : null
  };
}

/**
 * Remove the backup timer.
 */
export async function removeBackupSchedule(): Promise<{ success: boolean; message: string }> {
  try {
    await execHomelab('sudo', ['systemctl', 'stop', `${SERVICE_NAME}.timer`], { timeout: 10000 });
    await execHomelab('sudo', ['systemctl', 'disable', `${SERVICE_NAME}.timer`], { timeout: 10000 });
    await execHomelab('sudo', ['rm', '-f', `/etc/systemd/system/${SERVICE_NAME}.service`, `/etc/systemd/system/${SERVICE_NAME}.timer`], { timeout: 10000 });
    await execHomelab('sudo', ['systemctl', 'daemon-reload'], { timeout: 10000 });

    return { success: true, message: 'Backup schedule removed.' };
  } catch (error) {
    return { success: false, message: `Failed to remove schedule: ${String(error)}` };
  }
}
