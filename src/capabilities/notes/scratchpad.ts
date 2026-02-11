/**
 * Scratchpad / Quick Notes
 * A simple key-value note store, searchable via chat.
 * Always available (no homelab required). Uses project data dir.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { ROOT } from '../../config.js';
import { logger } from '../../utils/logger.js';

const NOTES_PATH = join(ROOT, 'data', 'notes.json');

export interface Note {
  id: string;
  content: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

function loadNotes(): Note[] {
  try {
    if (existsSync(NOTES_PATH)) {
      const data = JSON.parse(readFileSync(NOTES_PATH, 'utf-8'));
      return Array.isArray(data) ? data : [];
    }
  } catch (err) {
    logger.warn('Notes: could not load', { path: NOTES_PATH, error: String(err) });
  }
  return [];
}

function saveNotes(notes: Note[]): void {
  const dir = dirname(NOTES_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  try {
    writeFileSync(NOTES_PATH, JSON.stringify(notes, null, 2), 'utf-8');
  } catch (err) {
    logger.error('Notes: could not save', { path: NOTES_PATH, error: String(err) });
    throw new Error(`Could not save notes: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Add a new note. Content must be non-empty. Throws on save failure.
 */
export function addNote(content: string): Note {
  const trimmed = (content || '').trim();
  if (!trimmed) {
    throw new Error('Note content cannot be empty.');
  }

  const notes = loadNotes();
  const id = `note-${Date.now()}`;

  const tags: string[] = [];
  const tagMatch = trimmed.match(/#(\w+)/g);
  if (tagMatch) {
    tags.push(...tagMatch.map(t => t.substring(1).toLowerCase()));
  }

  const note: Note = {
    id,
    content: trimmed,
    tags,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  notes.push(note);
  saveNotes(notes);
  return note;
}

/**
 * Search notes by keyword.
 */
export function searchNotes(query: string): Note[] {
  const notes = loadNotes();
  const lower = query.toLowerCase();
  return notes.filter(n =>
    n.content.toLowerCase().includes(lower) ||
    n.tags.some(t => t.includes(lower))
  );
}

/**
 * List all notes.
 */
export function listNotes(): Note[] {
  return loadNotes();
}

/**
 * Delete a note by ID or content match.
 */
export function deleteNote(identifier: string): boolean {
  const notes = loadNotes();
  const idx = notes.findIndex(n =>
    n.id === identifier ||
    n.content.toLowerCase().includes(identifier.toLowerCase())
  );
  if (idx === -1) return false;
  notes.splice(idx, 1);
  saveNotes(notes);
  return true;
}

/**
 * Format notes for display (newest first).
 */
export function formatNotes(notes: Note[]): string {
  if (notes.length === 0) return 'No notes yet. Say "note: something to remember" or "add a note that ..." to save one.';

  const lines: string[] = [`## Notes (${notes.length})`, ''];
  const sorted = [...notes].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  for (const note of sorted.slice(0, 25)) {
    const date = new Date(note.createdAt).toLocaleDateString(undefined, { dateStyle: 'short' });
    const tags = note.tags.length > 0 ? ` [${note.tags.join(', ')}]` : '';
    const text = (note.content || '(empty)').replace(/\n/g, ' ');
    lines.push(`- ${text}${tags} _(${date})_`);
  }
  if (sorted.length > 25) lines.push(`\n_... and ${sorted.length - 25} more_`);
  return lines.join('\n');
}
