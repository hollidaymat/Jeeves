/**
 * Conversation Handler — Meta-discussion and capability chat
 *
 * Runs BEFORE task routing. Meta-questions about Jeeves (capabilities, self-reflection,
 * "how did that work") bypass loop detection and get natural responses.
 * No "outside task scope" or defensive refusals; offer alternatives instead.
 */

import type { OutgoingMessage } from '../types/index.js';
import { COMMAND_REGISTRY } from './command-registry.js';

/** Patterns that indicate a meta question or conversation (about Jeeves, his capabilities, or casual chat). */
const META_PATTERNS = [
  /^(what\s+can\s+you\s+do|tell\s+me\s+(your\s+)?capabilities|what\s+are\s+you\s+(able\s+to\s+)?(do|capable\s+of)|what\s+do\s+you\s+support)\??$/i,
  /^(tell\s+me\s+)?(what\s+do\s+you\s+think\s+(about|of)\s+.+|how\s+do\s+you\s+feel\s+about\s+.+)\??$/i,
  /tell\s+me\s+what\s+you\s+think\s+(about|of)\s+.+capabilities/i,
  /^(how\s+did\s+that\s+work|why\s+did\s+that\s+(work|happen)|what\s+happened\s+there)\??$/i,
  /^(what\s+do\s+you\s+see|what'?s\s+(there|running|going\s+on)|what\s+do\s+I\s+have)\??$/i,
  /^scan\s+(your\s+)?repo\b/i,
  /^scan\s+(the\s+)?(codebase|project)\b/i,
  /^list\s+(your\s+)?(repo|code)\b/i,
  /^(talk\s+to\s+me|just\s+chat|let'?s\s+talk|chat\s+with\s+me|hey\s+goose|talk\s+to\s+me\s+goose)\s*[!.]?$/i,
  /^(need\s+a\s+concrete\s+request|concrete\s+task)\??$/i,
  /^(what\s+do\s+you\s+know\s+about\s+yourself|describe\s+yourself|who\s+are\s+you)\??$/i,
];

/**
 * True if the message is a meta-question or conversation prompt (about Jeeves, capabilities, or casual).
 * These are handled in conversation mode: no loop detection, no fuzzy confirmation.
 */
export function isMetaOrConversation(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed || trimmed.length > 300) return false;
  return META_PATTERNS.some((re) => re.test(trimmed));
}

/**
 * True if the message is a clear question or statement that should get a direct answer,
 * not a "Did you mean: X?" fuzzy prompt. Used to skip fuzzy matching for these.
 */
export function isClearQuestionOrStatement(message: string): boolean {
  const trimmed = message.trim().toLowerCase();
  if (!trimmed) return false;
  return (
    /^(what|why|how|when|where|who|tell\s+me|show\s+me|can\s+you\s+explain|do\s+you\s+think)\b/.test(trimmed) ||
    /^(talk\s+to\s+me|scan\s+your\s+repo|what\s+do\s+you\s+see)\b/.test(trimmed)
  );
}

/**
 * Handle meta/conversation messages. Returns an OutgoingMessage to send, or null to fall through to task routing.
 * Call this FIRST (before workflow/registry). No loop detection is applied to this response.
 */
export async function handleConversation(
  primaryCommand: string,
  fullContent: string,
  sender: string,
  replyTo: string
): Promise<OutgoingMessage | null> {
  const trimmed = primaryCommand.trim();
  if (!isMetaOrConversation(trimmed)) return null;

  const lower = trimmed.toLowerCase();

  // "What can you do?" / "Tell me your capabilities"
  if (/^(what\s+can\s+you\s+do|tell\s+me\s+(your\s+)?capabilities|what\s+are\s+you\s+(able\s+to\s+)?(do|capable\s+of)|what\s+do\s+you\s+support)\??$/i.test(trimmed)) {
    const categories = new Map<string, string[]>();
    for (const cmd of COMMAND_REGISTRY) {
      const cat = cmd.category || 'other';
      if (!categories.has(cat)) categories.set(cat, []);
      const label = cmd.id.replace(/^[^.]+\./, '').replace(/_/g, ' ');
      categories.get(cat)!.push(label);
    }
    const lines = ['Here’s what I can do:\n'];
    for (const [cat, ids] of categories) {
      lines.push(`**${cat}**: ${ids.slice(0, 5).join(', ')}${ids.length > 5 ? '…' : ''}`);
    }
    lines.push('\nSay "help" for a full list, or ask for something specific (e.g. "homelab status", "dev typecheck-only: add a comment to src/foo.ts").');
    return { recipient: sender, content: lines.join('\n'), replyTo };
  }

  // "What do you think about features/capabilities" and "scan your repo" / "list your code" are NOT
  // answered here — they fall through to the cognitive path so Jeeves answers from real context
  // (capabilities doc + project list) in his own words.

  // "How did that work?" / "Why did that happen?"
  if (/^(how\s+did\s+that\s+work|why\s+did\s+that\s+(work|happen)|what\s+happened\s+there)\??$/i.test(trimmed)) {
    const blurb =
      'I don’t have the last run in this message, but you can check the last execution with the debug API (GET /api/debug/last-execution-outcome over HTTPS). For dev tasks I run: read file → plan (or fast path for "add comment at top") → apply → typecheck → smoke/full test. If something failed, the last-execution-outcome summary will say why.';
    return { recipient: sender, content: blurb, replyTo };
  }

  // "What do you see?" / "What's running?"
  if (/^(what\s+do\s+you\s+see|what'?s\s+(there|running|going\s+on)|what\s+do\s+I\s+have)\??$/i.test(trimmed)) {
    try {
      const { getDashboardStatus } = await import('../homelab/index.js');
      const dash = await getDashboardStatus();
      const services = (dash.services as { name?: string; state?: string }[] | undefined) ?? [];
      const count = Array.isArray(services) ? services.length : 0;
      const names = Array.isArray(services)
        ? (services as { name?: string }[]).slice(0, 12).map((s) => s.name || '?').join(', ')
        : '';
      const more = count > 12 ? ` … and ${count - 12} more` : '';
      return {
        recipient: sender,
        content: `I see Docker with **${count}** services${count ? `: ${names}${more}.` : '.'} Say "homelab status" or "containers" for the full list.`,
        replyTo,
      };
    } catch {
      return {
        recipient: sender,
        content: "I don't have homelab visibility from here. Say \"homelab status\" and I can try to pull a report, or check the dashboard directly.",
        replyTo,
      };
    }
  }

  // "Talk to me goose" / casual
  if (/^(talk\s+to\s+me|just\s+chat|let'?s\s+talk|chat\s+with\s+me|hey\s+goose|talk\s+to\s+me\s+goose)\s*[!.]?$/i.test(trimmed)) {
    return {
      recipient: sender,
      content: "Hey! I'm here. What would you like to do? I can run dev tasks, check homelab, list projects, or we can chat about what I can do.",
      replyTo,
    };
  }

  // "Need a concrete request" (user echoing back an error) — gentle redirect
  if (/need\s+a\s+concrete\s+request|concrete\s+task/i.test(trimmed)) {
    return {
      recipient: sender,
      content: "No worries. If you’d like a small task, try: \"dev typecheck-only: add a comment at the top of src/config.ts that says // hi\". Or ask \"what can you do?\" and I’ll list options.",
      replyTo,
    };
  }

  // "What do you know about yourself?" / "Describe yourself"
  if (/^(what\s+do\s+you\s+know\s+about\s+yourself|describe\s+yourself|who\s+are\s+you)\??$/i.test(trimmed)) {
    return {
      recipient: sender,
      content: "I'm Jeeves — I run tasks you send (homelab, dev, Cursor, notes, etc.). I have a command registry, dev modes (typecheck-only, smoke-test, full-test), and a capability doc at docs/CAPABILITY_AUDIT.md. Ask \"what can you do?\" for a quick list.",
      replyTo,
    };
  }

  return null;
}
