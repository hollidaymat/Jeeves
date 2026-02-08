/**
 * Scratchpad / Quick Notes
 * A simple key-value note store, searchable via chat.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const NOTES_PATH = '/home/jeeves/signal-cursor-controller/data/notes.json';

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
      return JSON.parse(readFileSync(NOTES_PATH, 'utf-8'));
    }
  } catch { /* ignore */ }
  return [];
}

function saveNotes(notes: Note[]): void {
  try {
    const dir = dirname(NOTES_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(NOTES_PATH, JSON.stringify(notes, null, 2));
  } catch { /* ignore */ }
}

/**
 * Add a new note.
 */
export function addNote(content: string): Note {
  const notes = loadNotes();
  const id = `note-${Date.now()}`;

  // Auto-extract tags from content
  const tags: string[] = [];
  const tagMatch = content.match(/#(\w+)/g);
  if (tagMatch) {
    tags.push(...tagMatch.map(t => t.substring(1).toLowerCase()));
  }

  const note: Note = {
    id,
    content,
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
 * Format notes for display.
 */
export function formatNotes(notes: Note[]): string {
  if (notes.length === 0) return 'No notes found.';

  const lines: string[] = [`## Notes (${notes.length})`, ''];
  for (const note of notes.slice(-20)) {
    const date = new Date(note.createdAt).toLocaleDateString();
    const tags = note.tags.length > 0 ? ` [${note.tags.join(', ')}]` : '';
    lines.push(`- ${note.content}${tags} _(${date})_`);
  }
  return lines.join('\n');
}
