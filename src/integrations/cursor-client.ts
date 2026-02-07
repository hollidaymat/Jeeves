/**
 * Cursor Background Agent API Client
 * 
 * Wraps the Cursor cloud agent API (https://api.cursor.com)
 * for launching, monitoring, and managing coding agents.
 * 
 * Auth: Basic Auth with API key from https://cursor.com/settings/api
 */

import { logger } from '../utils/logger.js';

// ============================================================================
// Types
// ============================================================================

export interface CursorAgentLaunchRequest {
  prompt: {
    text: string;
    images?: string[];  // base64 encoded
  };
  source: {
    repository: string;  // GitHub repo URL
    ref?: string;        // branch, defaults to main
  };
}

export interface CursorAgentResponse {
  id: string;
  status?: string;
  [key: string]: unknown;
}

export interface CursorConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
}

export interface CursorConversation {
  id: string;
  messages: CursorConversationMessage[];
  status?: 'running' | 'completed' | 'failed' | 'stopped';
  [key: string]: unknown;
}

export interface CursorRepo {
  id: string;
  name: string;
  full_name: string;
  url: string;
  default_branch: string;
  [key: string]: unknown;
}

export interface CursorModel {
  id: string;
  name: string;
  [key: string]: unknown;
}

export interface CursorApiInfo {
  id: string;
  email?: string;
  [key: string]: unknown;
}

export interface CursorAgentListItem {
  id: string;
  status?: string;
  created_at?: string;
  [key: string]: unknown;
}

// ============================================================================
// Client
// ============================================================================

export class CursorClient {
  private baseUrl = 'https://api.cursor.com';
  private authHeader: string;

  constructor(apiKey: string) {
    this.authHeader = `Basic ${Buffer.from(apiKey + ':').toString('base64')}`;
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
        'Authorization': this.authHeader,
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
        throw new Error(`Cursor API ${res.status}: ${res.statusText} ${errorBody}`);
      }

      // DELETE might return empty body
      if (res.status === 204 || res.headers.get('content-length') === '0') {
        return {} as T;
      }

      return await res.json() as T;
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        throw new Error(`Cursor API request timed out after ${timeoutMs}ms`);
      }
      // Log root cause for "TypeError: fetch failed" (usually DNS/TLS/network)
      const cause = (error as { cause?: Error })?.cause;
      if (cause) {
        logger.error('Cursor fetch root cause', {
          message: cause.message,
          code: (cause as { code?: string })?.code,
          name: cause.name,
        });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  // ---------- Agent Operations ----------

  /**
   * Launch a new Cursor background agent
   */
  async launchAgent(
    prompt: string,
    repository: string,
    branch = 'main',
    images?: string[]
  ): Promise<CursorAgentResponse> {
    logger.info('Launching Cursor agent', { repository, branch, promptLength: prompt.length });

    const payload: CursorAgentLaunchRequest = {
      prompt: {
        text: prompt,
        ...(images?.length ? { images } : {}),
      },
      source: {
        repository,
        ref: branch,
      },
    };

    const result = await this.request<CursorAgentResponse>('POST', '/v0/agents', payload, 60000);
    logger.info('Cursor agent launched', { agentId: result.id });
    return result;
  }

  /**
   * Get agent details (status, metadata)
   */
  async getAgent(agentId: string): Promise<CursorAgentResponse> {
    return this.request<CursorAgentResponse>('GET', `/v0/agents/${agentId}`);
  }

  /**
   * Get agent conversation / progress
   */
  async getConversation(agentId: string): Promise<CursorConversation> {
    return this.request<CursorConversation>('GET', `/v0/agents/${agentId}/conversation`);
  }

  /**
   * Send follow-up instructions to a running agent
   */
  async followUp(agentId: string, prompt: string, images?: string[]): Promise<CursorAgentResponse> {
    logger.info('Sending follow-up to Cursor agent', { agentId, promptLength: prompt.length });

    return this.request<CursorAgentResponse>('POST', `/v0/agents/${agentId}/followup`, {
      prompt: {
        text: prompt,
        ...(images?.length ? { images } : {}),
      },
    });
  }

  /**
   * Stop/pause an agent
   */
  async stopAgent(agentId: string): Promise<CursorAgentResponse> {
    logger.info('Stopping Cursor agent', { agentId });
    return this.request<CursorAgentResponse>('POST', `/v0/agents/${agentId}/stop`);
  }

  /**
   * Delete an agent
   */
  async deleteAgent(agentId: string): Promise<void> {
    logger.info('Deleting Cursor agent', { agentId });
    await this.request<unknown>('DELETE', `/v0/agents/${agentId}`);
  }

  /**
   * List agents (most recent first)
   */
  async listAgents(limit = 20): Promise<CursorAgentListItem[]> {
    const result = await this.request<{ agents: CursorAgentListItem[] } | CursorAgentListItem[]>(
      'GET',
      `/v0/agents?limit=${limit}`
    );
    // Handle both array and object response formats
    return Array.isArray(result) ? result : (result.agents || []);
  }

  // ---------- Info Endpoints ----------

  /**
   * Get API key info
   */
  async getMe(): Promise<CursorApiInfo> {
    return this.request<CursorApiInfo>('GET', '/v0/me');
  }

  /**
   * List available models
   */
  async listModels(): Promise<CursorModel[]> {
    const result = await this.request<{ models: CursorModel[] } | CursorModel[]>(
      'GET',
      '/v0/models'
    );
    return Array.isArray(result) ? result : (result.models || []);
  }

  /**
   * List connected repositories
   */
  async listRepos(): Promise<CursorRepo[]> {
    const result = await this.request<{ repositories: CursorRepo[] } | CursorRepo[]>(
      'GET',
      '/v0/repositories'
    );
    return Array.isArray(result) ? result : (result.repositories || []);
  }

  // ---------- Health Check ----------

  /**
   * Quick health check - verifies API key is valid
   */
  async healthCheck(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.getMe();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  }
}

// ============================================================================
// Singleton
// ============================================================================

let client: CursorClient | null = null;

export function getCursorClient(): CursorClient | null {
  if (client) return client;

  const apiKey = process.env.CURSOR_API_KEY;
  if (!apiKey) {
    logger.debug('CURSOR_API_KEY not set, Cursor integration disabled');
    return null;
  }

  client = new CursorClient(apiKey);
  return client;
}

export function isCursorEnabled(): boolean {
  return !!process.env.CURSOR_API_KEY;
}
