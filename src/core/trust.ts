/**
 * Trust System - Phase 6
 * 
 * Manages trust levels that determine what Jeeves can do autonomously.
 * Trust is earned through successful tasks and lost through failures.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { 
  TrustState, 
  TrustLevelNumber, 
  TrustLevelPermissions,
  TrustHistoryEntry,
  TaskRecord,
  LearnedPreferences,
  CorrectionRecord
} from '../types/index.js';

// Trust level definitions
const TRUST_LEVELS: Record<TrustLevelNumber, TrustLevelPermissions> = {
  1: {
    name: 'supervised',
    canCommit: false,
    canSpend: false,
    canContact: false,
    checkpointFrequency: 'every-change',
    requiresApproval: ['everything']
  },
  2: {
    name: 'semi-autonomous',
    canCommit: true,
    canSpend: { max: 5 },
    canContact: false,
    checkpointFrequency: 'per-phase',
    requiresApproval: ['prd-plans', 'deviations', 'spending']
  },
  3: {
    name: 'trusted',
    canCommit: true,
    canSpend: { max: 20 },
    canContact: { draftsOnly: true },
    checkpointFrequency: 'per-task',
    requiresApproval: ['large-refactors', 'external-communication']
  },
  4: {
    name: 'autonomous',
    canCommit: true,
    canSpend: { max: 50 },
    canContact: { preApprovedTemplates: true },
    checkpointFrequency: 'on-completion',
    requiresApproval: ['large-spending', 'production-deploys']
  },
  5: {
    name: 'full-trust',
    canCommit: true,
    canSpend: { max: 100 },
    canContact: true,
    checkpointFrequency: 'on-completion',
    requiresApproval: ['safety-critical']
  }
};

// Storage paths
const TRUST_STORAGE_PATH = './data/trust.json';
const PREFERENCES_STORAGE_PATH = './data/learned-preferences.json';

// In-memory state
let trustState: TrustState | null = null;
let learnedPreferences: LearnedPreferences | null = null;

/**
 * Initialize trust state from storage or defaults
 */
function initTrustState(): TrustState {
  const defaultState: TrustState = {
    currentLevel: config.trust.initial_level,
    history: [{
      date: new Date().toISOString(),
      level: config.trust.initial_level,
      reason: 'initial'
    }],
    taskHistory: [],
    successfulTasksAtLevel: 0,
    daysAtLevel: 0,
    levelStartDate: new Date().toISOString(),
    totalSpend: 0,
    totalSpendLimit: config.trust.monthly_spend_limit
  };

  if (!existsSync(TRUST_STORAGE_PATH)) {
    return defaultState;
  }

  try {
    const data = readFileSync(TRUST_STORAGE_PATH, 'utf-8');
    const stored = JSON.parse(data) as TrustState;
    
    // Calculate days at level
    const levelStart = new Date(stored.levelStartDate);
    stored.daysAtLevel = Math.floor((Date.now() - levelStart.getTime()) / (1000 * 60 * 60 * 24));
    
    return stored;
  } catch (error) {
    logger.warn('Failed to load trust state, using defaults', { error: String(error) });
    return defaultState;
  }
}

/**
 * Save trust state to storage
 */
function saveTrustState(): void {
  if (!trustState) return;

  try {
    const dir = dirname(TRUST_STORAGE_PATH);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(TRUST_STORAGE_PATH, JSON.stringify(trustState, null, 2));
  } catch (error) {
    logger.error('Failed to save trust state', { error: String(error) });
  }
}

/**
 * Initialize learned preferences from storage or defaults
 */
function initLearnedPreferences(): LearnedPreferences {
  const defaultPrefs: LearnedPreferences = {
    codeStyle: { confidence: 0 },
    communication: { confidence: 0 },
    decisions: { confidence: 0 },
    personality: { 
      traits: [], 
      rememberStatements: [], 
      dontDoStatements: [],
      confidence: 0 
    },
    corrections: []
  };

  if (!existsSync(PREFERENCES_STORAGE_PATH)) {
    return defaultPrefs;
  }

  try {
    const data = readFileSync(PREFERENCES_STORAGE_PATH, 'utf-8');
    const loaded = JSON.parse(data) as LearnedPreferences;
    // Migrate old preferences that don't have personality
    if (!loaded.personality) {
      loaded.personality = defaultPrefs.personality;
    }
    return loaded;
  } catch (error) {
    logger.warn('Failed to load learned preferences, using defaults', { error: String(error) });
    return defaultPrefs;
  }
}

/**
 * Save learned preferences to storage
 */
function saveLearnedPreferences(): void {
  if (!learnedPreferences) return;

  try {
    const dir = dirname(PREFERENCES_STORAGE_PATH);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(PREFERENCES_STORAGE_PATH, JSON.stringify(learnedPreferences, null, 2));
  } catch (error) {
    logger.error('Failed to save learned preferences', { error: String(error) });
  }
}

/**
 * Initialize trust system
 */
export function initTrust(): void {
  if (!config.trust.enabled) {
    logger.info('Trust system disabled');
    return;
  }

  trustState = initTrustState();
  learnedPreferences = initLearnedPreferences();
  
  logger.info('Trust system initialized', { 
    level: trustState.currentLevel,
    name: TRUST_LEVELS[trustState.currentLevel].name,
    successfulTasks: trustState.successfulTasksAtLevel,
    daysAtLevel: trustState.daysAtLevel
  });
}

/**
 * Get current trust level
 */
export function getTrustLevel(): TrustLevelNumber {
  if (!trustState) initTrust();
  return trustState?.currentLevel || config.trust.initial_level;
}

/**
 * Get current trust permissions
 */
export function getTrustPermissions(): TrustLevelPermissions {
  const level = getTrustLevel();
  return TRUST_LEVELS[level];
}

/**
 * Check if an action is allowed at current trust level
 */
export function isActionAllowed(action: string): { allowed: boolean; reason?: string } {
  if (!config.trust.enabled) {
    return { allowed: true };
  }

  const permissions = getTrustPermissions();

  // Check specific permissions
  if (action === 'commit' && !permissions.canCommit) {
    return { allowed: false, reason: `Commits require trust level 2+. Current: ${permissions.name}` };
  }

  if (action === 'spend') {
    if (!permissions.canSpend) {
      return { allowed: false, reason: `Spending requires trust level 2+. Current: ${permissions.name}` };
    }
  }

  if (action === 'contact') {
    if (!permissions.canContact) {
      return { allowed: false, reason: `External contact requires trust level 3+. Current: ${permissions.name}` };
    }
  }

  // Check if action requires approval
  if (permissions.requiresApproval.includes('everything') || 
      permissions.requiresApproval.includes(action)) {
    return { allowed: true, reason: 'Requires approval' };
  }

  return { allowed: true };
}

/**
 * Check spending limit
 */
export function checkSpendLimit(amount: number): { allowed: boolean; reason?: string } {
  if (!config.trust.enabled) {
    return { allowed: true };
  }

  if (!trustState) initTrust();

  const permissions = getTrustPermissions();
  
  if (!permissions.canSpend) {
    return { allowed: false, reason: 'Spending not allowed at current trust level' };
  }

  const maxPerTask = typeof permissions.canSpend === 'object' 
    ? permissions.canSpend.max 
    : config.trust.per_task_spend_limit;

  if (amount > maxPerTask) {
    return { allowed: false, reason: `Amount $${amount} exceeds per-task limit of $${maxPerTask}` };
  }

  if (trustState && (trustState.totalSpend + amount) > trustState.totalSpendLimit) {
    return { allowed: false, reason: `Would exceed monthly spend limit of $${trustState.totalSpendLimit}` };
  }

  return { allowed: true };
}

/**
 * Record a completed task
 */
export function recordTask(task: Omit<TaskRecord, 'id'>): void {
  if (!trustState) initTrust();
  if (!trustState) return;

  const record: TaskRecord = {
    ...task,
    id: `task-${Date.now()}`
  };

  trustState.taskHistory.push(record);

  // Keep only last 100 tasks
  if (trustState.taskHistory.length > 100) {
    trustState.taskHistory = trustState.taskHistory.slice(-100);
  }

  if (task.success && !task.rollback) {
    trustState.successfulTasksAtLevel++;
    logger.info('Task recorded successfully', { 
      successfulTasks: trustState.successfulTasksAtLevel,
      required: config.trust.successful_tasks_required
    });
  }

  if (task.spendAmount) {
    trustState.totalSpend += task.spendAmount;
  }

  // Check for trust upgrade eligibility
  checkTrustUpgrade();

  saveTrustState();
}

/**
 * Record a rollback/failure
 */
export function recordRollback(reason: string): void {
  if (!trustState) initTrust();
  if (!trustState) return;

  logger.warn('Recording rollback', { reason });

  // Drop trust level
  if (trustState.currentLevel > 1) {
    const newLevel = (trustState.currentLevel - 1) as TrustLevelNumber;
    
    trustState.history.push({
      date: new Date().toISOString(),
      level: newLevel,
      reason: `Rollback: ${reason}`
    });

    trustState.currentLevel = newLevel;
    trustState.successfulTasksAtLevel = 0;
    trustState.levelStartDate = new Date().toISOString();
    trustState.daysAtLevel = 0;

    logger.warn('Trust level decreased', { 
      from: trustState.currentLevel + 1, 
      to: newLevel,
      reason 
    });
  }

  saveTrustState();
}

/**
 * Check if eligible for trust upgrade
 */
function checkTrustUpgrade(): { eligible: boolean; reason?: string } {
  if (!trustState) return { eligible: false, reason: 'No trust state' };
  if (trustState.currentLevel >= 5) return { eligible: false, reason: 'Already at max level' };

  const hasEnoughTasks = trustState.successfulTasksAtLevel >= config.trust.successful_tasks_required;
  const hasEnoughTime = trustState.daysAtLevel >= config.trust.time_at_level_minimum_days;

  // Count rollbacks at current level
  const rollbacksAtLevel = trustState.taskHistory
    .filter(t => t.rollback && new Date(t.startedAt) >= new Date(trustState!.levelStartDate))
    .length;
  const noRollbacks = rollbacksAtLevel <= config.trust.rollbacks_allowed;

  if (hasEnoughTasks && hasEnoughTime && noRollbacks) {
    return { eligible: true };
  }

  const reasons: string[] = [];
  if (!hasEnoughTasks) {
    reasons.push(`Need ${config.trust.successful_tasks_required - trustState.successfulTasksAtLevel} more successful tasks`);
  }
  if (!hasEnoughTime) {
    reasons.push(`Need ${config.trust.time_at_level_minimum_days - trustState.daysAtLevel} more days at level`);
  }
  if (!noRollbacks) {
    reasons.push(`Too many rollbacks (${rollbacksAtLevel})`);
  }

  return { eligible: false, reason: reasons.join('; ') };
}

/**
 * Request trust level upgrade
 */
export function requestTrustUpgrade(): { 
  success: boolean; 
  newLevel?: TrustLevelNumber; 
  message: string 
} {
  if (!trustState) initTrust();
  if (!trustState) {
    return { success: false, message: 'Trust system not initialized' };
  }

  const eligibility = checkTrustUpgrade();
  
  if (!eligibility.eligible) {
    return { 
      success: false, 
      message: `Not eligible for upgrade. ${eligibility.reason}` 
    };
  }

  const newLevel = (trustState.currentLevel + 1) as TrustLevelNumber;
  const newPermissions = TRUST_LEVELS[newLevel];

  trustState.history.push({
    date: new Date().toISOString(),
    level: newLevel,
    reason: `Earned upgrade: ${trustState.successfulTasksAtLevel} successful tasks, ${trustState.daysAtLevel} days`
  });

  trustState.currentLevel = newLevel;
  trustState.successfulTasksAtLevel = 0;
  trustState.levelStartDate = new Date().toISOString();
  trustState.daysAtLevel = 0;

  saveTrustState();

  logger.info('Trust level upgraded', { to: newLevel, name: newPermissions.name });

  return {
    success: true,
    newLevel,
    message: `Trust upgraded to Level ${newLevel} (${newPermissions.name})!\n\nNew permissions:\n- Checkpoint: ${newPermissions.checkpointFrequency}\n- Can commit: ${newPermissions.canCommit}\n- Spending limit: $${typeof newPermissions.canSpend === 'object' ? newPermissions.canSpend.max : 0}`
  };
}

/**
 * Get trust status for display
 */
export function getTrustStatus(): string {
  if (!config.trust.enabled) {
    return 'Trust system disabled.';
  }

  if (!trustState) initTrust();
  if (!trustState) {
    return 'Trust system not initialized.';
  }

  const permissions = TRUST_LEVELS[trustState.currentLevel];
  const eligibility = checkTrustUpgrade();

  const lines = [
    `## Trust Level: ${trustState.currentLevel}/5 (${permissions.name})`,
    '',
    '### Current Permissions',
    `- **Checkpoints:** ${permissions.checkpointFrequency}`,
    `- **Can commit:** ${permissions.canCommit ? 'Yes' : 'No'}`,
    `- **Spending limit:** $${typeof permissions.canSpend === 'object' ? permissions.canSpend.max : 0}`,
    `- **External contact:** ${permissions.canContact ? 'Yes' : 'No'}`,
    '',
    '### Progress',
    `- Successful tasks: ${trustState.successfulTasksAtLevel}/${config.trust.successful_tasks_required}`,
    `- Days at level: ${trustState.daysAtLevel}/${config.trust.time_at_level_minimum_days}`,
    `- Monthly spend: $${trustState.totalSpend.toFixed(2)}/$${trustState.totalSpendLimit}`,
    ''
  ];

  if (trustState.currentLevel < 5) {
    if (eligibility.eligible) {
      lines.push('**Ready for upgrade!** Say "upgrade trust" to increase autonomy.');
    } else {
      lines.push(`**Next level requires:** ${eligibility.reason}`);
    }
  } else {
    lines.push('**Maximum trust level reached.**');
  }

  return lines.join('\n');
}

/**
 * Get trust history
 */
export function getTrustHistory(): string {
  if (!trustState) initTrust();
  if (!trustState || trustState.history.length === 0) {
    return 'No trust history available.';
  }

  const lines = ['## Trust History', ''];

  for (const entry of trustState.history.slice(-10).reverse()) {
    const date = new Date(entry.date).toLocaleDateString();
    lines.push(`- **${date}**: Level ${entry.level} - ${entry.reason}`);
  }

  return lines.join('\n');
}

/**
 * Record a user correction for preference learning
 */
export function recordCorrection(
  original: string, 
  corrected: string, 
  category: CorrectionRecord['category'],
  learned: string
): void {
  if (!learnedPreferences) initTrust();
  if (!learnedPreferences) return;

  const record: CorrectionRecord = {
    timestamp: new Date().toISOString(),
    original,
    corrected,
    category,
    learned
  };

  learnedPreferences.corrections.push(record);

  // Keep only last 50 corrections
  if (learnedPreferences.corrections.length > 50) {
    learnedPreferences.corrections = learnedPreferences.corrections.slice(-50);
  }

  // Update preferences based on category
  updatePreferencesFromCorrection(record);

  saveLearnedPreferences();
  logger.info('Correction recorded', { category, learned });
}

/**
 * Update preferences based on a correction
 */
function updatePreferencesFromCorrection(correction: CorrectionRecord): void {
  if (!learnedPreferences) return;

  switch (correction.category) {
    case 'code-style':
      // Boost code style confidence
      learnedPreferences.codeStyle.confidence = Math.min(
        100,
        learnedPreferences.codeStyle.confidence + 5
      );
      break;

    case 'library':
      // Update preferred libraries
      if (!learnedPreferences.codeStyle.preferredLibraries) {
        learnedPreferences.codeStyle.preferredLibraries = {};
      }
      // Parse correction for library preferences
      const avoidMatch = correction.learned.match(/avoid\s+(\w+)/i);
      const preferMatch = correction.learned.match(/prefer\s+(\w+)/i);
      if (avoidMatch) {
        learnedPreferences.codeStyle.preferredLibraries[avoidMatch[1]] = false;
      }
      if (preferMatch) {
        learnedPreferences.codeStyle.preferredLibraries[preferMatch[1]] = true;
      }
      break;

    case 'communication':
      learnedPreferences.communication.confidence = Math.min(
        100,
        learnedPreferences.communication.confidence + 5
      );
      break;

    case 'approach':
      learnedPreferences.decisions.confidence = Math.min(
        100,
        learnedPreferences.decisions.confidence + 5
      );
      break;
  }
}

/**
 * Get learned preferences for display
 */
export function getLearnedPreferences(): string {
  if (!learnedPreferences) initTrust();
  if (!learnedPreferences) {
    return 'No learned preferences available.';
  }

  const lines = ['## Learned Preferences', ''];

  // Code style
  if (learnedPreferences.codeStyle.confidence > 0) {
    lines.push(`### Code Style (${learnedPreferences.codeStyle.confidence}% confidence)`);
    if (learnedPreferences.codeStyle.prefersFunctionalComponents !== undefined) {
      lines.push(`- Functional components: ${learnedPreferences.codeStyle.prefersFunctionalComponents ? 'Preferred' : 'Avoid'}`);
    }
    if (learnedPreferences.codeStyle.prefersNamedExports !== undefined) {
      lines.push(`- Named exports: ${learnedPreferences.codeStyle.prefersNamedExports ? 'Preferred' : 'Avoid'}`);
    }
    if (learnedPreferences.codeStyle.preferredLibraries) {
      const libs = Object.entries(learnedPreferences.codeStyle.preferredLibraries);
      if (libs.length > 0) {
        lines.push('- Libraries:');
        for (const [lib, preferred] of libs) {
          lines.push(`  - ${lib}: ${preferred ? '✓ Use' : '✗ Avoid'}`);
        }
      }
    }
    lines.push('');
  }

  // Communication
  if (learnedPreferences.communication.confidence > 0) {
    lines.push(`### Communication (${learnedPreferences.communication.confidence}% confidence)`);
    if (learnedPreferences.communication.prefersConcisenessOver) {
      lines.push(`- Style: ${learnedPreferences.communication.prefersConcisenessOver}`);
    }
    if (learnedPreferences.communication.checkpointFrequency) {
      lines.push(`- Checkpoints: ${learnedPreferences.communication.checkpointFrequency}`);
    }
    lines.push('');
  }

  // Decisions
  if (learnedPreferences.decisions.confidence > 0) {
    lines.push(`### Decision Making (${learnedPreferences.decisions.confidence}% confidence)`);
    if (learnedPreferences.decisions.whenUncertain) {
      lines.push(`- When uncertain: ${learnedPreferences.decisions.whenUncertain}`);
    }
    if (learnedPreferences.decisions.deviationThreshold) {
      lines.push(`- Deviation tolerance: ${learnedPreferences.decisions.deviationThreshold}`);
    }
    lines.push('');
  }

  // Personality
  if (learnedPreferences.personality && learnedPreferences.personality.confidence > 0) {
    lines.push(`### Personality (${learnedPreferences.personality.confidence}% confidence)`);
    if (learnedPreferences.personality.role) {
      lines.push(`- Role: ${learnedPreferences.personality.role}`);
    }
    if (learnedPreferences.personality.traits.length > 0) {
      lines.push(`- Traits: ${learnedPreferences.personality.traits.join(', ')}`);
    }
    if (learnedPreferences.personality.rememberStatements.length > 0) {
      lines.push('- Remember:');
      for (const stmt of learnedPreferences.personality.rememberStatements) {
        lines.push(`  - ${stmt}`);
      }
    }
    if (learnedPreferences.personality.dontDoStatements.length > 0) {
      lines.push('- Don\'t:');
      for (const stmt of learnedPreferences.personality.dontDoStatements) {
        lines.push(`  - ${stmt}`);
      }
    }
    lines.push('');
  }

  // Recent corrections
  if (learnedPreferences.corrections.length > 0) {
    lines.push('### Recent Corrections');
    for (const c of learnedPreferences.corrections.slice(-5).reverse()) {
      const date = new Date(c.timestamp).toLocaleDateString();
      lines.push(`- **${date}** (${c.category}): ${c.learned}`);
    }
  }

  if (lines.length === 2) {
    lines.push('No preferences learned yet. I learn from your corrections and approvals.');
  }

  return lines.join('\n');
}

/**
 * Get trust state for external use
 */
export function getTrustState(): TrustState | null {
  if (!trustState) initTrust();
  return trustState;
}

/**
 * Save a personality preference (remember statement)
 */
export function rememberPersonality(statement: string): string {
  if (!learnedPreferences) initTrust();
  if (!learnedPreferences) return 'Error: preferences not initialized';
  
  // Ensure personality section exists
  if (!learnedPreferences.personality) {
    learnedPreferences.personality = {
      traits: [],
      rememberStatements: [],
      dontDoStatements: [],
      confidence: 0
    };
  }
  
  // Check if it's a "don't" statement
  const dontMatch = statement.match(/^(?:don'?t|never|stop|avoid)\s+(.+)$/i);
  if (dontMatch) {
    const dontStatement = dontMatch[1];
    if (!learnedPreferences.personality.dontDoStatements.includes(dontStatement)) {
      learnedPreferences.personality.dontDoStatements.push(dontStatement);
      learnedPreferences.personality.confidence = Math.min(100, learnedPreferences.personality.confidence + 10);
      saveLearnedPreferences();
      logger.info('Saved personality preference (don\'t)', { statement: dontStatement });
      return `I'll remember: Don't ${dontStatement}`;
    }
    return `I already know: Don't ${dontStatement}`;
  }
  
  // Regular remember statement
  if (!learnedPreferences.personality.rememberStatements.includes(statement)) {
    learnedPreferences.personality.rememberStatements.push(statement);
    learnedPreferences.personality.confidence = Math.min(100, learnedPreferences.personality.confidence + 10);
    saveLearnedPreferences();
    logger.info('Saved personality preference', { statement });
    return `I'll remember: ${statement}`;
  }
  return `I already know: ${statement}`;
}

/**
 * Set role/identity
 */
export function setPersonalityRole(role: string): string {
  if (!learnedPreferences) initTrust();
  if (!learnedPreferences) return 'Error: preferences not initialized';
  
  if (!learnedPreferences.personality) {
    learnedPreferences.personality = {
      traits: [],
      rememberStatements: [],
      dontDoStatements: [],
      confidence: 0
    };
  }
  
  learnedPreferences.personality.role = role;
  learnedPreferences.personality.confidence = Math.min(100, learnedPreferences.personality.confidence + 20);
  saveLearnedPreferences();
  logger.info('Set personality role', { role });
  return `My role is now: ${role}`;
}

/**
 * Add a personality trait
 */
export function addPersonalityTrait(trait: string): string {
  if (!learnedPreferences) initTrust();
  if (!learnedPreferences) return 'Error: preferences not initialized';
  
  if (!learnedPreferences.personality) {
    learnedPreferences.personality = {
      traits: [],
      rememberStatements: [],
      dontDoStatements: [],
      confidence: 0
    };
  }
  
  const normalizedTrait = trait.toLowerCase().trim();
  if (!learnedPreferences.personality.traits.includes(normalizedTrait)) {
    learnedPreferences.personality.traits.push(normalizedTrait);
    learnedPreferences.personality.confidence = Math.min(100, learnedPreferences.personality.confidence + 5);
    saveLearnedPreferences();
    logger.info('Added personality trait', { trait: normalizedTrait });
    return `Added trait: ${normalizedTrait}`;
  }
  return `I already have the trait: ${normalizedTrait}`;
}

/**
 * Get personality preferences as context for AI
 */
export function getPersonalityContext(): string {
  if (!learnedPreferences) initTrust();
  if (!learnedPreferences?.personality) return '';
  
  const p = learnedPreferences.personality;
  if (p.confidence === 0) return '';
  
  const lines: string[] = [];
  
  if (p.role) {
    lines.push(`Your role: ${p.role}`);
  }
  
  if (p.traits.length > 0) {
    lines.push(`Your personality traits: ${p.traits.join(', ')}`);
  }
  
  if (p.rememberStatements.length > 0) {
    lines.push('Things the user wants you to remember:');
    for (const stmt of p.rememberStatements) {
      lines.push(`- ${stmt}`);
    }
  }
  
  if (p.dontDoStatements.length > 0) {
    lines.push('Things the user does NOT want you to do:');
    for (const stmt of p.dontDoStatements) {
      lines.push(`- ${stmt}`);
    }
  }
  
  return lines.join('\n');
}

/**
 * Get raw learned preferences object
 */
export function getRawPreferences(): LearnedPreferences | null {
  if (!learnedPreferences) initTrust();
  return learnedPreferences;
}
