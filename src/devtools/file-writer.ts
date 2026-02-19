/**
 * File Writer (devtools)
 * Safe, audited file writing with JSON backups and rollback.
 */
// Jeeves dev test 2

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { existsSync } from 'fs';

const JEEVES_ROOT = '/home/jeeves/signal-cursor-controller';
const BACKUP_DIR = join(JEEVES_ROOT, 'data/devtools/backups');
const CHANGELOG_PATH = join(JEEVES_ROOT, 'data/devtools/changelog.json');
const MAX_FILE_SIZE = 50 * 1024;

const PROTECTED_FILES = [
  'config.json',
  'config.example.json',
  '.env',
  'package.json',
  'package-lock.json',
  'src/homelab/shell.ts',
  'src/devtools/file-writer.ts',
  'src/devtools/guardrails.ts',
  'src/core/trust.ts',
  'src/interfaces/signal.ts',
];

const ALLOWED_WRITE_DIRS = [
  join(JEEVES_ROOT, 'src'),
  join(JEEVES_ROOT, 'tests'),
  join(JEEVES_ROOT, 'web'),
];

export interface WriteResult {
  success: boolean;
  path: string;
  backupPath: string | null;
  error?: string;
  linesChanged: number;
}

export interface BackupPayload {
  originalPath: string;
  content: string;
  timestamp: string;
  taskId?: string;
  description?: string;
}

export interface ChangelogEntry {
  timestamp: string;
  taskId: string;
  action: 'create' | 'modify' | 'delete';
  path: string;
  backupPath: string | null;
  description: string;
  linesChanged: number;
}

function toAbsolutePath(filePath: string): string {
  return filePath.startsWith('/') ? filePath : join(JEEVES_ROOT, filePath);
}

function toRelativePath(fullPath: string): string {
  return fullPath.replace(JEEVES_ROOT + '/', '').replace(JEEVES_ROOT, '');
}

async function ensureDir(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}

async function appendChangelog(entry: ChangelogEntry): Promise<void> {
  let changelog: ChangelogEntry[] = [];
  try {
    const existing = await readFile(CHANGELOG_PATH, 'utf-8');
    changelog = JSON.parse(existing);
  } catch {
    /* first entry */
  }
  changelog.push(entry);
  if (changelog.length > 500) changelog = changelog.slice(-500);
  await ensureDir(CHANGELOG_PATH);
  await writeFile(CHANGELOG_PATH, JSON.stringify(changelog, null, 2), 'utf-8');
}

export async function writeProjectFile(
  filePath: string,
  content: string,
  taskId: string,
  description: string
): Promise<WriteResult> {
  const fullPath = toAbsolutePath(filePath);
  const relativePath = toRelativePath(fullPath);

  if (PROTECTED_FILES.some((p) => relativePath === p || relativePath.endsWith('/' + p))) {
    return {
      success: false,
      path: fullPath,
      backupPath: null,
      linesChanged: 0,
      error: `PROTECTED: ${relativePath} cannot be modified by autonomous developer`,
    };
  }

  const allowed = ALLOWED_WRITE_DIRS.some((dir) => fullPath.startsWith(dir + '/') || fullPath === dir);
  if (!allowed) {
    return {
      success: false,
      path: fullPath,
      backupPath: null,
      linesChanged: 0,
      error: 'ACCESS DENIED: Can only write to src/, tests/, web/',
    };
  }

  if (Buffer.byteLength(content) > MAX_FILE_SIZE) {
    return {
      success: false,
      path: fullPath,
      backupPath: null,
      linesChanged: 0,
      error: `FILE TOO LARGE: ${Buffer.byteLength(content)} bytes exceeds ${MAX_FILE_SIZE} limit`,
    };
  }

  let backupPath: string | null = null;
  let originalLines = 0;
  if (existsSync(fullPath)) {
    const original = await readFile(fullPath, 'utf-8');
    originalLines = original.split('\n').length;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeId = `${taskId.replace(/[^a-z0-9-]/gi, '_')}_${Date.now()}_${timestamp}`;
    backupPath = join(BACKUP_DIR, `${safeId}.backup.json`);
    await ensureDir(backupPath);
    const payload: BackupPayload = {
      originalPath: fullPath,
      content: original,
      timestamp: new Date().toISOString(),
      taskId,
      description,
    };
    await writeFile(backupPath, JSON.stringify(payload, null, 2), 'utf-8');
  }

  await ensureDir(fullPath);
  await writeFile(fullPath, content, 'utf-8');
  const newLines = content.split('\n').length;
  const linesChanged = Math.abs(newLines - originalLines);

  await appendChangelog({
    timestamp: new Date().toISOString(),
    taskId,
    action: originalLines > 0 ? 'modify' : 'create',
    path: relativePath,
    backupPath,
    description,
    linesChanged,
  });

  return { success: true, path: fullPath, backupPath, linesChanged };
}

export async function editProjectFile(
  filePath: string,
  oldString: string,
  newString: string,
  taskId: string,
  description: string
): Promise<WriteResult> {
  const fullPath = toAbsolutePath(filePath);
  let content: string;
  try {
    content = await readFile(fullPath, 'utf-8');
  } catch {
    return {
      success: false,
      path: fullPath,
      backupPath: null,
      linesChanged: 0,
      error: `File not found: ${fullPath}`,
    };
  }
  if (!content.includes(oldString)) {
    return {
      success: false,
      path: fullPath,
      backupPath: null,
      linesChanged: 0,
      error: 'old_string not found in file. Read the file first to get exact content.',
    };
  }
  const newContent = content.replace(oldString, newString);
  return writeProjectFile(fullPath, newContent, taskId, description);
}

export async function rollbackFile(backupPath: string): Promise<boolean> {
  try {
    const raw = await readFile(backupPath, 'utf-8');
    const payload: BackupPayload = JSON.parse(raw);
    await ensureDir(payload.originalPath);
    await writeFile(payload.originalPath, payload.content, 'utf-8');
    return true;
  } catch {
    return false;
  }
}

export async function getRecentChanges(limit: number = 20): Promise<ChangelogEntry[]> {
  try {
    const content = await readFile(CHANGELOG_PATH, 'utf-8');
    const changelog: ChangelogEntry[] = JSON.parse(content);
    return changelog.slice(-limit);
  } catch {
    return [];
  }
}
