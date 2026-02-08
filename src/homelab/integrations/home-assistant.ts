/**
 * Home Assistant Integration
 * Controls lights, reads sensors, triggers automations.
 */

import { logger } from '../../utils/logger.js';

const HA_URL = process.env.HA_URL || 'http://localhost:8123';

function getToken(): string | null {
  return process.env.HA_TOKEN || process.env.HOME_ASSISTANT_TOKEN || null;
}

async function haFetch(path: string, method: string = 'GET', body?: unknown): Promise<unknown> {
  const token = getToken();
  if (!token) throw new Error('No Home Assistant token configured (set HA_TOKEN in .env)');

  const res = await fetch(`${HA_URL}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) throw new Error(`HA API ${res.status}: ${res.statusText}`);
  return res.json();
}

export interface HAEntity {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  friendly_name?: string;
}

/**
 * Get all states from HA.
 */
export async function getStates(): Promise<HAEntity[]> {
  const states = await haFetch('/api/states') as HAEntity[];
  return states.map(s => ({
    ...s,
    friendly_name: s.attributes?.friendly_name as string || s.entity_id,
  }));
}

/**
 * Get specific entity state.
 */
export async function getEntityState(entityId: string): Promise<HAEntity | null> {
  try {
    return await haFetch(`/api/states/${entityId}`) as HAEntity;
  } catch {
    return null;
  }
}

/**
 * Call a HA service (e.g., turn on/off lights).
 */
export async function callService(domain: string, service: string, entityId: string): Promise<string> {
  await haFetch(`/api/services/${domain}/${service}`, 'POST', {
    entity_id: entityId,
  });
  return `Called ${domain}.${service} on ${entityId}`;
}

/**
 * Get sensors summary (temperature, humidity, etc.)
 */
export async function getSensorSummary(): Promise<string> {
  const states = await getStates();
  const sensors = states.filter(s => s.entity_id.startsWith('sensor.'));
  const tempSensors = sensors.filter(s =>
    s.attributes?.device_class === 'temperature' ||
    s.entity_id.includes('temperature')
  );
  const humiditySensors = sensors.filter(s =>
    s.attributes?.device_class === 'humidity' ||
    s.entity_id.includes('humidity')
  );

  const lines: string[] = ['## Home Assistant Sensors', ''];

  if (tempSensors.length > 0) {
    lines.push('**Temperature:**');
    for (const s of tempSensors.slice(0, 10)) {
      const name = s.friendly_name || s.entity_id;
      const unit = s.attributes?.unit_of_measurement || '°F';
      lines.push(`  ${name}: ${s.state}${unit}`);
    }
  }

  if (humiditySensors.length > 0) {
    lines.push('', '**Humidity:**');
    for (const s of humiditySensors.slice(0, 5)) {
      const name = s.friendly_name || s.entity_id;
      lines.push(`  ${name}: ${s.state}%`);
    }
  }

  return lines.length > 2 ? lines.join('\n') : 'No sensors found in Home Assistant.';
}

/**
 * Handle natural-language HA commands.
 */
export async function handleHACommand(command: string): Promise<string> {
  const lower = command.toLowerCase();

  // Lights on/off
  const lightMatch = lower.match(/(?:turn\s+)?(on|off)\s+(?:the\s+)?(.+?)(?:\s+lights?)?$/);
  if (lightMatch) {
    const [, action, area] = lightMatch;
    const states = await getStates();
    const light = states.find(s =>
      s.entity_id.startsWith('light.') &&
      (s.friendly_name?.toLowerCase().includes(area) || s.entity_id.includes(area.replace(/\s+/g, '_')))
    );
    if (light) {
      await callService('light', action === 'on' ? 'turn_on' : 'turn_off', light.entity_id);
      return `${light.friendly_name || light.entity_id} turned ${action}.`;
    }
    return `Couldn't find a light matching "${area}".`;
  }

  // Temperature
  if (lower.includes('temperature') || lower.includes('temp')) {
    return await getSensorSummary();
  }

  // Generic state query
  return await getSensorSummary();
}
