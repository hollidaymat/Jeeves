/**
 * Session Compactor
 * Summarizes long conversation histories to reduce token usage
 * 
 * When conversations grow beyond a threshold, this module:
 * 1. Summarizes older messages using Haiku (cheap)
 * 2. Replaces them with a compact summary
 * 3. Keeps recent messages intact
 */

import { generateText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { logger } from '../utils/logger.js';
import { 
  needsCompaction, 
  getMessagesForSummary, 
  compactGeneralConversations,
  getGeneralConversationTokenCount
} from './memory.js';
import { trackLLMUsage } from './cost-tracker.js';

// Compaction settings
const COMPACTION_THRESHOLD_TOKENS = 30000;  // Trigger compaction at 30k tokens
const KEEP_RECENT_COUNT = 10;               // Keep last 10 messages intact

/**
 * Check if compaction is needed and perform it if so
 * Call this periodically (e.g., after each message)
 */
export async function checkAndCompact(): Promise<{
  compacted: boolean;
  savings?: string;
  error?: string;
}> {
  try {
    if (!needsCompaction(COMPACTION_THRESHOLD_TOKENS)) {
      return { compacted: false };
    }
    
    logger.info('Session compaction triggered', {
      tokenCount: getGeneralConversationTokenCount(),
      threshold: COMPACTION_THRESHOLD_TOKENS
    });
    
    // Get messages to summarize
    const messagesToSummarize = getMessagesForSummary(KEEP_RECENT_COUNT);
    
    if (messagesToSummarize.length === 0) {
      return { compacted: false };
    }
    
    // Format messages for summarization
    const conversationText = messagesToSummarize
      .map(m => `${m.role === 'user' ? 'User' : 'Jeeves'}: ${m.content}`)
      .join('\n\n');
    
    // Generate summary using Haiku (cheap)
    const anthropic = createAnthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });
    
    const result = await generateText({
      model: anthropic('claude-3-5-haiku-20241022'),
      maxTokens: 500,
      prompt: `Summarize this conversation in bullet points. Focus on:
- Key decisions made
- Important context established
- User preferences or patterns noticed
- Current state of any ongoing work
- Pending tasks or questions

Keep it concise but complete enough that the conversation can continue naturally.

Conversation:
${conversationText.slice(-20000)}  // Limit to last 20k chars to avoid token limits`
    });
    
    // Track usage
    const usage = result.usage;
    if (usage) {
      trackLLMUsage(
        'compaction',
        'claude-3-5-haiku-20241022',
        usage.promptTokens,
        usage.completionTokens,
        false
      );
    }
    
    // Apply compaction
    const compactionResult = compactGeneralConversations(result.text, KEEP_RECENT_COUNT);
    
    if (compactionResult.success) {
      const savings = ((compactionResult.tokensBefore - compactionResult.tokensAfter) / 
        compactionResult.tokensBefore * 100).toFixed(1);
      
      logger.info('Session compaction complete', {
        messagesBefore: compactionResult.beforeCount,
        messagesAfter: compactionResult.afterCount,
        tokensBefore: compactionResult.tokensBefore,
        tokensAfter: compactionResult.tokensAfter,
        savings: `${savings}%`
      });
      
      return { 
        compacted: true, 
        savings: `${savings}% (${compactionResult.tokensBefore} -> ${compactionResult.tokensAfter} tokens)`
      };
    }
    
    return { compacted: false };
    
  } catch (error) {
    logger.error('Session compaction failed', { error: String(error) });
    return { 
      compacted: false, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    };
  }
}

/**
 * Force compaction regardless of threshold
 * Useful for manual cleanup
 */
export async function forceCompact(): Promise<{
  success: boolean;
  message: string;
}> {
  const result = await checkAndCompact();
  
  if (result.compacted) {
    return {
      success: true,
      message: `Conversation compacted. Savings: ${result.savings}`
    };
  } else if (result.error) {
    return {
      success: false,
      message: `Compaction failed: ${result.error}`
    };
  } else {
    return {
      success: false,
      message: 'No compaction needed (conversation is short enough)'
    };
  }
}

/**
 * Get compaction status
 */
export function getCompactionStatus(): {
  currentTokens: number;
  threshold: number;
  needsCompaction: boolean;
  percentOfThreshold: number;
} {
  const currentTokens = getGeneralConversationTokenCount();
  
  return {
    currentTokens,
    threshold: COMPACTION_THRESHOLD_TOKENS,
    needsCompaction: currentTokens >= COMPACTION_THRESHOLD_TOKENS,
    percentOfThreshold: Math.round((currentTokens / COMPACTION_THRESHOLD_TOKENS) * 100)
  };
}
