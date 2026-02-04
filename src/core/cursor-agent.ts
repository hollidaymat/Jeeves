/**
 * AI Assistant Integration
 * Uses Claude to provide AI-powered project assistance
 * since `cursor agent` requires interactive terminal
 */

import { generateText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { readdir, readFile, stat, writeFile } from 'fs/promises';
import { join, extname } from 'path';
import { existsSync } from 'fs';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

interface FileChange {
  filePath: string;
  originalContent: string | null;  // null for new files
  newContent: string;
  description: string;
}

interface AgentSession {
  workingDir: string;
  startedAt: Date;
  lastActivity: Date;
  projectContext: string;
  pendingChanges: FileChange[];
}

// Active session
let activeSession: AgentSession | null = null;

// File extensions to include in context
const CODE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.md', '.json', '.sql', '.css', '.html'];
const MAX_FILE_SIZE = 50000;  // 50KB max per file
const MAX_TOTAL_CONTEXT = 100000;  // 100KB max total context

/**
 * Scan project directory for context
 */
async function scanProjectContext(projectPath: string): Promise<string> {
  const contextParts: string[] = [];
  let totalSize = 0;

  async function scanDir(dir: string, depth: number = 0): Promise<void> {
    if (depth > 3 || totalSize > MAX_TOTAL_CONTEXT) return;

    try {
      const entries = await readdir(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        if (totalSize > MAX_TOTAL_CONTEXT) break;
        
        const fullPath = join(dir, entry.name);
        const relativePath = fullPath.replace(projectPath, '').replace(/\\/g, '/');

        // Skip node_modules, .git, dist, etc
        if (entry.isDirectory()) {
          if (['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv'].includes(entry.name)) {
            continue;
          }
          await scanDir(fullPath, depth + 1);
        } else if (entry.isFile()) {
          const ext = extname(entry.name).toLowerCase();
          if (!CODE_EXTENSIONS.includes(ext)) continue;
          
          try {
            const stats = await stat(fullPath);
            if (stats.size > MAX_FILE_SIZE) {
              contextParts.push(`\n### ${relativePath} (${stats.size} bytes - too large, skipped)\n`);
              continue;
            }

            const content = await readFile(fullPath, 'utf-8');
            const fileContext = `\n### ${relativePath}\n\`\`\`${ext.slice(1)}\n${content}\n\`\`\`\n`;
            
            if (totalSize + fileContext.length < MAX_TOTAL_CONTEXT) {
              contextParts.push(fileContext);
              totalSize += fileContext.length;
            }
          } catch (e) {
            // Skip unreadable files
          }
        }
      }
    } catch (e) {
      // Skip unreadable directories
    }
  }

  // First, add key files
  const keyFiles = ['package.json', 'README.md', 'tsconfig.json', 'Cargo.toml', 'go.mod', 'requirements.txt'];
  for (const keyFile of keyFiles) {
    try {
      const content = await readFile(join(projectPath, keyFile), 'utf-8');
      const fileContext = `\n### ${keyFile}\n\`\`\`json\n${content}\n\`\`\`\n`;
      contextParts.push(fileContext);
      totalSize += fileContext.length;
    } catch (e) {
      // File doesn't exist
    }
  }

  // Then scan directories
  await scanDir(projectPath);

  return contextParts.join('');
}

/**
 * Start an AI assistant session for a project
 */
export async function startAgentSession(projectPath: string): Promise<{ success: boolean; message: string }> {
  logger.info('Starting AI assistant session', { projectPath });

  try {
    // Scan project for context
    const projectContext = await scanProjectContext(projectPath);
    
    activeSession = {
      workingDir: projectPath,
      startedAt: new Date(),
      lastActivity: new Date(),
      projectContext,
      pendingChanges: []
    };

    const contextSize = Math.round(projectContext.length / 1024);
    logger.info('AI session ready', { contextSize: `${contextSize}KB` });

    return {
      success: true,
      message: `AI assistant ready for ${projectPath.split(/[\\/]/).pop()}. Loaded ${contextSize}KB of project context. Send questions with "ask <prompt>"`
    };
  } catch (error) {
    logger.error('Failed to start AI session', { error: String(error) });
    return {
      success: false,
      message: `Failed to start AI session: ${error instanceof Error ? error.message : 'Unknown error'}`
    };
  }
}

/**
 * Send a prompt to the AI assistant
 */
export async function sendToAgent(prompt: string): Promise<string> {
  if (!activeSession) {
    return 'No active AI session. Say "analyze <project>" or "open <project>" first.';
  }

  logger.info('Processing AI request', { prompt: prompt.substring(0, 50) });
  activeSession.lastActivity = new Date();

  // Check if this is a request for code changes
  const isEditRequest = /\b(fix|add|update|change|modify|create|remove|delete|refactor|implement|write)\b/i.test(prompt);

  try {
    const anthropic = createAnthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });

    const systemPrompt = `You are an AI coding assistant with FULL ACCESS to this project's source code.

IMPORTANT RULES:
1. You have ALL the project files loaded below - SEARCH THEM before asking for clarification
2. When the user mentions something vague like "the scan function", search the code for matches
3. If you find multiple matches, pick the most likely one based on context OR list the options
4. NEVER say "I don't have access" - you DO have access, the files are below
5. Be proactive - if asked to modify "the auth code", find auth-related files and suggest changes

${isEditRequest ? `
WHEN MAKING CHANGES - Format edits like this:

\`\`\`edit:relative/path/to/file.ts
<<<<<<< ORIGINAL
// paste the exact original code here (include enough context to be unique)
=======
// paste the modified code here
>>>>>>> MODIFIED
\`\`\`

Rules for edits:
- Use relative paths from project root (e.g., lib/scanners/ssl.ts not full paths)
- Include 3-5 lines of context around the change so it can be matched
- You can include multiple edit blocks for multiple files
- The ORIGINAL section must match the file EXACTLY (including whitespace)
` : ''}

Be concise. When discussing code, reference specific file paths. Don't ask for clarification if you can reasonably infer from context.

PROJECT: ${activeSession.workingDir.split(/[\\/]/).pop()}
PROJECT ROOT: ${activeSession.workingDir}

=== PROJECT FILES ===
${activeSession.projectContext}
=== END FILES ===`;

    const { text } = await generateText({
      model: anthropic(config.claude.model),
      system: systemPrompt,
      prompt: prompt,
      maxTokens: config.claude.max_tokens
    });

    logger.info('AI response received', { 
      length: text.length, 
      isEditRequest,
      hasEditMarkers: text.includes('<<<') || text.includes('ORIGINAL')
    });

    // Parse any edit blocks from the response
    if (isEditRequest) {
      const changes = parseEditBlocks(text, activeSession.workingDir);
      if (changes.length > 0) {
        activeSession.pendingChanges = changes;
        logger.info('Pending changes set', { count: changes.length });
        return text + `\n\n---\n**${changes.length} file(s) ready to modify.** Say "apply" to apply changes, "reject" to discard, or "show diff" to review.`;
      } else {
        logger.info('No edit blocks found in response');
      }
    }

    return text;
  } catch (error) {
    logger.error('AI request failed', { error: String(error) });
    return `AI error: ${error instanceof Error ? error.message : 'Unknown error'}`;
  }
}

/**
 * Parse edit blocks from AI response
 * Supports multiple formats that Claude might use
 */
function parseEditBlocks(text: string, workingDir: string): FileChange[] {
  const changes: FileChange[] = [];
  
  // Format 1: ```edit:filepath with ORIGINAL/MODIFIED markers
  const editBlockRegex1 = /```edit:([^\n]+)\n<<<<<<<?[^\n]*\n([\s\S]*?)\n======*\n([\s\S]*?)\n>>>>>>>[^\n]*\n```/gi;
  
  // Format 2: ```diff or ```typescript with file path in comment
  const editBlockRegex2 = /```(?:diff|typescript|javascript|ts|js)\n\/\/\s*(?:File:|Path:)?\s*([^\n]+)\n([\s\S]*?)```/gi;
  
  // Format 3: Just look for ORIGINAL/MODIFIED blocks anywhere
  const editBlockRegex3 = /(?:file|path)?:?\s*`?([^\n`]+\.[a-z]+)`?\n*```[a-z]*\n*<<<<<<<?[^\n]*\n([\s\S]*?)\n======*\n([\s\S]*?)\n>>>>>>>[^\n]*\n*```/gi;
  
  let match;
  
  // Try format 1
  while ((match = editBlockRegex1.exec(text)) !== null) {
    const filePath = join(workingDir, match[1].trim());
    logger.info('Parsed edit block (format 1)', { file: match[1].trim() });
    changes.push({
      filePath,
      originalContent: match[2].trim(),
      newContent: match[3].trim(),
      description: `Update ${match[1].trim()}`
    });
  }
  
  // Try format 3 if format 1 found nothing
  if (changes.length === 0) {
    while ((match = editBlockRegex3.exec(text)) !== null) {
      const filePath = join(workingDir, match[1].trim());
      logger.info('Parsed edit block (format 3)', { file: match[1].trim() });
      changes.push({
        filePath,
        originalContent: match[2].trim(),
        newContent: match[3].trim(),
        description: `Update ${match[1].trim()}`
      });
    }
  }
  
  logger.info('Parsed edit blocks', { count: changes.length, hasEditMarkers: text.includes('ORIGINAL') || text.includes('=======') });
  
  return changes;
}

/**
 * Apply pending changes
 */
export async function applyChanges(): Promise<{ success: boolean; message: string }> {
  if (!activeSession) {
    return { success: false, message: 'No active AI session' };
  }
  
  if (activeSession.pendingChanges.length === 0) {
    return { success: false, message: 'No pending changes to apply' };
  }
  
  const results: string[] = [];
  
  for (const change of activeSession.pendingChanges) {
    try {
      // Read current file content
      let currentContent = '';
      if (existsSync(change.filePath)) {
        currentContent = await readFile(change.filePath, 'utf-8');
      }
      
      // If original content was specified, do a replace; otherwise write the whole file
      let newContent: string;
      if (change.originalContent && currentContent.includes(change.originalContent)) {
        newContent = currentContent.replace(change.originalContent, change.newContent);
      } else {
        newContent = change.newContent;
      }
      
      await writeFile(change.filePath, newContent, 'utf-8');
      results.push(`✓ ${change.description}`);
      logger.info('Applied change', { file: change.filePath });
      
    } catch (error) {
      results.push(`✗ Failed: ${change.description} - ${error instanceof Error ? error.message : 'Unknown error'}`);
      logger.error('Failed to apply change', { file: change.filePath, error: String(error) });
    }
  }
  
  // Clear pending changes
  activeSession.pendingChanges = [];
  
  // Refresh project context
  activeSession.projectContext = await scanProjectContext(activeSession.workingDir);
  
  return {
    success: true,
    message: `Applied changes:\n${results.join('\n')}`
  };
}

/**
 * Reject pending changes
 */
export function rejectChanges(): { success: boolean; message: string } {
  if (!activeSession) {
    return { success: false, message: 'No active AI session' };
  }
  
  const count = activeSession.pendingChanges.length;
  activeSession.pendingChanges = [];
  
  return {
    success: true,
    message: count > 0 ? `Discarded ${count} pending change(s)` : 'No pending changes to discard'
  };
}

/**
 * Show pending changes diff
 */
export function showDiff(): string {
  if (!activeSession) {
    return 'No active AI session';
  }
  
  if (activeSession.pendingChanges.length === 0) {
    return 'No pending changes';
  }
  
  const diffs: string[] = ['## Pending Changes\n'];
  
  for (const change of activeSession.pendingChanges) {
    const relativePath = change.filePath.replace(activeSession.workingDir, '').replace(/\\/g, '/');
    diffs.push(`### ${relativePath}\n`);
    diffs.push('```diff');
    
    if (change.originalContent) {
      const origLines = change.originalContent.split('\n');
      const newLines = change.newContent.split('\n');
      
      origLines.forEach(line => diffs.push(`- ${line}`));
      newLines.forEach(line => diffs.push(`+ ${line}`));
    } else {
      diffs.push(`+ ${change.newContent}`);
    }
    
    diffs.push('```\n');
  }
  
  diffs.push('\nSay "apply" to apply or "reject" to discard.');
  
  return diffs.join('\n');
}

/**
 * Stop the AI session
 */
export async function stopAgentSession(): Promise<{ success: boolean; message: string }> {
  if (!activeSession) {
    return { success: true, message: 'No active AI session' };
  }

  logger.info('Stopping AI session');
  activeSession = null;
  
  return { success: true, message: 'AI session ended' };
}

/**
 * Get status of the AI session
 */
export function getAgentStatus(): { active: boolean; workingDir?: string; uptime?: number; contextSize?: number } {
  if (!activeSession) {
    return { active: false };
  }

  const uptime = Math.floor((Date.now() - activeSession.startedAt.getTime()) / 1000);
  
  return {
    active: true,
    workingDir: activeSession.workingDir,
    uptime,
    contextSize: Math.round(activeSession.projectContext.length / 1024)
  };
}

/**
 * Check if AI is available
 */
export function isAgentAvailable(): boolean {
  return activeSession !== null;
}

/**
 * Get pending changes for UI display
 */
export function getPendingChanges(): FileChange[] {
  return activeSession?.pendingChanges || [];
}

// Re-export FileChange type for external use
export type { FileChange };
