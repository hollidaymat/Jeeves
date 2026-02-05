/**
 * API Testing Module
 * Provides HTTP request capabilities for testing APIs
 * 
 * Security Features:
 * - All requests are logged
 * - Trust-level gated (GET always allowed, mutations need higher trust)
 * - Timeout protection
 * - Response size limits
 */

import { logger } from '../utils/logger.js';
import { getTrustLevel } from './trust.js';

export interface ApiTestOptions {
  headers?: Record<string, string>;
  body?: unknown;
  timeout?: number;
}

export interface ApiTestResult {
  success: boolean;
  method: string;
  url: string;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: unknown;
  duration?: number;
  error?: string;
}

// Request log for audit trail
interface ApiRequestLog {
  timestamp: Date;
  method: string;
  url: string;
  status?: number;
  duration?: number;
  error?: string;
}

const requestLog: ApiRequestLog[] = [];
const MAX_LOG_SIZE = 100;

// Response body size limit (1MB)
const MAX_RESPONSE_SIZE = 1024 * 1024;

// Default timeout (30 seconds)
const DEFAULT_TIMEOUT = 30000;

/**
 * Log an API request
 */
function logRequest(entry: Omit<ApiRequestLog, 'timestamp'>): void {
  requestLog.push({ ...entry, timestamp: new Date() });
  if (requestLog.length > MAX_LOG_SIZE) {
    requestLog.shift();
  }
  logger.info('API request logged', { ...entry });
}

/**
 * Get recent API request history
 */
export function getApiHistory(count: number = 20): ApiRequestLog[] {
  return requestLog.slice(-count);
}

/**
 * Check if the method is allowed at current trust level
 */
function isMethodAllowed(method: string): { allowed: boolean; reason?: string } {
  const trustLevel = getTrustLevel();
  const upperMethod = method.toUpperCase();
  
  // GET and HEAD are always allowed
  if (upperMethod === 'GET' || upperMethod === 'HEAD' || upperMethod === 'OPTIONS') {
    return { allowed: true };
  }
  
  // POST, PUT, PATCH, DELETE need trust level 3+
  if (trustLevel < 3) {
    return { 
      allowed: false, 
      reason: `${upperMethod} requests require trust level 3+. Current level: ${trustLevel}` 
    };
  }
  
  return { allowed: true };
}

/**
 * Make an HTTP request
 */
export async function apiTest(
  method: string,
  url: string,
  options: ApiTestOptions = {}
): Promise<ApiTestResult> {
  const startTime = Date.now();
  const upperMethod = method.toUpperCase();
  
  // Validate URL
  try {
    new URL(url);
  } catch {
    return {
      success: false,
      method: upperMethod,
      url,
      error: 'Invalid URL'
    };
  }
  
  // Check trust level for mutations
  const methodCheck = isMethodAllowed(upperMethod);
  if (!methodCheck.allowed) {
    logRequest({ method: upperMethod, url, error: methodCheck.reason });
    return {
      success: false,
      method: upperMethod,
      url,
      error: methodCheck.reason
    };
  }
  
  try {
    // Build request options
    const fetchOptions: RequestInit = {
      method: upperMethod,
      headers: {
        'User-Agent': 'Jeeves/2.0 API Tester',
        ...options.headers
      },
      signal: AbortSignal.timeout(options.timeout || DEFAULT_TIMEOUT)
    };
    
    // Add body for non-GET requests
    if (options.body && upperMethod !== 'GET' && upperMethod !== 'HEAD') {
      if (typeof options.body === 'string') {
        fetchOptions.body = options.body;
      } else {
        fetchOptions.body = JSON.stringify(options.body);
        (fetchOptions.headers as Record<string, string>)['Content-Type'] = 'application/json';
      }
    }
    
    logger.info('Making API request', { method: upperMethod, url });
    
    const response = await fetch(url, fetchOptions);
    const duration = Date.now() - startTime;
    
    // Extract response headers
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    
    // Check content length
    const contentLength = parseInt(responseHeaders['content-length'] || '0');
    if (contentLength > MAX_RESPONSE_SIZE) {
      logRequest({ method: upperMethod, url, status: response.status, duration, error: 'Response too large' });
      return {
        success: true,
        method: upperMethod,
        url,
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        duration,
        body: `[Response too large: ${contentLength} bytes. Max: ${MAX_RESPONSE_SIZE}]`
      };
    }
    
    // Parse response body
    let body: unknown;
    const contentType = responseHeaders['content-type'] || '';
    
    if (contentType.includes('application/json')) {
      try {
        body = await response.json();
      } catch {
        body = await response.text();
      }
    } else if (contentType.includes('text/')) {
      body = await response.text();
    } else {
      // Binary or unknown - just report size
      const buffer = await response.arrayBuffer();
      body = `[Binary data: ${buffer.byteLength} bytes]`;
    }
    
    logRequest({ method: upperMethod, url, status: response.status, duration });
    
    return {
      success: response.ok,
      method: upperMethod,
      url,
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      body,
      duration
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMsg = error instanceof Error ? error.message : String(error);
    
    logRequest({ method: upperMethod, url, duration, error: errorMsg });
    
    return {
      success: false,
      method: upperMethod,
      url,
      duration,
      error: errorMsg
    };
  }
}

/**
 * Convenience methods
 */
export const api = {
  get: (url: string, options?: ApiTestOptions) => apiTest('GET', url, options),
  post: (url: string, body?: unknown, options?: ApiTestOptions) => 
    apiTest('POST', url, { ...options, body }),
  put: (url: string, body?: unknown, options?: ApiTestOptions) => 
    apiTest('PUT', url, { ...options, body }),
  patch: (url: string, body?: unknown, options?: ApiTestOptions) => 
    apiTest('PATCH', url, { ...options, body }),
  delete: (url: string, options?: ApiTestOptions) => apiTest('DELETE', url, options),
};

/**
 * Truncate and clean response body for display
 */
function summarizeBody(body: unknown, contentType?: string): string {
  if (!body) return '';
  
  // For JSON, pretty print but limit length
  if (typeof body === 'object') {
    const json = JSON.stringify(body, null, 2);
    if (json.length > 500) {
      return json.substring(0, 500) + '\n    ... [truncated]';
    }
    return json;
  }
  
  const text = String(body);
  
  // For HTML responses, extract meaningful content
  if (contentType?.includes('text/html') || text.startsWith('<!DOCTYPE') || text.startsWith('<html')) {
    // Try to extract title
    const titleMatch = text.match(/<title>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1] : null;
    
    // Check if it's an error page
    const errorMatch = text.match(/(\d{3})[:\s]*([^<]+)/);
    
    if (title?.includes('404') || title?.includes('Not Found')) {
      return '[HTML Error Page: 404 Not Found]';
    } else if (title?.includes('500') || title?.includes('Error')) {
      return `[HTML Error Page: ${title}]`;
    } else if (title) {
      return `[HTML Page: ${title}]`;
    }
    return '[HTML Response - use browser to view]';
  }
  
  // For plain text, truncate if needed
  if (text.length > 300) {
    return text.substring(0, 300) + '... [truncated]';
  }
  
  return text;
}

/**
 * Format API result for display - concise version
 */
export function formatApiResult(result: ApiTestResult): string {
  const icon = result.success ? '✓' : '✗';
  const status = result.status ? `${result.status} ${result.statusText}` : 'No response';
  const duration = result.duration ? `${result.duration}ms` : '';
  
  let output = `${icon} ${result.method} ${result.url}\n`;
  output += `  ${status}${duration ? ` (${duration})` : ''}`;
  
  if (result.error && !result.status) {
    output += `\n  Error: ${result.error}`;
  }
  
  if (result.body && result.success) {
    const contentType = result.headers?.['content-type'];
    const summary = summarizeBody(result.body, contentType);
    if (summary && !summary.startsWith('[HTML')) {
      output += `\n  Body: ${summary}`;
    }
  }
  
  return output;
}

/**
 * Format multiple API results as a summary
 */
export function formatApiSummary(results: ApiTestResult[]): string {
  const successful = results.filter(r => r.success).length;
  const failed = results.length - successful;
  
  let output = `## API Test Results\n\n`;
  output += `**Summary**: ${successful} passed, ${failed} failed\n\n`;
  
  for (const result of results) {
    output += formatApiResult(result) + '\n';
  }
  
  return output;
}
