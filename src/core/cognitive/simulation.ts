/**
 * Mental Simulation (Pre-Execution Impact Analysis)
 * 
 * Before executing any file changes:
 * 1. Simulate what will change
 * 2. Identify impact on dependent files
 * 3. Predict potential breakages
 * 4. Suggest rollback strategy
 */

import { generateText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { logger } from '../../utils/logger.js';
import { trackLLMUsage } from '../cost-tracker.js';
import * as fs from 'fs';
import * as path from 'path';

// ==========================================
// TYPES
// ==========================================

export interface FileChange {
  path: string;
  type: 'create' | 'modify' | 'delete' | 'rename';
  description: string;
  oldContent?: string;
  newContent?: string;
  diff?: string;
}

export interface ImpactAssessment {
  directImpact: string[];       // Files directly changed
  indirectImpact: string[];     // Files that import/depend on changed files
  potentialBreaks: BreakageRisk[];
  rollbackStrategy: RollbackStep[];
  testSuggestions: string[];
}

export interface BreakageRisk {
  type: 'compilation' | 'runtime' | 'logic' | 'integration' | 'data';
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  affectedFiles: string[];
  mitigation?: string;
}

export interface RollbackStep {
  order: number;
  action: string;
  command?: string;
}

export interface SimulationResult {
  changes: FileChange[];
  impact: ImpactAssessment;
  shouldProceed: boolean;
  blockers: string[];
  warnings: string[];
  confidence: number;
}

// ==========================================
// MAIN SIMULATION FUNCTION
// ==========================================

/**
 * Simulate the impact of proposed changes before execution
 */
export async function simulateChanges(
  changes: FileChange[],
  projectPath: string
): Promise<SimulationResult> {
  logger.debug('Simulating changes', { 
    changeCount: changes.length, 
    projectPath 
  });
  
  const blockers: string[] = [];
  const warnings: string[] = [];
  
  // 1. Validate changes are possible
  const validation = await validateChanges(changes, projectPath);
  blockers.push(...validation.blockers);
  warnings.push(...validation.warnings);
  
  // 2. Find dependent files
  const directImpact = changes.map(c => c.path);
  const indirectImpact = await findDependentFiles(changes, projectPath);
  
  // 3. Analyze breakage risks
  const potentialBreaks = await analyzeBreakageRisks(changes, indirectImpact, projectPath);
  
  // 4. Generate rollback strategy
  const rollbackStrategy = generateRollbackStrategy(changes);
  
  // 5. Suggest tests
  const testSuggestions = generateTestSuggestions(changes, potentialBreaks);
  
  // Calculate overall confidence
  const confidence = calculateConfidence(blockers, warnings, potentialBreaks);
  
  return {
    changes,
    impact: {
      directImpact,
      indirectImpact,
      potentialBreaks,
      rollbackStrategy,
      testSuggestions
    },
    shouldProceed: blockers.length === 0,
    blockers,
    warnings,
    confidence
  };
}

// ==========================================
// VALIDATION
// ==========================================

interface ValidationResult {
  valid: boolean;
  blockers: string[];
  warnings: string[];
}

async function validateChanges(
  changes: FileChange[], 
  projectPath: string
): Promise<ValidationResult> {
  const blockers: string[] = [];
  const warnings: string[] = [];
  
  for (const change of changes) {
    const fullPath = path.isAbsolute(change.path) 
      ? change.path 
      : path.join(projectPath, change.path);
    
    switch (change.type) {
      case 'modify':
      case 'delete':
        // Check file exists
        if (!fs.existsSync(fullPath)) {
          blockers.push(`File does not exist: ${change.path}`);
        }
        break;
        
      case 'create':
        // Check file doesn't already exist
        if (fs.existsSync(fullPath)) {
          warnings.push(`File already exists, will be overwritten: ${change.path}`);
        }
        // Check parent directory exists
        const parentDir = path.dirname(fullPath);
        if (!fs.existsSync(parentDir)) {
          warnings.push(`Parent directory will be created: ${path.dirname(change.path)}`);
        }
        break;
        
      case 'rename':
        // Check source exists
        if (!fs.existsSync(fullPath)) {
          blockers.push(`Source file does not exist: ${change.path}`);
        }
        break;
    }
    
    // Check for protected files
    if (isProtectedFile(change.path)) {
      if (change.type === 'delete') {
        blockers.push(`Cannot delete protected file: ${change.path}`);
      } else {
        warnings.push(`Modifying protected file: ${change.path}`);
      }
    }
  }
  
  return {
    valid: blockers.length === 0,
    blockers,
    warnings
  };
}

function isProtectedFile(filePath: string): boolean {
  const protectedPatterns = [
    /package\.json$/,
    /package-lock\.json$/,
    /tsconfig\.json$/,
    /\.env$/,
    /\.gitignore$/,
    /\.eslintrc/,
    /webpack\.config/,
    /vite\.config/
  ];
  
  return protectedPatterns.some(p => p.test(filePath));
}

// ==========================================
// DEPENDENCY ANALYSIS
// ==========================================

async function findDependentFiles(
  changes: FileChange[],
  projectPath: string
): Promise<string[]> {
  const dependents = new Set<string>();
  
  for (const change of changes) {
    // Extract module name from file path
    const moduleName = extractModuleName(change.path);
    
    if (moduleName) {
      // Find files that import this module
      const importers = await findImporters(moduleName, projectPath);
      importers.forEach(f => dependents.add(f));
    }
  }
  
  return Array.from(dependents);
}

function extractModuleName(filePath: string): string | null {
  // Remove extension and convert to import path
  const withoutExt = filePath.replace(/\.(ts|tsx|js|jsx)$/, '');
  
  // Get the file name or directory name (for index files)
  const parts = withoutExt.split(/[\\/]/);
  const fileName = parts[parts.length - 1];
  
  if (fileName === 'index') {
    return parts[parts.length - 2] || null;
  }
  
  return fileName;
}

async function findImporters(moduleName: string, projectPath: string): Promise<string[]> {
  // Simple implementation: look for import statements
  // A more robust implementation would use a proper AST parser
  
  const importers: string[] = [];
  
  // This is a simplified version - in production, you'd walk the directory tree
  // and use proper import resolution
  
  try {
    // For now, return empty - the LLM analysis will catch these
    logger.debug('Finding importers', { moduleName, projectPath });
  } catch (error) {
    logger.debug('Error finding importers', { error: String(error) });
  }
  
  return importers;
}

// ==========================================
// BREAKAGE ANALYSIS
// ==========================================

async function analyzeBreakageRisks(
  changes: FileChange[],
  dependentFiles: string[],
  projectPath: string
): Promise<BreakageRisk[]> {
  const risks: BreakageRisk[] = [];
  
  // Quick heuristic analysis
  for (const change of changes) {
    // Deletion is always high risk
    if (change.type === 'delete') {
      risks.push({
        type: 'compilation',
        severity: dependentFiles.length > 0 ? 'high' : 'medium',
        description: `Deleting ${change.path} may break imports`,
        affectedFiles: dependentFiles,
        mitigation: 'Update imports in dependent files'
      });
    }
    
    // Type changes in TypeScript
    if (/\.(ts|tsx)$/.test(change.path)) {
      if (change.diff?.includes('interface') || change.diff?.includes('type')) {
        risks.push({
          type: 'compilation',
          severity: 'medium',
          description: 'Type definition changes may break type checking',
          affectedFiles: dependentFiles,
          mitigation: 'Run tsc --noEmit to verify'
        });
      }
    }
    
    // API/export changes
    if (change.diff?.includes('export')) {
      risks.push({
        type: 'compilation',
        severity: 'medium',
        description: 'Export changes may break imports',
        affectedFiles: dependentFiles,
        mitigation: 'Update imports in consuming files'
      });
    }
    
    // Database/schema changes
    if (/schema|migration|database|\.sql/i.test(change.path)) {
      risks.push({
        type: 'data',
        severity: 'high',
        description: 'Database schema changes may cause data issues',
        affectedFiles: [change.path],
        mitigation: 'Test with staging database first'
      });
    }
  }
  
  // If we have complex changes, use LLM for deeper analysis
  if (changes.length > 3 || dependentFiles.length > 5) {
    const llmRisks = await analyzeWithLLM(changes, dependentFiles, projectPath);
    risks.push(...llmRisks);
  }
  
  return deduplicateRisks(risks);
}

async function analyzeWithLLM(
  changes: FileChange[],
  dependentFiles: string[],
  projectPath: string
): Promise<BreakageRisk[]> {
  try {
    const anthropic = createAnthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });
    
    const changesSummary = changes.map(c => 
      `- ${c.type.toUpperCase()} ${c.path}: ${c.description}`
    ).join('\n');
    
    const prompt = `Analyze these code changes for potential breakages:

CHANGES:
${changesSummary}

DEPENDENT FILES: ${dependentFiles.join(', ') || 'None identified'}

Identify risks in these categories:
- compilation: TypeScript/build errors
- runtime: Crashes, exceptions at runtime
- logic: Incorrect behavior, subtle bugs
- integration: API/interface mismatches
- data: Data corruption, migration issues

For each risk, assess severity: low/medium/high/critical

Respond with ONLY JSON:
{
  "risks": [
    {
      "type": "compilation|runtime|logic|integration|data",
      "severity": "low|medium|high|critical",
      "description": "...",
      "affectedFiles": ["file1.ts"],
      "mitigation": "how to prevent/fix"
    }
  ]
}`;

    const result = await generateText({
      model: anthropic('claude-3-5-haiku-20241022'),
      prompt,
      maxTokens: 400
    });
    
    if (result.usage) {
      trackLLMUsage('simulation', 'claude-3-5-haiku-20241022',
        result.usage.promptTokens, result.usage.completionTokens, false);
    }
    
    const parsed = JSON.parse(result.text.match(/\{[\s\S]*\}/)?.[0] || '{}');
    
    return (parsed.risks || []).map((r: BreakageRisk) => ({
      type: r.type || 'logic',
      severity: r.severity || 'medium',
      description: r.description || 'Unknown risk',
      affectedFiles: r.affectedFiles || [],
      mitigation: r.mitigation
    }));
    
  } catch (error) {
    logger.debug('LLM risk analysis failed', { error: String(error) });
    return [];
  }
}

function deduplicateRisks(risks: BreakageRisk[]): BreakageRisk[] {
  const seen = new Set<string>();
  return risks.filter(r => {
    const key = `${r.type}:${r.description.substring(0, 30)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ==========================================
// ROLLBACK STRATEGY
// ==========================================

function generateRollbackStrategy(changes: FileChange[]): RollbackStep[] {
  const steps: RollbackStep[] = [];
  let order = 1;
  
  // First step: ensure we have backup
  steps.push({
    order: order++,
    action: 'Create backups of all modified files',
    command: 'jeeves backup create'
  });
  
  // For each change, add appropriate rollback
  for (const change of changes) {
    switch (change.type) {
      case 'create':
        steps.push({
          order: order++,
          action: `Delete newly created file: ${change.path}`,
          command: `rm "${change.path}"`
        });
        break;
        
      case 'modify':
        steps.push({
          order: order++,
          action: `Restore original version of: ${change.path}`,
          command: `git checkout HEAD -- "${change.path}"`
        });
        break;
        
      case 'delete':
        steps.push({
          order: order++,
          action: `Restore deleted file: ${change.path}`,
          command: `jeeves restore "${change.path}"`
        });
        break;
        
      case 'rename':
        steps.push({
          order: order++,
          action: `Rename file back to original: ${change.path}`,
          command: `git checkout HEAD -- "${change.path}"`
        });
        break;
    }
  }
  
  // Final step: verify
  steps.push({
    order: order++,
    action: 'Verify rollback succeeded',
    command: 'git status && npm run build'
  });
  
  return steps;
}

// ==========================================
// TEST SUGGESTIONS
// ==========================================

function generateTestSuggestions(
  changes: FileChange[],
  risks: BreakageRisk[]
): string[] {
  const suggestions: string[] = [];
  
  // Always suggest build verification
  suggestions.push('Run full build: npm run build');
  
  // Type checking for TypeScript
  if (changes.some(c => /\.(ts|tsx)$/.test(c.path))) {
    suggestions.push('Type check: tsc --noEmit');
  }
  
  // Linting
  suggestions.push('Lint changed files: npm run lint');
  
  // If there are test files, run tests
  if (changes.some(c => /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(c.path))) {
    suggestions.push('Run related tests: npm test -- --grep "affected modules"');
  }
  
  // Risk-specific suggestions
  for (const risk of risks) {
    if (risk.severity === 'high' || risk.severity === 'critical') {
      if (risk.type === 'data') {
        suggestions.push('Test with staging database before production');
      }
      if (risk.type === 'integration') {
        suggestions.push('Run integration tests: npm run test:integration');
      }
    }
  }
  
  return [...new Set(suggestions)];  // Deduplicate
}

// ==========================================
// CONFIDENCE CALCULATION
// ==========================================

function calculateConfidence(
  blockers: string[],
  warnings: string[],
  risks: BreakageRisk[]
): number {
  let confidence = 1.0;
  
  // Blockers are deal-breakers
  if (blockers.length > 0) {
    return 0;
  }
  
  // Warnings reduce confidence
  confidence -= warnings.length * 0.05;
  
  // Risks reduce confidence based on severity
  for (const risk of risks) {
    switch (risk.severity) {
      case 'critical':
        confidence -= 0.3;
        break;
      case 'high':
        confidence -= 0.15;
        break;
      case 'medium':
        confidence -= 0.05;
        break;
      case 'low':
        confidence -= 0.02;
        break;
    }
  }
  
  return Math.max(0, Math.min(1, confidence));
}

// ==========================================
// FORMATTING
// ==========================================

export function formatSimulationReport(result: SimulationResult): string {
  let report = `## Change Simulation Report

**Confidence:** ${(result.confidence * 100).toFixed(0)}%
**Proceed:** ${result.shouldProceed ? 'Yes' : 'No'}

### Changes (${result.changes.length})
${result.changes.map(c => `- ${c.type.toUpperCase()} ${c.path}`).join('\n')}
`;

  if (result.blockers.length > 0) {
    report += `\n### BLOCKERS\n${result.blockers.map(b => `- ${b}`).join('\n')}\n`;
  }

  if (result.warnings.length > 0) {
    report += `\n### Warnings\n${result.warnings.map(w => `- ${w}`).join('\n')}\n`;
  }

  if (result.impact.potentialBreaks.length > 0) {
    report += `\n### Potential Risks\n`;
    for (const risk of result.impact.potentialBreaks) {
      report += `- [${risk.severity.toUpperCase()}] ${risk.description}\n`;
      if (risk.mitigation) {
        report += `  → Mitigation: ${risk.mitigation}\n`;
      }
    }
  }

  if (result.impact.testSuggestions.length > 0) {
    report += `\n### Suggested Tests\n${result.impact.testSuggestions.map(t => `- ${t}`).join('\n')}\n`;
  }

  return report;
}

/**
 * Quick check if changes are safe enough to proceed without full simulation
 */
export function isLowRiskChange(changes: FileChange[]): boolean {
  // Single file modifications to non-critical files are low risk
  if (changes.length === 1 && changes[0].type === 'modify') {
    return !isProtectedFile(changes[0].path);
  }
  
  // Creating new files is generally low risk
  if (changes.every(c => c.type === 'create')) {
    return true;
  }
  
  return false;
}
