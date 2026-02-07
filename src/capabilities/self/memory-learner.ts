/**
 * Memory Learner
 * 
 * Detects corrections and preference statements in conversation,
 * extracts them, and stores them via the trust/annotations system.
 * These are then injected into Cursor agent prompts and PRDs.
 */

import { logger } from '../../utils/logger.js';

/** Patterns that indicate a correction or preference statement */
const CORRECTION_PATTERNS = [
  /\b(?:no,?\s+)?(?:I\s+(?:meant|mean|want|prefer|need|like)|don'?t\s+(?:do|use|add|make)|always\s+use|never\s+use|stop\s+(?:doing|using|adding)|please?\s+(?:don'?t|stop|always|never))\b/i,
  /\b(?:use\s+\w+\s+(?:instead|not)\s+\w+|prefer\s+\w+\s+(?:over|to|instead))\b/i,
  /\b(?:remember\s+(?:that|to|this)|for\s+(?:future|next\s+time|reference)|keep\s+in\s+mind)\b/i,
  /\b(?:that'?s?\s+(?:not\s+(?:right|correct|what)|wrong)|incorrect|fix\s+that|change\s+that)\b/i,
];

/** Categories for extracted preferences */
type PreferenceCategory = 'tech_stack' | 'code_style' | 'communication' | 'workflow' | 'general';

/** Map our categories to CorrectionRecord categories used by the trust system */
const CATEGORY_MAP: Record<PreferenceCategory, 'code-style' | 'library' | 'approach' | 'communication' | 'other'> = {
  tech_stack: 'library',
  code_style: 'code-style',
  communication: 'communication',
  workflow: 'approach',
  general: 'other',
};

interface ExtractedPreference {
  category: PreferenceCategory;
  preference: string;
  confidence: number;
  source: string;  // The original message text
}

/**
 * Analyze a message for corrections or preference statements.
 * Returns extracted preferences if found, null otherwise.
 */
export function detectCorrection(message: string): ExtractedPreference | null {
  const trimmed = message.trim();
  if (trimmed.length < 10 || trimmed.length > 500) return null;  // Too short or too long

  const isCorrection = CORRECTION_PATTERNS.some(p => p.test(trimmed));
  if (!isCorrection) return null;

  // Categorize
  const lower = trimmed.toLowerCase();
  let category: PreferenceCategory = 'general';
  if (/\b(tailwind|react|next\.?js|supabase|firebase|typescript|css|html|vercel|node|npm|pnpm|yarn|shadcn|styled)/i.test(lower)) {
    category = 'tech_stack';
  } else if (/\b(indent|tabs?|spaces?|semicolons?|quotes?|naming|convention|export|import|function|class|component|variable|const|let|var)/i.test(lower)) {
    category = 'code_style';
  } else if (/\b(verbose|concise|brief|detailed|summarize|bullet|format|emoji|tone|style|explain|short|long)/i.test(lower)) {
    category = 'communication';
  } else if (/\b(commit|push|merge|branch|deploy|test|review|approve|pr|pull\s*request|agent|cursor|build)/i.test(lower)) {
    category = 'workflow';
  }

  return {
    category,
    preference: trimmed,
    confidence: 0.7,
    source: trimmed.substring(0, 200),
  };
}

/**
 * Process a detected correction — store it in the trust/annotations system.
 */
export async function storePreference(pref: ExtractedPreference): Promise<void> {
  try {
    // Store via trust system
    // recordCorrection(original, corrected, category, learned)
    const trust = await import('../../core/trust.js');
    if (trust.recordCorrection) {
      const correctionCategory = CATEGORY_MAP[pref.category];
      trust.recordCorrection(pref.source, pref.preference, correctionCategory, pref.preference);
    }

    // Also store as annotation in the context layer
    // setAnnotation(key, value, category, source)
    try {
      const { setAnnotation } = await import('../../core/context/layers/annotations.js');
      if (setAnnotation) {
        const key = `learned_${pref.category}_${Date.now()}`;
        setAnnotation(key, pref.preference, 'preference', 'learned');
      }
    } catch {
      // Annotations layer may not be available
    }

    logger.info('Stored learned preference', { category: pref.category, preview: pref.preference.substring(0, 50) });
  } catch (err) {
    logger.debug('Failed to store preference', { error: String(err) });
  }
}

/**
 * Analyze a message and store any detected preferences.
 * Call this from the handler on every incoming message.
 */
export async function learnFromMessage(message: string): Promise<void> {
  const pref = detectCorrection(message);
  if (pref) {
    await storePreference(pref);
  }
}

/**
 * Get a summary of all learned preferences for injection into prompts.
 */
export async function getPreferenceSummary(): Promise<string> {
  try {
    // getLearnedPreferences() returns a formatted string
    const trust = await import('../../core/trust.js');
    if (trust.getLearnedPreferences) {
      const summary = trust.getLearnedPreferences();
      // Only return if it contains real content (not just the "no preferences" fallback)
      if (summary && !summary.includes('No learned preferences available')) {
        return '## Owner Preferences (learned from conversation)\n' + summary;
      }
    }
  } catch {
    // Trust system not available
  }

  return '';
}
