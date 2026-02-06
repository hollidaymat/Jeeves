/**
 * Entity Extraction
 * 
 * Pre-extract entities from messages before LLM classification.
 * This is FREE (no LLM cost) and helps improve classification accuracy.
 */

// ==========================================
// TYPES
// ==========================================

export interface ExtractedEntities {
  filePaths: string[];
  projectNames: string[];
  urls: string[];
  costs: string[];
  timeRefs: string[];
  codeRefs: string[];
  negations: string[];
  hasNegation: boolean;
  pronouns: string[];
  hasPronouns: boolean;
}

// ==========================================
// ENTITY PATTERNS
// ==========================================

const ENTITY_PATTERNS = {
  // File paths - Unix and Windows style
  filePath: /(?:^|[\s"'`])([.~]?[\/\\][\w\-./\\]+\.\w+)/g,
  
  // Project names (quoted or after "project"/"repo")
  projectName: /(?:project|repo|repository|folder)\s+["']?([\w][\w-]*)["']?/gi,
  
  // URLs
  url: /https?:\/\/[^\s<>"{}|\\^`[\]]+/g,
  
  // Cost/budget mentions
  cost: /\$[\d,.]+|\d+\s*(?:dollars?|cents?|USD)/gi,
  
  // Time references
  time: /(?:yesterday|today|tomorrow|last\s+\w+|next\s+\w+|\d+\s*(?:hours?|days?|minutes?|mins?|weeks?|months?)\s*(?:ago|from now)?)/gi,
  
  // Code references (backtick-wrapped)
  codeRef: /`([^`]+)`/g,
  
  // Negations (critical for intent)
  negation: /\b(don'?t|do not|stop|cancel|abort|never|without|no|not)\b/gi,
  
  // Pronouns (need resolution)
  pronoun: /\b(it|this|that|these|those|them|they|its|their)\b/gi
};

// ==========================================
// EXTRACTION FUNCTIONS
// ==========================================

/**
 * Extract all entities from a message
 */
export function extractEntities(message: string): ExtractedEntities {
  const result: ExtractedEntities = {
    filePaths: [],
    projectNames: [],
    urls: [],
    costs: [],
    timeRefs: [],
    codeRefs: [],
    negations: [],
    hasNegation: false,
    pronouns: [],
    hasPronouns: false
  };
  
  // File paths
  const fileMatches = message.matchAll(ENTITY_PATTERNS.filePath);
  for (const match of fileMatches) {
    result.filePaths.push(match[1]);
  }
  
  // Project names
  const projectMatches = message.matchAll(ENTITY_PATTERNS.projectName);
  for (const match of projectMatches) {
    result.projectNames.push(match[1]);
  }
  
  // URLs
  const urlMatches = message.match(ENTITY_PATTERNS.url);
  if (urlMatches) {
    result.urls = urlMatches;
  }
  
  // Costs
  const costMatches = message.match(ENTITY_PATTERNS.cost);
  if (costMatches) {
    result.costs = costMatches;
  }
  
  // Time references
  const timeMatches = message.match(ENTITY_PATTERNS.time);
  if (timeMatches) {
    result.timeRefs = timeMatches;
  }
  
  // Code references
  const codeMatches = message.matchAll(ENTITY_PATTERNS.codeRef);
  for (const match of codeMatches) {
    result.codeRefs.push(match[1]);
  }
  
  // Negations
  const negationMatches = message.match(ENTITY_PATTERNS.negation);
  if (negationMatches) {
    result.negations = negationMatches;
    result.hasNegation = true;
  }
  
  // Pronouns
  const pronounMatches = message.match(ENTITY_PATTERNS.pronoun);
  if (pronounMatches) {
    result.pronouns = pronounMatches;
    result.hasPronouns = true;
  }
  
  return result;
}

/**
 * Check if message contains destructive intent
 * Based on negations and destructive verbs
 */
export function hasDestructiveIntent(message: string): boolean {
  const destructivePatterns = [
    /\b(delete|remove|destroy|drop|wipe|clear|reset|overwrite|force)\b/i,
    /\bforce\s*(push|delete|remove)/i,
    /\b(rm|rmdir)\s+-r?f?\b/i,
    /\bgit\s+(reset|clean|push\s+--force)/i
  ];
  
  return destructivePatterns.some(pattern => pattern.test(message));
}

/**
 * Check if message is likely a PRD/spec
 */
export function isPRDContent(message: string): boolean {
  // Long message with structural elements
  if (message.length < 200) return false;
  
  const prdIndicators = [
    /##\s*(requirements?|features?|overview|mvp|spec)/i,
    /\b(build me|create|implement)\s+(a|an|the)/i,
    /\brequirements?\s*:/i,
    /\buser\s+stor(y|ies)/i,
    /\bacceptance\s+criteria/i,
    /^\s*[-*]\s+\[[\sx]\]/m  // Checkbox items
  ];
  
  const matchCount = prdIndicators.filter(p => p.test(message)).length;
  return matchCount >= 2;
}

/**
 * Extract action verb from message start
 */
export function extractActionVerb(message: string): string | null {
  const actionPattern = /^(?:please\s+)?(?:can you\s+)?(?:could you\s+)?([\w]+)/i;
  const match = message.match(actionPattern);
  
  if (match) {
    const verb = match[1].toLowerCase();
    const actionVerbs = [
      'open', 'close', 'create', 'delete', 'update', 'fix', 'add', 'remove',
      'build', 'run', 'start', 'stop', 'deploy', 'check', 'test', 'find',
      'search', 'show', 'list', 'help', 'explain', 'describe'
    ];
    
    if (actionVerbs.includes(verb)) {
      return verb;
    }
  }
  
  return null;
}

/**
 * Build entity context string for LLM prompts
 */
export function buildEntityContext(entities: ExtractedEntities): string {
  const parts: string[] = [];
  
  if (entities.filePaths.length > 0) {
    parts.push(`Files mentioned: ${entities.filePaths.join(', ')}`);
  }
  
  if (entities.projectNames.length > 0) {
    parts.push(`Projects mentioned: ${entities.projectNames.join(', ')}`);
  }
  
  if (entities.urls.length > 0) {
    parts.push(`URLs: ${entities.urls.join(', ')}`);
  }
  
  if (entities.codeRefs.length > 0) {
    parts.push(`Code references: ${entities.codeRefs.join(', ')}`);
  }
  
  if (entities.hasNegation) {
    parts.push(`Contains negation: ${entities.negations.join(', ')}`);
  }
  
  if (entities.hasPronouns) {
    parts.push(`Contains pronouns needing resolution: ${entities.pronouns.join(', ')}`);
  }
  
  return parts.join('\n');
}
