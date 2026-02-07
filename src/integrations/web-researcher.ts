/**
 * Web Researcher
 * 
 * Lightweight web search for PRD context gathering.
 * Uses DuckDuckGo HTML (no API key needed) via Node fetch.
 * Falls back gracefully if search is unavailable.
 */

import { logger } from '../utils/logger.js';

/**
 * Research a topic by searching DuckDuckGo and extracting snippets
 */
export async function researchTopic(query: string): Promise<string> {
  logger.debug('Web research', { query });

  try {
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Jeeves/2.0)',
        'Accept': 'text/html',
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      logger.debug('Web research failed', { status: res.status });
      return '';
    }

    const html = await res.text();

    // Extract search result snippets from DuckDuckGo HTML
    const snippets = extractSnippets(html);

    if (snippets.length === 0) {
      return '';
    }

    const summary = snippets
      .slice(0, 5)
      .map((s, i) => `${i + 1}. **${s.title}**: ${s.snippet}`)
      .join('\n');

    logger.debug('Web research results', { query, resultCount: snippets.length });

    return `Web search for "${query}":\n${summary}`;
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      logger.debug('Web research timed out', { query });
    } else {
      logger.debug('Web research failed', { query, error: String(error) });
    }
    return '';
  }
}

interface SearchSnippet {
  title: string;
  snippet: string;
  url: string;
}

/**
 * Extract search result snippets from DuckDuckGo HTML response
 */
function extractSnippets(html: string): SearchSnippet[] {
  const results: SearchSnippet[] = [];

  // DuckDuckGo HTML search results are in <div class="result"> blocks
  // Title is in <a class="result__a">
  // Snippet is in <a class="result__snippet">

  const resultBlocks = html.split(/class="result\s/);

  for (const block of resultBlocks.slice(1, 8)) {  // Skip first split, take up to 7
    try {
      // Extract title
      const titleMatch = block.match(/class="result__a"[^>]*>([^<]+)</);
      const title = titleMatch ? decodeHtmlEntities(titleMatch[1].trim()) : '';

      // Extract snippet
      const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
      let snippet = snippetMatch ? snippetMatch[1].trim() : '';
      // Strip remaining HTML tags from snippet
      snippet = snippet.replace(/<[^>]+>/g, '').trim();
      snippet = decodeHtmlEntities(snippet);

      // Extract URL
      const urlMatch = block.match(/class="result__url"[^>]*>([^<]+)/);
      const url = urlMatch ? urlMatch[1].trim() : '';

      if (title && snippet) {
        results.push({ title, snippet, url });
      }
    } catch {
      // Skip malformed result
    }
  }

  return results;
}

/**
 * Decode common HTML entities
 */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
