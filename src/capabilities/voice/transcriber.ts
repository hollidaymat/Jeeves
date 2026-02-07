/**
 * Voice Message Transcriber
 * 
 * Transcribes audio attachments from Signal voice notes using either:
 * 1. Local whisper binary (free, preferred if available)
 * 2. OpenAI Whisper API (requires OPENAI_API_KEY)
 * 
 * Budget-enforced as 'voice_transcription' feature.
 */

import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { logger } from '../../utils/logger.js';
import { enforceBudget, recordFeatureUsage } from '../../core/cost-tracker.js';

/** Check if local whisper binary is available */
function hasLocalWhisper(): boolean {
  try {
    execSync('which whisper 2>/dev/null || where whisper 2>NUL', { stdio: 'pipe', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** Transcribe using local whisper binary */
async function transcribeLocal(audioPath: string): Promise<string> {
  try {
    // whisper outputs to stdout with --output_format txt
    const result = execSync(
      `whisper "${audioPath}" --model tiny --language en --output_format txt --output_dir /tmp`,
      { timeout: 60000, encoding: 'utf-8', stdio: 'pipe' }
    );
    
    // Read the output txt file (whisper creates filename.txt)
    const baseName = audioPath.split('/').pop()?.replace(/\.[^.]+$/, '') || 'audio';
    const txtPath = `/tmp/${baseName}.txt`;
    if (existsSync(txtPath)) {
      return readFileSync(txtPath, 'utf-8').trim();
    }
    
    // Fallback: parse stdout
    return result.trim();
  } catch (err) {
    logger.error('Local whisper transcription failed', { error: String(err) });
    throw err;
  }
}

/** Transcribe using OpenAI Whisper API */
async function transcribeOpenAI(audioPath: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');

  const audioData = readFileSync(audioPath);
  const formData = new FormData();
  formData.append('file', new Blob([audioData]), 'audio.ogg');
  formData.append('model', 'whisper-1');
  formData.append('language', 'en');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
    },
    body: formData,
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`OpenAI Whisper API ${res.status}: ${errorText}`);
  }

  const result = await res.json() as { text: string };
  return result.text;
}

/**
 * Transcribe an audio file to text.
 * Prefers local whisper, falls back to OpenAI API.
 * Budget-enforced.
 */
export async function transcribeAudio(audioPath: string): Promise<{
  success: boolean;
  text: string;
  method: 'local' | 'api' | 'none';
}> {
  if (!audioPath || !existsSync(audioPath)) {
    return { success: false, text: '', method: 'none' };
  }

  // Budget check
  const budgetCheck = enforceBudget('voice_transcription');
  if (!budgetCheck.allowed) {
    logger.debug('Voice transcription budget exhausted', { reason: budgetCheck.reason });
    return { success: false, text: 'Voice transcription budget limit reached.', method: 'none' };
  }

  // Try local whisper first (free)
  if (hasLocalWhisper()) {
    try {
      const text = await transcribeLocal(audioPath);
      if (text) {
        logger.info('Voice transcribed (local)', { length: text.length });
        recordFeatureUsage('voice_transcription', 0);  // Free
        return { success: true, text, method: 'local' };
      }
    } catch {
      logger.debug('Local whisper failed, trying API');
    }
  }

  // Fall back to OpenAI API
  if (process.env.OPENAI_API_KEY) {
    try {
      const text = await transcribeOpenAI(audioPath);
      logger.info('Voice transcribed (API)', { length: text.length });
      recordFeatureUsage('voice_transcription', 0.006);  // ~$0.006 per minute
      return { success: true, text, method: 'api' };
    } catch (err) {
      logger.error('OpenAI Whisper transcription failed', { error: String(err) });
      return { success: false, text: `Transcription failed: ${err}`, method: 'none' };
    }
  }

  return { success: false, text: 'No transcription method available. Install whisper locally or set OPENAI_API_KEY.', method: 'none' };
}
