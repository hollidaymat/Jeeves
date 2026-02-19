// Jeeves dev test
/**
 * File Reader (devtools)
 * Structured file reading for autonomous development. Node-only (no homelab shell).
 */

import { readFile, stat, readdir } from 'fs/promises';
import { join, extname, relative } from 'path';
import { existsSync } from 'fs';

const JEEVES_ROOT = '/home/jeeves/signal-cursor-controller';

export interface FileReadResult {
  path: string;
  content: string;
  lines: number;
  size: number;
  type: string;
  exports: string[];
  imports: string[];
}

export interface SearchResult {
  file: string;
  line: number;
  content: string;
  context: { before: string; after: string };
}

const TYPE_MAP: Record<string, string> = {
  '.ts': 'typescript',
  '.js': 'javascript',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.md': 'markdown',
};

function isAllowedPath(fullPath: string): boolean {
  const normalized = fullPath.startsWith(JEEVES_ROOT) ? fullPath : join(JEEVES_ROOT, fullPath);
  return normalized.startsWith('/home/jeeves/');
}

export async function readProjectFile(filePath: string): Promise<FileReadResult> {
  const fullPath = filePath.startsWith('/') ? filePath : join(JEEVES_ROOT, filePath);
  if (!isAllowedPath(fullPath)) {
    throw new Error(`Access denied: ${fullPath} is outside Jeeves project directory`);
  }
  const content = await readFile(fullPath, 'utf-8');
  const stats = await stat(fullPath);
  const ext = extname(fullPath);
  const lines = content.split('\n');
  const exports: string[] = [];
  const imports: string[] = [];
  if (ext === '.ts' || ext === '.js') {
    for (const line of lines) {
      const exportMatch = line.match(/export\s+(async\s+)?(?:function|class|const|let|interface|type|enum)\s+(\w+)/);
      if (exportMatch) exports.push(exportMatch[2]);
      const importMatch = line.match(/import\s+.*from\s+['"]([^'"]+)['"]/);
      if (importMatch) imports.push(importMatch[1]);
    }
  }
  return {
    path: fullPath,
    content,
    lines: lines.length,
    size: stats.size,
    type: TYPE_MAP[ext] || 'unknown',
    exports,
    imports,
  };
}

export async function readMultipleFiles(paths: string[]): Promise<FileReadResult[]> {
  return Promise.all(paths.map((p) => readProjectFile(p)));
}

export interface ReadRecoveryResult {
  contents: FileReadResult[];
  failedPaths: { path: string; error: string }[];
}

/**
 * Read multiple files with path retry and partial success.
 * Tries each path, then variants (relative under JEEVES_ROOT, normalized), and returns
 * successful reads plus a list of paths that failed (with error message).
 */
export async function readMultipleFilesWithRecovery(paths: string[]): Promise<ReadRecoveryResult> {
  const contents: FileReadResult[] = [];
  const failedPaths: { path: string; error: string }[] = [];

  for (const rawPath of paths) {
    const variants = [rawPath];
    const normalized = rawPath.replace(/^\/+/, '').replace(/\\/g, '/');
    if (normalized !== rawPath) variants.push(normalized);
    if (!rawPath.startsWith(JEEVES_ROOT) && !rawPath.startsWith('/')) {
      const withRoot = join(JEEVES_ROOT, normalized);
      if (!variants.includes(withRoot)) variants.push(withRoot);
    }

    let lastError = '';
    for (const p of variants) {
      try {
        const result = await readProjectFile(p);
        contents.push(result);
        lastError = '';
        break;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
    if (lastError) failedPaths.push({ path: rawPath, error: lastError });
  }

  return { contents, failedPaths };
}

export async function listDirectory(dirPath: string): Promise<string[]> {
  const fullPath = dirPath.startsWith('/') ? dirPath : join(JEEVES_ROOT, dirPath);
  if (!isAllowedPath(fullPath)) {
    throw new Error(`Access denied: ${fullPath} is outside Jeeves project directory`);
  }
  const entries = await readdir(fullPath, { withFileTypes: true });
  return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
}

function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/\./g, '\\.')
    .replace(/\*/g, '[^/]*')
    .replace(/\?\?/g, '.*');
  return new RegExp(escaped + '$');
}

async function walkDir(
  dir: string,
  pattern: RegExp,
  maxDepth: number,
  currentDepth: number,
  results: string[]
): Promise<void> {
  if (currentDepth > maxDepth) return;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules' && e.name !== '.git' && !e.name.startsWith('.')) {
        await walkDir(full, pattern, maxDepth, currentDepth + 1, results);
      }
    } else if (pattern.test(e.name)) {
      results.push(full);
    }
  }
}

export async function searchProject(
  pattern: string,
  options: { glob?: string; maxResults?: number } = {}
): Promise<SearchResult[]> {
  const { glob = '*.ts', maxResults = 50 } = options;
  const searchDir = join(JEEVES_ROOT, 'src');
  const testsDir = join(JEEVES_ROOT, 'tests');
  const regex = globToRegex(glob);
  const files: string[] = [];
  if (existsSync(searchDir)) await walkDir(searchDir, regex, 10, 0, files);
  if (existsSync(testsDir)) await walkDir(testsDir, regex, 2, 0, files);
  const results: SearchResult[] = [];
  const patternRe = new RegExp(pattern, 'i');
  for (const file of files) {
    if (results.length >= maxResults) break;
    let content: string;
    try {
      content = await readFile(file, 'utf-8');
    } catch {
      continue;
    }
    const lineList = content.split('\n');
    for (let i = 0; i < lineList.length; i++) {
      if (results.length >= maxResults) break;
      if (patternRe.test(lineList[i])) {
        results.push({
          file: relative(JEEVES_ROOT, file),
          line: i + 1,
          content: lineList[i].trim(),
          context: {
            before: lineList[i - 1]?.trim() ?? '',
            after: lineList[i + 1]?.trim() ?? '',
          },
        });
      }
    }
  }
  return results;
}
