/**
 * Design Review Checklist System
 * 
 * Pre-submission design quality checks.
 * 
 * Rule: Every design decision should pass the "5 Whys" test.
 * Every visual element must serve a purpose.
 */

// ==========================================
// TYPES
// ==========================================

export type ReviewCategory =
  | 'visual-hierarchy'
  | 'typography'
  | 'color'
  | 'spacing'
  | 'accessibility'
  | 'responsiveness'
  | 'consistency'
  | 'interaction'
  | 'performance'
  | 'brand';

export type ReviewStatus = 'pass' | 'fail' | 'warning' | 'skip' | 'not-applicable';

export interface ReviewCheckItem {
  id: string;
  category: ReviewCategory;
  question: string;
  description: string;
  weight: number; // 1-10, importance
  autoCheckable: boolean;
  checkFunction?: (context: ReviewContext) => ReviewResult;
}

export interface ReviewContext {
  // Design tokens being used
  tokens?: Record<string, unknown>;
  // Components being reviewed
  components?: string[];
  // Page type
  pageType?: string;
  // Color values
  colors?: {
    foreground: string;
    background: string;
    primary: string;
    secondary: string;
  };
  // Typography values
  typography?: {
    headingSizes: number[];
    bodySizes: number[];
    lineHeights: number[];
  };
  // Spacing values
  spacing?: number[];
  // Custom context
  [key: string]: unknown;
}

export interface ReviewResult {
  status: ReviewStatus;
  message: string;
  details?: string;
  suggestions?: string[];
}

export interface DesignReview {
  timestamp: Date;
  reviewer: string;
  projectName: string;
  overallScore: number;
  results: ReviewItemResult[];
  summary: ReviewSummary;
}

export interface ReviewItemResult {
  checkId: string;
  status: ReviewStatus;
  notes?: string;
  autoResult?: ReviewResult;
}

export interface ReviewSummary {
  totalChecks: number;
  passed: number;
  failed: number;
  warnings: number;
  skipped: number;
  categoryScores: Record<ReviewCategory, number>;
  criticalIssues: string[];
  recommendations: string[];
}

// ==========================================
// REVIEW CHECKLIST
// ==========================================

export const designReviewChecklist: ReviewCheckItem[] = [
  // Visual Hierarchy
  {
    id: 'vh-clear-focal',
    category: 'visual-hierarchy',
    question: 'Is there a clear primary focal point on each screen?',
    description: 'Users should immediately know where to look first',
    weight: 9,
    autoCheckable: false,
  },
  {
    id: 'vh-three-levels',
    category: 'visual-hierarchy',
    question: 'Are there no more than 3 levels of visual emphasis?',
    description: 'Too many emphasis levels create confusion',
    weight: 8,
    autoCheckable: false,
  },
  {
    id: 'vh-cta-prominence',
    category: 'visual-hierarchy',
    question: 'Are primary CTAs the most visually prominent elements?',
    description: 'Main actions should stand out from other elements',
    weight: 9,
    autoCheckable: false,
  },
  {
    id: 'vh-z-pattern',
    category: 'visual-hierarchy',
    question: 'Does the layout follow a natural reading pattern (Z or F)?',
    description: 'Content should flow with how users naturally scan',
    weight: 7,
    autoCheckable: false,
  },

  // Typography
  {
    id: 'type-scale',
    category: 'typography',
    question: 'Does typography follow a consistent scale?',
    description: 'Font sizes should follow a mathematical ratio',
    weight: 8,
    autoCheckable: true,
    checkFunction: (ctx) => {
      if (!ctx.typography?.headingSizes || ctx.typography.headingSizes.length < 2) {
        return { status: 'skip', message: 'Not enough typography data' };
      }
      const sizes = [...ctx.typography.headingSizes].sort((a, b) => b - a);
      const ratios = sizes.slice(1).map((size, i) => sizes[i] / size);
      const avgRatio = ratios.reduce((a, b) => a + b, 0) / ratios.length;
      const variance = ratios.reduce((sum, r) => sum + Math.pow(r - avgRatio, 2), 0) / ratios.length;
      
      if (variance < 0.05) {
        return { status: 'pass', message: `Consistent scale with ratio ~${avgRatio.toFixed(2)}` };
      } else {
        return { 
          status: 'warning', 
          message: 'Type scale has inconsistent ratios',
          suggestions: ['Consider using a modular scale like 1.25 (Major Third) or 1.333 (Perfect Fourth)']
        };
      }
    },
  },
  {
    id: 'type-readability',
    category: 'typography',
    question: 'Is body text between 16-20px for comfortable reading?',
    description: 'Text that is too small strains eyes, too large wastes space',
    weight: 8,
    autoCheckable: true,
    checkFunction: (ctx) => {
      if (!ctx.typography?.bodySizes || ctx.typography.bodySizes.length === 0) {
        return { status: 'skip', message: 'No body size data' };
      }
      const mainBodySize = ctx.typography.bodySizes[0];
      if (mainBodySize >= 16 && mainBodySize <= 20) {
        return { status: 'pass', message: `Body text at ${mainBodySize}px is within optimal range` };
      } else if (mainBodySize >= 14 && mainBodySize <= 22) {
        return { status: 'warning', message: `Body text at ${mainBodySize}px is acceptable but not optimal` };
      } else {
        return { status: 'fail', message: `Body text at ${mainBodySize}px is outside comfortable range` };
      }
    },
  },
  {
    id: 'type-line-height',
    category: 'typography',
    question: 'Are line heights appropriate (1.4-1.6 for body text)?',
    description: 'Proper line height improves readability significantly',
    weight: 7,
    autoCheckable: true,
    checkFunction: (ctx) => {
      if (!ctx.typography?.lineHeights || ctx.typography.lineHeights.length === 0) {
        return { status: 'skip', message: 'No line height data' };
      }
      const avgLineHeight = ctx.typography.lineHeights.reduce((a, b) => a + b, 0) / ctx.typography.lineHeights.length;
      if (avgLineHeight >= 1.4 && avgLineHeight <= 1.7) {
        return { status: 'pass', message: `Line height ${avgLineHeight.toFixed(2)} is optimal` };
      } else {
        return { 
          status: 'warning', 
          message: `Line height ${avgLineHeight.toFixed(2)} may affect readability`,
          suggestions: ['Use 1.5 for body text, 1.2-1.3 for headings']
        };
      }
    },
  },
  {
    id: 'type-line-length',
    category: 'typography',
    question: 'Is line length between 45-75 characters for body text?',
    description: 'Lines that are too long or short impair reading',
    weight: 7,
    autoCheckable: false,
  },
  {
    id: 'type-font-pairing',
    category: 'typography',
    question: 'Are there no more than 2-3 font families used?',
    description: 'Too many fonts create visual noise',
    weight: 6,
    autoCheckable: false,
  },

  // Color
  {
    id: 'color-contrast-aa',
    category: 'color',
    question: 'Do all text elements meet WCAG AA contrast requirements?',
    description: '4.5:1 for normal text, 3:1 for large text',
    weight: 10,
    autoCheckable: false, // Would need actual color values
  },
  {
    id: 'color-limited-palette',
    category: 'color',
    question: 'Is the color palette limited (5-7 colors max)?',
    description: 'Too many colors create visual chaos',
    weight: 7,
    autoCheckable: false,
  },
  {
    id: 'color-meaning',
    category: 'color',
    question: 'Is color used consistently for meaning?',
    description: 'Red for errors, green for success, etc.',
    weight: 8,
    autoCheckable: false,
  },
  {
    id: 'color-not-only',
    category: 'color',
    question: 'Is color not the only means of conveying information?',
    description: 'Use icons, text, or patterns alongside color',
    weight: 9,
    autoCheckable: false,
  },

  // Spacing
  {
    id: 'space-consistency',
    category: 'spacing',
    question: 'Is spacing consistent (using a spacing scale)?',
    description: 'All spacing should come from a defined scale',
    weight: 8,
    autoCheckable: true,
    checkFunction: (ctx) => {
      if (!ctx.spacing || ctx.spacing.length < 3) {
        return { status: 'skip', message: 'Not enough spacing data' };
      }
      // Check if spacing values follow a pattern
      const sorted = [...ctx.spacing].sort((a, b) => a - b);
      const unique = [...new Set(sorted)];
      if (unique.length <= 8) {
        return { status: 'pass', message: 'Spacing uses a limited, consistent scale' };
      } else {
        return { 
          status: 'warning', 
          message: 'Many different spacing values detected',
          suggestions: ['Consolidate to a 4-8px based scale (4, 8, 12, 16, 24, 32, 48, 64)']
        };
      }
    },
  },
  {
    id: 'space-grouping',
    category: 'spacing',
    question: 'Does spacing create clear content groups?',
    description: 'Related items close together, groups separated',
    weight: 8,
    autoCheckable: false,
  },
  {
    id: 'space-breathing',
    category: 'spacing',
    question: 'Is there adequate whitespace around important elements?',
    description: 'CTAs and key content need breathing room',
    weight: 7,
    autoCheckable: false,
  },

  // Accessibility
  {
    id: 'a11y-focus-visible',
    category: 'accessibility',
    question: 'Are focus states visible on all interactive elements?',
    description: 'Keyboard users need to see where focus is',
    weight: 10,
    autoCheckable: false,
  },
  {
    id: 'a11y-touch-targets',
    category: 'accessibility',
    question: 'Are touch targets at least 44x44px?',
    description: 'Small targets are hard to hit on mobile',
    weight: 9,
    autoCheckable: false,
  },
  {
    id: 'a11y-form-labels',
    category: 'accessibility',
    question: 'Do all form inputs have visible labels?',
    description: 'Placeholder text alone is not sufficient',
    weight: 9,
    autoCheckable: false,
  },

  // Responsiveness
  {
    id: 'resp-mobile-first',
    category: 'responsiveness',
    question: 'Does the design work well on mobile?',
    description: 'Mobile is often the primary device',
    weight: 9,
    autoCheckable: false,
  },
  {
    id: 'resp-breakpoints',
    category: 'responsiveness',
    question: 'Are there smooth transitions between breakpoints?',
    description: 'No awkward layouts at intermediate sizes',
    weight: 7,
    autoCheckable: false,
  },
  {
    id: 'resp-content-priority',
    category: 'responsiveness',
    question: 'Is content prioritized appropriately on small screens?',
    description: 'Most important content should be visible first',
    weight: 8,
    autoCheckable: false,
  },

  // Consistency
  {
    id: 'cons-components',
    category: 'consistency',
    question: 'Are similar elements styled consistently?',
    description: 'Buttons, cards, inputs should look the same across pages',
    weight: 9,
    autoCheckable: false,
  },
  {
    id: 'cons-patterns',
    category: 'consistency',
    question: 'Are interaction patterns consistent?',
    description: 'Same gestures/clicks should do similar things',
    weight: 8,
    autoCheckable: false,
  },
  {
    id: 'cons-terminology',
    category: 'consistency',
    question: 'Is terminology consistent throughout?',
    description: 'Same concept should use same word everywhere',
    weight: 7,
    autoCheckable: false,
  },

  // Interaction
  {
    id: 'int-feedback',
    category: 'interaction',
    question: 'Do all interactive elements provide feedback?',
    description: 'Hover, active, focus states should be visible',
    weight: 8,
    autoCheckable: false,
  },
  {
    id: 'int-loading',
    category: 'interaction',
    question: 'Are loading states designed for async operations?',
    description: 'Users should know when something is happening',
    weight: 8,
    autoCheckable: false,
  },
  {
    id: 'int-empty',
    category: 'interaction',
    question: 'Are empty states designed thoughtfully?',
    description: 'Empty lists, no results should guide users',
    weight: 7,
    autoCheckable: false,
  },
  {
    id: 'int-error',
    category: 'interaction',
    question: 'Are error states clear and actionable?',
    description: 'Users should know what went wrong and how to fix it',
    weight: 9,
    autoCheckable: false,
  },

  // Performance
  {
    id: 'perf-images',
    category: 'performance',
    question: 'Are images optimized and appropriately sized?',
    description: 'Large images slow down page load',
    weight: 7,
    autoCheckable: false,
  },
  {
    id: 'perf-animations',
    category: 'performance',
    question: 'Are animations GPU-accelerated (transform, opacity)?',
    description: 'Animating layout properties causes jank',
    weight: 6,
    autoCheckable: false,
  },

  // Brand
  {
    id: 'brand-alignment',
    category: 'brand',
    question: 'Does the design align with brand guidelines?',
    description: 'Colors, typography, voice should match brand',
    weight: 8,
    autoCheckable: false,
  },
  {
    id: 'brand-differentiation',
    category: 'brand',
    question: 'Does the design differentiate from competitors?',
    description: 'Visual identity should be distinctive',
    weight: 6,
    autoCheckable: false,
  },
];

// ==========================================
// REVIEW ENGINE
// ==========================================

/**
 * Get checklist items by category
 */
export function getChecklistByCategory(category: ReviewCategory): ReviewCheckItem[] {
  return designReviewChecklist.filter((item) => item.category === category);
}

/**
 * Get all categories
 */
export function getAllCategories(): ReviewCategory[] {
  const categories = new Set(designReviewChecklist.map((item) => item.category));
  return Array.from(categories);
}

/**
 * Run automated checks
 */
export function runAutomatedChecks(context: ReviewContext): Map<string, ReviewResult> {
  const results = new Map<string, ReviewResult>();

  for (const item of designReviewChecklist) {
    if (item.autoCheckable && item.checkFunction) {
      try {
        const result = item.checkFunction(context);
        results.set(item.id, result);
      } catch (error) {
        results.set(item.id, {
          status: 'skip',
          message: 'Check failed to run',
          details: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  }

  return results;
}

/**
 * Calculate review score
 */
export function calculateReviewScore(results: ReviewItemResult[]): ReviewSummary {
  let totalWeight = 0;
  let earnedWeight = 0;
  let passed = 0;
  let failed = 0;
  let warnings = 0;
  let skipped = 0;
  const criticalIssues: string[] = [];
  const categoryScores: Record<ReviewCategory, { earned: number; total: number }> = {} as Record<ReviewCategory, { earned: number; total: number }>;

  for (const result of results) {
    const checkItem = designReviewChecklist.find((c) => c.id === result.checkId);
    if (!checkItem) continue;

    const weight = checkItem.weight;
    
    if (!categoryScores[checkItem.category]) {
      categoryScores[checkItem.category] = { earned: 0, total: 0 };
    }

    switch (result.status) {
      case 'pass':
        passed++;
        earnedWeight += weight;
        categoryScores[checkItem.category].earned += weight;
        categoryScores[checkItem.category].total += weight;
        break;
      case 'fail':
        failed++;
        if (weight >= 9) {
          criticalIssues.push(checkItem.question);
        }
        categoryScores[checkItem.category].total += weight;
        break;
      case 'warning':
        warnings++;
        earnedWeight += weight * 0.5; // Partial credit
        categoryScores[checkItem.category].earned += weight * 0.5;
        categoryScores[checkItem.category].total += weight;
        break;
      case 'skip':
      case 'not-applicable':
        skipped++;
        // Don't count towards total
        break;
    }

    totalWeight += weight;
  }

  const categoryScorePercentages: Record<ReviewCategory, number> = {} as Record<ReviewCategory, number>;
  for (const [cat, scores] of Object.entries(categoryScores)) {
    categoryScorePercentages[cat as ReviewCategory] = scores.total > 0 
      ? Math.round((scores.earned / scores.total) * 100) 
      : 100;
  }

  const recommendations: string[] = [];
  const sortedCategories = Object.entries(categoryScorePercentages)
    .sort(([, a], [, b]) => a - b);

  if (sortedCategories.length > 0 && sortedCategories[0][1] < 70) {
    recommendations.push(`Focus on improving ${sortedCategories[0][0]} (${sortedCategories[0][1]}%)`);
  }

  if (criticalIssues.length > 0) {
    recommendations.push('Address critical issues before shipping');
  }

  return {
    totalChecks: results.length,
    passed,
    failed,
    warnings,
    skipped,
    categoryScores: categoryScorePercentages,
    criticalIssues,
    recommendations,
  };
}

/**
 * Create a new design review
 */
export function createDesignReview(
  projectName: string,
  reviewer: string,
  results: ReviewItemResult[],
  context?: ReviewContext
): DesignReview {
  // Run automated checks if context provided
  if (context) {
    const autoResults = runAutomatedChecks(context);
    for (const [checkId, result] of autoResults) {
      const existingIndex = results.findIndex((r) => r.checkId === checkId);
      if (existingIndex === -1) {
        results.push({
          checkId,
          status: result.status,
          notes: result.message,
          autoResult: result,
        });
      }
    }
  }

  const summary = calculateReviewScore(results);
  const overallScore = summary.totalChecks > 0
    ? Math.round((summary.passed + summary.warnings * 0.5) / (summary.totalChecks - summary.skipped) * 100)
    : 0;

  return {
    timestamp: new Date(),
    reviewer,
    projectName,
    overallScore,
    results,
    summary,
  };
}

/**
 * Generate review report as markdown
 */
export function generateReviewReport(review: DesignReview): string {
  const lines: string[] = [
    `# Design Review: ${review.projectName}`,
    '',
    `**Reviewer:** ${review.reviewer}`,
    `**Date:** ${review.timestamp.toLocaleDateString()}`,
    `**Overall Score:** ${review.overallScore}%`,
    '',
    '## Summary',
    '',
    `- ✅ Passed: ${review.summary.passed}`,
    `- ❌ Failed: ${review.summary.failed}`,
    `- ⚠️ Warnings: ${review.summary.warnings}`,
    `- ⏭️ Skipped: ${review.summary.skipped}`,
    '',
  ];

  if (review.summary.criticalIssues.length > 0) {
    lines.push('## Critical Issues');
    lines.push('');
    for (const issue of review.summary.criticalIssues) {
      lines.push(`- ❌ ${issue}`);
    }
    lines.push('');
  }

  lines.push('## Category Scores');
  lines.push('');
  for (const [category, score] of Object.entries(review.summary.categoryScores)) {
    const bar = '█'.repeat(Math.floor(score / 10)) + '░'.repeat(10 - Math.floor(score / 10));
    lines.push(`- **${category}**: ${bar} ${score}%`);
  }
  lines.push('');

  if (review.summary.recommendations.length > 0) {
    lines.push('## Recommendations');
    lines.push('');
    for (const rec of review.summary.recommendations) {
      lines.push(`- 💡 ${rec}`);
    }
  }

  return lines.join('\n');
}
