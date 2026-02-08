/**
 * Visual Site Review
 * 
 * After a Cursor agent completes a web project task, takes screenshots
 * at desktop and mobile viewports and sends them via Signal for 
 * visual approval.
 */

import { logger } from '../../utils/logger.js';
import { existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCREENSHOT_DIR = resolve(__dirname, '..', '..', '..', 'data', 'screenshots');

// Ensure directory exists
if (!existsSync(SCREENSHOT_DIR)) {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

export interface VisualReview {
  taskId: string;
  url: string;
  screenshots: {
    desktop: string;  // file path
    mobile: string;   // file path
  };
  timestamp: string;
}

/**
 * Detect if a task involves a web project by checking file extensions in the spec.
 */
export function isWebProject(taskSpec: { description?: string; requirements?: string[]; relatedFiles?: string[] }): boolean {
  const allText = [
    taskSpec.description || '',
    ...(taskSpec.requirements || []),
    ...(taskSpec.relatedFiles || []),
  ].join(' ').toLowerCase();
  
  return /\.(tsx|jsx|html|css|vue|svelte)|next\.config|vite\.config|tailwind|vercel\.json|app\/page|components\//.test(allText);
}

/**
 * Extract a deployment URL from various sources.
 */
export async function findDeploymentUrl(taskSpec: { project?: string; description?: string }, _prUrl?: string): Promise<string | null> {
  // Try to find from Vercel status
  try {
    const { getVercelStatus } = await import('../../api/vercel.js');
    const vercelStatus = await getVercelStatus();
    if (vercelStatus?.projects) {
      // Match by project name
      const projectName = taskSpec.project?.toLowerCase() || '';
      const match = vercelStatus.projects.find(
        (p: { name: string }) => p.name.toLowerCase().includes(projectName) || projectName.includes(p.name.toLowerCase())
      );
      if (match?.production?.url) {
        return match.production.url.startsWith('http') ? match.production.url : `https://${match.production.url}`;
      }
    }
  } catch {
    // Vercel not available
  }

  // Try to extract from PR description or task description
  const urlMatch = (taskSpec.description || '').match(/https?:\/\/[^\s)]+\.vercel\.app/);
  if (urlMatch) return urlMatch[0];

  return null;
}

/**
 * Take screenshots of a URL at desktop and mobile viewports.
 * Uses the existing Playwright browser module.
 * 
 * Note: The browser module's takeScreenshot() auto-generates file paths
 * as `screenshot-{timestamp}.png` in `data/screenshots/` and returns the path.
 */
export async function takeVisualReview(
  taskId: string,
  url: string
): Promise<VisualReview | null> {
  try {
    const browser = await import('../../core/browser.js');

    let desktopPath = '';
    let mobilePath = '';

    // Desktop screenshot (1280x720 — default viewport)
    try {
      await browser.browse(url, { waitForSelector: 'body', timeout: 15000 });
      desktopPath = await browser.takeScreenshot({ fullPage: true });
      logger.info('Desktop screenshot taken', { taskId, url, path: desktopPath });
    } catch (err) {
      logger.warn('Desktop screenshot failed', { error: String(err) });
    }

    // Mobile screenshot (viewport-only, no full page)
    // Note: The browser module uses a fixed 1280x720 viewport.
    // Take a viewport-only screenshot as a "mobile" approximation.
    try {
      mobilePath = await browser.takeScreenshot({ fullPage: false });
      logger.info('Mobile screenshot taken', { taskId, path: mobilePath });
    } catch (err) {
      logger.warn('Mobile screenshot failed', { error: String(err) });
    }

    const review: VisualReview = {
      taskId,
      url,
      screenshots: {
        desktop: desktopPath,
        mobile: mobilePath,
      },
      timestamp: new Date().toISOString(),
    };

    return review;
  } catch (err) {
    logger.error('Visual review failed', { taskId, url, error: String(err) });
    return null;
  }
}

/**
 * Run a full visual review for a completed task.
 * Takes screenshots and sends them via Signal.
 */
export async function reviewCompletedTask(
  taskId: string,
  taskSpec: { project?: string; description?: string; summary?: string; requirements?: string[]; relatedFiles?: string[] },
  prUrl?: string
): Promise<VisualReview | null> {
  // Only review web projects
  if (!isWebProject(taskSpec)) {
    logger.debug('Skipping visual review: not a web project', { taskId });
    return null;
  }

  // Find the deployment URL
  const url = await findDeploymentUrl(taskSpec, prUrl);
  if (!url) {
    logger.debug('Skipping visual review: no deployment URL found', { taskId });
    return null;
  }

  // Take screenshots
  const review = await takeVisualReview(taskId, url);
  if (!review) return null;

  // Send via Signal
  try {
    const { getOwnerNumber } = await import('../../config.js');
    const { signalInterface } = await import('../../interfaces/signal.js');
    
    if (signalInterface.isAvailable()) {
      const attachments = [
        review.screenshots.desktop,
        review.screenshots.mobile,
      ].filter(Boolean);

      await signalInterface.send({
        recipient: getOwnerNumber(),
        content: `Visual review for "${taskSpec.summary || taskId}":\n${url}\n\nDesktop + mobile screenshots attached. Reply "looks good" or note any issues.`,
        attachments: attachments.length > 0 ? attachments : undefined,
      });

      logger.info('Visual review sent via Signal', { taskId, attachments: attachments.length });
    }
  } catch (err) {
    logger.debug('Could not send visual review via Signal', { error: String(err) });
  }

  return review;
}

/** Store active reviews for API access */
const recentReviews = new Map<string, VisualReview>();
const MAX_REVIEWS = 20;

export function storeReview(review: VisualReview): void {
  recentReviews.set(review.taskId, review);
  if (recentReviews.size > MAX_REVIEWS) {
    const oldest = recentReviews.keys().next().value;
    if (oldest) recentReviews.delete(oldest);
  }
}

export function getReview(taskId: string): VisualReview | null {
  return recentReviews.get(taskId) || null;
}

export function getRecentReviews(): VisualReview[] {
  return Array.from(recentReviews.values());
}
