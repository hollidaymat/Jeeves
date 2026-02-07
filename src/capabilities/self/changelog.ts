/**
 * Git Changelog Generator
 * 
 * Weekly: scans all projects in REPO_MAP for new commits,
 * groups by type, generates human-readable changelog entry.
 * One Haiku call per project (200 tokens, budget-enforced).
 * Registered as scheduler handler 'changelog_scan'.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../../utils/logger.js';
import { enforceBudget, recordFeatureUsage, getFeatureMaxTokens } from '../../core/cost-tracker.js';
import { config } from '../../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CHANGELOG_DIR = resolve(__dirname, '..', '..', '..', 'data', 'changelogs');
const STATE_FILE = resolve(CHANGELOG_DIR, '_state.json');

// Ensure directory exists
if (!existsSync(CHANGELOG_DIR)) {
  mkdirSync(CHANGELOG_DIR, { recursive: true });
}

interface ChangelogState {
  lastScanned: Record<string, string>;  // repo -> ISO timestamp
  lastUpdated: string;
}

function loadState(): ChangelogState {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    }
  } catch { /* corrupt */ }
  return { lastScanned: {}, lastUpdated: '' };
}

function saveState(state: ChangelogState): void {
  state.lastUpdated = new Date().toISOString();
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// Commit type classification
function classifyCommit(message: string): string {
  const lower = message.toLowerCase();
  if (/^(feat|feature|add|new)\b/i.test(lower)) return 'Features';
  if (/^(fix|bug|patch|hotfix)\b/i.test(lower)) return 'Fixes';
  if (/^(refactor|clean|reorganize)\b/i.test(lower)) return 'Refactoring';
  if (/^(docs?|readme|comment)\b/i.test(lower)) return 'Documentation';
  if (/^(test|spec|coverage)\b/i.test(lower)) return 'Tests';
  if (/^(chore|deps?|bump|update|upgrade)\b/i.test(lower)) return 'Maintenance';
  if (/^(style|css|ui|ux|design)\b/i.test(lower)) return 'UI/Style';
  if (/^\[jeeves/i.test(lower)) return 'Automated';
  return 'Other';
}

/**
 * Generate changelog for a single project.
 */
async function generateProjectChangelog(
  repoName: string,
  repoUrl: string,
  since: string | undefined,
): Promise<{ generated: boolean; commitCount: number; entry?: string }> {
  try {
    const { getGitHubClient } = await import('../../integrations/github-client.js');
    const github = getGitHubClient();
    if (!github) return { generated: false, commitCount: 0 };

    // Extract owner/repo from URL
    const repoPath = repoUrl.replace('https://github.com/', '');
    const commits = await github.getRecentCommits(repoPath, since, 50);

    if (commits.length < 5) {
      return { generated: false, commitCount: commits.length };
    }

    // Group commits by type
    const groups: Record<string, string[]> = {};
    for (const c of commits) {
      const type = classifyCommit(c.message);
      if (!groups[type]) groups[type] = [];
      groups[type].push(`- ${c.message} (${c.sha})`);
    }

    // Build markdown entry
    const date = new Date().toISOString().split('T')[0];
    let entry = `## ${date} (${commits.length} commits)\n\n`;
    for (const [type, items] of Object.entries(groups)) {
      entry += `### ${type}\n${items.join('\n')}\n\n`;
    }

    // Optional: use Haiku for a human-readable summary
    const budgetCheck = enforceBudget('changelog');
    if (budgetCheck.allowed) {
      try {
        const { generateText } = await import('ai');
        const { createAnthropic } = await import('@ai-sdk/anthropic');
        const provider = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY || '' });

        const { text } = await generateText({
          model: provider(config.claude.haiku_model),
          messages: [{
            role: 'user',
            content: `Summarize these code changes in 2-3 sentences. Be specific about what was added/fixed/changed:\n\n${entry.substring(0, 2000)}`,
          }],
          maxTokens: getFeatureMaxTokens('changelog'),
        });

        recordFeatureUsage('changelog', 0.001);
        entry = `**Summary:** ${text}\n\n${entry}`;
      } catch {
        // LLM not available, skip summary
      }
    }

    // Append to project changelog file
    const changelogPath = resolve(CHANGELOG_DIR, `${repoName}.md`);
    const existing = existsSync(changelogPath) ? readFileSync(changelogPath, 'utf-8') : `# ${repoName} Changelog\n\n`;
    writeFileSync(changelogPath, existing + entry);

    return { generated: true, commitCount: commits.length, entry };
  } catch (err) {
    logger.debug('Changelog generation failed for repo', { repo: repoName, error: String(err) });
    return { generated: false, commitCount: 0 };
  }
}

/**
 * Run changelog scan for all projects.
 * This is the scheduled handler function.
 */
export async function runChangelogScan(): Promise<void> {
  const state = loadState();

  // Get REPO_MAP
  let repoMap: Record<string, string> = {};
  try {
    const { getAvailableRepos } = await import('../../integrations/cursor-orchestrator.js');
    const repos = getAvailableRepos();
    for (const r of repos) {
      repoMap[r.name] = r.url;
    }
  } catch {
    logger.debug('Could not load REPO_MAP for changelog scan');
    return;
  }

  let generated = 0;
  for (const [name, url] of Object.entries(repoMap)) {
    const since = state.lastScanned[name];
    const result = await generateProjectChangelog(name, url, since);
    if (result.generated) {
      generated++;
      logger.info('Changelog generated', { repo: name, commits: result.commitCount });
    }
    state.lastScanned[name] = new Date().toISOString();
  }

  saveState(state);

  if (generated > 0) {
    logger.info('Changelog scan complete', { projectsUpdated: generated });
  }
}

/**
 * Get changelog for a specific project.
 */
export function getChangelog(repoName: string): string {
  const path = resolve(CHANGELOG_DIR, `${repoName}.md`);
  if (existsSync(path)) {
    return readFileSync(path, 'utf-8');
  }
  return `No changelog for ${repoName} yet.`;
}

/**
 * Register with the scheduler.
 */
export function registerChangelogHandler(): void {
  import('../scheduler/engine.js').then(({ registerHandler }) => {
    registerHandler('changelog_scan', runChangelogScan);
  }).catch(() => {});
}
