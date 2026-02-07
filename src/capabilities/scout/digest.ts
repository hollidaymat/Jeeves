/**
 * Knowledge Scout - Daily Digest Formatter
 * Accumulates findings and formats grouped text briefings.
 * No LLM needed — pure string templates.
 */

import type { ScoutFinding } from './sources.js';

// In-memory digest queue (also persisted via loop.ts to data/scout.json)
let digestQueue: ScoutFinding[] = [];

/**
 * Add a finding to the digest queue
 */
export function addToDigest(finding: ScoutFinding): void {
  // Avoid duplicates by id
  if (!digestQueue.some(f => f.id === finding.id)) {
    digestQueue.push(finding);
  }
}

/**
 * Get the current digest queue
 */
export function getDigestQueue(): ScoutFinding[] {
  return [...digestQueue];
}

/**
 * Replace the digest queue (used when loading from persisted state)
 */
export function setDigestQueue(queue: ScoutFinding[]): void {
  digestQueue = [...queue];
}

/**
 * Clear the digest queue after delivery
 */
export function clearDigest(): void {
  digestQueue = [];
}

// ============================================================================
// Severity indicators
// ============================================================================

const SEVERITY_ICON: Record<ScoutFinding['severity'], string> = {
  high: '[!!!]',
  medium: '[!!]',
  low: '[!]',
  info: '[i]',
};

// ============================================================================
// Formatting
// ============================================================================

/**
 * Format all queued findings into a grouped daily briefing
 */
export function getDigest(): string {
  if (digestQueue.length === 0) {
    return '## Scout Digest\n\nNo new findings to report. All clear.';
  }

  const groups: Record<string, ScoutFinding[]> = {
    SECURITY: [],
    UPDATES: [],
    TECH: [],
    BUSINESS: [],
  };

  for (const finding of digestQueue) {
    switch (finding.type) {
      case 'security':
        groups.SECURITY.push(finding);
        break;
      case 'release':
        groups.UPDATES.push(finding);
        break;
      case 'tech':
        groups.TECH.push(finding);
        break;
      case 'business':
        groups.BUSINESS.push(finding);
        break;
    }
  }

  // Sort each group by severity (high first) then by relevance score (desc)
  const severityOrder: Record<string, number> = { high: 0, medium: 1, low: 2, info: 3 };
  for (const group of Object.values(groups)) {
    group.sort((a, b) => {
      const sevDiff = (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3);
      if (sevDiff !== 0) return sevDiff;
      return b.relevanceScore - a.relevanceScore;
    });
  }

  const timestamp = new Date().toISOString().split('T')[0];
  let output = `## Scout Digest — ${timestamp}\n`;
  output += `${digestQueue.length} finding(s)\n`;

  for (const [section, findings] of Object.entries(groups)) {
    if (findings.length === 0) continue;

    output += `\n### ${section}\n`;

    for (const f of findings) {
      const icon = SEVERITY_ICON[f.severity];
      const action = f.actionable && f.recommendedAction
        ? `\n   Action: ${f.recommendedAction}`
        : '';
      const url = f.url ? `\n   Link: ${f.url}` : '';
      const score = `(relevance: ${f.relevanceScore})`;

      output += `\n ${icon} ${f.title} ${score}`;
      output += `\n   ${f.summary}`;
      output += url;
      output += action;
      output += '\n';
    }
  }

  return output;
}
