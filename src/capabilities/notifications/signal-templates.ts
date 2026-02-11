/**
 * Signal Message Templates
 *
 * Centralized templates for proactive Jeeves notifications.
 * All proactive sends should use these for consistent formatting.
 */

import { formatForSignal } from '../../utils/signal-format.js';

export type TemplateKind =
  | 'disk_health'
  | 'ssl_alert'
  | 'download_complete'
  | 'download_stall'
  | 'security_critical'
  | 'uptime_down'
  | 'briefing'
  | 'reminder'
  | 'scheduled'
  | 'quiet_hours_flush';

/** Build a proactive notification with consistent formatting */
export function buildSignalMessage(
  kind: TemplateKind,
  params: Record<string, string | number | boolean>
): string {
  let raw: string;
  switch (kind) {
    case 'disk_health':
      raw = `⚠️ Disk health: ${params.summary}`;
      break;
    case 'ssl_alert':
      raw = `🔒 SSL: ${params.domains}`;
      break;
    case 'download_complete':
      raw = `${params.icon || '🎬'} Download complete: ${params.title}${params.size ? ` (${params.size})` : ''}${params.duration ? ` in ${params.duration}` : ''}`;
      break;
    case 'download_stall':
      raw = `⚠️ ${params.action}`;
      break;
    case 'security_critical':
      raw = `🚨 ${params.project}: ${params.message}`;
      break;
    case 'uptime_down':
      raw = `ALERT: ${params.message}`;
      break;
    case 'briefing':
      raw = String(params.text);
      break;
    case 'reminder':
      raw = String(params.message);
      break;
    case 'scheduled':
      raw = `📋 Scheduled: ${params.action}`;
      break;
    case 'quiet_hours_flush':
      raw = `📬 While you were away (${params.count} notifications):\n\n${params.summary}`;
      break;
    default:
      raw = String(params.message ?? params.text ?? '');
  }
  return formatForSignal(raw);
}
