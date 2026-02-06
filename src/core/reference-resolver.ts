/**
 * Reference Resolver
 * 
 * Tracks and resolves pronouns like "it", "this", "that" to their referents.
 * Persists across conversation turns within a session.
 */

import { logger } from '../utils/logger.js';

// ==========================================
// TYPES
// ==========================================

export interface LastMentioned {
  file: string | null;
  project: string | null;
  task: string | null;
  error: string | null;
  component: string | null;
  url: string | null;
}

export interface ResolvedMessage {
  original: string;
  resolved: string;
  hadPronouns: boolean;
  resolutions: Array<{ pronoun: string; resolvedTo: string }>;
}

// ==========================================
// REFERENCE RESOLVER CLASS
// ==========================================

class ReferenceResolverImpl {
  private lastMentioned: LastMentioned = {
    file: null,
    project: null,
    task: null,
    error: null,
    component: null,
    url: null
  };
  
  private lastUpdated: Date = new Date();
  
  // Pronoun to referent type mapping
  private readonly pronounMappings: Record<string, (keyof LastMentioned)[]> = {
    'it': ['file', 'task', 'component'],
    'this': ['task', 'error', 'file'],
    'that': ['task', 'file', 'component'],
    'the file': ['file'],
    'the project': ['project'],
    'the error': ['error'],
    'the component': ['component'],
    'the task': ['task'],
    'the url': ['url'],
    'the link': ['url']
  };
  
  /**
   * Update last mentioned entities from a parsed message/result
   */
  update(parsed: {
    target?: string;
    resolved_path?: string;
    category?: string;
    action?: string;
    error?: string;
  }): void {
    // Update file reference
    if (parsed.resolved_path) {
      this.lastMentioned.file = parsed.resolved_path;
    } else if (parsed.target && /\.\w+$/.test(parsed.target)) {
      this.lastMentioned.file = parsed.target;
    }
    
    // Update project reference
    if (parsed.action === 'open_project' && parsed.target) {
      this.lastMentioned.project = parsed.target;
    }
    
    // Update task reference (for PRDs)
    if (parsed.category === 'prd' && parsed.target) {
      this.lastMentioned.task = parsed.target;
    }
    
    // Update error reference
    if (parsed.error) {
      this.lastMentioned.error = parsed.error;
    }
    
    this.lastUpdated = new Date();
    
    logger.debug('Reference resolver updated', { lastMentioned: this.lastMentioned });
  }
  
  /**
   * Update a specific reference type
   */
  setReference(type: keyof LastMentioned, value: string): void {
    this.lastMentioned[type] = value;
    this.lastUpdated = new Date();
  }
  
  /**
   * Resolve pronouns in a message
   */
  resolve(message: string): ResolvedMessage {
    const resolutions: Array<{ pronoun: string; resolvedTo: string }> = [];
    let resolved = message;
    let hadPronouns = false;
    
    // Check each pronoun pattern
    for (const [pronoun, referentTypes] of Object.entries(this.pronounMappings)) {
      const pattern = new RegExp(`\\b${pronoun}\\b`, 'gi');
      
      if (pattern.test(message)) {
        // Find first non-null referent
        for (const type of referentTypes) {
          const value = this.lastMentioned[type];
          if (value) {
            resolved = resolved.replace(pattern, value);
            resolutions.push({ pronoun, resolvedTo: value });
            hadPronouns = true;
            break;
          }
        }
      }
    }
    
    if (hadPronouns) {
      logger.debug('Resolved pronouns', { 
        original: message, 
        resolved, 
        resolutions 
      });
    }
    
    return {
      original: message,
      resolved,
      hadPronouns,
      resolutions
    };
  }
  
  /**
   * Get what a pronoun would resolve to (without modifying message)
   */
  getResolution(pronoun: string): string | null {
    const referentTypes = this.pronounMappings[pronoun.toLowerCase()];
    if (!referentTypes) return null;
    
    for (const type of referentTypes) {
      const value = this.lastMentioned[type];
      if (value) return value;
    }
    
    return null;
  }
  
  /**
   * Check if message contains pronouns that need resolution
   */
  hasPronouns(message: string): boolean {
    const pronounPatterns = Object.keys(this.pronounMappings);
    const lower = message.toLowerCase();
    
    return pronounPatterns.some(pronoun => {
      const pattern = new RegExp(`\\b${pronoun}\\b`, 'i');
      return pattern.test(lower);
    });
  }
  
  /**
   * Get list of unresolved pronouns in message
   */
  getUnresolvedPronouns(message: string): string[] {
    const unresolved: string[] = [];
    
    for (const pronoun of Object.keys(this.pronounMappings)) {
      const pattern = new RegExp(`\\b${pronoun}\\b`, 'gi');
      if (pattern.test(message)) {
        const resolution = this.getResolution(pronoun);
        if (!resolution) {
          unresolved.push(pronoun);
        }
      }
    }
    
    return unresolved;
  }
  
  /**
   * Get current state (for debugging/display)
   */
  getState(): LastMentioned {
    return { ...this.lastMentioned };
  }
  
  /**
   * Clear all references (e.g., on new session)
   */
  clear(): void {
    this.lastMentioned = {
      file: null,
      project: null,
      task: null,
      error: null,
      component: null,
      url: null
    };
    this.lastUpdated = new Date();
    logger.debug('Reference resolver cleared');
  }
  
  /**
   * Check if references are stale (older than threshold)
   */
  isStale(thresholdMinutes: number = 30): boolean {
    const now = new Date();
    const diffMs = now.getTime() - this.lastUpdated.getTime();
    const diffMinutes = diffMs / (1000 * 60);
    return diffMinutes > thresholdMinutes;
  }
}

// Singleton instance
export const referenceResolver = new ReferenceResolverImpl();

// Export class for testing
export { ReferenceResolverImpl };
