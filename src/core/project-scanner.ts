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
 * Find a project by name (fuzzy matching)
 */
export function findProject(query: string): Project | undefined {
  const normalizedQuery = query.toLowerCase().replace(/[^a-z0-9]/g, '');
  
  // Exact match first
  for (const [name, project] of projectIndex.projects) {
    if (name.replace(/-/g, '') === normalizedQuery) {
      return project;
    }
  }
  
  // Partial match
  for (const [name, project] of projectIndex.projects) {
    if (name.replace(/-/g, '').includes(normalizedQuery) || 
        normalizedQuery.includes(name.replace(/-/g, ''))) {
      return project;
    }
  }
  
  // Word-based match (e.g., "dive" matches "diveconnect")
  for (const [name, project] of projectIndex.projects) {
    if (name.includes(normalizedQuery)) {
      return project;
    }
  }
  
  return undefined;
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
