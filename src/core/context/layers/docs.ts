/**
 * Layer 4: Institutional Knowledge (Docs)
 * 
 * Indexes markdown documentation into searchable chunks.
 * Uses keyword-based search (FTS-like) instead of vector embeddings.
 */

import { getDb, generateId } from '../db.js';
import { logger } from '../../../utils/logger.js';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, basename } from 'path';

// ==========================================
// TYPES
// ==========================================

export interface DocChunk {
  id: string;
  sourceFile: string;
  section: string | null;
  content: string;
  keywords: string;
}

export interface DocResult {
  sourceFile: string;
  section: string | null;
  content: string;
  score: number;
}

// ==========================================
// INDEXING
// ==========================================

/**
 * Extract keywords from text for indexing.
 */
function extractKeywords(text: string): string {
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
    'on', 'with', 'at', 'by', 'from', 'and', 'or', 'but', 'not', 'if',
    'then', 'so', 'it', 'this', 'that', 'my', 'your', 'their', 'our',
    'all', 'each', 'every', 'some', 'any', 'no', 'more', 'most', 'other',
    'into', 'than', 'too', 'very', 'just', 'about', 'also', 'like'
  ]);

  const words = text.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));

  // Deduplicate
  return [...new Set(words)].join(' ');
}

/**
 * Split markdown content into chunks by headings.
 * Each chunk is ~500 tokens max.
 */
function chunkMarkdown(content: string, maxTokens = 500): Array<{ section: string; text: string }> {
  const lines = content.split('\n');
  const chunks: Array<{ section: string; text: string }> = [];
  let currentSection = '';
  let currentText = '';
  let currentTokens = 0;

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,3})\s+(.+)/);

    if (headingMatch) {
      // Save current chunk if non-empty
      if (currentText.trim()) {
        chunks.push({ section: currentSection, text: currentText.trim() });
      }
      currentSection = headingMatch[2];
      currentText = line + '\n';
      currentTokens = Math.ceil(line.length / 4);
      continue;
    }

    const lineTokens = Math.ceil(line.length / 4);

    if (currentTokens + lineTokens > maxTokens && currentText.trim()) {
      chunks.push({ section: currentSection, text: currentText.trim() });
      currentText = line + '\n';
      currentTokens = lineTokens;
    } else {
      currentText += line + '\n';
      currentTokens += lineTokens;
    }
  }

  // Save final chunk
  if (currentText.trim()) {
    chunks.push({ section: currentSection, text: currentText.trim() });
  }

  return chunks;
}

/**
 * Find all markdown files in a directory recursively.
 */
function findMarkdownFiles(dir: string, maxDepth = 3, depth = 0): string[] {
  if (!existsSync(dir) || depth > maxDepth) return [];

  const files: string[] = [];

  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (entry.startsWith('.') || entry === 'node_modules') continue;

      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);

      if (stat.isFile() && entry.endsWith('.md')) {
        files.push(fullPath);
      } else if (stat.isDirectory()) {
        files.push(...findMarkdownFiles(fullPath, maxDepth, depth + 1));
      }
    }
  } catch {
    // Permission error or similar
  }

  return files;
}

/**
 * Index all markdown files in the project into the database.
 */
export function indexDocs(rootDir?: string): number {
  const db = getDb();
  const baseDir = rootDir || process.cwd();

  // Find markdown files (skip node_modules, .git, etc.)
  const mdFiles = findMarkdownFiles(baseDir);

  // Only index files that seem relevant (skip changelogs, lock files, etc.)
  const relevant = mdFiles.filter(f => {
    const name = basename(f).toLowerCase();
    return !name.includes('changelog') &&
      !name.includes('license') &&
      !name.includes('lock') &&
      !name.startsWith('.');
  });

  // Clear existing chunks
  db.prepare('DELETE FROM doc_chunks').run();

  const insert = db.prepare(`
    INSERT INTO doc_chunks (id, source_file, section, content, keywords)
    VALUES (?, ?, ?, ?, ?)
  `);

  let totalChunks = 0;

  const insertAll = db.transaction(() => {
    for (const file of relevant) {
      try {
        const content = readFileSync(file, 'utf-8');
        const relPath = relative(baseDir, file);
        const chunks = chunkMarkdown(content);

        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          const keywords = extractKeywords(chunk.text);
          const id = generateId('doc');

          insert.run(id, relPath, chunk.section || null, chunk.text, keywords);
          totalChunks++;
        }
      } catch (error) {
        logger.debug('Failed to index doc', { file, error: String(error) });
      }
    }
  });

  insertAll();
  logger.info('Docs indexed', { files: relevant.length, chunks: totalChunks });

  return totalChunks;
}

// ==========================================
// SEARCH
// ==========================================

/**
 * Search indexed docs using keyword matching.
 * Returns top N results sorted by relevance score.
 */
export function searchDocs(query: string, limit = 3): DocResult[] {
  const db = getDb();

  // Check if we have any indexed docs
  const count = (db.prepare('SELECT COUNT(*) as cnt FROM doc_chunks').get() as any)?.cnt || 0;
  if (count === 0) return [];

  const queryKeywords = extractKeywords(query).split(' ').filter(Boolean);
  if (queryKeywords.length === 0) return [];

  // Get all chunks and score them
  const rows = db.prepare('SELECT * FROM doc_chunks').all() as DocChunk[];

  const scored: Array<DocResult & { score: number }> = [];

  for (const row of rows) {
    const chunkKeywords = new Set(row.keywords.split(' '));
    const matches = queryKeywords.filter(qk =>
      [...chunkKeywords].some(ck => ck.includes(qk) || qk.includes(ck))
    );

    if (matches.length === 0) continue;

    const score = matches.length / queryKeywords.length;

    scored.push({
      sourceFile: row.sourceFile,
      section: row.section,
      content: row.content,
      score
    });
  }

  // Sort by score descending, take top N
  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map(({ sourceFile, section, content, score }) => ({
    sourceFile,
    section,
    content: content.substring(0, 1000), // Truncate long chunks
    score
  }));
}

/**
 * Check if docs have been indexed.
 */
export function isIndexed(): boolean {
  const db = getDb();
  const count = (db.prepare('SELECT COUNT(*) as cnt FROM doc_chunks').get() as any)?.cnt || 0;
  return count > 0;
}
