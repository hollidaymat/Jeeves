/**
 * Deploy Pipeline
 * 
 * Orchestrates the full client site deployment:
 *   1. Create GitHub repo
 *   2. Generate PRD
 *   3. Push PRD + cursor rules to repo
 *   4. Launch Cursor agent via cursor-orchestrator
 *   5. Track progress
 * 
 * Each step logs progress and handles failures gracefully.
 */

import { logger } from '../../utils/logger.js';
import { getGitHubClient, isGitHubEnabled } from '../../integrations/github-client.js';
import { createNewProject } from '../../integrations/cursor-orchestrator.js';
import { generateClientPRD } from './prd-generator.js';
import type { ClientData } from './client-template.js';

// ============================================================================
// Pipeline
// ============================================================================

/**
 * Deploy a full client site from a ClientData record.
 * 
 * Steps:
 *   1. Validate prerequisites (GitHub token, etc.)
 *   2. Create GitHub repository
 *   3. Generate PRD from client data
 *   4. Push PRD + cursor rules to the repo
 *   5. Launch Cursor Background Agent to implement the PRD
 */
export async function deployClientSite(
  client: ClientData
): Promise<{ success: boolean; message: string }> {
  logger.info('Starting client site deployment', {
    client: client.slug,
    businessType: client.businessType,
    repoName: client.repoName,
  });

  // ---- Step 1: Validate prerequisites ----
  if (!isGitHubEnabled()) {
    const msg = 'GitHub integration not configured. Set GITHUB_TOKEN in .env to enable deployments.';
    logger.error('Deploy failed — GitHub not enabled', { client: client.slug });
    return { success: false, message: msg };
  }

  const github = getGitHubClient();
  if (!github) {
    const msg = 'Failed to initialize GitHub client.';
    logger.error('Deploy failed — GitHub client init error', { client: client.slug });
    return { success: false, message: msg };
  }

  // ---- Step 2: Create GitHub repo ----
  let repoFullName: string;
  try {
    logger.info('Creating GitHub repository', { name: client.repoName });

    const exists = await github.repoExists(client.repoName);
    if (exists) {
      logger.warn('Repository already exists, reusing', { name: client.repoName });
      const user = await github.getAuthenticatedUser();
      repoFullName = `${user.login}/${client.repoName}`;
    } else {
      const repo = await github.createRepo({
        name: client.repoName,
        description: `DiveConnect site for ${client.businessName} — ${client.location}`,
        isPrivate: true,
        autoInit: true,
      });
      repoFullName = repo.full_name;
      client.githubRepo = repo.html_url;
      logger.info('GitHub repository created', { fullName: repoFullName });
    }
  } catch (error) {
    const msg = `Failed to create GitHub repository: ${error}`;
    logger.error('Deploy step 2 failed', { error: String(error), client: client.slug });
    return { success: false, message: msg };
  }

  // ---- Step 3: Generate PRD ----
  let prd: string;
  try {
    logger.info('Generating PRD', { client: client.slug });
    prd = generateClientPRD(client);
    logger.info('PRD generated successfully', {
      client: client.slug,
      length: prd.length,
    });
  } catch (error) {
    const msg = `Failed to generate PRD: ${error}`;
    logger.error('Deploy step 3 failed', { error: String(error), client: client.slug });
    return { success: false, message: msg };
  }

  // ---- Step 4: Push PRD + cursor rules to repo ----
  try {
    logger.info('Pushing PRD and cursor rules to repo', { repo: repoFullName });

    const cursorRules = buildCursorRules(client);

    await github.pushFiles(
      repoFullName,
      [
        { path: 'PRD.md', content: prd },
        { path: '.cursor/rules/project.mdc', content: cursorRules },
      ],
      `[diveconnect] Initial scaffold for ${client.businessName}`
    );

    logger.info('PRD and rules pushed to repo', { repo: repoFullName });
  } catch (error) {
    const msg = `Failed to push files to repository: ${error}`;
    logger.error('Deploy step 4 failed', { error: String(error), client: client.slug });
    return { success: false, message: msg };
  }

  // ---- Step 5: Launch Cursor agent ----
  try {
    logger.info('Launching Cursor agent', { client: client.slug, repo: repoFullName });

    const result = await createNewProject(client.repoName, prd);

    if (!result.success) {
      logger.warn('Cursor agent launch returned failure', {
        client: client.slug,
        message: result.message,
      });
      // Still a partial success — repo + PRD exist
      return {
        success: true,
        message: `Repository created and PRD pushed: ${client.githubRepo || repoFullName}\n\nCursor agent could not be launched: ${result.message}\n\nYou can manually trigger the build from Cursor.`,
      };
    }

    client.status = 'building';
    logger.info('Cursor agent launched successfully', {
      client: client.slug,
      repo: repoFullName,
    });

    return {
      success: true,
      message: `Deployment started for ${client.businessName}!\n\nRepo: ${client.githubRepo || repoFullName}\nSubdomain: ${client.subdomain}\n\n${result.message}`,
    };
  } catch (error) {
    const msg = `Repository and PRD are ready, but Cursor agent failed to launch: ${error}`;
    logger.error('Deploy step 5 failed', { error: String(error), client: client.slug });
    return {
      success: true,
      message: `Partial deployment for ${client.businessName}.\n\nRepo: ${client.githubRepo || repoFullName}\n\n${msg}`,
    };
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Build cursor rules tailored to the client site.
 */
function buildCursorRules(client: ClientData): string {
  return `# DiveConnect Project Rules — ${client.businessName}

## Context
This is a DiveConnect client site for **${client.businessName}**, a ${client.businessType} in ${client.location}.
It was bootstrapped by Jeeves and is being built by a Cursor Background Agent.

## Stack
- **Framework:** Next.js 16 (App Router)
- **Styling:** Tailwind CSS v4
- **Components:** shadcn/ui
- **Language:** TypeScript (strict mode)
- **Deployment:** Vercel

## Conventions
- Follow the PRD in \`PRD.md\` for all requirements
- Use TypeScript for all source files
- Use App Router patterns (layout.tsx, page.tsx, loading.tsx, error.tsx)
- Commit with clear messages prefixed with \`[diveconnect]\`
- Create clean, well-documented code
- Include error handling and edge cases
- Mobile-first responsive design
- Optimize for Core Web Vitals (LCP, FID, CLS)
- Use semantic HTML elements
- All images should have alt text
- No hardcoded secrets — use environment variables

## File Structure
\`\`\`
app/
  layout.tsx          # Root layout with metadata
  page.tsx            # Home page
  ${client.services.length > 0 ? client.services.slice(0, 3).map(s => `${s.toLowerCase().replace(/\s+/g, '-')}/\n    page.tsx`).join('\n  ') : ''}
  ...
components/
  ui/                 # shadcn/ui components
  sections/           # Page section components
  layout/             # Header, footer, nav
lib/
  utils.ts            # Shared utilities
public/
  images/             # Static assets
\`\`\`
`;
}
