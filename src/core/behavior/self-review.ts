/**
 * Self-Review Checklist System
 * 
 * Pre-submission checks Jeeves runs before delivering work:
 * 1. Compilation/Type checking
 * 2. Linting passes
 * 3. Tests pass (if available)
 * 4. No debug artifacts left behind
 * 5. Documentation updated (if needed)
 * 6. Changes match requirements
 */

import { logger } from '../../utils/logger.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execAsync = promisify(exec);

// ==========================================
// TYPES
// ==========================================

export type CheckCategory = 
  | 'compilation'
  | 'linting'
  | 'testing'
  | 'artifacts'
  | 'documentation'
  | 'requirements';

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'skip' | 'pending';

export interface CheckResult {
  id: string;
  category: CheckCategory;
  name: string;
  status: CheckStatus;
  message?: string;
  details?: string[];
  duration?: number;
  canFix?: boolean;
  fixCommand?: string;
}

export interface ReviewResult {
  passed: boolean;
  timestamp: number;
  duration: number;
  checks: CheckResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    warnings: number;
    skipped: number;
  };
  blockers: string[];
  suggestions: string[];
}

export interface ReviewConfig {
  projectPath: string;
  changedFiles?: string[];
  skipCategories?: CheckCategory[];
  quickMode?: boolean;  // Skip slow checks
}

// ==========================================
// CHECK DEFINITIONS
// ==========================================

interface CheckDefinition {
  id: string;
  category: CheckCategory;
  name: string;
  description: string;
  quick: boolean;  // Can run in quick mode
  run: (config: ReviewConfig) => Promise<CheckResult>;
}

const CHECKS: CheckDefinition[] = [
  // Compilation checks
  {
    id: 'ts_compile',
    category: 'compilation',
    name: 'TypeScript Compilation',
    description: 'Verify TypeScript compiles without errors',
    quick: true,
    run: async (config) => {
      const start = Date.now();
      const tsconfigPath = path.join(config.projectPath, 'tsconfig.json');
      
      if (!fs.existsSync(tsconfigPath)) {
        return {
          id: 'ts_compile',
          category: 'compilation',
          name: 'TypeScript Compilation',
          status: 'skip',
          message: 'No tsconfig.json found',
          duration: Date.now() - start
        };
      }
      
      try {
        await execAsync('npx tsc --noEmit', { cwd: config.projectPath });
        return {
          id: 'ts_compile',
          category: 'compilation',
          name: 'TypeScript Compilation',
          status: 'pass',
          message: 'No type errors',
          duration: Date.now() - start
        };
      } catch (error: unknown) {
        const errorOutput = error && typeof error === 'object' && 'stderr' in error 
          ? String((error as { stderr: unknown }).stderr)
          : String(error);
        
        // Parse error count
        const errorMatch = errorOutput.match(/Found (\d+) error/);
        const errorCount = errorMatch ? parseInt(errorMatch[1]) : 'unknown';
        
        return {
          id: 'ts_compile',
          category: 'compilation',
          name: 'TypeScript Compilation',
          status: 'fail',
          message: `${errorCount} type error(s) found`,
          details: errorOutput.split('\n').slice(0, 10),
          duration: Date.now() - start,
          canFix: false
        };
      }
    }
  },
  
  // Linting checks
  {
    id: 'eslint',
    category: 'linting',
    name: 'ESLint',
    description: 'Check for linting errors',
    quick: true,
    run: async (config) => {
      const start = Date.now();
      const eslintConfig = [
        '.eslintrc.js',
        '.eslintrc.json',
        '.eslintrc.yaml',
        'eslint.config.js',
        'eslint.config.mjs'
      ].some(f => fs.existsSync(path.join(config.projectPath, f)));
      
      if (!eslintConfig) {
        return {
          id: 'eslint',
          category: 'linting',
          name: 'ESLint',
          status: 'skip',
          message: 'No ESLint config found',
          duration: Date.now() - start
        };
      }
      
      try {
        // Only lint changed files if specified
        const files = config.changedFiles?.length 
          ? config.changedFiles.join(' ')
          : '.';
        
        await execAsync(`npx eslint ${files} --max-warnings 0`, { cwd: config.projectPath });
        return {
          id: 'eslint',
          category: 'linting',
          name: 'ESLint',
          status: 'pass',
          message: 'No linting errors',
          duration: Date.now() - start
        };
      } catch (error: unknown) {
        const errorOutput = error && typeof error === 'object' && 'stdout' in error
          ? String((error as { stdout: unknown }).stdout)
          : String(error);
        
        const errorCount = (errorOutput.match(/\d+ error/g) || []).length;
        const warnCount = (errorOutput.match(/\d+ warning/g) || []).length;
        
        return {
          id: 'eslint',
          category: 'linting',
          name: 'ESLint',
          status: errorCount > 0 ? 'fail' : 'warn',
          message: `${errorCount} errors, ${warnCount} warnings`,
          details: errorOutput.split('\n').slice(0, 10),
          duration: Date.now() - start,
          canFix: true,
          fixCommand: 'npx eslint --fix'
        };
      }
    }
  },
  
  // Testing checks
  {
    id: 'tests_run',
    category: 'testing',
    name: 'Run Tests',
    description: 'Execute test suite',
    quick: false,  // Tests can be slow
    run: async (config) => {
      const start = Date.now();
      const packageJson = path.join(config.projectPath, 'package.json');
      
      if (!fs.existsSync(packageJson)) {
        return {
          id: 'tests_run',
          category: 'testing',
          name: 'Run Tests',
          status: 'skip',
          message: 'No package.json found',
          duration: Date.now() - start
        };
      }
      
      try {
        const pkg = JSON.parse(fs.readFileSync(packageJson, 'utf-8'));
        if (!pkg.scripts?.test) {
          return {
            id: 'tests_run',
            category: 'testing',
            name: 'Run Tests',
            status: 'skip',
            message: 'No test script defined',
            duration: Date.now() - start
          };
        }
        
        await execAsync('npm test', { cwd: config.projectPath, timeout: 60000 });
        return {
          id: 'tests_run',
          category: 'testing',
          name: 'Run Tests',
          status: 'pass',
          message: 'All tests passed',
          duration: Date.now() - start
        };
      } catch (error: unknown) {
        const errorOutput = error && typeof error === 'object' && 'stdout' in error
          ? String((error as { stdout: unknown }).stdout)
          : String(error);
        
        return {
          id: 'tests_run',
          category: 'testing',
          name: 'Run Tests',
          status: 'fail',
          message: 'Some tests failed',
          details: errorOutput.split('\n').slice(-15),
          duration: Date.now() - start
        };
      }
    }
  },
  
  // Debug artifacts check
  {
    id: 'debug_artifacts',
    category: 'artifacts',
    name: 'Debug Artifacts',
    description: 'Check for leftover debug code',
    quick: true,
    run: async (config) => {
      const start = Date.now();
      const patterns = [
        /console\.log\(/g,
        /debugger;/g,
        /TODO:/gi,
        /FIXME:/gi,
        /XXX:/gi,
        /\btest\b.*=.*true/gi
      ];
      
      const issues: string[] = [];
      const filesToCheck = config.changedFiles || [];
      
      // If no specific files, check common source directories
      if (filesToCheck.length === 0) {
        const srcDir = path.join(config.projectPath, 'src');
        if (fs.existsSync(srcDir)) {
          // Would need to recursively read files - simplified for now
          return {
            id: 'debug_artifacts',
            category: 'artifacts',
            name: 'Debug Artifacts',
            status: 'skip',
            message: 'No changed files specified',
            duration: Date.now() - start
          };
        }
      }
      
      for (const file of filesToCheck) {
        const filePath = path.isAbsolute(file) ? file : path.join(config.projectPath, file);
        
        if (!fs.existsSync(filePath)) continue;
        if (!/\.(ts|tsx|js|jsx)$/.test(file)) continue;
        
        const content = fs.readFileSync(filePath, 'utf-8');
        
        for (const pattern of patterns) {
          const matches = content.match(pattern);
          if (matches) {
            issues.push(`${file}: ${matches.length}x ${pattern.source}`);
          }
        }
      }
      
      if (issues.length === 0) {
        return {
          id: 'debug_artifacts',
          category: 'artifacts',
          name: 'Debug Artifacts',
          status: 'pass',
          message: 'No debug artifacts found',
          duration: Date.now() - start
        };
      }
      
      return {
        id: 'debug_artifacts',
        category: 'artifacts',
        name: 'Debug Artifacts',
        status: 'warn',
        message: `Found ${issues.length} potential debug artifacts`,
        details: issues.slice(0, 10),
        duration: Date.now() - start
      };
    }
  },
  
  // Build check
  {
    id: 'build',
    category: 'compilation',
    name: 'Production Build',
    description: 'Verify production build succeeds',
    quick: false,
    run: async (config) => {
      const start = Date.now();
      const packageJson = path.join(config.projectPath, 'package.json');
      
      if (!fs.existsSync(packageJson)) {
        return {
          id: 'build',
          category: 'compilation',
          name: 'Production Build',
          status: 'skip',
          message: 'No package.json found',
          duration: Date.now() - start
        };
      }
      
      try {
        const pkg = JSON.parse(fs.readFileSync(packageJson, 'utf-8'));
        if (!pkg.scripts?.build) {
          return {
            id: 'build',
            category: 'compilation',
            name: 'Production Build',
            status: 'skip',
            message: 'No build script defined',
            duration: Date.now() - start
          };
        }
        
        await execAsync('npm run build', { cwd: config.projectPath, timeout: 120000 });
        return {
          id: 'build',
          category: 'compilation',
          name: 'Production Build',
          status: 'pass',
          message: 'Build succeeded',
          duration: Date.now() - start
        };
      } catch (error: unknown) {
        const errorOutput = error && typeof error === 'object' && 'stderr' in error
          ? String((error as { stderr: unknown }).stderr)
          : String(error);
        
        return {
          id: 'build',
          category: 'compilation',
          name: 'Production Build',
          status: 'fail',
          message: 'Build failed',
          details: errorOutput.split('\n').slice(-10),
          duration: Date.now() - start
        };
      }
    }
  }
];

// ==========================================
// SELF-REVIEW CLASS
// ==========================================

export class SelfReview {
  private lastReview: ReviewResult | null = null;
  
  /**
   * Run the full self-review checklist
   */
  async review(config: ReviewConfig): Promise<ReviewResult> {
    const start = Date.now();
    const checks: CheckResult[] = [];
    const skipCategories = new Set(config.skipCategories || []);
    
    logger.debug('Starting self-review', { 
      projectPath: config.projectPath,
      quickMode: config.quickMode,
      changedFiles: config.changedFiles?.length
    });
    
    // Run each check
    for (const check of CHECKS) {
      // Skip if category is excluded
      if (skipCategories.has(check.category)) {
        checks.push({
          id: check.id,
          category: check.category,
          name: check.name,
          status: 'skip',
          message: 'Category skipped'
        });
        continue;
      }
      
      // Skip slow checks in quick mode
      if (config.quickMode && !check.quick) {
        checks.push({
          id: check.id,
          category: check.category,
          name: check.name,
          status: 'skip',
          message: 'Skipped in quick mode'
        });
        continue;
      }
      
      try {
        const result = await check.run(config);
        checks.push(result);
      } catch (error) {
        checks.push({
          id: check.id,
          category: check.category,
          name: check.name,
          status: 'fail',
          message: `Check failed: ${String(error)}`
        });
      }
    }
    
    // Calculate summary
    const summary = {
      total: checks.length,
      passed: checks.filter(c => c.status === 'pass').length,
      failed: checks.filter(c => c.status === 'fail').length,
      warnings: checks.filter(c => c.status === 'warn').length,
      skipped: checks.filter(c => c.status === 'skip').length
    };
    
    // Identify blockers and suggestions
    const blockers: string[] = [];
    const suggestions: string[] = [];
    
    for (const check of checks) {
      if (check.status === 'fail') {
        blockers.push(`${check.name}: ${check.message}`);
        if (check.canFix && check.fixCommand) {
          suggestions.push(`Run: ${check.fixCommand}`);
        }
      } else if (check.status === 'warn') {
        suggestions.push(`${check.name}: ${check.message}`);
      }
    }
    
    const result: ReviewResult = {
      passed: summary.failed === 0,
      timestamp: Date.now(),
      duration: Date.now() - start,
      checks,
      summary,
      blockers,
      suggestions
    };
    
    this.lastReview = result;
    
    logger.debug('Self-review complete', { 
      passed: result.passed,
      duration: result.duration,
      summary
    });
    
    return result;
  }
  
  /**
   * Run only quick checks
   */
  async quickReview(config: ReviewConfig): Promise<ReviewResult> {
    return this.review({ ...config, quickMode: true });
  }
  
  /**
   * Get the last review result
   */
  getLastReview(): ReviewResult | null {
    return this.lastReview;
  }
  
  /**
   * Format review result as a report
   */
  formatReport(result: ReviewResult): string {
    const lines: string[] = [];
    
    lines.push('## Self-Review Report');
    lines.push('');
    lines.push(`**Status:** ${result.passed ? '✅ PASSED' : '❌ FAILED'}`);
    lines.push(`**Duration:** ${result.duration}ms`);
    lines.push('');
    
    lines.push('### Summary');
    lines.push(`- Passed: ${result.summary.passed}`);
    lines.push(`- Failed: ${result.summary.failed}`);
    lines.push(`- Warnings: ${result.summary.warnings}`);
    lines.push(`- Skipped: ${result.summary.skipped}`);
    lines.push('');
    
    if (result.blockers.length > 0) {
      lines.push('### Blockers');
      for (const blocker of result.blockers) {
        lines.push(`- ❌ ${blocker}`);
      }
      lines.push('');
    }
    
    if (result.suggestions.length > 0) {
      lines.push('### Suggestions');
      for (const suggestion of result.suggestions) {
        lines.push(`- 💡 ${suggestion}`);
      }
      lines.push('');
    }
    
    lines.push('### Detailed Checks');
    for (const check of result.checks) {
      const icon = {
        pass: '✅',
        fail: '❌',
        warn: '⚠️',
        skip: '⏭️',
        pending: '⏳'
      }[check.status];
      
      lines.push(`- ${icon} **${check.name}**: ${check.message || check.status}`);
      
      if (check.details && check.details.length > 0) {
        lines.push('  ```');
        for (const detail of check.details.slice(0, 5)) {
          lines.push(`  ${detail}`);
        }
        lines.push('  ```');
      }
    }
    
    return lines.join('\n');
  }
}

// ==========================================
// SINGLETON INSTANCE
// ==========================================

let instance: SelfReview | null = null;

export function getSelfReview(): SelfReview {
  if (!instance) {
    instance = new SelfReview();
  }
  return instance;
}
