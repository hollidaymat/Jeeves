/**
 * Semantic Memory (L3)
 * 
 * Vector-indexed long-term knowledge store.
 * Stores:
 * - Project patterns and conventions
 * - Code snippets and solutions
 * - Domain knowledge
 * - Best practices learned
 */

import { logger } from '../../utils/logger.js';
import * as path from 'path';
import * as fs from 'fs';
import { generateText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { trackLLMUsage } from '../cost-tracker.js';

// ==========================================
// TYPES
// ==========================================

export interface KnowledgeEntry {
  id: string;
  type: 'pattern' | 'solution' | 'convention' | 'fact' | 'best_practice';
  content: string;
  embedding?: number[];
  tags: string[];
  projectPath?: string;
  confidence: number;
  usageCount: number;
  lastUsed: number;
  createdAt: number;
  source: 'learned' | 'imported' | 'inferred';
}

export interface ProjectPattern {
  projectPath: string;
  patterns: {
    fileStructure?: string;
    namingConventions?: string;
    testingApproach?: string;
    buildTools?: string;
    dependencies?: string[];
    codeStyle?: string;
  };
  lastUpdated: number;
}

export interface CodeSolution {
  id: string;
  problem: string;
  solution: string;
  language: string;
  tags: string[];
  effectiveness: number;  // 0-1 based on outcomes
  usageCount: number;
}

// ==========================================
// SIMPLE EMBEDDING (without Vectra for now)
// ==========================================

/**
 * Generate a simple keyword-based "embedding" for similarity search
 * This is a placeholder until proper vector embeddings are set up
 */
function generateSimpleEmbedding(text: string): number[] {
  // Common programming keywords to track
  const keywords = [
    'function', 'class', 'interface', 'type', 'const', 'let', 'var',
    'async', 'await', 'promise', 'return', 'import', 'export',
    'if', 'else', 'for', 'while', 'switch', 'case',
    'try', 'catch', 'throw', 'error', 'exception',
    'api', 'http', 'request', 'response', 'fetch',
    'database', 'query', 'sql', 'insert', 'update', 'delete',
    'test', 'spec', 'mock', 'assert', 'expect',
    'component', 'render', 'state', 'props', 'hook',
    'file', 'read', 'write', 'path', 'directory',
    'config', 'env', 'setting', 'option', 'parameter'
  ];
  
  const lowerText = text.toLowerCase();
  return keywords.map(kw => lowerText.includes(kw) ? 1 : 0);
}

/**
 * Calculate cosine similarity between two embeddings
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ==========================================
// SEMANTIC MEMORY CLASS
// ==========================================

export class SemanticMemory {
  private knowledge: Map<string, KnowledgeEntry>;
  private patterns: Map<string, ProjectPattern>;
  private solutions: Map<string, CodeSolution>;
  private dbPath: string;
  private initialized: boolean = false;
  
  constructor(dataDir: string = '.jeeves') {
    this.dbPath = path.join(dataDir, 'semantic.json');
    this.knowledge = new Map();
    this.patterns = new Map();
    this.solutions = new Map();
  }
  
  /**
   * Initialize the semantic memory store
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    
    try {
      const dataDir = path.dirname(this.dbPath);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      
      if (fs.existsSync(this.dbPath)) {
        const data = JSON.parse(fs.readFileSync(this.dbPath, 'utf-8'));
        this.knowledge = new Map(Object.entries(data.knowledge || {}));
        this.patterns = new Map(Object.entries(data.patterns || {}));
        this.solutions = new Map(Object.entries(data.solutions || {}));
      }
      
      this.initialized = true;
      logger.debug('Semantic memory initialized', { 
        path: this.dbPath,
        entries: this.knowledge.size
      });
      
    } catch (error) {
      logger.error('Failed to initialize semantic memory', { error: String(error) });
      this.initialized = true;
    }
  }
  
  private persist(): void {
    try {
      const data = {
        knowledge: Object.fromEntries(this.knowledge),
        patterns: Object.fromEntries(this.patterns),
        solutions: Object.fromEntries(this.solutions)
      };
      
      fs.writeFileSync(this.dbPath, JSON.stringify(data, null, 2));
    } catch (error) {
      logger.error('Failed to persist semantic memory', { error: String(error) });
    }
  }
  
  // ==========================================
  // KNOWLEDGE MANAGEMENT
  // ==========================================
  
  /**
   * Store a piece of knowledge
   */
  storeKnowledge(entry: Omit<KnowledgeEntry, 'id' | 'embedding' | 'usageCount' | 'lastUsed' | 'createdAt'>): string {
    const id = `know_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const fullEntry: KnowledgeEntry = {
      ...entry,
      id,
      embedding: generateSimpleEmbedding(entry.content),
      usageCount: 0,
      lastUsed: Date.now(),
      createdAt: Date.now()
    };
    
    this.knowledge.set(id, fullEntry);
    this.persist();
    
    logger.debug('Knowledge stored', { id, type: entry.type });
    
    return id;
  }
  
  /**
   * Search for relevant knowledge
   */
  searchKnowledge(query: string, options: {
    type?: KnowledgeEntry['type'];
    projectPath?: string;
    limit?: number;
    minConfidence?: number;
  } = {}): KnowledgeEntry[] {
    const { type, projectPath, limit = 5, minConfidence = 0.3 } = options;
    
    const queryEmbedding = generateSimpleEmbedding(query);
    
    let entries = Array.from(this.knowledge.values())
      .filter(e => e.confidence >= minConfidence);
    
    // Filter by type if specified
    if (type) {
      entries = entries.filter(e => e.type === type);
    }
    
    // Filter by project if specified
    if (projectPath) {
      entries = entries.filter(e => !e.projectPath || e.projectPath === projectPath);
    }
    
    // Calculate similarity and sort
    const scored = entries.map(entry => ({
      entry,
      score: entry.embedding 
        ? cosineSimilarity(queryEmbedding, entry.embedding)
        : 0
    }));
    
    return scored
      .filter(({ score }) => score > 0.1)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ entry }) => {
        // Update usage stats
        entry.usageCount++;
        entry.lastUsed = Date.now();
        return entry;
      });
  }
  
  /**
   * Mark knowledge as used (reinforcement)
   */
  reinforceKnowledge(id: string, wasHelpful: boolean): void {
    const entry = this.knowledge.get(id);
    if (entry) {
      entry.usageCount++;
      entry.lastUsed = Date.now();
      
      // Adjust confidence based on helpfulness
      if (wasHelpful) {
        entry.confidence = Math.min(1, entry.confidence + 0.05);
      } else {
        entry.confidence = Math.max(0.1, entry.confidence - 0.1);
      }
      
      this.persist();
    }
  }
  
  // ==========================================
  // PROJECT PATTERNS
  // ==========================================
  
  /**
   * Learn patterns from a project
   */
  async learnProjectPatterns(projectPath: string): Promise<ProjectPattern> {
    logger.debug('Learning project patterns', { projectPath });
    
    // Try to identify project patterns from common files
    const patterns: ProjectPattern['patterns'] = {};
    
    // Check for package.json
    const packageJsonPath = path.join(projectPath, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
        patterns.dependencies = Object.keys(pkg.dependencies || {});
        
        // Infer build tools from scripts
        const scripts = Object.keys(pkg.scripts || {});
        if (scripts.includes('build')) {
          patterns.buildTools = 'npm scripts';
        }
      } catch {
        // Ignore parse errors
      }
    }
    
    // Check for TypeScript
    if (fs.existsSync(path.join(projectPath, 'tsconfig.json'))) {
      patterns.codeStyle = 'TypeScript';
    }
    
    // Check for common test directories
    if (fs.existsSync(path.join(projectPath, '__tests__')) ||
        fs.existsSync(path.join(projectPath, 'tests')) ||
        fs.existsSync(path.join(projectPath, 'test'))) {
      patterns.testingApproach = 'Dedicated test directory';
    }
    
    const projectPattern: ProjectPattern = {
      projectPath,
      patterns,
      lastUpdated: Date.now()
    };
    
    this.patterns.set(projectPath, projectPattern);
    this.persist();
    
    return projectPattern;
  }
  
  /**
   * Get patterns for a project
   */
  getProjectPatterns(projectPath: string): ProjectPattern | null {
    return this.patterns.get(projectPath) || null;
  }
  
  // ==========================================
  // CODE SOLUTIONS
  // ==========================================
  
  /**
   * Store a code solution
   */
  storeSolution(problem: string, solution: string, language: string, tags: string[]): string {
    const id = `sol_${Date.now()}`;
    
    this.solutions.set(id, {
      id,
      problem,
      solution,
      language,
      tags,
      effectiveness: 0.5,  // Start neutral
      usageCount: 0
    });
    
    this.persist();
    
    return id;
  }
  
  /**
   * Find solutions for a problem
   */
  findSolutions(problem: string, language?: string): CodeSolution[] {
    const keywords = problem.toLowerCase().split(/\s+/);
    
    return Array.from(this.solutions.values())
      .filter(sol => !language || sol.language === language)
      .map(sol => ({
        solution: sol,
        score: keywords.filter(kw => 
          sol.problem.toLowerCase().includes(kw) ||
          sol.tags.some(t => t.includes(kw))
        ).length
      }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map(({ solution }) => solution);
  }
  
  /**
   * Update solution effectiveness
   */
  updateSolutionEffectiveness(id: string, worked: boolean): void {
    const solution = this.solutions.get(id);
    if (solution) {
      solution.usageCount++;
      
      // Bayesian update of effectiveness
      const alpha = worked ? 1 : 0;
      solution.effectiveness = (solution.effectiveness * (solution.usageCount - 1) + alpha) / solution.usageCount;
      
      this.persist();
    }
  }
  
  // ==========================================
  // KNOWLEDGE SYNTHESIS
  // ==========================================
  
  /**
   * Use LLM to synthesize new knowledge from observations
   */
  async synthesizeKnowledge(observations: string[]): Promise<string[]> {
    if (observations.length < 3) {
      return [];  // Need enough observations to synthesize
    }
    
    try {
      const anthropic = createAnthropic({
        apiKey: process.env.ANTHROPIC_API_KEY
      });
      
      const result = await generateText({
        model: anthropic('claude-3-5-haiku-20241022'),
        prompt: `Analyze these observations and extract general patterns or best practices:

OBSERVATIONS:
${observations.map((o, i) => `${i + 1}. ${o}`).join('\n')}

Extract 1-3 general insights that could be useful for similar future tasks.
Respond with JSON: { "insights": ["insight 1", "insight 2"] }`,
        maxTokens: 200
      });
      
      if (result.usage) {
        trackLLMUsage('semantic-synthesis', 'claude-3-5-haiku-20241022',
          result.usage.promptTokens, result.usage.completionTokens, false);
      }
      
      const parsed = JSON.parse(result.text.match(/\{[\s\S]*\}/)?.[0] || '{}');
      
      // Store each insight
      const insightIds: string[] = [];
      for (const insight of parsed.insights || []) {
        const id = this.storeKnowledge({
          type: 'best_practice',
          content: insight,
          tags: ['synthesized'],
          confidence: 0.6,
          source: 'inferred'
        });
        insightIds.push(id);
      }
      
      return insightIds;
      
    } catch (error) {
      logger.debug('Knowledge synthesis failed', { error: String(error) });
      return [];
    }
  }
  
  // ==========================================
  // STATISTICS
  // ==========================================
  
  getStats(): {
    knowledgeCount: number;
    patternCount: number;
    solutionCount: number;
    byType: Record<string, number>;
  } {
    const byType: Record<string, number> = {};
    
    for (const entry of this.knowledge.values()) {
      byType[entry.type] = (byType[entry.type] || 0) + 1;
    }
    
    return {
      knowledgeCount: this.knowledge.size,
      patternCount: this.patterns.size,
      solutionCount: this.solutions.size,
      byType
    };
  }
  
  /**
   * Clear all semantic memory
   */
  clear(): void {
    this.knowledge = new Map();
    this.patterns = new Map();
    this.solutions = new Map();
    this.persist();
  }
}

// ==========================================
// SINGLETON INSTANCE
// ==========================================

let instance: SemanticMemory | null = null;

export async function getSemanticMemory(dataDir?: string): Promise<SemanticMemory> {
  if (!instance) {
    instance = new SemanticMemory(dataDir);
    await instance.init();
  }
  return instance;
}

export function resetSemanticMemory(): void {
  if (instance) {
    instance.clear();
  }
  instance = null;
}
