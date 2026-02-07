/**
 * Project Tracker Model
 * 
 * Kanban-style project and task management.
 * Persists to data/projects.json.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_PATH = join(__dirname, '../../data/projects.json');

// ============================================================================
// Types
// ============================================================================

export type TaskStatus = 'backlog' | 'in_progress' | 'review' | 'done';
export type TaskPriority = 'P1' | 'P2' | 'P3';
export type Assignee = 'jeeves' | 'you' | 'cursor';

export interface Task {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: TaskPriority;
  points: number;
  assignee?: Assignee;
  createdAt: string;
  completedAt?: string;
  linkedCommits?: string[];
  linkedFiles?: string[];
}

export interface Project {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  tasks: Task[];
  // Computed
  progress: number;      // 0-100 based on points done/total
  velocity?: number;     // points per week
  estimatedCompletion?: string;
}

interface ProjectStore {
  projects: Project[];
}

// ============================================================================
// State
// ============================================================================

let store: ProjectStore = { projects: [] };

function loadData(): void {
  try {
    if (existsSync(DATA_PATH)) {
      store = JSON.parse(readFileSync(DATA_PATH, 'utf-8'));
    }
  } catch (e) {
    logger.debug('Failed to load project data', { error: String(e) });
  }
}

function saveData(): void {
  try {
    // Recalculate computed fields
    for (const project of store.projects) {
      computeProjectStats(project);
    }
    writeFileSync(DATA_PATH, JSON.stringify(store, null, 2));
  } catch (e) {
    logger.debug('Failed to save project data', { error: String(e) });
  }
}

function computeProjectStats(project: Project): void {
  const totalPoints = project.tasks.reduce((s, t) => s + (t.points || 0), 0);
  const donePoints = project.tasks
    .filter(t => t.status === 'done')
    .reduce((s, t) => s + (t.points || 0), 0);

  project.progress = totalPoints > 0 ? Math.round((donePoints / totalPoints) * 100) : 0;

  // Calculate velocity: points completed in last 14 days / 2
  const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
  const recentDone = project.tasks
    .filter(t => t.status === 'done' && t.completedAt && new Date(t.completedAt).getTime() > twoWeeksAgo)
    .reduce((s, t) => s + (t.points || 0), 0);
  project.velocity = Math.round(recentDone / 2);

  // Estimate completion based on velocity
  if (project.velocity && project.velocity > 0) {
    const remainingPoints = totalPoints - donePoints;
    const weeksLeft = remainingPoints / project.velocity;
    const estDate = new Date(Date.now() + weeksLeft * 7 * 24 * 60 * 60 * 1000);
    project.estimatedCompletion = estDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
}

function generateId(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;
}

// Load on module init
loadData();

// ============================================================================
// Public API
// ============================================================================

export function getProjects(): Project[] {
  // Ensure computed fields are fresh
  for (const project of store.projects) {
    computeProjectStats(project);
  }
  return store.projects;
}

export function getProject(id: string): Project | undefined {
  const project = store.projects.find(p => p.id === id);
  if (project) computeProjectStats(project);
  return project;
}

export function addProject(name: string, description?: string): Project {
  const project: Project = {
    id: generateId(),
    name,
    description,
    createdAt: new Date().toISOString(),
    tasks: [],
    progress: 0,
  };
  store.projects.push(project);
  saveData();
  return project;
}

export function addTask(projectId: string, task: {
  title: string;
  description?: string;
  priority?: TaskPriority;
  points?: number;
  assignee?: Assignee;
  status?: TaskStatus;
}): Task | null {
  const project = store.projects.find(p => p.id === projectId);
  if (!project) return null;

  const newTask: Task = {
    id: generateId(),
    title: task.title,
    description: task.description,
    status: task.status || 'backlog',
    priority: task.priority || 'P3',
    points: task.points || 1,
    assignee: task.assignee,
    createdAt: new Date().toISOString(),
  };

  project.tasks.push(newTask);
  saveData();
  return newTask;
}

export function moveTask(projectId: string, taskId: string, newStatus: TaskStatus): boolean {
  const project = store.projects.find(p => p.id === projectId);
  if (!project) return false;

  const task = project.tasks.find(t => t.id === taskId);
  if (!task) return false;

  task.status = newStatus;
  if (newStatus === 'done' && !task.completedAt) {
    task.completedAt = new Date().toISOString();
  }

  saveData();
  return true;
}

export function updateTask(projectId: string, taskId: string, updates: Partial<Pick<Task, 'title' | 'description' | 'priority' | 'points' | 'assignee' | 'linkedCommits' | 'linkedFiles'>>): boolean {
  const project = store.projects.find(p => p.id === projectId);
  if (!project) return false;

  const task = project.tasks.find(t => t.id === taskId);
  if (!task) return false;

  Object.assign(task, updates);
  saveData();
  return true;
}

export function deleteProject(id: string): boolean {
  const idx = store.projects.findIndex(p => p.id === id);
  if (idx === -1) return false;
  store.projects.splice(idx, 1);
  saveData();
  return true;
}
