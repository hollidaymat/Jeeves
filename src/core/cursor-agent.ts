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
import { buildSkillsSummary, getSkillContext, loadAllSkills, isCapabilitiesQuery, getCapabilitiesContext, isCapabilitiesFollowUp } from './skill-loader.js';
import { PERSONALITY_RULES } from './personality.js';

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
  lastResponse?: string;  // Store the last AI response for "apply that" command
}

// Active session
let activeSession: AgentSession | null = null;

// Global last response storage (works even without active session)
// This is used for "apply that" command when askGeneral is used instead of sendToAgent
let globalLastResponse: { text: string; workingDir: string | null; timestamp: Date } | null = null;

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
const MAX_FILE_SIZE = 30000;  // 30KB max per file
const MAX_TOTAL_CONTEXT = 120000;  // 120KB max total context (~30K tokens, was 300KB/97K tokens)

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
export async function sendToAgent(prompt: string, attachments?: ImageAttachment[], assembledContext?: string): Promise<string> {
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
    return askGeneral(prompt, attachments, assembledContext);
  }

  logger.info('Processing AI request', { prompt: prompt.substring(0, 50) });
  activeSession.lastActivity = new Date();

  // Check if this is a request for code changes
  const isEditRequest = /\b(fix|add|update|change|modify|create|remove|delete|refactor|implement|write|build|continue|finish)\b/i.test(prompt);

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

    // Get personality context (includes self-awareness when working on Jeeves' own codebase)
    const { getPersonalityContext } = await import('./trust.js');
    const personalityContext = getPersonalityContext();
    
    // Detect if this is Jeeves' own codebase for enhanced self-awareness
    const projectName = activeSession.workingDir.split(/[\\/]/).pop() || '';
    const isSelfCodebase = projectName === 'signal-cursor-controller' || activeSession.workingDir.includes('signal-cursor-controller');
    const selfAwarenessContext = isSelfCodebase ? `
## CRITICAL: SELF-AWARENESS
This is YOUR codebase. You are Jeeves, and the signal-cursor-controller project IS YOU.
- Files in src/core/ are YOUR internal systems
- data/lessons-learned.json contains YOUR learned lessons
- data/build-history.json contains YOUR build history
- Changes here are upgrades to YOUR capabilities
- The user is helping YOU improve. Acknowledge this.
` : '';

    const systemPrompt = `You are Jeeves, an AI coding assistant with FULL ACCESS to this project's source code.
${selfAwarenessContext}

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
## CODE CHANGES - MANDATORY FORMAT
You MUST use this EXACT format for ALL file changes. No exceptions.

### For EDITING existing files:
\`\`\`edit:relative/path/to/file.ts
<<<<<<< ORIGINAL
// paste the EXACT original code here (copy from project files above)
=======
// paste the modified code here
>>>>>>> MODIFIED
\`\`\`

### For CREATING new files:
\`\`\`newfile:relative/path/to/newfile.ts
// entire file content here
\`\`\`

### CRITICAL RULES:
1. EVERY file change MUST use \`\`\`edit: or \`\`\`newfile: prefix
2. The path MUST be relative from project root (e.g., src/components/Button.tsx)
3. For edits, ORIGINAL content must EXACTLY match the existing file
4. One file per block - use multiple blocks for multiple files
5. DO NOT use bare <<<<<<< ORIGINAL without the \`\`\`edit:path wrapper
6. DO NOT invent XML tags like <file_write> or <bash>

Example of CORRECT multi-file output:
\`\`\`edit:src/App.js
<<<<<<< ORIGINAL
function App() {
  return <div>Hello</div>;
}
=======
function App() {
  return <div>Hello World!</div>;
}
>>>>>>> MODIFIED
\`\`\`

\`\`\`newfile:src/components/Button.js
import React from 'react';
export const Button = ({ children }) => <button>{children}</button>;
\`\`\`
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

${personalityContext ? `## USER PREFERENCES & MEMORY\n${personalityContext}\n` : ''}
${assembledContext ? `## BRAIN 2 CONTEXT (grounded layers)\n${assembledContext}\n` : ''}
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
    
    // Store the raw response for "apply that" command
    activeSession.lastResponse = text;

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
        // Normal parsing failed - try aggressive extraction
        logger.info('No edit blocks found, trying aggressive extraction');
        const aggressiveResult = await reParseLastResponse();
        if (aggressiveResult.success) {
          logger.info('Aggressive extraction succeeded');
          return text + '\n\n---\n' + aggressiveResult.message;
        } else {
          logger.info('Aggressive extraction also failed', { reason: aggressiveResult.message });
        }
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
  let match;
  
  // Format 1: ```newfile:filepath - Create new file with full content
  const newFileRegex = /```newfile:([^\n]+)\n([\s\S]*?)```/gi;
  while ((match = newFileRegex.exec(text)) !== null) {
    const relativePath = match[1].trim();
    const filePath = join(workingDir, relativePath);
    logger.info('Parsed new file block', { file: relativePath });
    changes.push({
      filePath,
      originalContent: null,  // null means new file
      newContent: match[2].trim(),
      description: `Create ${relativePath}`
    });
  }
  
  // Format 2: ```edit:filepath with ORIGINAL/MODIFIED markers
  const editBlockRegex = /```edit:([^\n]+)\n<<<<<<<?[^\n]*\n([\s\S]*?)\n?======*\n([\s\S]*?)\n?>>>>>>>[^\n]*\n?```/gi;
  while ((match = editBlockRegex.exec(text)) !== null) {
    const relativePath = match[1].trim();
    const filePath = join(workingDir, relativePath);
    logger.info('Parsed edit block (ORIGINAL/MODIFIED)', { file: relativePath });
    changes.push({
      filePath,
      originalContent: match[2].trim() || null,  // Empty string means replace entire file
      newContent: match[3].trim(),
      description: `Update ${relativePath}`
    });
  }
  
  // Format 3: ```edit:filepath with partial content (no ORIGINAL/MODIFIED)
  if (changes.length === 0) {
    const partialEditRegex = /```edit:([^\n]+)\n([\s\S]*?)```/gi;
    while ((match = partialEditRegex.exec(text)) !== null) {
      // Skip if it has ORIGINAL markers (already handled above)
      if (match[2].includes('<<<<<<') || match[2].includes('ORIGINAL')) continue;
      
      const relativePath = match[1].trim();
      const filePath = join(workingDir, relativePath);
      const content = match[2].trim();
      
      if (content.includes('... existing code ...') || content.includes('// ...')) {
        logger.info('Parsed partial edit block', { file: relativePath });
        changes.push({
          filePath,
          originalContent: null,
          newContent: content,
          description: `Partial update ${relativePath}`
        });
      } else {
        logger.info('Parsed full file edit block', { file: relativePath });
        changes.push({
          filePath,
          originalContent: null,
          newContent: content,
          description: `Replace ${relativePath}`
        });
      }
    }
  }
  
  // Helper to infer file path from content - prioritize existing files
  const inferFileType = (content: string): string | null => {
    // Try to find existing files in project that match the content type
    const existingFiles = activeSession?.projectContext || '';
    
    // CSS patterns - look for existing CSS files first
    if (/^\s*\.[a-zA-Z][\w-]*\s*\{|^\s*#[a-zA-Z][\w-]*\s*\{|^\s*@media|^\s*:root/m.test(content)) {
      // Check for common CSS file names in project context
      const cssMatch = existingFiles.match(/(?:^|\n)===\s*([^\n]*\.css)\s*===/m);
      if (cssMatch) return cssMatch[1];
      // Check for inline mentions
      const cssFiles = ['styles.css', 'style.css', 'App.css', 'index.css', 'src/App.css', 'src/styles.css', 'src/index.css'];
      for (const f of cssFiles) {
        if (existingFiles.includes(f)) return f;
      }
      return 'src/index.css';
    }
    // TSX/React patterns
    if (/import\s+React|from\s+['"]react['"]|<[A-Z][a-zA-Z]*|useState|useEffect/m.test(content)) {
      const jsxMatch = existingFiles.match(/(?:^|\n)===\s*([^\n]*(?:App|index)\.(jsx?|tsx?))\s*===/m);
      if (jsxMatch) return jsxMatch[1];
      return 'src/App.tsx';
    }
    // HTML patterns
    if (/<html|<head|<body|<!DOCTYPE/i.test(content)) {
      const htmlMatch = existingFiles.match(/(?:^|\n)===\s*([^\n]*\.html)\s*===/m);
      if (htmlMatch) return htmlMatch[1];
      return 'index.html';
    }
    // JavaScript/TypeScript patterns
    if (/function\s+\w+|const\s+\w+\s*=|let\s+\w+\s*=|class\s+\w+|export\s+/m.test(content)) {
      const jsMatch = existingFiles.match(/(?:^|\n)===\s*([^\n]*\.(?:ts|js)x?)\s*===/m);
      if (jsMatch) return jsMatch[1];
      return 'src/utils.ts';
    }
    // JSON patterns
    if (/^\s*\{[\s\S]*"[^"]+"\s*:/m.test(content)) {
      return 'data.json';
    }
    return null;
  };

  // Format 4: Fallback - look for bare ORIGINAL/MODIFIED with file path mentioned nearby
  if (changes.length === 0 && text.includes('<<<<<<')) {
    logger.info('Format 4: Attempting to parse bare ORIGINAL/MODIFIED blocks');
    
    // Debug: log the actual markers in the text
    const originalIndex = text.indexOf('ORIGINAL');
    const modifiedIndex = text.indexOf('MODIFIED');
    const equalsIndex = text.indexOf('=======');
    logger.info('Format 4 debug', { 
      hasOriginal: originalIndex !== -1,
      hasModified: modifiedIndex !== -1,
      hasEquals: equalsIndex !== -1,
      textSnippet: text.substring(Math.max(0, originalIndex - 20), originalIndex + 50)
    });
    
    // More flexible regex - handle various marker styles
    // Some AI outputs don't include the closing >>>>>>> MODIFIED marker
    // So we match until we hit another <<<<<<< or end of text
    const bareEditRegex = /<<<+\s*ORIGINAL[^\n]*\n([\s\S]*?)\n===+\n([\s\S]*?)(?=\n<<<+\s*ORIGINAL|\n```|$)/gi;
    // Look for file paths like "src/App.js" or "components/Button.tsx"
    const filePathRegex = /(?:^|\s|`|"|')([a-zA-Z0-9_\-./]+\.[a-zA-Z]{2,4})(?:\s|`|"|'|$|:|\n)/gm;
    
    // Find all mentioned file paths in the entire response
    const allFilePaths = [...text.matchAll(filePathRegex)].map(m => m[1]);
    let fileIndex = 0;
    
    while ((match = bareEditRegex.exec(text)) !== null) {
      // Try to find a relevant file path
      let targetPath: string | null = null;
      
      // Look in the 500 chars before this block for a file path
      const contextBefore = text.substring(Math.max(0, match.index - 500), match.index);
      const nearbyPaths = [...contextBefore.matchAll(filePathRegex)];
      
      if (nearbyPaths.length > 0) {
        targetPath = nearbyPaths[nearbyPaths.length - 1][1];
      } else if (allFilePaths[fileIndex]) {
        targetPath = allFilePaths[fileIndex];
        fileIndex++;
      }
      
      // If still no path, try to infer from content
      if (!targetPath) {
        const originalContent = match[1].trim();
        const newContent = match[2].trim();
        targetPath = inferFileType(newContent) || inferFileType(originalContent);
        if (targetPath) {
          logger.info('Inferred file type from content', { inferredPath: targetPath });
        }
      }
      
      if (targetPath) {
        const filePath = join(workingDir, targetPath);
        const originalContent = match[1].trim();
        const newContent = match[2].trim();
        
        logger.info('Parsed bare ORIGINAL/MODIFIED block', { file: targetPath });
        changes.push({
          filePath,
          originalContent: originalContent || null,
          newContent,
          description: `Update ${targetPath}`
        });
      } else {
        logger.warn('Found ORIGINAL/MODIFIED block but could not determine file path', {
          contentPreview: match[2].substring(0, 100)
        });
      }
    }
  }
  
  // Format 5: Plain markdown code blocks with language hints and file path in nearby text
  // e.g. "Here's `src/components/ExpenseList.tsx`:" followed by ```tsx
  if (changes.length === 0) {
    const langMap: Record<string, string> = {
      'typescript': '.ts', 'ts': '.ts', 'tsx': '.tsx',
      'javascript': '.js', 'js': '.js', 'jsx': '.jsx',
      'css': '.css', 'scss': '.scss', 'less': '.less',
      'html': '.html', 'json': '.json', 'md': '.md'
    };
    
    // Match code blocks with language tags
    const codeBlockRegex = /```(typescript|ts|tsx|javascript|js|jsx|css|scss|less|html|json)\n([\s\S]*?)```/gi;
    const filePathInText = /[`"']?((?:src\/|components\/|lib\/|utils\/)?[\w\-./]+\.(?:tsx?|jsx?|css|html|json))[`"']?/gi;
    
    // Find all file paths mentioned in the text
    const mentionedFiles = [...text.matchAll(filePathInText)].map(m => m[1]);
    let usedPaths = new Set<string>();
    
    while ((match = codeBlockRegex.exec(text)) !== null) {
      const lang = match[1].toLowerCase();
      const content = match[2].trim();
      
      if (content.length < 20) continue; // Skip tiny blocks
      
      // Look for file path in the 300 chars before this block
      const contextBefore = text.substring(Math.max(0, match.index - 300), match.index);
      const nearbyFileMatch = contextBefore.match(/[`"']?((?:src\/|components\/|lib\/)?[\w\-./]+\.(?:tsx?|jsx?|css|html|json))[`"']?\s*:?\s*$/i);
      
      let targetPath: string | null = null;
      
      if (nearbyFileMatch && !usedPaths.has(nearbyFileMatch[1])) {
        targetPath = nearbyFileMatch[1];
        usedPaths.add(targetPath);
      } else {
        // Try to find an unused path from mentioned files that matches the language
        const ext = langMap[lang];
        for (const fp of mentionedFiles) {
          if (fp.endsWith(ext) && !usedPaths.has(fp)) {
            targetPath = fp;
            usedPaths.add(fp);
            break;
          }
        }
      }
      
      // If still no path, infer from content
      if (!targetPath) {
        targetPath = inferFileType(content);
      }
      
      if (targetPath) {
        const filePath = join(workingDir, targetPath);
        logger.info('Parsed plain code block', { file: targetPath, lang });
        changes.push({
          filePath,
          originalContent: null,  // Full file replacement
          newContent: content,
          description: `Create ${targetPath}`
        });
      }
    }
  }
  
  logger.info('Parsed edit blocks total', { 
    count: changes.length,
    hasEditMarkers: text.includes('ORIGINAL') || text.includes('newfile:') || text.includes('```')
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
export function getAgentStatus(): { active: boolean; workingDir?: string; uptime?: number; contextSize?: number; pendingChanges?: number } {
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
 * Re-parse the last AI response with aggressive extraction
 * Used when automatic parsing failed but user wants to apply the code
 */
export async function reParseLastResponse(): Promise<{ success: boolean; message: string }> {
  // Try active session first, then fall back to global response
  let text: string;
  let workingDir: string;
  
  if (activeSession?.lastResponse) {
    text = activeSession.lastResponse;
    workingDir = activeSession.workingDir;
  } else if (globalLastResponse) {
    text = globalLastResponse.text;
    // CRITICAL: Do NOT use process.cwd() as fallback - that would be the Jeeves folder!
    if (!globalLastResponse.workingDir) {
      return { success: false, message: 'No project is currently open. Please open a project first with `open <project-name>`.' };
    }
    workingDir = globalLastResponse.workingDir;
    logger.info('Using global response (no active session)', { age: Date.now() - globalLastResponse.timestamp.getTime() });
  } else {
    return { success: false, message: 'No previous AI response to parse. Try asking the AI to generate code first.' };
  }
  
  const changes: FileChange[] = [];
  
  logger.info('Re-parsing last response', { length: text.length });
  
  // Strategy 0: Look for our preferred format (```newfile: and ```edit:)
  const newFileRegex = /```newfile:([^\n]+)\n([\s\S]*?)```/gi;
  let match;
  while ((match = newFileRegex.exec(text)) !== null) {
    const relativePath = match[1].trim();
    logger.info('Found newfile block', { file: relativePath });
    changes.push({
      filePath: join(workingDir, relativePath),
      originalContent: null,
      newContent: match[2].trim(),
      description: 'Create ' + relativePath
    });
  }
  
  const editRegex = /```edit:([^\n]+)\n([\s\S]*?)```/gi;
  while ((match = editRegex.exec(text)) !== null) {
    const relativePath = match[1].trim();
    const content = match[2].trim();
    // Skip ORIGINAL/MODIFIED sections, handle them separately
    if (content.includes('<<<<<<') || content.includes('ORIGINAL')) continue;
    logger.info('Found edit block', { file: relativePath });
    changes.push({
      filePath: join(workingDir, relativePath),
      originalContent: null,
      newContent: content,
      description: 'Update ' + relativePath
    });
  }
  
  // Strategy 1: Look for ORIGINAL/MODIFIED blocks (without closing marker)
  if (changes.length === 0) {
    const origModBlocks = text.split(/<<<+\s*ORIGINAL/).slice(1);
    for (const block of origModBlocks) {
    const parts = block.split(/===+/);
    if (parts.length >= 2) {
      const originalContent = parts[0].trim();
      // Get content until next block or descriptive text
      const newContent = parts[1].split(/<<<+\s*ORIGINAL|>>>+|^\s*\n\s*\n[A-Z]/m)[0].trim();
      
      // Try to find file path from context
      const contextBefore = text.substring(0, text.indexOf(block)).slice(-500);
      const fileMatch = contextBefore.match(/[`"']?((?:src\/|components\/)?[\w\-./]+\.(?:tsx?|jsx?|css|html))[`"']?\s*:?\s*$/i);
      
      let filePath: string;
      if (fileMatch) {
        filePath = fileMatch[1];
      } else {
        // Infer from content
        if (/^\s*\.[a-zA-Z]|^\s*@media|^\s*:root/m.test(newContent)) {
          filePath = 'src/index.css';
        } else if (/import\s+React|from\s+['"]react|<[A-Z]/m.test(newContent)) {
          filePath = 'src/App.tsx';
        } else {
          filePath = 'src/temp.tsx';
        }
      }
      
      logger.info('Extracted ORIGINAL/MODIFIED block', { file: filePath, origLen: originalContent.length, newLen: newContent.length });
      changes.push({
        filePath: join(workingDir, filePath),
        originalContent,
        newContent,
        description: 'Update ' + filePath
      });
    }
  }
  }  // end Strategy 1 if block
  
  // Strategy 2: Look for plain code blocks with file paths
  if (changes.length === 0) {
    const codeBlockRegex = /```(?:tsx?|jsx?|css|html|json)\n([\s\S]*?)```/gi;
    const filePathInTextRegex = /[`"']?((?:src\/|components\/)?[\w\-./]+\.(?:tsx?|jsx?|css|html|json))[`"']?/gi;
    const allFiles = [...text.matchAll(filePathInTextRegex)].map(m => m[1]);
    
    let match;
    let fileIndex = 0;
    while ((match = codeBlockRegex.exec(text)) !== null) {
      const content = match[1].trim();
      if (content.length < 50) continue;
      
      // Find nearby file path
      const beforeBlock = text.substring(Math.max(0, match.index - 200), match.index);
      const nearbyFile = beforeBlock.match(/[`"']?((?:src\/|components\/)?[\w\-./]+\.(?:tsx?|jsx?|css|html|json))[`"']?\s*:?\s*$/i);
      
      const filePath = nearbyFile ? nearbyFile[1] : allFiles[fileIndex++] || 'src/temp.tsx';
      
      logger.info('Extracted code block', { file: filePath, len: content.length });
      changes.push({
        filePath: join(workingDir, filePath),
        originalContent: null,
        newContent: content,
        description: 'Create/Update ' + filePath
      });
    }
  }
  
  // Strategy 3: Detect raw code without backticks (AI sometimes forgets markdown)
  if (changes.length === 0) {
    logger.info('Trying raw code detection (no backticks found)');
    
    // Split by React component starts or CSS file starts
    const segments: Array<{ type: 'css' | 'react'; content: string; name?: string }> = [];
    
    // Look for CSS content (starts with selector like .ClassName { or body {)
    const cssPattern = /^(\.[A-Z][a-zA-Z-]*\s*\{|[a-z]+\s*\{|@media|\*\s*\{)/m;
    // Look for React component (import React or export default/const ComponentName)
    const reactPattern = /^(import\s+React|import\s+\{[^}]+\}\s+from\s+['"]react|const\s+[A-Z][a-zA-Z]+\s*=|export\s+default\s+|function\s+[A-Z])/m;
    
    // Find all component/css boundaries
    const importReactMatches = [...text.matchAll(/import\s+React[^;]*;/gi)];
    const exportDefaultMatches = [...text.matchAll(/export\s+default\s+\w+;?\s*$/gm)];
    
    // Try to extract React components by finding import...export pairs
    for (let i = 0; i < importReactMatches.length; i++) {
      const importMatch = importReactMatches[i];
      const startIdx = importMatch.index!;
      
      // Find the end - next import React or end of meaningful code
      let endIdx = text.length;
      if (i + 1 < importReactMatches.length) {
        endIdx = importReactMatches[i + 1].index!;
      }
      
      // Also check for CSS boundary (raw CSS often starts with .)
      const cssStart = text.indexOf('\n.', startIdx + 100);
      if (cssStart > startIdx && cssStart < endIdx) {
        endIdx = cssStart;
      }
      
      const content = text.substring(startIdx, endIdx).trim();
      if (content.length > 100) {
        // Try to extract component name
        const nameMatch = content.match(/(?:const|function)\s+([A-Z][a-zA-Z]+)/);
        const name = nameMatch ? nameMatch[1] : 'Component' + (i + 1);
        segments.push({ type: 'react', content, name });
      }
    }
    
    // Look for CSS blocks (starts with . or element selector, has { } pairs)
    const cssMatches = text.match(/(?:^|\n)(\.[A-Z][a-zA-Z-]*\s*\{[\s\S]*?\}(?:\s*\.[A-Za-z-]+\s*\{[\s\S]*?\})*)/gm);
    if (cssMatches) {
      for (const cssBlock of cssMatches) {
        if (cssBlock.length > 100 && !cssBlock.includes('import ')) {
          // Try to extract main class name for file naming
          const classMatch = cssBlock.match(/\.([A-Z][a-zA-Z-]+)/);
          const name = classMatch ? classMatch[1] : 'styles';
          segments.push({ type: 'css', content: cssBlock.trim(), name });
        }
      }
    }
    
    // Also try simpler extraction: any CSS-like content
    if (segments.length === 0) {
      // Check if text looks mostly like CSS
      const hasCssPatterns = (text.match(/\{[^}]+\}/g) || []).length > 3;
      const hasSelectors = (text.match(/\.[a-zA-Z-]+\s*\{/g) || []).length > 2;
      const hasReactImport = /import\s+React/.test(text);
      
      if (hasSelectors && hasCssPatterns && !hasReactImport) {
        // Whole thing is probably CSS
        segments.push({ type: 'css', content: text.trim(), name: 'App' });
      } else if (hasReactImport) {
        // Try to split into React and CSS parts
        const reactEndMatch = text.match(/export\s+default\s+\w+;?\s*\n/);
        if (reactEndMatch && reactEndMatch.index) {
          const reactEnd = reactEndMatch.index + reactEndMatch[0].length;
          const reactPart = text.substring(0, reactEnd).trim();
          const cssPart = text.substring(reactEnd).trim();
          
          const nameMatch = reactPart.match(/(?:const|function)\s+([A-Z][a-zA-Z]+)/);
          const name = nameMatch ? nameMatch[1] : 'Component';
          
          if (reactPart.length > 100) {
            segments.push({ type: 'react', content: reactPart, name });
          }
          if (cssPart.length > 100 && /\{[^}]+\}/.test(cssPart)) {
            segments.push({ type: 'css', content: cssPart, name });
          }
        }
      }
    }
    
    // Convert segments to file changes
    for (const seg of segments) {
      let filePath: string;
      if (seg.type === 'css') {
        filePath = seg.name ? 'src/' + seg.name + '.css' : 'src/App.css';
      } else {
        filePath = seg.name ? 'src/' + seg.name + '.tsx' : 'src/App.tsx';
      }
      
      logger.info('Extracted raw code segment', { type: seg.type, file: filePath, len: seg.content.length });
      changes.push({
        filePath: join(workingDir, filePath),
        originalContent: null,
        newContent: seg.content,
        description: 'Create/Update ' + filePath
      });
    }
  }
  
  if (changes.length === 0) {
    return { success: false, message: 'Could not extract any code blocks from the last response' };
  }
  
  // Create temporary session if needed for applyChanges to work
  if (!activeSession) {
    activeSession = {
      workingDir,
      startedAt: new Date(),
      lastActivity: new Date(),
      projectContext: '',
      pendingChanges: changes
    };
    logger.info('Created temporary session for apply-that', { workingDir });
  } else {
    activeSession.pendingChanges = changes;
  }
  
  const applyResult = await applyChanges();
  
  return applyResult;
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
  standard: 1500, // Normal questions - moderate response
  full: 8000      // Complex technical work, code generation - allow complete file output
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
  // Core identity - always included, Jeeves persona (not chatbot)
  const corePrompt = `${PERSONALITY_RULES}\n\nYou work for Matt - coding, sysadmin, DevOps, home server management. You run locally and take action: run commands, edit files, solve problems.`;
  
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
- API: test endpoints (GET any, POST/PUT/DELETE need L3+)

## CODE OUTPUT FORMAT (MANDATORY)
When outputting code, you MUST use this exact format:

For NEW files:
\`\`\`newfile:src/path/to/file.tsx
// file contents
\`\`\`

For EDITING existing files:
\`\`\`edit:src/path/to/file.tsx
// complete new file contents
\`\`\`

RULES:
- ALWAYS use \`\`\`newfile: or \`\`\`edit: prefix
- NEVER output raw code without the prefix
- Include the FULL file path after the colon
- Output COMPLETE file contents, not snippets`;

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

export async function askGeneral(prompt: string, attachments?: ImageAttachment[], assembledContext?: string): Promise<string> {
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
    // Check if we're already in a capabilities conversation (for follow-ups)
    const wasInCapConvo = isCapabilitiesFollowUp();
    
    // Check if asking about capabilities
    const isCapQuery = isCapabilitiesQuery(prompt);
    logger.info('Checking capabilities query', { isCapQuery, wasInCapConvo, promptStart: prompt.substring(0, 50) });
    
    if (isCapQuery) {
      // Pass whether this is a follow-up for different instructions
      const isFollowUp = wasInCapConvo;
      skillsContext = await getCapabilitiesContext(isFollowUp);
      logger.info('Loaded capabilities context', { length: skillsContext.length, isFollowUp });
    } else {
      // Detect relevant skills based on prompt content
      skillsContext = await getSkillContext(prompt);
    }
    
    if (skillsContext) {
      logger.debug('Loaded context', { length: skillsContext.length });
    }
  }
  
  // Build tiered system prompt
  let systemPrompt = buildSystemPrompt(
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

  if (assembledContext) {
    systemPrompt += `\n\n## BRAIN 2 CONTEXT (grounded layers)\n${assembledContext}\n`;
  }

  try {
    // Smart model selection based on prompt complexity (with forced model support)
    const selectedModel = selectModel(prompt, forcedModel ?? undefined);
    const modelDisplay = forcedModel ? `[FORCED: ${forcedModel.toUpperCase()}]` : `[AUTO: ${selectedModel.tier.toUpperCase()}]`;
    const promptTokenEstimate = Math.ceil(systemPrompt.length / 4);
    const contextLayers = (systemPrompt.match(/## BRAIN 2 CONTEXT|## PROJECTS|## PREFERENCES|## CAPABILITIES/g) || []).length;
    logger.info(`Using ${selectedModel.tier.toUpperCase()} model ${modelDisplay} [${analysis.tier.toUpperCase()} prompt ~${promptTokenEstimate} tokens]`);
    console.log(`[COGNITIVE] Prompt size: ${systemPrompt.length} chars, context sections: ${contextLayers}, model: ${selectedModel.modelId}`);

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

    // Store globally for "apply that" command
    // When no active Cursor project: use Jeeves' own root so he can modify himself (signal-cursor-controller)
    const { ROOT } = await import('../config.js');
    const workingDir = activeSession?.workingDir || ROOT;
    globalLastResponse = {
      text,
      workingDir,
      timestamp: new Date()
    };
    logger.debug('Stored response for apply-that', { length: text.length, hasWorkingDir: !!workingDir, fallbackToSelf: !activeSession?.workingDir });

    // Auto-detect and apply code if this looks like a build/edit request
    const isBuildRequest = /\b(build|continue|finish|implement|create|write)\b/i.test(prompt);
    const hasCodeBlocks = /```(?:tsx?|jsx?|css|html|json|newfile:|edit:)/i.test(text);
    // Also detect raw code patterns (CSS selectors, React imports, etc.)
    const hasRawCode = /import\s+React|from\s+['"]react|^\s*\.[A-Z][a-zA-Z-]*\s*\{|export\s+default/m.test(text);
    
    if (isBuildRequest && (hasCodeBlocks || hasRawCode || text.length > 500)) {
      // workingDir is always set now (ROOT fallback when no active project)
      
      logger.info('Build request detected, auto-parsing response');
      const parseResult = await reParseLastResponse();
      if (parseResult.success) {
        return text + '\n\n---\n' + parseResult.message;
      } else {
        logger.debug('Auto-parse failed', { reason: parseResult.message });
      }
    }

    return text;
  } catch (error) {
    logger.error('General question failed', { error: String(error) });
    return `Sorry, I encountered an error: ${error instanceof Error ? error.message : 'Unknown error'}`;
  }
}

// Re-export FileChange type for external use
export type { FileChange };

// ============================================================================
// AUTONOMOUS BUILD LOOP
// Plans from PRD, then builds entire project without user intervention
// Includes safety features to prevent token waste
// ============================================================================

interface BuildProgress {
  phase: 'planning' | 'building' | 'complete' | 'stopped';
  iteration: number;
  filesCreated: string[];
  filesUpdated: string[];
  totalChanges: number;
  isComplete: boolean;
  estimatedCost: number;
  lastResponse: string;
}

interface BuildPlan {
  components: string[];
  files: string[];
  order?: string[];
  estimatedIterations: number;
  // NEW: Store original requirements for context persistence
  originalPrd?: string;
  // NEW: Track which items have been completed
  completedComponents: string[];
  completedFiles: string[];
}

/**
 * Helper: Get remaining plan items that haven't been completed yet
 */
function getRemainingPlanItems(plan: BuildPlan, filesCreated: string[], filesUpdated: string[]): {
  remainingComponents: string[];
  remainingFiles: string[];
  completionPercentage: number;
} {
  const allCreatedFiles = [...filesCreated, ...filesUpdated].map(f => f.toLowerCase());
  
  // Check which planned files have been created
  const remainingFiles = plan.files.filter(f => {
    const fLower = f.toLowerCase();
    // Check if any created file matches this planned file (fuzzy match)
    return !allCreatedFiles.some(cf => 
      cf.includes(fLower) || fLower.includes(cf) || 
      cf.endsWith(fLower) || fLower.endsWith(cf)
    );
  });
  
  // Check which components have been implemented (by checking if related files exist)
  const remainingComponents = plan.components.filter(comp => {
    const compWords = comp.toLowerCase().split(/[\s-_]+/);
    // A component is done if at least one file mentions it
    const isDone = allCreatedFiles.some(f => 
      compWords.some(word => word.length > 3 && f.includes(word))
    );
    return !isDone;
  });
  
  const totalItems = plan.components.length + plan.files.length;
  const completedItems = (plan.components.length - remainingComponents.length) + 
                         (plan.files.length - remainingFiles.length);
  const completionPercentage = totalItems > 0 ? Math.round((completedItems / totalItems) * 100) : 0;
  
  return { remainingComponents, remainingFiles, completionPercentage };
}

/**
 * Helper: Validate if build is truly complete against the original plan
 */
function validateBuildCompletion(
  plan: BuildPlan | null, 
  filesCreated: string[], 
  filesUpdated: string[]
): { isComplete: boolean; missingItems: string[]; completionPercentage: number } {
  if (!plan) {
    // No plan = can't validate, assume complete if we have files
    return { 
      isComplete: filesCreated.length > 0 || filesUpdated.length > 0, 
      missingItems: [],
      completionPercentage: 100
    };
  }
  
  const { remainingComponents, remainingFiles, completionPercentage } = 
    getRemainingPlanItems(plan, filesCreated, filesUpdated);
  
  const missingItems = [
    ...remainingComponents.map(c => `Component: ${c}`),
    ...remainingFiles.map(f => `File: ${f}`)
  ];
  
  // Consider complete if at least 80% done (allows for minor variations in naming)
  const isComplete = completionPercentage >= 80 || missingItems.length === 0;
  
  return { isComplete, missingItems, completionPercentage };
}

type BuildProgressCallback = (progress: BuildProgress) => void;

/**
 * Autonomously build a project to completion
 * 1. First creates a plan from the PRD/context
 * 2. Then builds iteratively until complete
 * 3. Has safety features to stop when done
 */
export async function autonomousBuild(
  projectPath: string,
  prdOrPrompt?: string,
  options: {
    maxIterations?: number;
    maxCostDollars?: number;
    onProgress?: BuildProgressCallback;
  } = {}
): Promise<{ success: boolean; message: string; totalChanges: number; estimatedCost: number }> {
  const maxIterations = options.maxIterations || 10;
  const maxCostDollars = options.maxCostDollars || 2.0; // Safety limit: $2 max
  const onProgress = options.onProgress;
  
  logger.info('Starting autonomous build', { projectPath, maxIterations, maxCostDollars });
  
  // Ensure we have an active session for this project
  if (!activeSession || activeSession.workingDir !== projectPath) {
    const sessionResult = await startAgentSession(projectPath);
    if (!sessionResult.success) {
      return { success: false, message: sessionResult.message, totalChanges: 0, estimatedCost: 0 };
    }
  }
  
  const filesCreated: string[] = [];
  const filesUpdated: string[] = [];
  let totalChanges = 0;
  let isComplete = false;
  let estimatedCost = 0;
  let consecutiveEmptyIterations = 0;
  let lastResponseHash = '';
  
  // ============================================================================
  // PHASE 1: PLANNING
  // ============================================================================
  
  logger.info('Phase 1: Planning build');
  
  if (onProgress) {
    onProgress({
      phase: 'planning',
      iteration: 0,
      filesCreated: [],
      filesUpdated: [],
      totalChanges: 0,
      isComplete: false,
      estimatedCost: 0,
      lastResponse: 'Creating build plan...'
    });
  }
  
  const planPrompt = prdOrPrompt
    ? `Analyze this project and the following requirements to create a BUILD PLAN.

REQUIREMENTS:
${prdOrPrompt}

OUTPUT FORMAT - respond with ONLY this JSON structure:
{
  "components": ["list of components/features to build"],
  "files": ["list of files that need to be created or modified"],
  "order": ["build order - what to create first, second, etc"],
  "estimatedIterations": <number 1-10>
}

Be concise. List only what's needed. Do NOT output any code yet.`
    : `Analyze the current project state and create a BUILD PLAN to complete it.

Review the existing files and determine what's missing.

OUTPUT FORMAT - respond with ONLY this JSON structure:
{
  "components": ["list of components/features still needed"],
  "files": ["list of files that need to be created or modified"],
  "order": ["build order - what to create first, second, etc"],
  "estimatedIterations": <number 1-10>
}

Be concise. List only what's needed. Do NOT output any code yet.`;

  let buildPlan: BuildPlan | null = null;
  
  try {
    const planResponse = await sendToAgent(planPrompt);
    estimatedCost += 0.02; // Rough estimate for planning call
    
    // Try to parse the plan
    const jsonMatch = planResponse.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        buildPlan = {
          components: parsed.components || [],
          files: parsed.files || [],
          order: parsed.order || undefined,
          estimatedIterations: Math.min(parsed.estimatedIterations || 5, maxIterations),
          // Store original PRD for context persistence
          originalPrd: prdOrPrompt || undefined,
          // Initialize completion tracking
          completedComponents: [],
          completedFiles: []
        };
        logger.info('Build plan created', { 
          components: buildPlan.components.length,
          files: buildPlan.files.length,
          estimatedIterations: buildPlan.estimatedIterations
        });
      } catch {
        logger.warn('Could not parse build plan JSON, proceeding with defaults');
      }
    }
  } catch (error) {
    logger.error('Planning phase failed', { error: String(error) });
    // Continue anyway with no plan
  }
  
  // ============================================================================
  // PHASE 2: BUILDING
  // ============================================================================
  
  logger.info('Phase 2: Building');
  
  // Completion detection patterns - AGGRESSIVE
  const completionPatterns = [
    /BUILD\s+COMPLETE/i,
    /project\s+is\s+(?:now\s+)?complete/i,
    /all\s+(?:features?|files?|components?)\s+(?:have been\s+)?(?:are\s+)?(?:now\s+)?(?:implemented|created|complete|built)/i,
    /nothing\s+(?:more\s+)?(?:left\s+)?to\s+(?:implement|add|create|build)/i,
    /fully\s+(?:implemented|functional|complete)/i,
    /implementation\s+is\s+complete/i,
    /everything\s+(?:is\s+)?(?:now\s+)?(?:in place|complete|done|built)/i,
    /no\s+(?:additional|more|further)\s+(?:files?|components?|features?)\s+(?:are\s+)?(?:needed|required)/i,
    /the\s+(?:application|app|project)\s+(?:is\s+)?(?:now\s+)?(?:fully\s+)?(?:functional|complete|ready)/i
  ];
  
  // Limit iterations based on plan
  const effectiveMaxIterations = buildPlan 
    ? Math.min(buildPlan.estimatedIterations + 2, maxIterations) // +2 buffer
    : maxIterations;
  
  for (let iteration = 1; iteration <= effectiveMaxIterations && !isComplete; iteration++) {
    // SAFETY: Check cost limit
    if (estimatedCost >= maxCostDollars) {
      logger.warn('Cost limit reached, stopping build', { estimatedCost, maxCostDollars });
      break;
    }
    
    // SAFETY: Check consecutive empty iterations (stall detection)
    if (consecutiveEmptyIterations >= 2) {
      logger.info('Stall detected (2 consecutive iterations with no changes), assuming complete');
      isComplete = true;
      break;
    }
    
    logger.info('Build iteration', { iteration, effectiveMaxIterations, estimatedCost });
    
    if (onProgress) {
      onProgress({
        phase: 'building',
        iteration,
        filesCreated: [...filesCreated],
        filesUpdated: [...filesUpdated],
        totalChanges,
        isComplete: false,
        estimatedCost,
        lastResponse: `Building iteration ${iteration}/${effectiveMaxIterations}...`
      });
    }
    
    // Build the prompt based on iteration
    // IMPROVEMENT: Always include full plan context and remaining items
    let buildPrompt: string;
    
    // Calculate remaining items from plan (for context persistence)
    const planContext = buildPlan ? (() => {
      const { remainingComponents, remainingFiles, completionPercentage } = 
        getRemainingPlanItems(buildPlan, filesCreated, filesUpdated);
      
      let context = `\n\n📋 BUILD PLAN STATUS (${completionPercentage}% complete):\n`;
      
      // Always show original requirements for context
      if (buildPlan.originalPrd) {
        context += `\n--- ORIGINAL REQUIREMENTS ---\n${buildPlan.originalPrd.substring(0, 1500)}${buildPlan.originalPrd.length > 1500 ? '...' : ''}\n--- END REQUIREMENTS ---\n`;
      }
      
      context += `\nFULL PLAN:\n`;
      context += `Components to build: ${buildPlan.components.join(', ')}\n`;
      context += `Files to create: ${buildPlan.files.join(', ')}\n`;
      
      if (remainingComponents.length > 0 || remainingFiles.length > 0) {
        context += `\n⚠️ REMAINING (NOT YET IMPLEMENTED):\n`;
        if (remainingComponents.length > 0) {
          context += `  Components: ${remainingComponents.join(', ')}\n`;
        }
        if (remainingFiles.length > 0) {
          context += `  Files: ${remainingFiles.join(', ')}\n`;
        }
        context += `\nYou MUST implement all remaining items before declaring BUILD COMPLETE.\n`;
      }
      
      return context;
    })() : '';
    
    if (iteration === 1) {
      // First iteration - start building based on plan
      buildPrompt = buildPlan
        ? `Execute the build plan. Create the following in order:
${buildPlan.order ? buildPlan.order.map((item, i) => `${i + 1}. ${item}`).join('\n') : buildPlan.files.slice(0, 3).map((f, i) => `${i + 1}. ${f}`).join('\n')}
${planContext}
Start with the first items now. Output the COMPLETE file contents.`
        : `Build this project to completion. Start creating the necessary files NOW.`;
    } else {
      // Subsequent iterations - continue building with plan context
      buildPrompt = `Continue building. You have created: ${filesCreated.concat(filesUpdated).join(', ') || 'nothing yet'}.
${planContext}
What's NEXT? 

⚠️ IMPORTANT: Do NOT say "BUILD COMPLETE" unless ALL items from the plan above have been implemented.
Check the REMAINING items list above - if there are remaining items, implement them NOW.

If truly everything from the plan is complete and functional, respond with: "BUILD COMPLETE - all features implemented."

Otherwise, create the next file(s) needed. Focus on what's MISSING from the plan.`;
    }
    
    // Add format instructions - VERY EMPHATIC to ensure AI follows format
    const formattedPrompt = `${buildPrompt}

⚠️ MANDATORY OUTPUT FORMAT ⚠️
You MUST use this EXACT format. Code without this format WILL BE IGNORED:

For NEW files:
\`\`\`newfile:src/components/ExampleComponent.tsx
import React from 'react';

const ExampleComponent = () => {
  return <div>Example</div>;
};

export default ExampleComponent;
\`\`\`

For EXISTING files:
\`\`\`edit:src/App.tsx
// Complete new file contents go here
\`\`\`

RULES:
1. EVERY code block MUST start with \`\`\`newfile: or \`\`\`edit:
2. Include the FULL file path after the colon
3. Output COMPLETE file contents - no partial snippets
4. One file per code block
5. NO explanatory text between code blocks
6. Do NOT use \`\`\`tsx or \`\`\`css - use \`\`\`newfile: or \`\`\`edit:

NOW OUTPUT THE FILES:`;

    try {
      const response = await sendToAgent(formattedPrompt);
      estimatedCost += 0.05; // Rough estimate per iteration
      
      // SAFETY: Detect duplicate responses (stall)
      const responseHash = response.substring(0, 200);
      if (responseHash === lastResponseHash) {
        logger.info('Duplicate response detected, incrementing stall counter');
        consecutiveEmptyIterations++;
      }
      lastResponseHash = responseHash;
      
      // Check for completion - BUT VALIDATE AGAINST PLAN FIRST
      let aiClaimsComplete = false;
      for (const pattern of completionPatterns) {
        if (pattern.test(response)) {
          aiClaimsComplete = true;
          logger.info('AI claims build complete', { pattern: pattern.toString() });
          break;
        }
      }
      
      // IMPROVEMENT: Validate completion against the original plan
      if (aiClaimsComplete && buildPlan) {
        const validation = validateBuildCompletion(buildPlan, filesCreated, filesUpdated);
        
        if (validation.isComplete) {
          isComplete = true;
          logger.info('Build completion VALIDATED', { 
            completionPercentage: validation.completionPercentage 
          });
        } else {
          // AI said complete but plan items are missing - continue building
          logger.warn('AI claimed complete but plan items missing', { 
            missingItems: validation.missingItems.slice(0, 5),
            completionPercentage: validation.completionPercentage
          });
          
          // Don't mark as complete - the next iteration prompt will remind AI
          // of the remaining items
          isComplete = false;
        }
      } else if (aiClaimsComplete) {
        // No plan to validate against, trust the AI
        isComplete = true;
        logger.info('Build completion accepted (no plan to validate)');
      }
      
      // Parse and apply changes
      const parseResult = await reParseLastResponse();
      
      if (parseResult.success) {
        consecutiveEmptyIterations = 0; // Reset stall counter
        
        // Extract file names from the result message
        const createdMatches = [...parseResult.message.matchAll(/Create\s+(\S+)/gi)];
        const updatedMatches = [...parseResult.message.matchAll(/Update\s+(\S+)/gi)];
        
        for (const match of createdMatches) {
          if (!filesCreated.includes(match[1])) filesCreated.push(match[1]);
          totalChanges++;
        }
        for (const match of updatedMatches) {
          if (!filesUpdated.includes(match[1])) filesUpdated.push(match[1]);
          totalChanges++;
        }
        
        logger.info('Iteration complete', { 
          iteration, 
          changesThisIteration: createdMatches.length + updatedMatches.length,
          totalChanges 
        });
      } else {
        // No changes extracted
        consecutiveEmptyIterations++;
        logger.info('No changes extracted', { 
          consecutiveEmpty: consecutiveEmptyIterations,
          reason: parseResult.message 
        });
        
        // If no code blocks at all, likely complete
        if (!response.includes('```') && iteration > 1) {
          logger.info('No code blocks in response, assuming complete');
          isComplete = true;
        }
      }
      
      // Small delay between iterations
      if (!isComplete && iteration < effectiveMaxIterations) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      
    } catch (error) {
      logger.error('Build iteration failed', { iteration, error: String(error) });
      return {
        success: false,
        message: `Build failed at iteration ${iteration}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        totalChanges,
        estimatedCost
      };
    }
  }
  
  // ============================================================================
  // SUMMARY - Now includes plan validation
  // ============================================================================
  
  // Final validation against plan
  const finalValidation = buildPlan 
    ? validateBuildCompletion(buildPlan, filesCreated, filesUpdated)
    : { isComplete: true, missingItems: [], completionPercentage: 100 };
  
  const stopReason = isComplete 
    ? 'complete'
    : consecutiveEmptyIterations >= 2 
      ? 'stalled'
      : estimatedCost >= maxCostDollars
        ? 'cost_limit'
        : 'max_iterations';
  
  let summary = isComplete
    ? `✓ Build complete! Created ${filesCreated.length} files, updated ${filesUpdated.length} files.`
    : stopReason === 'stalled'
      ? `✓ Build finished (no more changes detected). Created ${filesCreated.length} files, updated ${filesUpdated.length} files.`
      : stopReason === 'cost_limit'
        ? `⚠️ Build stopped (cost limit $${maxCostDollars} reached). Created ${filesCreated.length} files, updated ${filesUpdated.length} files.`
        : `⚠️ Build stopped (max iterations). Created ${filesCreated.length} files, updated ${filesUpdated.length} files.`;
  
  // Add plan completion percentage
  if (buildPlan) {
    summary += ` Plan completion: ${finalValidation.completionPercentage}%`;
    
    // Warn about missing items
    if (finalValidation.missingItems.length > 0 && !isComplete) {
      summary += `\n\n⚠️ Missing from plan (${finalValidation.missingItems.length} items):\n`;
      summary += finalValidation.missingItems.slice(0, 10).map(item => `  • ${item}`).join('\n');
      if (finalValidation.missingItems.length > 10) {
        summary += `\n  ... and ${finalValidation.missingItems.length - 10} more`;
      }
    }
  }
  
  logger.info('Autonomous build finished', { 
    isComplete, 
    stopReason,
    filesCreated: filesCreated.length,
    filesUpdated: filesUpdated.length,
    totalChanges,
    estimatedCost 
  });
  
  if (onProgress) {
    onProgress({
      phase: isComplete || stopReason === 'stalled' ? 'complete' : 'stopped',
      iteration: effectiveMaxIterations,
      filesCreated: [...filesCreated],
      filesUpdated: [...filesUpdated],
      totalChanges,
      isComplete: isComplete || stopReason === 'stalled',
      estimatedCost,
      lastResponse: summary
    });
  }
  
  const fileList = filesCreated.length > 0
    ? '\n\nFiles created:\n' + filesCreated.map(f => '  ✓ ' + f).join('\n')
    : '';
  const updateList = filesUpdated.length > 0
    ? '\n\nFiles updated:\n' + filesUpdated.map(f => '  ✓ ' + f).join('\n')
    : '';
  const costNote = `\n\nEstimated cost: ~$${estimatedCost.toFixed(2)}`;
  
  return {
    success: true,
    message: summary + fileList + updateList + costNote,
    totalChanges,
    estimatedCost
  };
}
