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
import { 
  getProjectMemory, 
  addMessage, 
  buildContextForAI,
  extractFilesFromMessage,
  getGeneralConversations,
  addGeneralMessage
} from './memory.js';
import { selectModel, type ModelTier } from './model-selector.js';
import { getProjectIndex } from './project-scanner.js';
import { getLastBrowseResult } from './browser.js';

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
    const projectName = projectPath.split(/[\\/]/).pop() || 'unknown';
    
    // Initialize memory for this project
    if (config.memory.enabled) {
      getProjectMemory(projectPath, projectName);
    }
    
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
      message: `AI assistant ready for ${projectName}. Loaded ${contextSize}KB of project context. Send questions with "ask <prompt>"`
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
    // No project loaded - use general mode for conversational questions
    logger.debug('No active session, using general mode');
    return askGeneral(prompt);
  }

  logger.info('Processing AI request', { prompt: prompt.substring(0, 50) });
  activeSession.lastActivity = new Date();

  // Check if this is a request for code changes
  const isEditRequest = /\b(fix|add|update|change|modify|create|remove|delete|refactor|implement|write)\b/i.test(prompt);

  // Build conversation context from memory
  let conversationContext = '';
  if (config.memory.enabled) {
    conversationContext = buildContextForAI(activeSession.workingDir);
    
    // Store user message in memory
    const filesInPrompt = extractFilesFromMessage(prompt);
    addMessage(activeSession.workingDir, 'user', prompt, filesInPrompt);
  }

  try {
    const anthropic = createAnthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });

    const systemPrompt = `You are Jeeves, an AI coding assistant with FULL ACCESS to this project's source code.

## THINKING
Start your response with a brief [Thinking] section (1-3 sentences) explaining your reasoning:
- What you're looking for in the codebase
- What approach you'll take
- Any decisions you're making

Example: "[Thinking] Looking for authentication-related files. Found auth.ts and middleware.ts. Will modify the middleware to add the new check."

## RULES
1. You have ALL the project files loaded below - SEARCH THEM before asking for clarification
2. When the user mentions something vague like "the scan function", search the code for matches
3. If you find multiple matches, pick the most likely one based on context OR list the options
4. NEVER say "I don't have access" - you DO have access, the files are below
5. Be proactive - if asked to modify "the auth code", find auth-related files and suggest changes
6. Use the previous conversation context to understand references like "that file" or "what we discussed"

${isEditRequest ? `
## CODE CHANGES
Format edits using ONE of these formats:

### Format 1: ORIGINAL/MODIFIED (for precise replacements)
\`\`\`edit:relative/path/to/file.ts
<<<<<<< ORIGINAL
// paste the exact original code here
=======
// paste the modified code here
>>>>>>> MODIFIED
\`\`\`

### Format 2: Partial Edit (for quick changes)
\`\`\`edit:relative/path/to/file.ts
// ... existing code ...
const newFunction = () => {
  // <CHANGE> Added new authentication check
  return authenticated;
}
// ... existing code ...
\`\`\`

Rules:
- Use relative paths from project root (e.g., lib/scanners/ssl.ts)
- Include 3-5 lines of context around changes
- Add <CHANGE> comments to explain non-obvious edits
- You can include multiple edit blocks for multiple files
` : ''}

## DESIGN GUIDELINES (when working on frontend)
- Use 3-5 colors max: 1 primary + 2-3 neutrals + 1-2 accents
- Max 2 font families (headings + body)
- Mobile-first, then enhance for larger screens
- Use semantic HTML and proper ARIA attributes
- Prefer Tailwind spacing scale over arbitrary values

Be concise. Reference specific file paths. Don't ask for clarification if you can infer from context.

PROJECT: ${activeSession.workingDir.split(/[\\/]/).pop()}
PROJECT ROOT: ${activeSession.workingDir}

${conversationContext}
=== PROJECT FILES ===
${activeSession.projectContext}
=== END FILES ===`;

    // Smart model selection - code editing gets at least Sonnet
    const selectedModel = selectModel(prompt);
    // For edit requests, always use at least Sonnet (not Haiku)
    const modelToUse = isEditRequest && selectedModel.tier === 'haiku' 
      ? 'claude-sonnet-4-20250514' 
      : selectedModel.modelId;
    
    logger.info('Model selected for project work', { 
      tier: selectedModel.tier, 
      actualModel: modelToUse,
      isEditRequest 
    });

    const { text } = await generateText({
      model: anthropic(modelToUse),
      system: systemPrompt,
      prompt: prompt,
      maxTokens: config.claude.max_tokens
    });

    logger.info('AI response received', { 
      length: text.length, 
      isEditRequest,
      hasEditMarkers: text.includes('<<<') || text.includes('ORIGINAL')
    });

    // Store assistant response in memory
    if (config.memory.enabled) {
      const filesInResponse = extractFilesFromMessage(text);
      addMessage(activeSession.workingDir, 'assistant', text, filesInResponse);
    }

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
 * Supports multiple formats:
 * 1. ORIGINAL/MODIFIED markers (full replacement)
 * 2. // ... existing code ... markers (partial edit, v0-style)
 * 3. Simple file path + code block
 */
function parseEditBlocks(text: string, workingDir: string): FileChange[] {
  const changes: FileChange[] = [];
  
  // Format 1: ```edit:filepath with ORIGINAL/MODIFIED markers (full replacement)
  const editBlockRegex1 = /```edit:([^\n]+)\n<<<<<<<?[^\n]*\n([\s\S]*?)\n======*\n([\s\S]*?)\n>>>>>>>[^\n]*\n```/gi;
  
  // Format 2: ```edit:filepath with // ... existing code ... markers (partial edit)
  const editBlockRegex2 = /```(?:edit:|lang\s+file=["']?)([^\n"']+)["']?\n([\s\S]*?)```/gi;
  
  // Format 3: Just look for ORIGINAL/MODIFIED blocks anywhere
  const editBlockRegex3 = /(?:file|path)?:?\s*`?([^\n`]+\.[a-z]+)`?\n*```[a-z]*\n*<<<<<<<?[^\n]*\n([\s\S]*?)\n======*\n([\s\S]*?)\n>>>>>>>[^\n]*\n*```/gi;
  
  let match;
  
  // Try format 1 (ORIGINAL/MODIFIED)
  while ((match = editBlockRegex1.exec(text)) !== null) {
    const filePath = join(workingDir, match[1].trim());
    logger.info('Parsed edit block (ORIGINAL/MODIFIED)', { file: match[1].trim() });
    changes.push({
      filePath,
      originalContent: match[2].trim(),
      newContent: match[3].trim(),
      description: `Update ${match[1].trim()}`
    });
  }
  
  // Try format 2 (partial edit with ... existing code ...)
  if (changes.length === 0) {
    while ((match = editBlockRegex2.exec(text)) !== null) {
      const filePath = join(workingDir, match[1].trim());
      const content = match[2];
      
      // Check if this uses the ... existing code ... pattern
      if (content.includes('... existing code ...') || content.includes('// ...')) {
        logger.info('Parsed edit block (partial)', { file: match[1].trim() });
        changes.push({
          filePath,
          originalContent: null,  // null indicates partial edit
          newContent: content.trim(),
          description: `Partial update ${match[1].trim()}`
        });
      } else {
        // Full file replacement
        logger.info('Parsed edit block (full file)', { file: match[1].trim() });
        changes.push({
          filePath,
          originalContent: null,
          newContent: content.trim(),
          description: `Update ${match[1].trim()}`
        });
      }
    }
  }
  
  // Try format 3 if still nothing found
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
  
  logger.info('Parsed edit blocks', { 
    count: changes.length, 
    hasEditMarkers: text.includes('ORIGINAL') || text.includes('=======') || text.includes('existing code')
  });
  
  return changes;
}

/**
 * Apply partial edit by expanding ... existing code ... markers
 */
async function applyPartialEdit(filePath: string, editContent: string): Promise<string> {
  // Read original file
  const original = await readFile(filePath, 'utf-8');
  const originalLines = original.split('\n');
  const editLines = editContent.split('\n');
  
  // Find the non-placeholder lines in the edit
  const editParts: { type: 'keep' | 'change'; content: string[] }[] = [];
  let currentPart: { type: 'keep' | 'change'; content: string[] } = { type: 'change', content: [] };
  
  for (const line of editLines) {
    if (line.includes('... existing code ...') || line.trim() === '// ...') {
      if (currentPart.content.length > 0) {
        editParts.push(currentPart);
      }
      editParts.push({ type: 'keep', content: [] });
      currentPart = { type: 'change', content: [] };
    } else {
      currentPart.content.push(line);
    }
  }
  if (currentPart.content.length > 0) {
    editParts.push(currentPart);
  }
  
  // Find anchor points in original file to locate where changes go
  let result = original;
  
  for (let i = 0; i < editParts.length; i++) {
    const part = editParts[i];
    if (part.type === 'change' && part.content.length > 0) {
      // Find first line of change in original
      const firstLine = part.content[0].trim();
      const lastLine = part.content[part.content.length - 1].trim();
      
      // Try to find matching section in original
      let startIdx = -1;
      let endIdx = -1;
      
      for (let j = 0; j < originalLines.length; j++) {
        if (originalLines[j].trim().includes(firstLine.substring(0, Math.min(30, firstLine.length)))) {
          startIdx = j;
          break;
        }
      }
      
      if (startIdx >= 0) {
        // Find end by matching last line
        for (let j = startIdx; j < originalLines.length; j++) {
          if (originalLines[j].trim().includes(lastLine.substring(0, Math.min(30, lastLine.length)))) {
            endIdx = j;
            break;
          }
        }
        
        if (endIdx >= 0) {
          // Replace the section
          const before = originalLines.slice(0, startIdx);
          const after = originalLines.slice(endIdx + 1);
          result = [...before, ...part.content, ...after].join('\n');
        }
      }
    }
  }
  
  return result;
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
      
      let newContent: string;
      
      // Check if this is a partial edit (uses ... existing code ... markers)
      if (change.newContent.includes('... existing code ...') || change.newContent.includes('// ...')) {
        // Apply partial edit
        newContent = await applyPartialEdit(change.filePath, change.newContent);
        logger.info('Applied partial edit', { file: change.filePath });
      } else if (change.originalContent && currentContent.includes(change.originalContent)) {
        // Standard ORIGINAL/MODIFIED replacement
        newContent = currentContent.replace(change.originalContent, change.newContent);
      } else {
        // Full file replacement
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

/**
 * Answer general questions without needing a project session
 * Used for questions about Jeeves itself, trust system, capabilities, etc.
 */
export async function askGeneral(prompt: string): Promise<string> {
  logger.debug('Processing general question', { prompt: prompt.substring(0, 50) });

  // Import trust info and personality for context
  const { getTrustState, getPersonalityContext } = await import('./trust.js');
  const trustState = getTrustState();
  const personalityContext = getPersonalityContext();
  
  // Get available projects for context
  const projectIndex = getProjectIndex();
  const projectList = Array.from(projectIndex.projects.entries())
    .map(([name, p]) => `- ${name} (${p.type}): ${p.path}`)
    .join('\n');
  
  // Get last browse result for web context
  const lastBrowse = getLastBrowseResult();
  logger.info('askGeneral: Checking browse context', { 
    hasBrowseResult: !!lastBrowse,
    success: lastBrowse?.success,
    url: lastBrowse?.url,
    hasScreenshot: !!lastBrowse?.screenshotBase64
  });
  let browseContext = '';
  let browseScreenshot: string | undefined;
  if (lastBrowse && lastBrowse.success) {
    browseContext = `\n## LAST WEB PAGE VIEWED
URL: ${lastBrowse.url}
Title: ${lastBrowse.title || 'Unknown'}
Content:
${lastBrowse.content || '[No content]'}
`;
    browseScreenshot = lastBrowse.screenshotBase64;
    logger.info('askGeneral: Added browse context', { 
      length: browseContext.length,
      hasScreenshot: !!browseScreenshot
    });
  }
  
  // Build trust context with null safety
  const trustLevel = trustState?.currentLevel ?? 2;
  const trustNames = ['supervised', 'semi-autonomous', 'trusted', 'autonomous', 'full-trust'];
  const trustName = trustNames[trustLevel - 1] || 'semi-autonomous';
  const successfulTasks = trustState?.successfulTasksAtLevel ?? 0;
  const levelStartDate = trustState?.levelStartDate ? new Date(trustState.levelStartDate) : new Date();
  const daysAtLevel = Math.floor((Date.now() - levelStartDate.getTime()) / (1000 * 60 * 60 * 24));
  const totalTasks = trustState?.taskHistory?.length ?? 0;
  
  const systemPrompt = `You are Jeeves, an AI employee (not just an assistant - you work for the user).

## ABOUT YOURSELF
- You are Jeeves, a general-purpose AI employee
- You handle coding, but also sysadmin, DevOps, home server management, and technical tasks
- You run locally on the user's machine and can execute commands, manage services, edit configs
- You use Claude (Anthropic) as your brain via the Anthropic SDK
- Unlike a chatbot, you take action: run commands, edit files, manage systems, solve problems

## TRUST SYSTEM
You operate under a 5-level trust system:
- Level 1 (Supervised): Checkpoints on every action, no commits, no spending
- Level 2 (Semi-Autonomous): Per-phase checkpoints, limited autonomy
- Level 3 (Trusted): Can commit with review, $10/task spend limit  
- Level 4 (Autonomous): Free commits, $25/task limit, summary checkpoints
- Level 5 (Full-Trust): Full autonomy, external contact allowed

Current trust level: ${trustLevel} (${trustName})
Successful tasks at this level: ${successfulTasks}
Days at level: ${daysAtLevel}
Total tasks completed: ${totalTasks}

Trust is earned by successfully completing tasks. After 10 successful tasks and 7 days at a level, you may be eligible for upgrade.

## WHY LEVEL 2?
All users start at Level 2 (Semi-Autonomous) because:
1. It provides a good balance of autonomy and safety
2. Level 1 (Supervised) would require confirmation on literally every action, which is tedious
3. You haven't done anything wrong to lose trust
4. But you also haven't proven yourself yet for higher trust

## CAPABILITIES

**Coding & Development:**
- Load project context and understand codebases
- Make code changes (propose edits, user reviews in diff view)
- Run dev commands (npm, git, etc.)
- Execute PRDs autonomously - build features from specs
- GitHub Actions, CI/CD pipelines

**System Administration:**
- Linux server setup and management
- Docker container configuration and troubleshooting
- Service management (systemd, etc.)
- Nginx / Traefik reverse proxy
- SSL certs (Let's Encrypt, Certbot)
- Cron jobs and automation

**Media & Entertainment:**
- Plex server setup and management
- *arr stack (Sonarr, Radarr, Prowlarr, Lidarr, Bazarr)
- Jellyfin / Emby
- Tautulli, Overseerr/Ombi

**Self-Hosted Services:**
- Nextcloud (files, calendar, contacts)
- Home Assistant / home automation
- Pi-hole / AdGuard DNS blocking
- Vaultwarden (Bitwarden self-hosted)
- Paperless-ngx for documents
- Portainer for Docker management

**Networking & Security:**
- Tailscale / WireGuard VPN
- Cloudflare tunnel / DNS
- Firewall rules (UFW, iptables)
- Fail2ban, SSH hardening
- Log analysis

**Infrastructure & DevOps:**
- Terraform / Ansible
- Kubernetes (k3s for home lab)
- AWS / DigitalOcean / Linode
- Uptime Kuma / Grafana / Prometheus monitoring
- Backup automation (Restic, Borg, rsync)

**Databases:**
- PostgreSQL / MySQL administration
- Redis
- Backups and migrations

**Hardware:**
- Raspberry Pi projects
- NAS management (Unraid, TrueNAS)
- UPS monitoring (NUT)

**Web Browsing:**
- Browse websites securely (say "browse <url>")
- Take screenshots of web pages (say "screenshot <url>")
- Click and type on web pages for testing
- Content is sanitized against prompt injection attacks
- Visual feedback while coding: spin up dev servers and see changes

**General:**
- Answer technical questions on any topic
- Remember conversations and learn your preferences
- Research solutions and provide step-by-step guidance
- Earn more autonomy through successful work

## AVAILABLE PROJECTS
You have access to these local projects (say "open <name>" to load full context):
${projectList || 'No projects discovered yet.'}

To work on a project's code, ask the user to say "open <project name>" to load the full codebase context.
You can still discuss projects generally without loading them.

## EMPLOYEE MINDSET
- You work FOR the user, not just chat with them
- You're a generalist - coding, sysadmin, DevOps, home server, whatever's needed
- Take initiative when appropriate to your trust level
- Be direct and professional, not sycophantic
- If a task requires terminal access or file editing, mention what you'd need to do it
${personalityContext ? `\n## USER'S PREFERENCES FOR YOU\n${personalityContext}` : ''}
${browseContext}
Answer the user's question directly.`;

  try {
    // Smart model selection based on prompt complexity
    const selectedModel = selectModel(prompt);
    logger.debug('Model selected for general question', { 
      tier: selectedModel.tier, 
      model: selectedModel.modelId 
    });

    // Load recent conversation history for context
    const recentHistory = getGeneralConversations(20);
    
    // Build messages array with history
    // Using any to allow for vision message format
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const messages: Array<any> = [];
    
    for (const msg of recentHistory) {
      messages.push({
        role: msg.role,
        content: msg.content
      });
    }
    
    // Add current user message - include screenshot if available
    if (browseScreenshot) {
      logger.info('Including screenshot in AI request');
      messages.push({
        role: 'user',
        content: [
          {
            type: 'text',
            text: `${prompt}\n\n[A screenshot of the webpage is attached for visual analysis]`
          },
          {
            type: 'image',
            image: `data:image/png;base64,${browseScreenshot}`
          }
        ]
      });
    } else {
      messages.push({
        role: 'user',
        content: prompt
      });
    }
    
    logger.debug('General conversation context', { 
      historyMessages: recentHistory.length,
      totalMessages: messages.length,
      hasScreenshot: !!browseScreenshot
    });

    const anthropic = createAnthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });

    const { text } = await generateText({
      model: anthropic(selectedModel.modelId),
      system: systemPrompt,
      messages: messages,
      maxTokens: 2000  // Increase for vision responses
    });

    // Save conversation to memory
    addGeneralMessage('user', prompt);
    addGeneralMessage('assistant', text);

    return text;
  } catch (error) {
    logger.error('General question failed', { error: String(error) });
    return `Sorry, I encountered an error: ${error instanceof Error ? error.message : 'Unknown error'}`;
  }
}

// Re-export FileChange type for external use
export type { FileChange };
