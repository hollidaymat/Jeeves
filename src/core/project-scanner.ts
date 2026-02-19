/**
 * Project Scanner
 * Auto-discovers projects by scanning directories for markers
 */

import { readdirSync, readFileSync, statSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, basename } from 'path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { Project, ProjectIndex } from '../types/index.js';

// In-memory project index
let projectIndex: ProjectIndex = {
  projects: new Map(),
  scanned_at: new Date()
};

/**
 * Detect project type from markers
 */
function detectProjectType(projectPath: string): Project['type'] {
  if (existsSync(join(projectPath, 'package.json'))) return 'node';
  if (existsSync(join(projectPath, 'Cargo.toml'))) return 'rust';
  if (existsSync(join(projectPath, 'go.mod'))) return 'go';
  if (existsSync(join(projectPath, 'pyproject.toml')) || existsSync(join(projectPath, 'setup.py'))) return 'python';
  return 'unknown';
}

/**
 * Check if directory contains any project markers
 */
function hasProjectMarker(dirPath: string): boolean {
  return config.projects.markers.some(marker => 
    existsSync(join(dirPath, marker))
  );
}

/**
 * Should this directory be excluded from scanning?
 */
function shouldExclude(name: string): boolean {
  return config.projects.exclude.includes(name);
}

/**
 * Recursively scan directory for projects
 */
function scanDirectory(dirPath: string, depth: number = 0): Project[] {
  const projects: Project[] = [];
  
  if (depth > config.projects.scan_depth) return projects;
  
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (shouldExclude(entry.name)) continue;
      
      const fullPath = join(dirPath, entry.name);
      
      if (hasProjectMarker(fullPath)) {
        if (fullPath.includes('/.cache/') || fullPath.includes('\\.cache\\')) continue;
        const stats = statSync(fullPath);
        const project: Project = {
          name: entry.name.toLowerCase().replace(/[^a-z0-9]/g, '-'),
          path: fullPath,
          type: detectProjectType(fullPath),
          last_modified: stats.mtime
        };
        projects.push(project);
        logger.debug(`Found project: ${project.name}`, { path: project.path, type: project.type });
      } else {
        // Continue scanning subdirectories
        projects.push(...scanDirectory(fullPath, depth + 1));
      }
    }
  } catch (error) {
    logger.error(`Error scanning directory: ${dirPath}`, { error: String(error) });
  }
  
  return projects;
}

/**
 * Scan all configured directories for projects
 */
export function scanProjects(): ProjectIndex {
  logger.info('Scanning for projects...');
  
  const projects = new Map<string, Project>();
  
  for (const dir of config.projects.directories) {
    if (!existsSync(dir)) {
      logger.warn(`Project directory not found: ${dir}`);
      continue;
    }
    
    const found = scanDirectory(dir);
    for (const project of found) {
      // Handle name collisions by appending parent folder
      let name = project.name;
      let suffix = 1;
      while (projects.has(name)) {
        name = `${project.name}-${suffix}`;
        suffix++;
      }
      project.name = name;
      projects.set(name, project);
    }
  }
  
  projectIndex = {
    projects,
    scanned_at: new Date()
  };
  
  logger.info(`Found ${projects.size} projects`);
  
  return projectIndex;
}

/**
 * Get current project index
 */
export function getProjectIndex(): ProjectIndex {
  return projectIndex;
}

/**
 * Normalize a string for fuzzy matching
 * "Dive Connect AI" -> "diveconnectai"
 * "dive_connect-ai" -> "diveconnectai"
 */
function normalizeForMatch(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Calculate similarity score between two strings (0-1)
 */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  
  // Check if one contains the other
  if (a.includes(b)) return 0.9;
  if (b.includes(a)) return 0.8;
  
  // Check word overlap
  const wordsA = a.match(/[a-z]+/g) || [];
  const wordsB = b.match(/[a-z]+/g) || [];
  const overlap = wordsA.filter(w => wordsB.some(wb => wb.includes(w) || w.includes(wb)));
  if (overlap.length > 0) {
    return 0.5 + (0.4 * overlap.length / Math.max(wordsA.length, wordsB.length));
  }
  
  return 0;
}

// Project aliases - common nicknames for projects
const PROJECT_ALIASES: Record<string, string> = {
  'jeeves': 'signal-cursor-controller',
  'controller': 'signal-cursor-controller',
  'cursor controller': 'signal-cursor-controller',
  'dive': 'Dive_Connect',
  'diveconnect': 'Dive_Connect',
  'dive connect': 'Dive_Connect',
  'mobile': 'diveconnect-mobile',
  'legends': 'Legends-Agile',
  'agile': 'Legends-Agile',
};

/**
 * Find a project by name (fuzzy matching)
 * Handles natural language like "dive connect ai", "diveconnect", "Dive_Connect"
 */
export function findProject(query: string): Project | undefined {
  // Check aliases first
  const lowerQuery = query.toLowerCase().trim();
  if (PROJECT_ALIASES[lowerQuery]) {
    const aliasTarget = PROJECT_ALIASES[lowerQuery];
    for (const [name, project] of projectIndex.projects) {
      if (name.toLowerCase() === aliasTarget.toLowerCase()) {
        return project;
      }
    }
  }
  
  const normalizedQuery = normalizeForMatch(query);
  
  // Score all projects
  const scored: Array<{ project: Project; score: number }> = [];
  
  for (const [name, project] of projectIndex.projects) {
    const normalizedName = normalizeForMatch(name);
    
    // Exact match (highest priority)
    if (normalizedName === normalizedQuery) {
      return project;
    }
    
    const score = similarity(normalizedQuery, normalizedName);
    if (score > 0.4) {
      scored.push({ project, score });
    }
  }
  
  // Sort by score and return best match
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.project;
}

/**
 * List all projects as formatted string
 */
export function listProjects(): string {
  if (projectIndex.projects.size === 0) {
    return 'No projects found. Check your config.json projects.directories setting.';
  }
  
  const lines = ['Available projects:'];
  for (const [name, project] of projectIndex.projects) {
    lines.push(`  - ${name} (${project.type})`);
  }
  return lines.join('\n');
}

/**
 * Create a new project
 * Creates folder in first project directory, initializes with package.json
 */
export function createProject(name: string): { success: boolean; path?: string; error?: string } {
  // Sanitize name
  const safeName = name.replace(/[^a-zA-Z0-9-_]/g, '-').toLowerCase();
  
  // Get workspace directory (first projects directory)
  const workspaceDir = config.projects.directories[0];
  if (!workspaceDir || !existsSync(workspaceDir)) {
    return { success: false, error: 'No workspace directory configured' };
  }
  
  const projectPath = join(workspaceDir, safeName);
  
  // Check if already exists
  if (existsSync(projectPath)) {
    return { success: false, error: `Project "${safeName}" already exists at ${projectPath}` };
  }
  
  try {
    // Create directory
    mkdirSync(projectPath, { recursive: true });
    
    // Create basic package.json
    const packageJson = {
      name: safeName,
      version: '0.1.0',
      description: `${safeName} - created by Jeeves`,
      main: 'index.js',
      scripts: {
        dev: 'echo "No dev script configured"',
        build: 'echo "No build script configured"',
        test: 'echo "No tests configured"'
      },
      keywords: [],
      author: '',
      license: 'MIT'
    };
    
    writeFileSync(
      join(projectPath, 'package.json'),
      JSON.stringify(packageJson, null, 2)
    );
    
    // Create README
    writeFileSync(
      join(projectPath, 'README.md'),
      `# ${safeName}\n\nProject created by Jeeves.\n\n## Getting Started\n\nTODO: Add setup instructions\n`
    );
    
    // Create .gitignore
    writeFileSync(
      join(projectPath, '.gitignore'),
      `node_modules/\ndist/\n.env\n.env.local\n*.log\n`
    );
    
    // Register the new project
    const project: Project = {
      name: safeName,
      path: projectPath,
      type: 'node',
      last_modified: new Date()
    };
    
    projectIndex.projects.set(safeName, project);
    
    // Also add to aliases
    PROJECT_ALIASES[safeName] = safeName;
    
    logger.info('Created new project', { name: safeName, path: projectPath });
    
    return { success: true, path: projectPath };
  } catch (err) {
    logger.error('Failed to create project', { name: safeName, error: String(err) });
    return { success: false, error: `Failed to create project: ${String(err)}` };
  }
}

/**
 * Get workspace directory for new projects
 */
export function getWorkspaceDir(): string | undefined {
  return config.projects.directories[0];
}

/**
 * Scan existing projects for tech conventions and patterns.
 * Used by the PRD builder to suggest tech stacks based on user's existing work.
 */
export function scanForConventions(): string | null {
  const projects = getProjectIndex();
  if (projects.projects.size === 0) return null;

  const conventions: string[] = [];
  const frameworks = new Set<string>();
  const uiLibs = new Set<string>();
  const cssTools = new Set<string>();
  const databases = new Set<string>();
  const languages = new Set<string>();

  for (const [name, project] of projects.projects) {
    try {
      const pkgPath = join(project.path, 'package.json');
      if (!existsSync(pkgPath)) continue;

      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      const allDeps = {
        ...pkg.dependencies,
        ...pkg.devDependencies,
      };

      // Detect frameworks
      if (allDeps['next']) frameworks.add('Next.js');
      if (allDeps['react']) frameworks.add('React');
      if (allDeps['vue']) frameworks.add('Vue');
      if (allDeps['svelte'] || allDeps['@sveltejs/kit']) frameworks.add('Svelte');
      if (allDeps['express']) frameworks.add('Express');
      if (allDeps['fastify']) frameworks.add('Fastify');
      if (allDeps['expo'] || allDeps['react-native']) frameworks.add('React Native/Expo');

      // Detect UI libraries
      if (allDeps['@radix-ui/react-slot'] || allDeps['@radix-ui/react-dialog']) uiLibs.add('Radix UI');
      if (allDeps['@shadcn/ui'] || allDeps['class-variance-authority']) uiLibs.add('shadcn/ui');
      if (allDeps['@mui/material']) uiLibs.add('Material UI');
      if (allDeps['@chakra-ui/react']) uiLibs.add('Chakra UI');

      // Detect CSS tools
      if (allDeps['tailwindcss']) cssTools.add('Tailwind CSS');
      if (allDeps['sass'] || allDeps['node-sass']) cssTools.add('Sass');
      if (allDeps['styled-components']) cssTools.add('Styled Components');

      // Detect databases
      if (allDeps['@supabase/supabase-js']) databases.add('Supabase');
      if (allDeps['prisma'] || allDeps['@prisma/client']) databases.add('Prisma');
      if (allDeps['mongoose']) databases.add('MongoDB');
      if (allDeps['pg']) databases.add('PostgreSQL');

      // Detect languages
      if (allDeps['typescript']) languages.add('TypeScript');

    } catch {
      // Skip projects with unreadable package.json
    }
  }

  if (frameworks.size === 0 && languages.size === 0) return null;

  conventions.push(`Found ${projects.projects.size} projects in workspace.`);
  if (frameworks.size > 0) conventions.push(`Frameworks: ${[...frameworks].join(', ')}`);
  if (uiLibs.size > 0) conventions.push(`UI libraries: ${[...uiLibs].join(', ')}`);
  if (cssTools.size > 0) conventions.push(`CSS: ${[...cssTools].join(', ')}`);
  if (databases.size > 0) conventions.push(`Databases: ${[...databases].join(', ')}`);
  if (languages.size > 0) conventions.push(`Languages: ${[...languages].join(', ')}`);

  return conventions.join('\n');
}

