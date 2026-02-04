/**
 * Project Scanner
 * Auto-discovers projects by scanning directories for markers
 */

import { readdirSync, statSync, existsSync } from 'fs';
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
        // Found a project
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

/**
 * Find a project by name (fuzzy matching)
 * Handles natural language like "dive connect ai", "diveconnect", "Dive_Connect"
 */
export function findProject(query: string): Project | undefined {
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
