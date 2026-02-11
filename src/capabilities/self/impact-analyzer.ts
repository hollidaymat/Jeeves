/**
 * Multi-Project Impact Analyzer
 * 
 * Detects when changes in one project might affect others.
 * Rules-based — no LLM needed.
 * 
 * Cross-references:
 * - Shared dependencies (same npm packages across projects)
 * - Shared database tables (Supabase table names)
 * - Shared component names (DiveConnect prefix)
 * - API contract changes (route files, type definitions)
 */

import { logger } from '../../utils/logger.js';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Known project groupings that share contracts
const PROJECT_GROUPS: Record<string, string[]> = {
  diveconnect: ['Dive_Connect', 'diveconnect_ai', 'diveconnect-mobile'],
};

// File patterns that indicate shared contracts
const SHARED_PATTERNS = [
  { pattern: /^(types|lib\/types|src\/types)\//i, label: 'shared type definitions' },
  { pattern: /supabase\/(migrations|schema|.*\.sql)/i, label: 'database schema' },
  { pattern: /package\.json$/i, label: 'dependency changes' },
  { pattern: /lib\/(supabase|api|shared|utils)\//i, label: 'shared library code' },
  { pattern: /\.(graphql|proto|openapi|swagger)/i, label: 'API contract' },
];

export interface ImpactReport {
  sourceProject: string;
  changedFiles: string[];
  impacts: ImpactItem[];
  timestamp: string;
}

export interface ImpactItem {
  affectedProject: string;
  reason: string;
  severity: 'high' | 'medium' | 'low';
  files: string[];
}

/**
 * Analyze a list of changed files from a PR and determine cross-project impacts.
 */
export function analyzeImpact(
  sourceProject: string,
  changedFiles: string[]
): ImpactReport {
  const impacts: ImpactItem[] = [];
  const sourceNormalized = sourceProject.toLowerCase().replace(/[-_]/g, '');

  // Find which group this project belongs to
  let siblingProjects: string[] = [];
  for (const [groupKey, members] of Object.entries(PROJECT_GROUPS)) {
    const normalizedMembers = members.map(m => m.toLowerCase().replace(/[-_]/g, ''));
    if (normalizedMembers.includes(sourceNormalized) || groupKey === sourceNormalized) {
      siblingProjects = members.filter(m => m.toLowerCase().replace(/[-_]/g, '') !== sourceNormalized);
      break;
    }
  }

  if (siblingProjects.length === 0) {
    // No known siblings — skip analysis
    return { sourceProject, changedFiles, impacts, timestamp: new Date().toISOString() };
  }

  // Check each changed file against shared patterns
  for (const file of changedFiles) {
    for (const { pattern, label } of SHARED_PATTERNS) {
      if (pattern.test(file)) {
        // This file matches a shared pattern — flag all siblings
        for (const sibling of siblingProjects) {
          // Check if we already have an impact for this sibling + reason
          const existing = impacts.find(i => i.affectedProject === sibling && i.reason === label);
          if (existing) {
            existing.files.push(file);
          } else {
            impacts.push({
              affectedProject: sibling,
              reason: label,
              severity: getSeverity(label),
              files: [file],
            });
          }
        }
      }
    }
  }

  // Check for package.json dependency changes specifically
  if (changedFiles.includes('package.json')) {
    // Try to read the package.json to find specific deps
    // This is a static analysis — we flag it as medium impact
    for (const sibling of siblingProjects) {
      const existing = impacts.find(i => i.affectedProject === sibling && i.reason === 'dependency changes');
      if (!existing) {
        impacts.push({
          affectedProject: sibling,
          reason: 'dependency changes',
          severity: 'medium',
          files: ['package.json'],
        });
      }
    }
  }

  return {
    sourceProject,
    changedFiles,
    impacts,
    timestamp: new Date().toISOString(),
  };
}

function getSeverity(label: string): 'high' | 'medium' | 'low' {
  switch (label) {
    case 'database schema': return 'high';
    case 'shared type definitions': return 'high';
    case 'API contract': return 'high';
    case 'shared library code': return 'medium';
    case 'dependency changes': return 'medium';
    default: return 'low';
  }
}

/**
 * Analyze a PR for cross-project impacts.
 * Call this from the refinement loop after PR review.
 */
export async function analyzePRImpact(
  repoFullName: string,
  prNumber: number
): Promise<ImpactReport | null> {
  try {
    const { getGitHubClient } = await import('../../integrations/github-client.js');
    const github = getGitHubClient();
    if (!github) return null;

    const files = await github.getPullRequestFiles(repoFullName, prNumber);
    const fileNames = files.map(f => f.filename);

    // Extract project name from repo (e.g., "hollidaymat/Dive_Connect" -> "Dive_Connect")
    const projectName = repoFullName.split('/').pop() || repoFullName;

    const report = analyzeImpact(projectName, fileNames);

    if (report.impacts.length > 0) {
      logger.info('Cross-project impact detected', {
        source: projectName,
        impactCount: report.impacts.length,
        affected: report.impacts.map(i => i.affectedProject),
      });

      // Send Signal alert for high-severity impacts (respects mute / notification-state)
      const highImpacts = report.impacts.filter(i => i.severity === 'high');
      if (highImpacts.length > 0) {
        try {
          const { isMuted } = await import('../notifications/quiet-hours.js');
          if (isMuted()) return report;
          const { getOwnerNumber } = await import('../../config.js');
          const { signalInterface } = await import('../../interfaces/signal.js');
          if (signalInterface.isAvailable()) {
            const alertLines = [
              `IMPACT ALERT: Changes in ${projectName} may affect:`,
              ...highImpacts.map(i => `- ${i.affectedProject}: ${i.reason} (${i.files.length} files)`),
              '',
              'Review before merging.',
            ];
            await signalInterface.send({
              recipient: getOwnerNumber(),
              content: alertLines.join('\n'),
            });
          }
        } catch { /* Signal not available */ }
      }
    }

    return report;
  } catch (err) {
    logger.debug('Impact analysis failed', { error: String(err) });
    return null;
  }
}

/**
 * Format an impact report as readable text.
 */
export function formatImpactReport(report: ImpactReport): string {
  if (report.impacts.length === 0) {
    return `No cross-project impacts detected for ${report.sourceProject}.`;
  }

  const lines = [
    `Cross-project impact analysis for ${report.sourceProject}:`,
    `Changed files: ${report.changedFiles.length}`,
    '',
  ];

  for (const impact of report.impacts) {
    const icon = impact.severity === 'high' ? 'HIGH' : impact.severity === 'medium' ? 'MED' : 'LOW';
    lines.push(`[${icon}] ${impact.affectedProject}: ${impact.reason}`);
    lines.push(`  Files: ${impact.files.slice(0, 3).join(', ')}${impact.files.length > 3 ? ` (+${impact.files.length - 3} more)` : ''}`);
  }

  return lines.join('\n');
}
