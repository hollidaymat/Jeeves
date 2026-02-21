/**
 * Extract music tracks from a playlist/screenshot image and add them to Lidarr.
 * Vision: Claude extracts [{artist, track}]. Lidarr: search + add each.
 */

import { readFileSync, existsSync } from 'fs';
import { createAnthropic } from '@ai-sdk/anthropic';
import { generateObject } from '../../core/llm/traced-llm.js';
import { z } from 'zod';
import { logger } from '../../utils/logger.js';
import { config } from '../../config.js';
import { addMedia } from '../../homelab/media/search.js';

export interface TrackExtraction {
  artist: string;
  track: string;
}

export interface PlaylistImageResult {
  summary: string;
  added: string[];
  notFound: string[];
  existing: string[];
  error?: string;
}

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

const TracksSchema = z.object({
  tracks: z.array(z.object({
    artist: z.string(),
    track: z.string(),
  })),
});

async function extractTracksFromImage(imageInput: {
  path?: string;
  data?: string;
}): Promise<TrackExtraction[]> {
  const dataUrl = imageToDataUrl(imageInput);
  if (!dataUrl) {
    return [];
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logger.warn('ANTHROPIC_API_KEY not set, cannot extract tracks from image');
    return [];
  }

  try {
    const anthropic = createAnthropic({ apiKey });
    const result = await generateObject({
      model: anthropic(config.claude.haiku_model),
      schema: TracksSchema,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Extract all music track names from this image (playlist, screenshot, photo of a list).
Return JSON with a "tracks" array. Each item: { "artist": "Artist Name", "track": "Track Title" }.
Use "Unknown" for artist or track if only one is visible (e.g. "Song Name" with no artist).
Skip headers, instructions, and non-track lines. If no tracks found, return empty tracks array.`,
            },
            { type: 'image', image: dataUrl },
          ],
        },
      ],
      maxTokens: 2048,
    });

    const parsed = result.object as { tracks: TrackExtraction[] };
    const tracks = (parsed?.tracks ?? []).filter(
      (t) => t.artist?.trim() || t.track?.trim()
    );
    logger.info('Extracted tracks from image', { count: tracks.length });
    return tracks;
  } catch (error) {
    logger.error('extractTracksFromImage failed', { error: String(error) });
    return [];
  }
}

export async function handlePlaylistImage(imageInput: {
  path?: string;
  data?: string;
}): Promise<PlaylistImageResult> {
  const tracks = await extractTracksFromImage(imageInput);
  const added: string[] = [];
  const notFound: string[] = [];
  const existing: string[] = [];

  if (tracks.length === 0) {
    return {
      summary: 'No music tracks found in the image.',
      added: [],
      notFound: [],
      existing: [],
    };
  }

  for (const { artist, track } of tracks) {
    const label = `${artist} - ${track}`;
    // Lidarr adds by artist; artist lookup fails on full "Artist - Track" string
    const query = artist?.trim() || track?.trim();
    if (!query) continue;

    const result = await addMedia(query, { type: 'music', autoSelectBest: true });

    if (result.success) {
      if (result.message?.toLowerCase().includes('already in library')) {
        existing.push(label);
      } else {
        added.push(label);
      }
    } else {
      notFound.push(label);
    }
  }

  const parts: string[] = [];
  if (added.length) parts.push(`Added ${added.length} to queue`);
  if (notFound.length) parts.push(`${notFound.length} not found (try individual requests)`);
  if (existing.length) parts.push(`${existing.length} already in library`);

  return {
    summary: parts.join('. ') || 'No changes.',
    added,
    notFound,
    existing,
  };
}
