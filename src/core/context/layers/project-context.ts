/**
 * Project Context Layer
 * Live project structure for code-review / agent_ask intents.
 * Builds context from filesystem: project structure, package.json deps, recent git log.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

export interface ProjectContext {
  files: string;
  dependencies: string;
  recentChanges: string;
}

/**
 * Get project context for code-review / agent_ask when projectPath is set.
 * Returns null if path doesn't exist or isn't a project.
 */
export async function getProjectContext(projectPath: string): Promise<ProjectContext | null> {
  if (!projectPath || !existsSync(projectPath)) return null;

  const ctx: ProjectContext = { files: '', dependencies: '', recentChanges: '' };

  try {
    // Project structure (first 30 .ts/.js files)
    try {
      const tree = execSync(
        `find "${projectPath}" -type f \\( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" \\) 2>/dev/null | head -30`,
        { encoding: 'utf8', timeout: 5000 }
      );
      const relative = tree
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((p) => p.replace(projectPath, '').replace(/\\/g, '/'))
        .join('\n');
      if (relative) ctx.files = `PROJECT FILES:\n${relative}`;
    } catch {
      /* skip */
    }

    // package.json deps
    const pkgPath = join(projectPath, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        const deps = Object.keys(pkg.dependencies || {}).join(', ');
        if (deps) ctx.dependencies = `DEPENDENCIES: ${deps}`;
      } catch {
        /* skip */
      }
    }

    // Recent git log
    try {
      const gitLog = execSync(
        `cd "${projectPath}" && git log --oneline -5 2>/dev/null || echo "no git"`,
        { encoding: 'utf8', timeout: 3000 }
      );
      if (gitLog && !gitLog.includes('no git')) {
        ctx.recentChanges = `RECENT CHANGES:\n${gitLog.trim()}`;
      }
    } catch {
      /* skip */
    }
  } catch (err) {
    return null;
  }

  if (!ctx.files && !ctx.dependencies && !ctx.recentChanges) return null;
  return ctx;
}
