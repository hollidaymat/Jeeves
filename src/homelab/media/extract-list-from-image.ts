/**
 * Extract a list of media items (movies, TV shows, songs) from an image using Claude vision.
 * Used when the user sends a screenshot or photo of a list and says "download these".
 */

import { readFileSync, existsSync } from 'fs';
import { createAnthropic } from '@ai-sdk/anthropic';
import { generateText } from '../../core/llm/traced-llm.js';
import { logger } from '../../utils/logger.js';
import { config } from '../../config.js';

export interface ExtractMediaListResult {
  success: boolean;
  list: string;
  message: string;
}

const SYSTEM_PROMPT = `You are extracting a list of media from an image. The image may be a screenshot, photo of a list, playlist, or similar.

Output ONLY a plain list: one item per line. No numbering, no bullets, no headers, no extra text.
- Movies: include title and year if visible (e.g. "Inception 2010", "Dune 2021").
- TV shows: include title and year or season if visible (e.g. "Breaking Bad season 1", "Fallout 2024").
- Songs: use "Song Title by Artist Name" or "Artist Name - Song Title" when both are visible.

Skip any line that is clearly not a media title (headers, instructions, etc.). If you cannot read any list of media, output exactly: NONE`;

/**
 * Get image as a data URL (for Claude). Accepts path (Signal) or existing data URL (web).
 */
function imageToDataUrl(input: { path?: string; data?: string }): string | null {
  if (input.data) {
    return input.data.startsWith('data:') ? input.data : `data:image/png;base64,${input.data}`;
  }
  if (input.path && existsSync(input.path)) {
    const buf = readFileSync(input.path);
    const base64 = buf.toString('base64');
    const mime = input.path.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
    return `data:${mime};base64,${base64}`;
  }
  return null;
}

/**
 * Extract a newline-separated list of media items from an image using Claude vision.
 */
export async function extractMediaListFromImage(imageInput: {
  path?: string;
  data?: string;
}): Promise<ExtractMediaListResult> {
  const dataUrl = imageToDataUrl(imageInput);
  if (!dataUrl) {
    return { success: false, list: '', message: 'No image data (path not found or data missing)' };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { success: false, list: '', message: 'ANTHROPIC_API_KEY not set' };
  }

  try {
    const anthropic = createAnthropic({ apiKey });
    const result = await generateText({
      model: anthropic(config.claude.haiku_model),
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Extract every movie, TV show, or song from this image. One per line, no numbering.' },
            { type: 'image', image: dataUrl },
          ],
        },
      ],
      maxTokens: 1024,
    });

    const text = (result.text || '').trim();
    const normalized = text.toUpperCase().replace(/\s+/g, ' ');
    if (normalized === 'NONE' || text.length < 2) {
      return { success: true, list: '', message: 'No media list found in the image' };
    }

    const lines = text
      .split(/\n/)
      .map(l => l.replace(/^[\d.)\-\s*]+/, '').trim())
      .filter(l => l.length > 0 && !/^(none|n\/a|—|–|-)$/i.test(l));

    const list = lines.join('\n');
    logger.info('Extracted media list from image', { lineCount: lines.length, preview: list.slice(0, 100) });
    return { success: true, list, message: `Found ${lines.length} item(s) in the image` };
  } catch (error) {
    logger.error('extractMediaListFromImage failed', { error: String(error) });
    return {
      success: false,
      list: '',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
