/**
 * Extract JSON from LLM output that may contain markdown, extra text, etc.
 */
export function extractJsonFromText(text: string): string {
  const trimmed = text.trim();
  const blockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (blockMatch) return blockMatch[1].trim();
  const start = trimmed.indexOf('{');
  if (start >= 0) {
    let depth = 0;
    for (let i = start; i < trimmed.length; i++) {
      if (trimmed[i] === '{') depth++;
      else if (trimmed[i] === '}') {
        depth--;
        if (depth === 0) return trimmed.slice(start, i + 1);
      }
    }
  }
  return trimmed;
}
