/**
 * Jeeves Self-Updater
 * 
 * Periodically checks for upstream changes to the Jeeves repo,
 * pulls new code, rebuilds, and restarts the process.
 * 
 * Flow:
 *   1. Every 5 minutes: `git fetch origin`
 *   2. Compare local HEAD vs origin/main
 *   3. If behind:
 *      a. Notify Matt
 *      b. `git pull origin main`
 *      c. `npm run build`
 *      d. If build succeeds: `process.exit(0)` → systemd auto-restarts (Restart=always)
 *      e. If build fails: revert, log error, notify Matt
 * 
 * Safety:
 *   - Won't auto-update if there are local uncommitted changes
 *   - Won't restart mid-task (checks for active Cursor tasks)
 *   - Build failure triggers automatic revert
 *   - Matt can disable auto-update via config or command
 */

import { execSync, ExecSyncOptions } from 'child_process';
import { logger } from '../../utils/logger.js';
import { config } from '../../config.js';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_DIR = resolve(__dirname, '..', '..', '..');  // project root

// ============================================================================
// State
// ============================================================================

interface UpdateState {
  lastCheck: string;
  lastUpdate: string;
  localHead: string;
  remoteHead: string;
  behind: number;
  autoUpdateEnabled: boolean;
  updateInProgress: boolean;
  lastError: string | null;
  history: UpdateEvent[];
}

interface UpdateEvent {
  timestamp: string;
  type: 'check' | 'pull' | 'build' | 'restart' | 'error' | 'revert';
  message: string;
  success: boolean;
}

const state: UpdateState = {
  lastCheck: '',
  lastUpdate: '',
  localHead: '',
  remoteHead: '',
  behind: 0,
  autoUpdateEnabled: true,
  updateInProgress: false,
  lastError: null,
  history: [],
};

let checkInterval: ReturnType<typeof setInterval> | null = null;
let broadcastFn: ((type: string, payload: unknown) => void) | null = null;
let activeTaskChecker: (() => boolean) | null = null;

const CHECK_INTERVAL_MS = 300000;  // 5 minutes
const MAX_HISTORY = 50;

// ============================================================================
// Setup
// ============================================================================

export function setUpdateBroadcast(fn: (type: string, payload: unknown) => void): void {
  broadcastFn = fn;
}

export function setActiveTaskChecker(fn: () => boolean): void {
  activeTaskChecker = fn;
}

function broadcast(type: string, payload: unknown): void {
  if (broadcastFn) broadcastFn(type, payload);
}

function addEvent(type: UpdateEvent['type'], message: string, success: boolean): void {
  state.history.unshift({ timestamp: new Date().toISOString(), type, message, success });
  if (state.history.length > MAX_HISTORY) state.history.pop();
}

// ============================================================================
// Git Operations
// ============================================================================

const execOpts: ExecSyncOptions = { cwd: REPO_DIR, timeout: 30000, encoding: 'utf-8' };

function git(cmd: string): string {
  try {
    return execSync(`git ${cmd}`, { ...execOpts, stdio: 'pipe' }).toString().trim();
  } catch (err) {
    const error = err as { stderr?: Buffer | string };
    throw new Error(`git ${cmd} failed: ${error.stderr?.toString() || String(err)}`);
  }
}

function getLocalHead(): string {
  return git('rev-parse HEAD');
}

function getRemoteHead(): string {
  return git('rev-parse origin/main');
}

function getCommitsBehind(): number {
  const count = git('rev-list --count HEAD..origin/main');
  return parseInt(count, 10) || 0;
}

function hasLocalChanges(): boolean {
  const status = git('status --porcelain');
  return status.length > 0;
}

function getNewCommitMessages(): string[] {
  try {
    const log = git('log --oneline HEAD..origin/main');
    return log.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

// ============================================================================
// Check for Updates
// ============================================================================

export async function checkForUpdates(): Promise<{
  behind: number;
  commits: string[];
  hasLocalChanges: boolean;
  localHead: string;
  remoteHead: string;
}> {
  try {
    // Fetch latest from remote
    git('fetch origin main');

    state.localHead = getLocalHead();
    state.remoteHead = getRemoteHead();
    state.behind = getCommitsBehind();
    state.lastCheck = new Date().toISOString();

    const localChanges = hasLocalChanges();
    const commits = state.behind > 0 ? getNewCommitMessages() : [];

    addEvent('check', `Checked: ${state.behind} commits behind`, true);

    logger.debug('Self-update check', {
      behind: state.behind,
      localHead: state.localHead.substring(0, 8),
      remoteHead: state.remoteHead.substring(0, 8),
    });

    return {
      behind: state.behind,
      commits,
      hasLocalChanges: localChanges,
      localHead: state.localHead,
      remoteHead: state.remoteHead,
    };
  } catch (err) {
    state.lastError = String(err);
    addEvent('check', `Check failed: ${err}`, false);
    logger.error('Self-update check failed', { error: String(err) });
    throw err;
  }
}

// ============================================================================
// Pull, Build, Restart
// ============================================================================

export async function pullAndRestart(options?: { force?: boolean }): Promise<{
  success: boolean;
  message: string;
}> {
  if (state.updateInProgress) {
    return { success: false, message: 'Update already in progress.' };
  }

  // Safety checks
  if (!options?.force) {
    // Check for local changes
    if (hasLocalChanges()) {
      return {
        success: false,
        message: 'Local uncommitted changes detected. Commit or stash them first, or use force update.',
      };
    }

    // Check for active Cursor tasks
    if (activeTaskChecker && activeTaskChecker()) {
      return {
        success: false,
        message: 'Active Cursor tasks running. Wait for them to complete or use force update.',
      };
    }
  }

  state.updateInProgress = true;
  const previousHead = getLocalHead();

  try {
    // 1. Pull
    logger.info('Self-update: pulling changes');
    broadcast('self:update:pulling', { behind: state.behind });
    addEvent('pull', 'Pulling from origin/main', true);

    git('pull origin main');

    state.localHead = getLocalHead();
    addEvent('pull', `Pulled to ${state.localHead.substring(0, 8)}`, true);

    // 2. Build
    logger.info('Self-update: building');
    broadcast('self:update:building', { head: state.localHead.substring(0, 8) });
    addEvent('build', 'Running npm run build', true);

    try {
      execSync('npm run build', { ...execOpts, timeout: 120000, stdio: 'pipe' });
      addEvent('build', 'Build succeeded', true);
    } catch (buildErr) {
      // Build failed — revert
      logger.error('Self-update: build failed, reverting', { error: String(buildErr) });
      addEvent('build', `Build failed: ${buildErr}`, false);

      try {
        git(`reset --hard ${previousHead}`);
        addEvent('revert', `Reverted to ${previousHead.substring(0, 8)}`, true);
      } catch (revertErr) {
        addEvent('revert', `Revert failed: ${revertErr}`, false);
      }

      state.updateInProgress = false;
      state.lastError = `Build failed: ${buildErr}`;

      broadcast('self:update:failed', { error: 'Build failed, reverted to previous version.' });

      return {
        success: false,
        message: `Build failed after pull. Reverted to ${previousHead.substring(0, 8)}. Error: ${buildErr}`,
      };
    }

    // 3. Restart
    logger.info('Self-update: restarting');
    state.lastUpdate = new Date().toISOString();
    addEvent('restart', 'Restarting process', true);

    broadcast('self:update:restarting', {
      previousHead: previousHead.substring(0, 8),
      newHead: state.localHead.substring(0, 8),
    });

    // Give broadcasts a moment to flush, then exit cleanly.
    // systemd (Restart=always, RestartSec=5) will auto-restart with the new code.
    setTimeout(() => {
      process.exit(0);
    }, 2000);

    return {
      success: true,
      message: `Updated to ${state.localHead.substring(0, 8)}. Restarting in 2 seconds.`,
    };

  } catch (err) {
    state.updateInProgress = false;
    state.lastError = String(err);
    addEvent('error', `Update failed: ${err}`, false);
    logger.error('Self-update failed', { error: String(err) });

    return { success: false, message: `Update failed: ${err}` };
  }
}

// ============================================================================
// Auto-Update Loop
// ============================================================================

async function autoUpdateCheck(): Promise<void> {
  if (!state.autoUpdateEnabled || state.updateInProgress) return;

  try {
    const status = await checkForUpdates();

    if (status.behind > 0) {
      logger.info('Self-update: new commits available', { behind: status.behind });

      broadcast('self:update:available', {
        behind: status.behind,
        commits: status.commits,
        hasLocalChanges: status.hasLocalChanges,
      });

      // Auto-pull if no local changes and no active tasks
      if (!status.hasLocalChanges && (!activeTaskChecker || !activeTaskChecker())) {
        logger.info('Self-update: auto-pulling');
        await pullAndRestart();
      } else {
        logger.info('Self-update: changes available but conditions not met for auto-pull', {
          hasLocalChanges: status.hasLocalChanges,
          hasActiveTasks: activeTaskChecker ? activeTaskChecker() : false,
        });
      }
    }
  } catch {
    // Check failures are logged in checkForUpdates
  }
}

export function startUpdateChecker(): void {
  if (checkInterval) return;
  checkInterval = setInterval(autoUpdateCheck, CHECK_INTERVAL_MS);
  logger.info('Self-update checker started', { intervalMs: CHECK_INTERVAL_MS });

  // Run initial check after 30 seconds (give time for startup)
  setTimeout(autoUpdateCheck, 30000);
}

export function stopUpdateChecker(): void {
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
  }
}

// ============================================================================
// Config
// ============================================================================

export function setAutoUpdate(enabled: boolean): void {
  state.autoUpdateEnabled = enabled;
  logger.info('Self-update auto-update', { enabled });
}

export function getUpdateStatus(): UpdateState {
  return { ...state };
}

export function isAutoUpdateEnabled(): boolean {
  return state.autoUpdateEnabled;
}
