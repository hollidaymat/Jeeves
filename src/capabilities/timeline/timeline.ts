/**
 * System Event Timeline
 * Unified "what happened today" feed aggregating events from all sources.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const TIMELINE_PATH = '/home/jeeves/signal-cursor-controller/data/timeline.json';
const MAX_EVENTS = 500;

export interface TimelineEvent {
  id: string;
  timestamp: string;
  source: string;
  category: 'container' | 'download' | 'security' | 'backup' | 'scheduler' | 'user' | 'system' | 'notification';
  message: string;
  severity: 'info' | 'warning' | 'error';
}

function loadEvents(): TimelineEvent[] {
  try {
    if (existsSync(TIMELINE_PATH)) {
      return JSON.parse(readFileSync(TIMELINE_PATH, 'utf-8'));
    }
  } catch { /* ignore */ }
  return [];
}

function saveEvents(events: TimelineEvent[]): void {
  try {
    const dir = dirname(TIMELINE_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    // Keep only last MAX_EVENTS
    writeFileSync(TIMELINE_PATH, JSON.stringify(events.slice(-MAX_EVENTS), null, 2));
  } catch { /* ignore */ }
}

/**
 * Add an event to the timeline.
 */
export function addTimelineEvent(
  source: string,
  category: TimelineEvent['category'],
  message: string,
  severity: TimelineEvent['severity'] = 'info'
): void {
  const events = loadEvents();
  events.push({
    id: `evt-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
    timestamp: new Date().toISOString(),
    source,
    category,
    message,
    severity,
  });
  saveEvents(events);
}

/**
 * Get events from the last N hours.
 */
export function getRecentEvents(hours: number = 24): TimelineEvent[] {
  const events = loadEvents();
  const cutoff = new Date(Date.now() - hours * 3600000).toISOString();
  return events.filter(e => e.timestamp >= cutoff).sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp)
  );
}

/**
 * Get events by category.
 */
export function getEventsByCategory(category: TimelineEvent['category'], hours: number = 24): TimelineEvent[] {
  return getRecentEvents(hours).filter(e => e.category === category);
}

/**
 * Format a timeline summary.
 */
export function formatTimeline(hours: number = 24): string {
  const events = getRecentEvents(hours);

  if (events.length === 0) {
    return `Nothing recorded in the last ${hours} hours.`;
  }

  const lines: string[] = [`## Timeline (last ${hours}h)`, ''];

  // Group by category
  const categories = new Map<string, TimelineEvent[]>();
  for (const evt of events) {
    const list = categories.get(evt.category) || [];
    list.push(evt);
    categories.set(evt.category, list);
  }

  // Summary counts
  const counts: string[] = [];
  for (const [cat, evts] of categories) {
    counts.push(`${cat}: ${evts.length}`);
  }
  lines.push(counts.join(' | '), '');

  // Show most recent events (last 15)
  const recent = events.slice(-15);
  for (const evt of recent) {
    const time = new Date(evt.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const icon = evt.severity === 'error' ? '🔴'
      : evt.severity === 'warning' ? '🟡'
      : '⚪';
    lines.push(`${icon} ${time} [${evt.source}] ${evt.message}`);
  }

  if (events.length > 15) {
    lines.push(``, `... ${events.length - 15} older events`);
  }

  return lines.join('\n');
}
