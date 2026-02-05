/**
 * Memory & Context Storage
 * Persists conversation history, project context, and user preferences
 * 
 * Features:
 * - JSON file-based persistence
 * - Per-project conversation history
 * - Files discussed tracking
 * - User preferences
 * - Context for AI continuity
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { 
  MemoryStore, 
  ProjectMemory, 
  ConversationMessage, 
  UserPreferences 
} from '../types/index.js';

const MEMORY_VERSION = 1;

// In-memory cache
let memoryStore: MemoryStore | null = null;

/**
 * Get the storage file path
 */
function getStoragePath(): string {
  return config.memory.storage_path;
}

/**
 * Initialize an empty memory store
 */
function createEmptyStore(): MemoryStore {
  return {
    version: MEMORY_VERSION,
    preferences: {},
    projects: {},
    generalConversations: [],
    lastUpdated: new Date().toISOString()
  };
}

/**
 * Load memory from disk
 */
export function loadMemory(): MemoryStore {
  if (memoryStore) {
    return memoryStore;
  }

  const storagePath = getStoragePath();

  if (!existsSync(storagePath)) {
    logger.info('No memory file found, creating new store');
    memoryStore = createEmptyStore();
    return memoryStore;
  }

  try {
    const data = readFileSync(storagePath, 'utf-8');
    memoryStore = JSON.parse(data) as MemoryStore;
    
    // Handle version migrations if needed
    if (memoryStore.version !== MEMORY_VERSION) {
      logger.info('Migrating memory store', { from: memoryStore.version, to: MEMORY_VERSION });
      memoryStore.version = MEMORY_VERSION;
      saveMemory();
    }

    logger.info('Loaded memory store', { 
      projects: Object.keys(memoryStore.projects).length 
    });
    
    return memoryStore;
  } catch (error) {
    logger.error('Failed to load memory store', { error: String(error) });
    memoryStore = createEmptyStore();
    return memoryStore;
  }
}

/**
 * Save memory to disk
 */
export function saveMemory(): void {
  if (!memoryStore) {
    return;
  }

  const storagePath = getStoragePath();
  
  try {
    // Ensure directory exists
    const dir = dirname(storagePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    memoryStore.lastUpdated = new Date().toISOString();
    writeFileSync(storagePath, JSON.stringify(memoryStore, null, 2), 'utf-8');
    
    logger.debug('Saved memory store');
  } catch (error) {
    logger.error('Failed to save memory store', { error: String(error) });
  }
}

/**
 * Get or create project memory
 */
export function getProjectMemory(projectPath: string, projectName: string): ProjectMemory {
  const store = loadMemory();
  
  if (!store.projects[projectPath]) {
    store.projects[projectPath] = {
      projectPath,
      projectName,
      conversations: [],
      lastAccessed: new Date().toISOString(),
      filesDiscussed: []
    };
    saveMemory();
  }

  // Update last accessed
  store.projects[projectPath].lastAccessed = new Date().toISOString();
  
  return store.projects[projectPath];
}

/**
 * Add a message to project conversation history
 */
export function addMessage(
  projectPath: string, 
  role: 'user' | 'assistant', 
  content: string,
  filesDiscussed?: string[]
): void {
  const store = loadMemory();
  const project = store.projects[projectPath];
  
  if (!project) {
    logger.warn('Cannot add message: project not in memory', { projectPath });
    return;
  }

  const message: ConversationMessage = {
    role,
    content,
    timestamp: new Date().toISOString(),
    filesDiscussed
  };

  project.conversations.push(message);

  // Track files discussed at project level
  if (filesDiscussed) {
    for (const file of filesDiscussed) {
      if (!project.filesDiscussed.includes(file)) {
        project.filesDiscussed.push(file);
      }
    }
  }

  // Trim to max messages
  const maxMessages = config.memory.max_messages_per_conversation;
  if (project.conversations.length > maxMessages) {
    project.conversations = project.conversations.slice(-maxMessages);
  }

  saveMemory();
}

/**
 * Get recent conversation history for AI context
 */
export function getConversationContext(projectPath: string, maxMessages: number = 10): ConversationMessage[] {
  const store = loadMemory();
  const project = store.projects[projectPath];
  
  if (!project) {
    return [];
  }

  return project.conversations.slice(-maxMessages);
}

/**
 * Get formatted conversation history for display
 */
export function getFormattedHistory(projectPath: string): string {
  const store = loadMemory();
  const project = store.projects[projectPath];
  
  if (!project || project.conversations.length === 0) {
    return 'No conversation history for this project.';
  }

  const lines: string[] = [
    `## Conversation History: ${project.projectName}`,
    `Last accessed: ${new Date(project.lastAccessed).toLocaleString()}`,
    `Total messages: ${project.conversations.length}`,
    ''
  ];

  // Show last 10 messages
  const recent = project.conversations.slice(-10);
  for (const msg of recent) {
    const time = new Date(msg.timestamp).toLocaleTimeString();
    const role = msg.role === 'user' ? 'You' : 'Jeeves';
    const preview = msg.content.length > 200 
      ? msg.content.substring(0, 200) + '...' 
      : msg.content;
    
    lines.push(`**[${time}] ${role}:** ${preview}`);
    lines.push('');
  }

  if (project.filesDiscussed.length > 0) {
    lines.push('**Files discussed:**');
    lines.push(project.filesDiscussed.slice(-10).join(', '));
  }

  return lines.join('\n');
}

/**
 * Clear conversation history for a project
 */
export function clearProjectHistory(projectPath: string): { success: boolean; message: string } {
  const store = loadMemory();
  
  if (!store.projects[projectPath]) {
    return { success: false, message: 'No history found for this project' };
  }

  const count = store.projects[projectPath].conversations.length;
  store.projects[projectPath].conversations = [];
  store.projects[projectPath].filesDiscussed = [];
  saveMemory();

  return { success: true, message: `Cleared ${count} messages from history` };
}

/**
 * Get user preferences
 */
export function getPreferences(): UserPreferences {
  const store = loadMemory();
  return store.preferences;
}

/**
 * Set a user preference
 */
export function setPreference<K extends keyof UserPreferences>(
  key: K, 
  value: UserPreferences[K]
): void {
  const store = loadMemory();
  store.preferences[key] = value;
  saveMemory();
  
  logger.info('Preference updated', { key, value });
}

/**
 * Get all preferences as formatted string
 */
export function getFormattedPreferences(): string {
  const prefs = getPreferences();
  
  const lines = [
    '## User Preferences',
    '',
    `- **Default Project:** ${prefs.defaultProject || '(not set)'}`,
    `- **Preferred Model:** ${prefs.preferredModel || '(default)'}`,
    `- **Verbose Mode:** ${prefs.verboseMode ? 'enabled' : 'disabled'}`,
    `- **Auto-apply Changes:** ${prefs.autoApplyChanges ? 'enabled' : 'disabled'}`
  ];

  return lines.join('\n');
}

/**
 * Get project summary (files discussed, recent topics)
 */
export function getProjectSummary(projectPath: string): string {
  const store = loadMemory();
  const project = store.projects[projectPath];
  
  if (!project) {
    return 'No memory for this project yet.';
  }

  const lines = [
    `## Project Summary: ${project.projectName}`,
    '',
    `**Last accessed:** ${new Date(project.lastAccessed).toLocaleString()}`,
    `**Total messages:** ${project.conversations.length}`,
    `**Files discussed:** ${project.filesDiscussed.length}`,
    ''
  ];

  if (project.summary) {
    lines.push('**Summary:**');
    lines.push(project.summary);
    lines.push('');
  }

  if (project.filesDiscussed.length > 0) {
    lines.push('**Recent files:**');
    lines.push(project.filesDiscussed.slice(-15).join(', '));
  }

  // Extract recent topics from messages
  const recentQuestions = project.conversations
    .filter(m => m.role === 'user')
    .slice(-5)
    .map(m => m.content.substring(0, 80) + (m.content.length > 80 ? '...' : ''));

  if (recentQuestions.length > 0) {
    lines.push('');
    lines.push('**Recent topics:**');
    for (const q of recentQuestions) {
      lines.push(`- ${q}`);
    }
  }

  return lines.join('\n');
}

/**
 * Build context string for AI from conversation history
 */
export function buildContextForAI(projectPath: string): string {
  const history = getConversationContext(projectPath, 6);
  
  if (history.length === 0) {
    return '';
  }

  const lines = [
    '--- Previous Conversation ---',
    ''
  ];

  for (const msg of history) {
    const role = msg.role === 'user' ? 'User' : 'Assistant';
    // Truncate long messages in context
    const content = msg.content.length > 500 
      ? msg.content.substring(0, 500) + '...' 
      : msg.content;
    lines.push(`${role}: ${content}`);
    lines.push('');
  }

  lines.push('--- End Previous Conversation ---');
  lines.push('');

  return lines.join('\n');
}

/**
 * Extract file paths mentioned in a message
 */
export function extractFilesFromMessage(content: string): string[] {
  const files: string[] = [];
  
  // Match common file patterns
  const patterns = [
    /`([^`]+\.[a-zA-Z]{1,5})`/g,  // Backtick quoted files
    /(['"]?)([\/\\]?[\w\-\.\/\\]+\.[a-zA-Z]{2,5})\1/g,  // Path-like strings
    /\b([\w\-]+\.(ts|tsx|js|jsx|py|rs|go|json|md|css|html))\b/g  // Common extensions
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const file = match[2] || match[1] || match[0];
      if (file && !files.includes(file) && file.length < 100) {
        files.push(file);
      }
    }
  }

  return files;
}

/**
 * Get recent general (non-project) conversation history
 */
export function getGeneralConversations(limit: number = 20): ConversationMessage[] {
  const store = loadMemory();
  // Migrate old stores that don't have generalConversations
  if (!store.generalConversations) {
    store.generalConversations = [];
  }
  // Return the most recent messages (up to limit)
  return store.generalConversations.slice(-limit);
}

/**
 * Add a message to general conversation history
 */
export function addGeneralMessage(
  role: 'user' | 'assistant',
  content: string
): void {
  const store = loadMemory();
  // Migrate old stores that don't have generalConversations
  if (!store.generalConversations) {
    store.generalConversations = [];
  }
  
  const message: ConversationMessage = {
    role,
    content,
    timestamp: new Date().toISOString()
  };
  
  store.generalConversations.push(message);
  
  // Keep only last 100 general messages to prevent unbounded growth
  if (store.generalConversations.length > 100) {
    store.generalConversations = store.generalConversations.slice(-100);
  }
  
  saveMemory();
}

/**
 * Export all conversations as downloadable data
 */
export function exportConversations(format: 'json' | 'markdown' = 'json'): { 
  filename: string; 
  content: string; 
  mimeType: string 
} {
  const store = loadMemory();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  
  if (format === 'markdown') {
    let md = `# Jeeves Conversation Export\n`;
    md += `Exported: ${new Date().toLocaleString()}\n\n`;
    
    // General conversations (non-project)
    const generalConvos = store.generalConversations || [];
    if (generalConvos.length > 0) {
      md += `## General Conversations\n`;
      md += `*Non-project discussions*\n\n`;
      
      for (const msg of generalConvos) {
        const role = msg.role === 'user' ? '**You**' : '**Jeeves**';
        const time = new Date(msg.timestamp).toLocaleString();
        md += `### ${role} (${time})\n\n`;
        md += `${msg.content}\n\n`;
        md += `---\n\n`;
      }
    }
    
    // Project-specific conversations
    for (const [projectPath, project] of Object.entries(store.projects)) {
      md += `## Project: ${project.projectName}\n`;
      md += `Path: \`${projectPath}\`\n`;
      md += `Last accessed: ${project.lastAccessed}\n\n`;
      
      if (project.conversations.length === 0) {
        md += `*No conversations*\n\n`;
        continue;
      }
      
      for (const msg of project.conversations) {
        const role = msg.role === 'user' ? '**You**' : '**Jeeves**';
        const time = new Date(msg.timestamp).toLocaleString();
        md += `### ${role} (${time})\n\n`;
        md += `${msg.content}\n\n`;
        if (msg.filesDiscussed?.length) {
          md += `*Files: ${msg.filesDiscussed.join(', ')}*\n\n`;
        }
        md += `---\n\n`;
      }
    }
    
    return {
      filename: `jeeves-conversations-${timestamp}.md`,
      content: md,
      mimeType: 'text/markdown'
    };
  }
  
  // JSON format
  return {
    filename: `jeeves-conversations-${timestamp}.json`,
    content: JSON.stringify(store, null, 2),
    mimeType: 'application/json'
  };
}

/**
 * Get estimated token count for general conversations
 */
export function getGeneralConversationTokenCount(): number {
  const store = loadMemory();
  const convos = store.generalConversations || [];
  
  // Rough estimate: 4 chars per token
  let totalChars = 0;
  for (const msg of convos) {
    totalChars += msg.content.length;
  }
  
  return Math.ceil(totalChars / 4);
}

/**
 * Check if session compaction is needed
 */
export function needsCompaction(thresholdTokens: number = 50000): boolean {
  return getGeneralConversationTokenCount() >= thresholdTokens;
}

/**
 * Compact general conversations by replacing old messages with a summary
 * This is called after summarization is done externally (to avoid circular deps)
 */
export function compactGeneralConversations(
  summary: string,
  keepRecentCount: number = 10
): { 
  success: boolean; 
  beforeCount: number; 
  afterCount: number;
  tokensBefore: number;
  tokensAfter: number;
} {
  const store = loadMemory();
  
  if (!store.generalConversations) {
    store.generalConversations = [];
  }
  
  const beforeCount = store.generalConversations.length;
  const tokensBefore = getGeneralConversationTokenCount();
  
  if (beforeCount <= keepRecentCount) {
    return {
      success: false,
      beforeCount,
      afterCount: beforeCount,
      tokensBefore,
      tokensAfter: tokensBefore
    };
  }
  
  // Keep the most recent messages
  const recentMessages = store.generalConversations.slice(-keepRecentCount);
  
  // Create a summary message
  const summaryMessage: ConversationMessage = {
    role: 'assistant',
    content: `[CONVERSATION SUMMARY]\n${summary}\n[END SUMMARY]`,
    timestamp: new Date().toISOString()
  };
  
  // Replace conversations with summary + recent
  store.generalConversations = [summaryMessage, ...recentMessages];
  
  saveMemory();
  
  const tokensAfter = getGeneralConversationTokenCount();
  
  logger.info('Compacted general conversations', {
    beforeCount,
    afterCount: store.generalConversations.length,
    tokensBefore,
    tokensAfter,
    savings: `${((tokensBefore - tokensAfter) / tokensBefore * 100).toFixed(1)}%`
  });
  
  return {
    success: true,
    beforeCount,
    afterCount: store.generalConversations.length,
    tokensBefore,
    tokensAfter
  };
}

/**
 * Get messages for summarization (excluding recent ones we want to keep)
 */
export function getMessagesForSummary(keepRecentCount: number = 10): ConversationMessage[] {
  const store = loadMemory();
  const convos = store.generalConversations || [];
  
  if (convos.length <= keepRecentCount) {
    return [];
  }
  
  // Return all messages except the most recent ones
  return convos.slice(0, -keepRecentCount);
}

/**
 * Initialize memory system
 */
export function initMemory(): void {
  if (!config.memory.enabled) {
    logger.info('Memory system disabled');
    return;
  }

  loadMemory();
  logger.info('Memory system initialized');
}
