/**
 * Accessibility Baseline Checker
 * 
 * Accessibility rules and validation utilities.
 * 
 * Rule: WCAG 2.1 AA minimum. Color contrast 4.5:1 for normal text, 3:1 for large text.
 */

// ==========================================
// TYPES
// ==========================================

export type WCAGLevel = 'A' | 'AA' | 'AAA';
export type IssueCategory = 'color' | 'keyboard' | 'screen-reader' | 'motion' | 'structure';
export type IssueSeverity = 'critical' | 'serious' | 'moderate' | 'minor';

export interface AccessibilityRule {
  id: string;
  name: string;
  description: string;
  wcagCriteria: string[];
  level: WCAGLevel;
  category: IssueCategory;
  check: (context: CheckContext) => AccessibilityIssue[];
}

export interface CheckContext {
  colors?: ColorContext;
  element?: ElementContext;
  interactive?: InteractiveContext;
  motion?: MotionContext;
}

export interface ColorContext {
  foreground: string; // hex
  background: string; // hex
  fontSize?: number;
  fontWeight?: number;
}

export interface ElementContext {
  tagName: string;
  role?: string;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  hasVisibleText?: boolean;
}

export interface InteractiveContext {
  hasTabIndex?: boolean;
  hasClickHandler?: boolean;
  hasKeyboardHandler?: boolean;
  hasFocusIndicator?: boolean;
}

export interface MotionContext {
  hasAnimation?: boolean;
  animationDuration?: number;
  canBePaused?: boolean;
  reducedMotionSupported?: boolean;
}

export interface AccessibilityIssue {
  ruleId: string;
  severity: IssueSeverity;
  category: IssueCategory;
  message: string;
  suggestion: string;
  wcagCriteria: string[];
}

export interface AccessibilityReport {
  score: number; // 0-100
  level: WCAGLevel;
  issues: AccessibilityIssue[];
  passed: string[];
  summary: string;
}

// ==========================================
// COLOR UTILITIES
// ==========================================

/**
 * Convert hex to RGB
 */
export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
      }
    : null;
}

/**
 * Calculate relative luminance
 * Based on WCAG 2.1 formula
 */
export function getRelativeLuminance(rgb: { r: number; g: number; b: number }): number {
  const [rs, gs, bs] = [rgb.r, rgb.g, rgb.b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

/**
 * Calculate contrast ratio between two colors
 */
export function getContrastRatio(color1: string, color2: string): number {
  const rgb1 = hexToRgb(color1);
  const rgb2 = hexToRgb(color2);

  if (!rgb1 || !rgb2) return 0;

  const l1 = getRelativeLuminance(rgb1);
  const l2 = getRelativeLuminance(rgb2);

  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);

  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Check if text is considered "large" per WCAG
 * Large text: 18pt+ regular OR 14pt+ bold
 */
export function isLargeText(fontSize: number, fontWeight: number = 400): boolean {
  const ptSize = fontSize * 0.75; // Convert px to pt (approximate)
  return ptSize >= 18 || (ptSize >= 14 && fontWeight >= 700);
}

/**
 * Get required contrast ratio based on text size
 */
export function getRequiredContrastRatio(
  level: WCAGLevel,
  isLarge: boolean
): number {
  const ratios = {
    A: { normal: 3.0, large: 3.0 },
    AA: { normal: 4.5, large: 3.0 },
    AAA: { normal: 7.0, large: 4.5 },
  };

  return ratios[level][isLarge ? 'large' : 'normal'];
}

// ==========================================
// ACCESSIBILITY RULES
// ==========================================

export const accessibilityRules: Record<string, AccessibilityRule> = {
  // Color contrast
  colorContrast: {
    id: 'color-contrast',
    name: 'Color Contrast',
    description: 'Text must have sufficient color contrast against its background',
    wcagCriteria: ['1.4.3', '1.4.6'],
    level: 'AA',
    category: 'color',
    check: (context) => {
      const issues: AccessibilityIssue[] = [];
      if (!context.colors) return issues;

      const { foreground, background, fontSize = 16, fontWeight = 400 } = context.colors;
      const ratio = getContrastRatio(foreground, background);
      const isLarge = isLargeText(fontSize, fontWeight);
      const required = getRequiredContrastRatio('AA', isLarge);

      if (ratio < required) {
        issues.push({
          ruleId: 'color-contrast',
          severity: ratio < 3.0 ? 'critical' : 'serious',
          category: 'color',
          message: `Contrast ratio ${ratio.toFixed(2)}:1 is below required ${required}:1`,
          suggestion: `Increase contrast by darkening foreground or lightening background`,
          wcagCriteria: ['1.4.3'],
        });
      }

      return issues;
    },
  },

  // Focus visibility
  focusVisible: {
    id: 'focus-visible',
    name: 'Focus Visibility',
    description: 'Interactive elements must have a visible focus indicator',
    wcagCriteria: ['2.4.7', '2.4.11'],
    level: 'AA',
    category: 'keyboard',
    check: (context) => {
      const issues: AccessibilityIssue[] = [];
      if (!context.interactive) return issues;

      const { hasClickHandler, hasFocusIndicator, hasKeyboardHandler } = context.interactive;

      if (hasClickHandler && !hasFocusIndicator) {
        issues.push({
          ruleId: 'focus-visible',
          severity: 'serious',
          category: 'keyboard',
          message: 'Interactive element lacks visible focus indicator',
          suggestion: 'Add focus-visible styles with outline or ring',
          wcagCriteria: ['2.4.7'],
        });
      }

      if (hasClickHandler && !hasKeyboardHandler) {
        issues.push({
          ruleId: 'focus-visible',
          severity: 'serious',
          category: 'keyboard',
          message: 'Click handler without keyboard equivalent',
          suggestion: 'Add keyboard handler for Enter/Space keys',
          wcagCriteria: ['2.1.1'],
        });
      }

      return issues;
    },
  },

  // Accessible name
  accessibleName: {
    id: 'accessible-name',
    name: 'Accessible Name',
    description: 'Interactive elements must have an accessible name',
    wcagCriteria: ['4.1.2', '1.1.1'],
    level: 'A',
    category: 'screen-reader',
    check: (context) => {
      const issues: AccessibilityIssue[] = [];
      if (!context.element) return issues;

      const { tagName, ariaLabel, ariaLabelledBy, hasVisibleText, role } = context.element;
      const interactiveElements = ['button', 'a', 'input', 'select', 'textarea'];
      const isInteractive = interactiveElements.includes(tagName.toLowerCase()) || role;

      if (isInteractive && !ariaLabel && !ariaLabelledBy && !hasVisibleText) {
        issues.push({
          ruleId: 'accessible-name',
          severity: 'critical',
          category: 'screen-reader',
          message: 'Interactive element has no accessible name',
          suggestion: 'Add aria-label, aria-labelledby, or visible text content',
          wcagCriteria: ['4.1.2'],
        });
      }

      return issues;
    },
  },

  // Motion safety
  motionSafety: {
    id: 'motion-safety',
    name: 'Motion Safety',
    description: 'Animations should respect reduced motion preferences',
    wcagCriteria: ['2.3.3'],
    level: 'AAA',
    category: 'motion',
    check: (context) => {
      const issues: AccessibilityIssue[] = [];
      if (!context.motion) return issues;

      const { hasAnimation, animationDuration = 0, canBePaused, reducedMotionSupported } = context.motion;

      if (hasAnimation && !reducedMotionSupported) {
        issues.push({
          ruleId: 'motion-safety',
          severity: 'moderate',
          category: 'motion',
          message: 'Animation does not respect prefers-reduced-motion',
          suggestion: 'Add @media (prefers-reduced-motion: reduce) query',
          wcagCriteria: ['2.3.3'],
        });
      }

      if (hasAnimation && animationDuration > 5000 && !canBePaused) {
        issues.push({
          ruleId: 'motion-safety',
          severity: 'moderate',
          category: 'motion',
          message: 'Long animation cannot be paused',
          suggestion: 'Add pause/stop control for animations over 5 seconds',
          wcagCriteria: ['2.2.2'],
        });
      }

      return issues;
    },
  },

  // Touch target size
  touchTargetSize: {
    id: 'touch-target',
    name: 'Touch Target Size',
    description: 'Touch targets should be at least 44x44 CSS pixels',
    wcagCriteria: ['2.5.5'],
    level: 'AAA',
    category: 'keyboard',
    check: () => {
      // This would need actual element dimensions to check
      return [];
    },
  },

  // Heading hierarchy
  headingHierarchy: {
    id: 'heading-hierarchy',
    name: 'Heading Hierarchy',
    description: 'Headings should follow a logical hierarchy (h1 > h2 > h3)',
    wcagCriteria: ['1.3.1', '2.4.6'],
    level: 'AA',
    category: 'structure',
    check: () => {
      // This would need page context to check
      return [];
    },
  },
};

// ==========================================
// CHECKER FUNCTIONS
// ==========================================

/**
 * Run accessibility check
 */
export function checkAccessibility(
  context: CheckContext,
  level: WCAGLevel = 'AA'
): AccessibilityReport {
  const issues: AccessibilityIssue[] = [];
  const passed: string[] = [];

  // Filter rules by level
  const applicableRules = Object.values(accessibilityRules).filter((rule) => {
    const levelOrder = { A: 1, AA: 2, AAA: 3 };
    return levelOrder[rule.level] <= levelOrder[level];
  });

  // Run each rule
  for (const rule of applicableRules) {
    const ruleIssues = rule.check(context);
    if (ruleIssues.length > 0) {
      issues.push(...ruleIssues);
    } else {
      passed.push(rule.id);
    }
  }

  // Calculate score
  const totalChecks = applicableRules.length;
  const passedChecks = passed.length;
  const score = totalChecks > 0 ? Math.round((passedChecks / totalChecks) * 100) : 100;

  // Generate summary
  const criticalCount = issues.filter((i) => i.severity === 'critical').length;
  const seriousCount = issues.filter((i) => i.severity === 'serious').length;

  let summary: string;
  if (issues.length === 0) {
    summary = 'All accessibility checks passed!';
  } else if (criticalCount > 0) {
    summary = `${criticalCount} critical issue(s) found that must be addressed`;
  } else if (seriousCount > 0) {
    summary = `${seriousCount} serious issue(s) found that should be addressed`;
  } else {
    summary = `${issues.length} minor issue(s) found for review`;
  }

  return {
    score,
    level,
    issues,
    passed,
    summary,
  };
}

/**
 * Check color contrast only
 */
export function checkColorContrast(
  foreground: string,
  background: string,
  fontSize: number = 16,
  fontWeight: number = 400,
  level: WCAGLevel = 'AA'
): {
  ratio: number;
  passes: boolean;
  required: number;
  isLargeText: boolean;
} {
  const ratio = getContrastRatio(foreground, background);
  const isLarge = isLargeText(fontSize, fontWeight);
  const required = getRequiredContrastRatio(level, isLarge);

  return {
    ratio: Math.round(ratio * 100) / 100,
    passes: ratio >= required,
    required,
    isLargeText: isLarge,
  };
}

/**
 * Suggest accessible color alternatives
 */
export function suggestAccessibleColor(
  foreground: string,
  background: string,
  targetRatio: number = 4.5
): string {
  const bgRgb = hexToRgb(background);
  const fgRgb = hexToRgb(foreground);
  if (!bgRgb || !fgRgb) return foreground;

  const bgLuminance = getRelativeLuminance(bgRgb);

  // Determine if we need lighter or darker foreground
  const needsDarker = bgLuminance > 0.5;

  // Adjust foreground incrementally
  let adjusted = { ...fgRgb };
  let attempts = 0;
  const maxAttempts = 50;

  while (attempts < maxAttempts) {
    const currentRatio = getContrastRatio(
      rgbToHex(adjusted),
      background
    );

    if (currentRatio >= targetRatio) {
      return rgbToHex(adjusted);
    }

    // Adjust color
    if (needsDarker) {
      adjusted.r = Math.max(0, adjusted.r - 5);
      adjusted.g = Math.max(0, adjusted.g - 5);
      adjusted.b = Math.max(0, adjusted.b - 5);
    } else {
      adjusted.r = Math.min(255, adjusted.r + 5);
      adjusted.g = Math.min(255, adjusted.g + 5);
      adjusted.b = Math.min(255, adjusted.b + 5);
    }

    attempts++;
  }

  // Fall back to black or white
  return needsDarker ? '#000000' : '#ffffff';
}

/**
 * Convert RGB to hex
 */
function rgbToHex(rgb: { r: number; g: number; b: number }): string {
  const toHex = (n: number) => Math.round(n).toString(16).padStart(2, '0');
  return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`;
}

// ==========================================
// BASELINE CHECKLIST
// ==========================================

export interface AccessibilityChecklist {
  category: string;
  items: ChecklistItem[];
}

export interface ChecklistItem {
  id: string;
  requirement: string;
  howToCheck: string;
  wcag: string;
  level: WCAGLevel;
}

export const accessibilityBaseline: AccessibilityChecklist[] = [
  {
    category: 'Color & Contrast',
    items: [
      {
        id: 'contrast-normal',
        requirement: 'Normal text has 4.5:1 contrast ratio',
        howToCheck: 'Use color contrast checker tool',
        wcag: '1.4.3',
        level: 'AA',
      },
      {
        id: 'contrast-large',
        requirement: 'Large text (18pt+) has 3:1 contrast ratio',
        howToCheck: 'Use color contrast checker tool',
        wcag: '1.4.3',
        level: 'AA',
      },
      {
        id: 'color-not-only',
        requirement: 'Color is not the only means of conveying information',
        howToCheck: 'Review with grayscale filter',
        wcag: '1.4.1',
        level: 'A',
      },
    ],
  },
  {
    category: 'Keyboard Navigation',
    items: [
      {
        id: 'keyboard-all',
        requirement: 'All interactive elements are keyboard accessible',
        howToCheck: 'Navigate entire page using only Tab and Enter',
        wcag: '2.1.1',
        level: 'A',
      },
      {
        id: 'focus-visible',
        requirement: 'Focus indicator is always visible',
        howToCheck: 'Tab through page and verify focus ring visibility',
        wcag: '2.4.7',
        level: 'AA',
      },
      {
        id: 'focus-order',
        requirement: 'Focus order is logical',
        howToCheck: 'Tab through page and verify sequence',
        wcag: '2.4.3',
        level: 'A',
      },
      {
        id: 'no-trap',
        requirement: 'Keyboard focus is not trapped',
        howToCheck: 'Ensure you can exit all components with keyboard',
        wcag: '2.1.2',
        level: 'A',
      },
    ],
  },
  {
    category: 'Screen Readers',
    items: [
      {
        id: 'alt-text',
        requirement: 'All images have appropriate alt text',
        howToCheck: 'Review all img elements for alt attributes',
        wcag: '1.1.1',
        level: 'A',
      },
      {
        id: 'form-labels',
        requirement: 'All form inputs have associated labels',
        howToCheck: 'Check for label/for pairs or aria-label',
        wcag: '1.3.1',
        level: 'A',
      },
      {
        id: 'button-names',
        requirement: 'All buttons have accessible names',
        howToCheck: 'Check button text or aria-label',
        wcag: '4.1.2',
        level: 'A',
      },
      {
        id: 'landmarks',
        requirement: 'Page uses semantic landmarks',
        howToCheck: 'Verify nav, main, footer elements',
        wcag: '1.3.1',
        level: 'A',
      },
    ],
  },
  {
    category: 'Motion & Animation',
    items: [
      {
        id: 'reduced-motion',
        requirement: 'Respects prefers-reduced-motion',
        howToCheck: 'Enable reduced motion in OS and verify',
        wcag: '2.3.3',
        level: 'AAA',
      },
      {
        id: 'no-autoplay',
        requirement: 'No auto-playing media that cannot be paused',
        howToCheck: 'Check for autoplay attributes',
        wcag: '1.4.2',
        level: 'A',
      },
    ],
  },
  {
    category: 'Structure',
    items: [
      {
        id: 'heading-hierarchy',
        requirement: 'Heading levels are in order (h1 > h2 > h3)',
        howToCheck: 'Use heading outline tool',
        wcag: '1.3.1',
        level: 'A',
      },
      {
        id: 'skip-link',
        requirement: 'Skip to main content link exists',
        howToCheck: 'Tab first on page to reveal skip link',
        wcag: '2.4.1',
        level: 'A',
      },
      {
        id: 'page-title',
        requirement: 'Page has descriptive title',
        howToCheck: 'Check document title element',
        wcag: '2.4.2',
        level: 'A',
      },
    ],
  },
];

/**
 * Get checklist for specific level
 */
export function getChecklistForLevel(level: WCAGLevel): AccessibilityChecklist[] {
  const levelOrder = { A: 1, AA: 2, AAA: 3 };
  const maxLevel = levelOrder[level];

  return accessibilityBaseline.map((category) => ({
    ...category,
    items: category.items.filter((item) => levelOrder[item.level] <= maxLevel),
  })).filter((category) => category.items.length > 0);
}
