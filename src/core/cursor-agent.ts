/**
 * AI Assistant Integration
 * Uses Claude to provide AI-powered project assistance
 * since `cursor agent` requires interactive terminal
 */

import { generateText, streamText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';

// Streaming callback for real-time updates
type StreamCallback = (chunk: string) => void;
let activeStreamCallback: StreamCallback | null = null;

export function setStreamCallback(callback: StreamCallback | null): void {
  activeStreamCallback = callback;
}
import { readdir, readFile, stat, writeFile, copyFile, rename, mkdir, unlink } from 'fs/promises';
import { join, extname, basename, dirname } from 'path';
import { existsSync, mkdirSync } from 'fs';
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
import { trackLLMUsage } from './cost-tracker.js';
import type { ImageAttachment } from '../types/index.js';
import { buildSkillsSummary, getSkillContext, loadAllSkills } from './skill-loader.js';

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

// Forced model override (user can say "use haiku" etc.)
let forcedModel: ModelTier | null = null;

// Preload skills on module initialization
loadAllSkills().catch(err => logger.debug('Skills preload deferred', { error: String(err) }));

/**
 * Set the forced model tier (or null to use auto-selection)
 */
export function setForcedModel(tier: ModelTier | null): void {
  forcedModel = tier;
  if (tier) {
    logger.info(`Model locked to ${tier.toUpperCase()}`);
  } else {
    logger.info('Model selection set to AUTO');
  }
}

/**
 * Get current forced model (null = auto)
 */
export function getForcedModel(): ModelTier | null {
  return forcedModel;
}

// ==========================================
// PROMPT CACHING INFRASTRUCTURE
// ==========================================

// Cache heartbeat interval (4.5 minutes - cache expires at 5 minutes)
const CACHE_HEARTBEAT_INTERVAL_MS = 4.5 * 60 * 1000;
let cacheHeartbeatTimer: NodeJS.Timeout | null = null;
let lastCacheWarmTime: Date | null = null;

// Track cache statistics
interface CacheStats {
  hits: number;
  misses: number;
  lastHit: Date | null;
}

const cacheStats: CacheStats = {
  hits: 0,
  misses: 0,
  lastHit: null
};

/**
 * Get cache hit rate
 */
export function getCacheHitRate(): number {
  const total = cacheStats.hits + cacheStats.misses;
  return total > 0 ? (cacheStats.hits / total) * 100 : 0;
}

/**
 * Record a cache hit or miss
 */
export function recordCacheResult(hit: boolean): void {
  if (hit) {
    cacheStats.hits++;
    cacheStats.lastHit = new Date();
  } else {
    cacheStats.misses++;
  }
}

/**
 * Start cache heartbeat to keep system prompt cached
 * Sends a minimal request every 4.5 minutes to prevent cache expiration
 */
export function startCacheHeartbeat(): void {
  if (cacheHeartbeatTimer) return; // Already running
  
  logger.info('Starting cache heartbeat (4.5 min interval)');
  
  cacheHeartbeatTimer = setInterval(async () => {
    try {
      // Send minimal request to keep cache warm
      // This is a low-cost way to maintain the cache
      const anthropic = createAnthropic({
        apiKey: process.env.ANTHROPIC_API_KEY
      });
      
      // Minimal request - just ping with system prompt
      await generateText({
        model: anthropic('claude-3-5-haiku-20241022'),
        system: 'You are Jeeves, a helpful assistant.', // Minimal cached prompt
        prompt: 'ping',
        maxTokens: 1
      });
      
      lastCacheWarmTime = new Date();
      logger.debug('Cache heartbeat sent');
    } catch (error) {
      logger.warn('Cache heartbeat failed', { error: String(error) });
    }
  }, CACHE_HEARTBEAT_INTERVAL_MS);
}

/**
 * Stop cache heartbeat
 */
export function stopCacheHeartbeat(): void {
  if (cacheHeartbeatTimer) {
    clearInterval(cacheHeartbeatTimer);
    cacheHeartbeatTimer = null;
    logger.info('Cache heartbeat stopped');
  }
}

/**
 * Get cache status
 */
export function getCacheStatus(): { 
  heartbeatActive: boolean; 
  lastWarm: Date | null; 
  hitRate: number;
  stats: CacheStats;
} {
  return {
    heartbeatActive: cacheHeartbeatTimer !== null,
    lastWarm: lastCacheWarmTime,
    hitRate: getCacheHitRate(),
    stats: { ...cacheStats }
  };
}

/**
 * Get active project session (if any)
 */
export function getActiveProject(): AgentSession | null {
  return activeSession;
}

// Re-export plan state functions
import {
  getPendingPlan,
  setPendingPlan,
  clearPendingPlan,
  getLastExecutionResults,
  setExecutionResults
} from './plan-state.js';

export { getPendingPlan, clearPendingPlan, getLastExecutionResults };

// ============================================================================
// FILE SAFETY SYSTEM
// Prevents file truncation and corruption with backup, validation, and atomic writes
// ============================================================================

interface SafeWriteResult {
  success: boolean;
  error?: string;
  backupPath?: string;
  warnings?: string[];
}

/**
 * Get the backup directory for a project
 */
function getBackupDir(projectPath: string): string {
  return join(projectPath, '.jeeves-backup');
}

/**
 * Validate content for obvious truncation/corruption
 */
function validateContent(content: string, filePath: string): { valid: boolean; warning?: string } {
  const ext = extname(filePath).toLowerCase();
  
  // Skip validation for small files or non-code files
  if (content.length < 100) {
    return { valid: true };
  }
  
  // Check balanced braces for JS/TS/CSS/JSON
  if (['.ts', '.tsx', '.js', '.jsx', '.css', '.scss', '.json'].includes(ext)) {
    const opens = (content.match(/\{/g) || []).length;
    const closes = (content.match(/\}/g) || []).length;
    if (Math.abs(opens - closes) > 2) {  // Allow small imbalance for template literals
      return { valid: false, warning: `Unbalanced braces: ${opens} opens, ${closes} closes - possible truncation` };
    }
  }
  
  // Check for files that end abruptly (no trailing newline and ends with partial content)
  if (!content.endsWith('\n') && content.length > 500) {
    // Check if it ends mid-statement
    const lastChars = content.slice(-20);
    if (lastChars.match(/[a-zA-Z0-9_]$/)) {  // Ends with identifier character
      return { valid: false, warning: 'File appears truncated (ends mid-identifier)' };
    }
  }
  
  return { valid: true };
}

/**
 * Check if file shrinkage exceeds safety threshold
 */
async function checkShrinkage(filePath: string, newContent: string): Promise<{ safe: boolean; shrinkage: number; warning?: string }> {
  if (!existsSync(filePath)) {
    return { safe: true, shrinkage: 0 };
  }
  
  try {
    const stats = await stat(filePath);
    const originalSize = stats.size;
    const newSize = Buffer.byteLength(newContent, 'utf-8');
    
    if (originalSize === 0) {
      return { safe: true, shrinkage: 0 };
    }
    
    const shrinkage = (originalSize - newSize) / originalSize;
    const maxShrinkage = config.safety.maxShrinkagePercent / 100;
    
    // Only flag if original file was substantial (>500 bytes) and shrinkage is significant
    if (shrinkage > maxShrinkage && originalSize > 500) {
      return { 
        safe: false, 
        shrinkage: Math.round(shrinkage * 100),
        warning: `File would shrink by ${Math.round(shrinkage * 100)}% (${originalSize} → ${newSize} bytes) - possible truncation`
      };
    }
    
    return { safe: true, shrinkage: Math.round(shrinkage * 100) };
  } catch {
    return { safe: true, shrinkage: 0 };
  }
}

/**
 * Create a backup of a file before modification
 */
async function createBackup(filePath: string, projectPath: string): Promise<string | null> {
  if (!config.safety.backupEnabled || !existsSync(filePath)) {
    return null;
  }
  
  try {
    const backupDir = getBackupDir(projectPath);
    if (!existsSync(backupDir)) {
      await mkdir(backupDir, { recursive: true });
    }
    
    const fileName = basename(filePath);
    const timestamp = Date.now();
    const backupPath = join(backupDir, `${fileName}.${timestamp}.bak`);
    
    await copyFile(filePath, backupPath);
    logger.debug('Created backup', { original: filePath, backup: backupPath });
    
    return backupPath;
  } catch (error) {
    logger.warn('Failed to create backup', { filePath, error: String(error) });
    return null;
  }
}

/**
 * Clean up old backups (older than retention period)
 */
async function cleanupOldBackups(projectPath: string): Promise<number> {
  const backupDir = getBackupDir(projectPath);
  if (!existsSync(backupDir)) {
    return 0;
  }
  
  try {
    const files = await readdir(backupDir);
    const cutoffTime = Date.now() - (config.safety.backupRetentionHours * 60 * 60 * 1000);
    let cleaned = 0;
    
    for (const file of files) {
      if (!file.endsWith('.bak')) continue;
      
      // Extract timestamp from filename (format: filename.timestamp.bak)
      const match = file.match(/\.(\d+)\.bak$/);
      if (match) {
        const timestamp = parseInt(match[1], 10);
        if (timestamp < cutoffTime) {
          await unlink(join(backupDir, file));
          cleaned++;
        }
      }
    }
    
    if (cleaned > 0) {
      logger.debug('Cleaned up old backups', { count: cleaned, dir: backupDir });
    }
    
    return cleaned;
  } catch (error) {
    logger.warn('Failed to cleanup backups', { error: String(error) });
    return 0;
  }
}

/**
 * List available backups for a file
 */
export async function listBackups(fileName: string, projectPath: string): Promise<Array<{ path: string; timestamp: Date; size: number }>> {
  const backupDir = getBackupDir(projectPath);
  if (!existsSync(backupDir)) {
    return [];
  }
  
  try {
    const files = await readdir(backupDir);
    const backups: Array<{ path: string; timestamp: Date; size: number }> = [];
    
    for (const file of files) {
      if (!file.startsWith(fileName) || !file.endsWith('.bak')) continue;
      
      const match = file.match(/\.(\d+)\.bak$/);
      if (match) {
        const filePath = join(backupDir, file);
        const stats = await stat(filePath);
        backups.push({
          path: filePath,
          timestamp: new Date(parseInt(match[1], 10)),
          size: stats.size
        });
      }
    }
    
    // Sort by timestamp descending (newest first)
    backups.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    
    return backups;
  } catch {
    return [];
  }
}

/**
 * Restore a file from backup
 */
export async function restoreFromBackup(backupPath: string, originalPath: string): Promise<{ success: boolean; message: string }> {
  if (!existsSync(backupPath)) {
    return { success: false, message: 'Backup file not found' };
  }
  
  try {
    await copyFile(backupPath, originalPath);
    logger.info('Restored file from backup', { backup: backupPath, target: originalPath });
    return { success: true, message: `Restored ${basename(originalPath)} from backup` };
  } catch (error) {
    return { success: false, message: `Failed to restore: ${error instanceof Error ? error.message : 'Unknown error'}` };
  }
}

/**
 * Safe file write with all safety layers:
 * 1. Pre-edit backup
 * 2. Size sanity check
 * 3. Content validation
 * 4. Atomic write (write to temp, then rename)
 */
async function safeWriteFile(
  filePath: string, 
  content: string, 
  projectPath: string,
  options: { force?: boolean } = {}
): Promise<SafeWriteResult> {
  const warnings: string[] = [];
  
  // Layer 1: Create backup
  let backupPath: string | null = null;
  if (config.safety.backupEnabled && existsSync(filePath)) {
    backupPath = await createBackup(filePath, projectPath);
    if (backupPath) {
      warnings.push(`Backup created: ${basename(backupPath)}`);
    }
  }
  
  // Layer 2: Size sanity check
  const shrinkageCheck = await checkShrinkage(filePath, content);
  if (!shrinkageCheck.safe && !options.force) {
    return {
      success: false,
      error: `SAFETY BLOCK: ${shrinkageCheck.warning}. Use --force to override.`,
      backupPath: backupPath || undefined,
      warnings
    };
  }
  if (shrinkageCheck.shrinkage > 20) {
    warnings.push(`File shrinks by ${shrinkageCheck.shrinkage}%`);
  }
  
  // Layer 3: Content validation
  if (config.safety.validateContent) {
    const validation = validateContent(content, filePath);
    if (!validation.valid && !options.force) {
      return {
        success: false,
        error: `SAFETY BLOCK: ${validation.warning}. Use --force to override.`,
        backupPath: backupPath || undefined,
        warnings
      };
    }
    if (validation.warning) {
      warnings.push(validation.warning);
    }
  }
  
  // Layer 4: Atomic write
  try {
    if (config.safety.atomicWrites) {
      // Ensure directory exists
      const dir = dirname(filePath);
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }
      
      // Write to temp file first
      const tempPath = `${filePath}.jeeves-tmp`;
      await writeFile(tempPath, content, 'utf-8');
      
      // Atomic rename
      await rename(tempPath, filePath);
    } else {
      await writeFile(filePath, content, 'utf-8');
    }
    
    return {
      success: true,
      backupPath: backupPath || undefined,
      warnings: warnings.length > 0 ? warnings : undefined
    };
  } catch (error) {
    return {
      success: false,
      error: `Write failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      backupPath: backupPath || undefined,
      warnings
    };
  }
}

// ============================================================================
// END FILE SAFETY SYSTEM
// ============================================================================

/**
 * Validate a command against trust level constraints
 * Returns error message if forbidden, null if allowed
 */
async function validateCommandTrust(command: string): Promise<string | null> {
  const { getTrustLevel } = await import('./trust.js');
  const trustLevel = getTrustLevel();
  const lower = command.toLowerCase().trim();
  
  // POST/PUT/PATCH/DELETE require trust level 3+
  if (trustLevel < 3) {
    if (lower.startsWith('post ') || lower.match(/^(?:api\s+)?post\s+/i)) {
      return `POST requests require trust level 3+ (current: ${trustLevel})`;
    }
    if (lower.startsWith('put ') || lower.match(/^(?:api\s+)?put\s+/i)) {
      return `PUT requests require trust level 3+ (current: ${trustLevel})`;
    }
    if (lower.startsWith('patch ') || lower.match(/^(?:api\s+)?patch\s+/i)) {
      return `PATCH requests require trust level 3+ (current: ${trustLevel})`;
    }
    if (lower.startsWith('delete ') || lower.match(/^(?:api\s+)?delete\s+/i)) {
      return `DELETE requests require trust level 3+ (current: ${trustLevel})`;
    }
  }
  
  // Database writes require trust level 4+
  if (trustLevel < 4) {
    if (lower.match(/\b(insert|update|delete|drop|truncate|alter)\b/i)) {
      return `Database mutations require trust level 4+ (current: ${trustLevel})`;
    }
  }
  
  return null; // Command is allowed
}

/**
 * Extract a plan from AI response and store it
 * Validates commands against trust constraints
 */
async function extractAndStorePlan(text: string): Promise<void> {
  // Look for ```plan blocks
  const planMatch = text.match(/```plan\s*([\s\S]*?)```/i);
  if (!planMatch) return;
  
  const planBlock = planMatch[1];
  
  // Extract description
  const descMatch = planBlock.match(/DESCRIPTION:\s*(.+)/i);
  const description = descMatch ? descMatch[1].trim() : 'Proposed plan';
  
  // Extract commands
  const commandsMatch = planBlock.match(/COMMANDS:\s*([\s\S]*)/i);
  if (!commandsMatch) return;
  
  const rawCommands = commandsMatch[1]
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#') && !line.startsWith('//'));
  
  if (rawCommands.length === 0) return;
  
  // Validate each command against trust constraints
  const validCommands: string[] = [];
  const rejectedCommands: string[] = [];
  
  for (const cmd of rawCommands) {
    const error = await validateCommandTrust(cmd);
    if (error) {
      rejectedCommands.push(`${cmd} (BLOCKED: ${error})`);
      logger.warn('Command blocked by trust constraints', { command: cmd, error });
    } else {
      validCommands.push(cmd);
    }
  }
  
  // Only store valid commands
  if (validCommands.length > 0) {
    setPendingPlan(validCommands, description);
    logger.info('Extracted plan from AI response', { 
      description, 
      validCommands: validCommands.length,
      rejectedCommands: rejectedCommands.length 
    });
  }
  
  if (rejectedCommands.length > 0) {
    logger.warn('Some commands rejected due to trust constraints', { rejectedCommands });
  }
}

/**
 * Execute the pending plan
 */
export async function executePendingPlan(): Promise<{ success: boolean; results: string[] }> {
  const plan = getPendingPlan();
  if (!plan) {
    return { success: false, results: ['No pending plan to execute'] };
  }
  
  const { parseIntent } = await import('./parser.js');
  const { executeCommand } = await import('./executor.js');
  
  const results: string[] = [];
  const summary: { command: string; success: boolean; status?: string }[] = [];
  let successCount = 0;
  let failCount = 0;
  
  logger.info('Executing pending plan', { commands: plan.commands.length });
  
  for (const command of plan.commands) {
    try {
      const intent = await parseIntent(command);
      const result = await executeCommand(intent);
      
      if (result.success) {
        successCount++;
        // Extract status from API results (format: "  404 Not Found (215ms)")
        const statusMatch = result.output?.match(/^\s+(\d{3}\s+[^\n(]+)/m);
        const status = statusMatch ? statusMatch[1].trim() : 'OK';
        summary.push({ command, success: true, status });
        results.push(`✓ ${command}: ${status}`);
      } else {
        failCount++;
        const status = result.error || 'Failed';
        summary.push({ command, success: false, status });
        results.push(`✗ ${command}: ${status}`);
      }
    } catch (error) {
      failCount++;
      const status = error instanceof Error ? error.message : String(error);
      summary.push({ command, success: false, status });
      results.push(`✗ ${command}: ${status}`);
    }
  }
  
  // Create a clean summary
  const header = `## Plan Execution Complete\n\n**${plan.description}**\n\n📊 ${successCount} passed, ${failCount} failed\n`;
  results.unshift(header);
  
  // Store results for follow-up questions
  setExecutionResults(plan.description, results);
  
  // Clear the plan after execution
  clearPendingPlan();
  
  return { success: failCount === 0, results };
}

// File extensions to include in context
const CODE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.md', '.json', '.sql', '.css', '.html'];
const MAX_FILE_SIZE = 50000;  // 50KB max per file
const MAX_TOTAL_CONTEXT = 300000;  // 300KB max total context (Claude can handle much more)

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

  // Prioritize frontend directories first (they're often at the end alphabetically)
  const priorityDirs = ['web', 'public', 'client', 'frontend', 'app', 'pages', 'components'];
  for (const dir of priorityDirs) {
    const dirPath = join(projectPath, dir);
    try {
      const stats = await stat(dirPath);
      if (stats.isDirectory()) {
        await scanDir(dirPath, 1);
      }
    } catch (e) {
      // Directory doesn't exist
    }
  }
  
  // Then scan remaining directories
  await scanDir(projectPath);

  // Extract file list for quick reference
  const fileList = contextParts
    .map(p => {
      const match = p.match(/^### (.+)/m);
      return match ? match[1] : null;
    })
    .filter(Boolean);
  
  // Prepend file list summary so model knows what's available
  const fileSummary = `## LOADED FILES (${fileList.length} files)\n${fileList.join('\n')}\n\n`;
  
  return fileSummary + contextParts.join('');
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
export async function sendToAgent(prompt: string, attachments?: ImageAttachment[]): Promise<string> {
  const lowerPrompt = prompt.toLowerCase().trim();
  
  // Handle model switching commands
  const modelMatch = lowerPrompt.match(/^use\s+(haiku|sonnet|opus)$/i);
  if (modelMatch) {
    const tier = modelMatch[1].toLowerCase() as ModelTier;
    setForcedModel(tier);
    return `Model locked to **${tier.toUpperCase()}**. All requests will now use ${tier} until you say "use auto".`;
  }
  if (lowerPrompt === 'use auto' || lowerPrompt === 'auto model') {
    setForcedModel(null);
    return 'Model selection set to **AUTO**. Will choose the best model based on task complexity.';
  }
  
  if (!activeSession) {
    // No project loaded - use general mode for conversational questions
    logger.debug('No active session, using general mode');
    return askGeneral(prompt, attachments);
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
Start your response with a [Thinking] section that shows your search process:
1. What keywords/patterns you're searching for
2. Which files you found that match
3. The specific file and line numbers you'll modify

Example: "[Thinking] User wants to modify the text input. Searching for 'input', 'textarea', 'form'. Found: web/index.html:47 has <input>, web/styles.css:390 has input styling, web/app.js:17 references commandInput. Will modify all three files."

## CRITICAL RULES
1. **SEARCH BEFORE RESPONDING**: Scan the loaded files for relevant keywords before writing any code
2. **NEVER GIVE GENERIC EXAMPLES**: If asked to modify something, find the ACTUAL file in the project context
3. **QUOTE ACTUAL PATHS**: Reference real file paths from the project (e.g., "In web/index.html line 47...")
4. **MATCH THE TECH STACK**: If the project uses vanilla HTML/CSS/JS, don't suggest React/Tailwind solutions
5. **LIST WHAT YOU FOUND**: In [Thinking], explicitly list the files and line numbers you found
6. **FAIL LOUDLY**: If you cannot find the relevant file in the loaded context, say "I searched for X but couldn't find it in the loaded files" - don't make up generic code
7. **BE SPECIFIC**: Propose edits to the actual code you see, not hypothetical code that might exist

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

REMEMBER: You have the actual project files loaded. ALWAYS search them and reference specific paths. NEVER give generic examples when you have the real code available.

PROJECT: ${activeSession.workingDir.split(/[\\/]/).pop()}
PROJECT ROOT: ${activeSession.workingDir}

${conversationContext}
=== PROJECT FILES ===
${activeSession.projectContext}
=== END FILES ===`;

    // Smart model selection - check for forced model first
    const selectedModel = selectModel(prompt, forcedModel ?? undefined);
    
    // For edit requests, always use at least Sonnet (not Haiku) - unless user forced Haiku
    let modelToUse = selectedModel.modelId;
    let wasUpgraded = false;
    if (!forcedModel && isEditRequest && selectedModel.tier === 'haiku') {
      modelToUse = 'claude-sonnet-4-20250514';
      wasUpgraded = true;
    }
    
    // Clear, visible logging of which model is being used
    const modelDisplay = forcedModel ? `[FORCED: ${forcedModel.toUpperCase()}]` : `[AUTO: ${selectedModel.tier.toUpperCase()}]`;
    logger.info(`Using ${selectedModel.tier.toUpperCase()} model ${modelDisplay}`, { 
      tier: selectedModel.tier, 
      actualModel: modelToUse,
      isEditRequest,
      forcedModel: forcedModel ?? 'auto',
      wasUpgraded
    });

    // Use streaming for real-time updates
    let text = '';
    
    if (activeStreamCallback) {
      // Streaming mode
      const result = streamText({
        model: anthropic(modelToUse),
        system: systemPrompt,
        prompt: prompt,
        maxTokens: config.claude.max_tokens
      });
      
      for await (const chunk of result.textStream) {
        text += chunk;
        activeStreamCallback(chunk);
      }
    } else {
      // Non-streaming fallback
      const result = await generateText({
        model: anthropic(modelToUse),
        system: systemPrompt,
        prompt: prompt,
        maxTokens: config.claude.max_tokens
      });
      text = result.text;
    }

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
      
      // Use safe write with backup, validation, and atomic write
      const writeResult = await safeWriteFile(change.filePath, newContent, activeSession.workingDir);
      
      if (writeResult.success) {
        let msg = `✓ ${change.description}`;
        if (writeResult.backupPath) {
          msg += ` (backup: ${basename(writeResult.backupPath)})`;
        }
        results.push(msg);
        logger.info('Applied change safely', { 
          file: change.filePath, 
          backup: writeResult.backupPath,
          warnings: writeResult.warnings 
        });
      } else {
        results.push(`✗ ${change.description} - ${writeResult.error}`);
        logger.error('Safe write blocked change', { 
          file: change.filePath, 
          error: writeResult.error,
          backup: writeResult.backupPath 
        });
      }
      
    } catch (error) {
      results.push(`✗ Failed: ${change.description} - ${error instanceof Error ? error.message : 'Unknown error'}`);
      logger.error('Failed to apply change', { file: change.filePath, error: String(error) });
    }
  }
  
  // Clear pending changes
  activeSession.pendingChanges = [];
  
  // Cleanup old backups periodically
  await cleanupOldBackups(activeSession.workingDir);
  
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
/**
 * Prompt complexity tiers for token optimization
 */
type PromptTier = 'minimal' | 'standard' | 'full';

interface PromptAnalysis {
  tier: PromptTier;
  needsProjectContext: boolean;
  needsBrowseContext: boolean;
  needsExecContext: boolean;
  historyCount: number;
  maxTokens: number;  // Response token limit based on intent
}

// Token limits per tier - prevents verbose responses
const TOKEN_LIMITS: Record<PromptTier, number> = {
  minimal: 150,   // Greetings, status checks - keep it brief
  standard: 800,  // Normal questions - moderate response
  full: 2000      // Complex technical work - allow detailed responses
};

/**
 * Analyze prompt to determine optimal context tier
 * Returns tier and what context is actually needed
 */
function analyzePromptComplexity(prompt: string): PromptAnalysis {
  const lower = prompt.toLowerCase().trim();
  const wordCount = prompt.split(/\s+/).length;
  
  // Minimal tier: greetings, simple chat, status checks
  const minimalPatterns = [
    /^(hi|hey|hello|yo|sup|what'?s? up|you there|you back|back\??|test|ping|status)\b/i,
    /^(how are you|how'?s? it going|good morning|good afternoon|good evening)\b/i,
    /^(thanks|thank you|ok|okay|yes|no|sure|got it|cool|nice|great)\b/i
  ];
  
  if (wordCount <= 5 && minimalPatterns.some(p => p.test(lower))) {
    return {
      tier: 'minimal',
      needsProjectContext: false,
      needsBrowseContext: false,
      needsExecContext: false,
      historyCount: 3,
      maxTokens: TOKEN_LIMITS.minimal
    };
  }
  
  // Check what context is actually needed
  const needsProjectContext = /\b(project|code|file|function|component|api|database|bug|fix|implement|refactor|open|load)\b/i.test(lower);
  const needsBrowseContext = /\b(browse|website|page|url|screenshot|web|site|click|scroll)\b/i.test(lower);
  const needsExecContext = /\b(result|output|what happened|did it work|success|fail|error|run|execute|plan)\b/i.test(lower);
  
  // Full tier: complex technical work, multi-step tasks
  // Only use if explicitly technical, not just long conversation
  const fullPatterns = [
    /\b(implement|build|create|develop|architect|design|refactor|migrate)\b/i,
    /\b(deploy|kubernetes|docker|terraform|ansible|ci\/?cd)\b/i,
    /\b(security|audit|vulnerability|penetration|hardening)\b/i,
    /```/,  // Code blocks indicate complex work
    /\bplan\b.*\bcommands?\b/i  // "plan" only if talking about commands
  ];
  
  // Only use FULL tier if technical patterns match, not just word count
  if (fullPatterns.some(p => p.test(lower))) {
    return {
      tier: 'full',
      needsProjectContext: true,
      needsBrowseContext: needsBrowseContext,
      needsExecContext: needsExecContext,
      historyCount: 15,
      maxTokens: TOKEN_LIMITS.full
    };
  }
  
  // Standard tier: normal questions and tasks
  return {
    tier: 'standard',
    needsProjectContext: needsProjectContext,
    needsBrowseContext: needsBrowseContext,
    needsExecContext: needsExecContext,
    historyCount: 8,
    maxTokens: TOKEN_LIMITS.standard
  };
}

/**
 * Build system prompt based on tier
 */
function buildSystemPrompt(
  tier: PromptTier,
  trustLevel: number,
  trustName: string,
  projectList: string | null,
  browseContext: string,
  executionContext: string,
  personalityContext: string | null,
  analysis: PromptAnalysis,
  skillsContext?: string
): string {
  // Core identity - always included (~100 tokens)
  const corePrompt = `You are Jeeves, an AI employee. You work for the user - coding, sysadmin, DevOps, home server management. You run locally and take action: run commands, edit files, solve problems. Be direct and professional.`;
  
  if (tier === 'minimal') {
    // ~150 tokens total
    return `${corePrompt}

Trust level: ${trustLevel}/5 (${trustName}). Be conversational and helpful - a few sentences is fine.`;
  }
  
  // Standard tier: core + trust + constraints (~400 tokens)
  const trustConstraints = `
## TRUST LEVEL: ${trustLevel}/5 (${trustName})
${trustLevel < 3 ? 'Cannot: POST/PUT/PATCH/DELETE (need L3+)' : 'Can: All HTTP methods'}
${trustLevel < 4 ? 'Cannot: Database mutations (need L4+)' : 'Can: Database operations'}

When proposing multi-command work, use:
\`\`\`plan
DESCRIPTION: What you'll do
COMMANDS:
command1
command2
\`\`\`
User says "yes" to approve. Only propose commands allowed at your level.`;

  if (tier === 'standard') {
    let prompt = `${corePrompt}
${trustConstraints}`;
    
    if (analysis.needsProjectContext && projectList) {
      prompt += `\n\n## PROJECTS\n${projectList}`;
    }
    if (analysis.needsBrowseContext && browseContext) {
      prompt += browseContext;
    }
    if (analysis.needsExecContext && executionContext) {
      prompt += executionContext;
    }
    if (personalityContext) {
      prompt += `\n\n## PREFERENCES\n${personalityContext}`;
    }
    if (skillsContext) {
      prompt += `\n\n${skillsContext}`;
    }
    
    return prompt;
  }
  
  // Full tier: everything (~1200 tokens)
  const capabilities = `
## CAPABILITIES
- Coding: project context, code changes, git, npm, CI/CD, PRDs
- Sysadmin: Linux, Docker, systemd, Nginx, SSL, cron
- Media: Plex, *arr stack, Jellyfin
- Self-hosted: Nextcloud, Home Assistant, Pi-hole, Vaultwarden
- Network: Tailscale, WireGuard, Cloudflare, firewalls
- DevOps: Terraform, Ansible, k8s, AWS/DO, monitoring
- Databases: PostgreSQL, MySQL, Redis
- Web: browse sites, screenshots, click/type for testing
- API: test endpoints (GET any, POST/PUT/DELETE need L3+)`;

  let prompt = `${corePrompt}
${capabilities}
${trustConstraints}`;

  if (projectList) {
    prompt += `\n\n## PROJECTS\nSay "open <name>" to load context:\n${projectList}`;
  }
  if (browseContext) {
    prompt += browseContext;
  }
  if (executionContext) {
    prompt += executionContext;
  }
  if (personalityContext) {
    prompt += `\n\n## PREFERENCES\n${personalityContext}`;
  }
  if (skillsContext) {
    prompt += `\n\n${skillsContext}`;
  }
  
  return prompt;
}

export async function askGeneral(prompt: string, attachments?: ImageAttachment[]): Promise<string> {
  // Analyze prompt complexity first
  const analysis = analyzePromptComplexity(prompt);
  logger.debug('Prompt analysis', { tier: analysis.tier, historyCount: analysis.historyCount, attachments: attachments?.length || 0 });

  // Import trust info and personality for context
  const { getTrustState, getPersonalityContext } = await import('./trust.js');
  const trustState = getTrustState();
  const personalityContext = getPersonalityContext();
  
  // Build trust context with null safety
  const trustLevel = trustState?.currentLevel ?? 2;
  const trustNames = ['supervised', 'semi-autonomous', 'trusted', 'autonomous', 'full-trust'];
  const trustName = trustNames[trustLevel - 1] || 'semi-autonomous';
  
  // Only load project list if needed
  let projectList: string | null = null;
  if (analysis.needsProjectContext || analysis.tier === 'full') {
    const projectIndex = getProjectIndex();
    projectList = Array.from(projectIndex.projects.entries())
      .map(([name, p]) => `- ${name} (${p.type}): ${p.path}`)
      .join('\n') || null;
  }
  
  // Only load browse context if needed
  let browseContext = '';
  let browseScreenshot: string | undefined;
  if (analysis.needsBrowseContext) {
    const lastBrowse = getLastBrowseResult();
    if (lastBrowse && lastBrowse.success) {
      browseContext = `\n## LAST WEB PAGE\nURL: ${lastBrowse.url}\nTitle: ${lastBrowse.title || 'Unknown'}\nContent:\n${lastBrowse.content || '[No content]'}`;
      browseScreenshot = lastBrowse.screenshotBase64;
    }
  }
  
  // Only load execution context if needed
  let executionContext = '';
  if (analysis.needsExecContext) {
    const execResults = getLastExecutionResults();
    if (execResults) {
      executionContext = `\n## RECENT EXECUTION\nTask: ${execResults.description}\nResults:\n${execResults.results.join('\n\n')}\nUse these ACTUAL results - never generate placeholders.`;
    }
  }
  
  // Load relevant skills context (only for standard/full tiers to save tokens)
  let skillsContext = '';
  if (analysis.tier !== 'minimal') {
    // Detect relevant skills based on prompt content
    skillsContext = await getSkillContext(prompt);
    
    if (skillsContext) {
      logger.debug('Loaded skills context', { length: skillsContext.length });
    }
  }
  
  // Build tiered system prompt
  const systemPrompt = buildSystemPrompt(
    analysis.tier,
    trustLevel,
    trustName,
    projectList,
    browseContext,
    executionContext,
    personalityContext,
    analysis,
    skillsContext
  );

  try {
    // Smart model selection based on prompt complexity (with forced model support)
    const selectedModel = selectModel(prompt, forcedModel ?? undefined);
    const modelDisplay = forcedModel ? `[FORCED: ${forcedModel.toUpperCase()}]` : `[AUTO: ${selectedModel.tier.toUpperCase()}]`;
    const promptTokenEstimate = Math.ceil(systemPrompt.length / 4);
    logger.info(`Using ${selectedModel.tier.toUpperCase()} model ${modelDisplay} [${analysis.tier.toUpperCase()} prompt ~${promptTokenEstimate} tokens]`);

    // Load conversation history based on complexity tier
    const recentHistory = getGeneralConversations(analysis.historyCount);
    
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
    
    // Add current user message - include screenshot and/or attachments if available
    const hasAttachments = attachments && attachments.length > 0;
    
    if (browseScreenshot || hasAttachments) {
      // Build multimodal message content
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const contentParts: Array<any> = [];
      
      // Add text prompt
      let textContent = prompt;
      if (browseScreenshot) {
        textContent += '\n\n[A screenshot of the webpage is attached for visual analysis]';
      }
      if (hasAttachments) {
        const attachmentNames = attachments!.map(a => a.name).join(', ');
        textContent += `\n\n[Attached images: ${attachmentNames}]`;
        logger.info('Including user attachments in AI request', { count: attachments!.length });
      }
      
      contentParts.push({
        type: 'text',
        text: textContent
      });
      
      // Add browse screenshot if available
      if (browseScreenshot) {
        logger.info('Including browse screenshot in AI request');
        contentParts.push({
          type: 'image',
          image: `data:image/png;base64,${browseScreenshot}`
        });
      }
      
      // Add user-attached images
      if (hasAttachments) {
        for (const attachment of attachments!) {
          // attachment.data is already a data URL (e.g., "data:image/png;base64,...")
          contentParts.push({
            type: 'image',
            image: attachment.data
          });
        }
      }
      
      messages.push({
        role: 'user',
        content: contentParts
      });
    } else {
      messages.push({
        role: 'user',
        content: prompt
      });
    }
    
    logger.debug('Context', { history: recentHistory.length, hasScreenshot: !!browseScreenshot, attachments: attachments?.length || 0 });

    const anthropic = createAnthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });

    // Use tier-based max tokens, but increase for vision (screenshots/images need more detail)
    const hasVision = browseScreenshot || hasAttachments;
    const maxTokens = hasVision ? Math.max(analysis.maxTokens, 1000) : analysis.maxTokens;
    
    const result = await generateText({
      model: anthropic(selectedModel.modelId),
      system: systemPrompt,
      messages: messages,
      maxTokens: maxTokens
    });
    
    logger.debug(`Response tokens limit: ${maxTokens} (tier: ${analysis.tier})`);

    const { text } = result;
    
    // Track LLM usage for cost monitoring
    const usage = result.usage;
    if (usage) {
      trackLLMUsage(
        'general',
        selectedModel.modelId,
        usage.promptTokens,
        usage.completionTokens,
        false  // TODO: Track cache hits when SDK supports it
      );
    }

    // Save conversation to memory
    addGeneralMessage('user', prompt);
    addGeneralMessage('assistant', text);
    
    // Extract and store any proposed plan (validates trust constraints)
    await extractAndStorePlan(text);

    return text;
  } catch (error) {
    logger.error('General question failed', { error: String(error) });
    return `Sorry, I encountered an error: ${error instanceof Error ? error.message : 'Unknown error'}`;
  }
}

// Re-export FileChange type for external use
export type { FileChange };
