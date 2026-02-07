/**
 * GitHub API Client
 * 
 * Creates repos, pushes initial scaffolds (PRD, rules), and manages
 * project bootstrapping for Jeeves-initiated Cursor agent tasks.
 */

import { logger } from '../utils/logger.js';

// ============================================================================
// Types
// ============================================================================

export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  html_url: string;
  clone_url: string;
  ssh_url: string;
  default_branch: string;
  private: boolean;
}

export interface CreateRepoOptions {
  name: string;
  description?: string;
  isPrivate?: boolean;
  autoInit?: boolean;
}

export interface PushFileOptions {
  repo: string;        // "owner/repo" or just "repo" (uses authenticated user)
  path: string;        // file path in the repo
  content: string;     // file content (will be base64-encoded)
  message: string;     // commit message
  branch?: string;     // defaults to 'main'
}

// ============================================================================
// Client
// ============================================================================

export class GitHubClient {
  private baseUrl = 'https://api.github.com';
  private token: string;
  private owner: string | null = null;

  constructor(token: string) {
    this.token = token;
  }

  // ---------- Core HTTP ----------

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = 30000
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headers: Record<string, string> = {
        'Authorization': `Bearer ${this.token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      };
      if (body) {
        headers['Content-Type'] = 'application/json';
      }

      const res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!res.ok) {
        const errorBody = await res.text().catch(() => '');
        throw new Error(`GitHub API ${res.status}: ${res.statusText} ${errorBody}`);
      }

      if (res.status === 204) return {} as T;
      return await res.json() as T;
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        throw new Error(`GitHub API request timed out after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  // ---------- User ----------

  async getAuthenticatedUser(): Promise<{ login: string; id: number }> {
    const user = await this.request<{ login: string; id: number }>('GET', '/user');
    this.owner = user.login;
    return user;
  }

  private async ensureOwner(): Promise<string> {
    if (this.owner) return this.owner;
    const user = await this.getAuthenticatedUser();
    return user.login;
  }

  // ---------- Repository Operations ----------

  /**
   * Create a new repository
   */
  async createRepo(options: CreateRepoOptions): Promise<GitHubRepo> {
    logger.info('Creating GitHub repo', { name: options.name });

    const repo = await this.request<GitHubRepo>('POST', '/user/repos', {
      name: options.name,
      description: options.description || '',
      private: options.isPrivate ?? true,
      auto_init: options.autoInit ?? true,  // Creates with initial commit + README
    });

    logger.info('GitHub repo created', { fullName: repo.full_name, url: repo.html_url });
    return repo;
  }

  /**
   * Check if a repository exists
   */
  async repoExists(name: string): Promise<boolean> {
    const owner = await this.ensureOwner();
    try {
      await this.request('GET', `/repos/${owner}/${name}`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Push a file to a repository (creates or updates)
   */
  async pushFile(options: PushFileOptions): Promise<void> {
    const owner = await this.ensureOwner();
    const repo = options.repo.includes('/') ? options.repo : `${owner}/${options.repo}`;
    const branch = options.branch || 'main';

    logger.debug('Pushing file to GitHub', { repo, path: options.path });

    // Check if file already exists (need SHA for updates)
    let sha: string | undefined;
    try {
      const existing = await this.request<{ sha: string }>(
        'GET',
        `/repos/${repo}/contents/${options.path}?ref=${branch}`
      );
      sha = existing.sha;
    } catch {
      // File doesn't exist yet, that's fine
    }

    const payload: Record<string, unknown> = {
      message: options.message,
      content: Buffer.from(options.content).toString('base64'),
      branch,
    };
    if (sha) payload.sha = sha;

    await this.request('PUT', `/repos/${repo}/contents/${options.path}`, payload);
  }

  /**
   * Push multiple files in a single commit using the Git Trees API
   */
  async pushFiles(
    repo: string,
    files: Array<{ path: string; content: string }>,
    message: string,
    branch = 'main'
  ): Promise<void> {
    const owner = await this.ensureOwner();
    const fullRepo = repo.includes('/') ? repo : `${owner}/${repo}`;

    logger.info('Pushing files to GitHub', { repo: fullRepo, fileCount: files.length });

    // Get the latest commit SHA on the branch
    const ref = await this.request<{ object: { sha: string } }>(
      'GET',
      `/repos/${fullRepo}/git/ref/heads/${branch}`
    );
    const latestCommitSha = ref.object.sha;

    // Get the tree SHA of the latest commit
    const commit = await this.request<{ tree: { sha: string } }>(
      'GET',
      `/repos/${fullRepo}/git/commits/${latestCommitSha}`
    );
    const baseTreeSha = commit.tree.sha;

    // Create blobs for each file
    const treeItems = [];
    for (const file of files) {
      const blob = await this.request<{ sha: string }>(
        'POST',
        `/repos/${fullRepo}/git/blobs`,
        { content: file.content, encoding: 'utf-8' }
      );
      treeItems.push({
        path: file.path,
        mode: '100644',
        type: 'blob',
        sha: blob.sha,
      });
    }

    // Create a new tree
    const newTree = await this.request<{ sha: string }>(
      'POST',
      `/repos/${fullRepo}/git/trees`,
      { base_tree: baseTreeSha, tree: treeItems }
    );

    // Create a new commit
    const newCommit = await this.request<{ sha: string }>(
      'POST',
      `/repos/${fullRepo}/git/commits`,
      {
        message,
        tree: newTree.sha,
        parents: [latestCommitSha],
      }
    );

    // Update the branch reference
    await this.request(
      'PATCH',
      `/repos/${fullRepo}/git/refs/heads/${branch}`,
      { sha: newCommit.sha }
    );

    logger.info('Files pushed to GitHub', { repo: fullRepo, commitSha: newCommit.sha.substring(0, 8) });
  }

  // ---------- Pull Request Review ----------

  /**
   * Get a pull request by number
   */
  async getPullRequest(
    repo: string,
    prNumber: number
  ): Promise<{
    number: number;
    title: string;
    state: string;
    body: string;
    html_url: string;
    changed_files: number;
    additions: number;
    deletions: number;
    mergeable: boolean | null;
    head: { ref: string; sha: string };
    base: { ref: string };
  }> {
    const owner = await this.ensureOwner();
    const fullRepo = repo.includes('/') ? repo : `${owner}/${repo}`;
    return this.request('GET', `/repos/${fullRepo}/pulls/${prNumber}`);
  }

  /**
   * Get the diff for a pull request (raw patch text)
   */
  async getPullRequestDiff(repo: string, prNumber: number): Promise<string> {
    const owner = await this.ensureOwner();
    const fullRepo = repo.includes('/') ? repo : `${owner}/${repo}`;
    const url = `${this.baseUrl}/repos/${fullRepo}/pulls/${prNumber}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Accept': 'application/vnd.github.v3.diff',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`GitHub API ${res.status}: ${res.statusText}`);
      }

      return await res.text();
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Get the list of files changed in a pull request
   */
  async getPullRequestFiles(
    repo: string,
    prNumber: number
  ): Promise<Array<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    changes: number;
    patch?: string;
  }>> {
    const owner = await this.ensureOwner();
    const fullRepo = repo.includes('/') ? repo : `${owner}/${repo}`;
    return this.request('GET', `/repos/${fullRepo}/pulls/${prNumber}/files?per_page=100`);
  }

  /**
   * Get CI/check status for a commit
   */
  async getCheckStatus(
    repo: string,
    commitSha: string
  ): Promise<{ state: string; statuses: Array<{ context: string; state: string; description: string }> }> {
    const owner = await this.ensureOwner();
    const fullRepo = repo.includes('/') ? repo : `${owner}/${repo}`;
    return this.request('GET', `/repos/${fullRepo}/commits/${commitSha}/status`);
  }

  // ---------- Health Check ----------

  async healthCheck(): Promise<{ ok: boolean; login?: string; error?: string }> {
    try {
      const user = await this.getAuthenticatedUser();
      return { ok: true, login: user.login };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  }
}

// ============================================================================
// Singleton
// ============================================================================

let client: GitHubClient | null = null;

export function getGitHubClient(): GitHubClient | null {
  if (client) return client;

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    logger.debug('GITHUB_TOKEN not set, GitHub integration disabled');
    return null;
  }

  client = new GitHubClient(token);
  return client;
}

export function isGitHubEnabled(): boolean {
  return !!process.env.GITHUB_TOKEN;
}
