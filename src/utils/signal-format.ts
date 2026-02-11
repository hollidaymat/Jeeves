/**
 * Format content for Signal — no markdown rendering, cap length.
 */

const SIGNAL_MAX_CHARS = 2000;

/** Strip markdown for plain-text display (bullets, lists, bold, etc.) — exported for API responses */
export function stripMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, '')           // headers
    .replace(/\*\*([^*]+)\*\*/g, '$1')    // bold
    .replace(/\*([^*]+)\*/g, '$1')        // italic
    .replace(/__([^_]+)__/g, '$1')        // bold alt
    .replace(/_([^_]+)_/g, '$1')          // italic alt
    .replace(/`([^`]+)`/g, '$1')          // inline code
    .replace(/```[\s\S]*?```/g, '')       // code blocks
    .replace(/^\s*[-*]\s+/gm, ' ')        // bullets at line start
    .replace(/ - /g, ' — ')               // " - " -> em dash
    .replace(/- /g, ' ')                  // "- " (dash-space, bullet remnant)
    .replace(/^\s*\d+\.\s+/gm, ' ')       // numbered list
    .replace(/\n{3,}/g, '\n\n')           // collapse newlines
    .trim();
}

/** Format response for Signal: strip markdown, cap at 500 chars */
export function formatForSignal(content: string): string {
  const stripped = stripMarkdown(content);
  if (stripped.length <= SIGNAL_MAX_CHARS) return stripped;
  return stripped.slice(0, SIGNAL_MAX_CHARS - 3) + '...';
}
