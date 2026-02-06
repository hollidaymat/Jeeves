/**
 * Visual Hierarchy Rules
 * 
 * Rules for establishing clear visual hierarchy in UI design.
 * 
 * Rule: Maximum 3 levels of emphasis per viewport. Use size, weight, and color together.
 */

// ==========================================
// TYPES
// ==========================================

export type EmphasisLevel = 'primary' | 'secondary' | 'tertiary' | 'muted';
export type ContrastLevel = 'high' | 'medium' | 'low';

export interface HierarchyRule {
  name: string;
  description: string;
  principle: string;
  implementation: HierarchyImplementation;
  examples: string[];
  antiPatterns: string[];
}

export interface HierarchyImplementation {
  size?: SizeRelationship;
  weight?: WeightRelationship;
  color?: ColorRelationship;
  spacing?: SpacingRelationship;
  position?: PositionRelationship;
}

export interface SizeRelationship {
  ratio: number; // e.g., 1.5 means 50% larger than base
  minDifference: string; // e.g., "4px"
}

export interface WeightRelationship {
  primary: number;
  secondary: number;
  tertiary: number;
}

export interface ColorRelationship {
  primaryOpacity: number;
  secondaryOpacity: number;
  tertiaryOpacity: number;
}

export interface SpacingRelationship {
  multiplier: number;
  direction: 'all' | 'vertical' | 'horizontal';
}

export interface PositionRelationship {
  placement: 'top' | 'center' | 'prominent';
  zIndex?: number;
}

export interface VisualWeight {
  element: string;
  weight: number; // 0-100 scale
  factors: WeightFactor[];
}

export interface WeightFactor {
  factor: string;
  contribution: number;
}

export interface HierarchyAnalysis {
  levels: ElementLevel[];
  issues: HierarchyIssue[];
  score: number; // 0-100
  recommendations: string[];
}

export interface ElementLevel {
  element: string;
  level: EmphasisLevel;
  visualWeight: number;
}

export interface HierarchyIssue {
  type: 'competing' | 'missing-primary' | 'too-many-levels' | 'insufficient-contrast';
  description: string;
  severity: 'error' | 'warning' | 'info';
  suggestion: string;
}

// ==========================================
// HIERARCHY RULES
// ==========================================

export const hierarchyRules: Record<string, HierarchyRule> = {
  // Size hierarchy
  sizeHierarchy: {
    name: 'Size Creates Importance',
    description: 'Larger elements command more attention',
    principle: 'Use size to establish primary focal points. Headlines > subheads > body.',
    implementation: {
      size: {
        ratio: 1.5, // Each level 50% larger
        minDifference: '4px',
      },
    },
    examples: [
      'Hero headline at 48-72px, subhead at 24-32px, body at 16px',
      'Primary button at 48px height, secondary at 40px',
      'Main navigation items larger than utility nav',
    ],
    antiPatterns: [
      'All text same size (no hierarchy)',
      'Size differences too subtle (<4px)',
      'Overusing large text (everything is "important")',
    ],
  },

  // Weight hierarchy
  weightHierarchy: {
    name: 'Weight Establishes Structure',
    description: 'Bolder elements indicate importance and section breaks',
    principle: 'Use font weight to differentiate headings from body text.',
    implementation: {
      weight: {
        primary: 700, // Bold
        secondary: 600, // Semi-bold
        tertiary: 400, // Regular
      },
    },
    examples: [
      'Headlines: 700 (Bold), Body: 400 (Regular)',
      'Card titles: 600, Card body: 400',
      'Navigation active state: 600, inactive: 400',
    ],
    antiPatterns: [
      'All bold text (reduces emphasis)',
      'Body text heavier than headings',
      'Too many weight levels (>3)',
    ],
  },

  // Color hierarchy
  colorHierarchy: {
    name: 'Color Draws Attention',
    description: 'Use color strategically to guide focus',
    principle: 'One accent color for CTAs. Reduce saturation for secondary elements.',
    implementation: {
      color: {
        primaryOpacity: 1.0,
        secondaryOpacity: 0.7,
        tertiaryOpacity: 0.5,
      },
    },
    examples: [
      'Primary CTA: Saturated brand color',
      'Secondary text: Muted/gray',
      'Interactive elements: Accent color',
    ],
    antiPatterns: [
      'Multiple competing accent colors',
      'Same color intensity everywhere',
      'Low-contrast important elements',
    ],
  },

  // Spacing hierarchy
  spacingHierarchy: {
    name: 'Space Creates Grouping',
    description: 'More space around important elements, less within groups',
    principle: 'Related items close together, sections separated by more space.',
    implementation: {
      spacing: {
        multiplier: 2,
        direction: 'vertical',
      },
    },
    examples: [
      'Section gap: 64-96px, Component gap: 24-32px, Element gap: 8-16px',
      'More padding around CTAs than secondary buttons',
      'Tight spacing within cards, more space between cards',
    ],
    antiPatterns: [
      'Uniform spacing everywhere',
      'Cramped important elements',
      'Excessive spacing reducing scanability',
    ],
  },

  // Position hierarchy
  positionHierarchy: {
    name: 'Position Indicates Priority',
    description: 'Top-left gets seen first (in LTR languages), center draws focus',
    principle: 'Place primary content in natural reading flow. Use visual balance.',
    implementation: {
      position: {
        placement: 'top',
      },
    },
    examples: [
      'Logo top-left, primary nav left, secondary nav right',
      'Hero content centered or left-aligned',
      'CTAs at natural decision points',
    ],
    antiPatterns: [
      'Important content buried below fold',
      'Primary CTA in corner or footer',
      'Random element placement',
    ],
  },

  // Contrast hierarchy
  contrastHierarchy: {
    name: 'Contrast Creates Focus',
    description: 'High contrast elements stand out from their surroundings',
    principle: 'Use contrast strategically. Not everything can be high contrast.',
    implementation: {
      color: {
        primaryOpacity: 1.0,
        secondaryOpacity: 0.6,
        tertiaryOpacity: 0.4,
      },
    },
    examples: [
      'Dark text on light background for body (high readability)',
      'Bright accent on dark background for CTAs',
      'Subtle borders and dividers (low contrast)',
    ],
    antiPatterns: [
      'Everything high contrast (visual noise)',
      'Low contrast on important elements',
      'Competing high-contrast elements',
    ],
  },
};

// ==========================================
// EMPHASIS PRESETS
// ==========================================

export const emphasisPresets = {
  // Text emphasis levels
  text: {
    primary: {
      size: '1.25rem',
      weight: 600,
      opacity: 1,
      color: 'foreground',
    },
    secondary: {
      size: '1rem',
      weight: 400,
      opacity: 0.8,
      color: 'muted-foreground',
    },
    tertiary: {
      size: '0.875rem',
      weight: 400,
      opacity: 0.6,
      color: 'muted-foreground',
    },
    muted: {
      size: '0.75rem',
      weight: 400,
      opacity: 0.5,
      color: 'muted-foreground',
    },
  },

  // Interactive emphasis
  interactive: {
    primary: {
      background: 'primary',
      text: 'primary-foreground',
      shadow: 'md',
      scale: 1.0,
    },
    secondary: {
      background: 'secondary',
      text: 'secondary-foreground',
      shadow: 'none',
      scale: 1.0,
    },
    tertiary: {
      background: 'transparent',
      text: 'foreground',
      shadow: 'none',
      scale: 1.0,
    },
  },

  // Container emphasis
  container: {
    primary: {
      background: 'card',
      border: true,
      shadow: 'lg',
      padding: '2rem',
    },
    secondary: {
      background: 'card',
      border: true,
      shadow: 'sm',
      padding: '1.5rem',
    },
    tertiary: {
      background: 'transparent',
      border: false,
      shadow: 'none',
      padding: '1rem',
    },
  },
};

// ==========================================
// VISUAL WEIGHT CALCULATION
// ==========================================

/**
 * Calculate visual weight of an element
 */
export function calculateVisualWeight(element: {
  size: number; // in px
  weight: number; // font weight
  saturation: number; // 0-100
  contrast: number; // 0-1
  position: 'above-fold' | 'center' | 'below-fold';
  hasAnimation: boolean;
}): VisualWeight {
  const factors: WeightFactor[] = [];
  let totalWeight = 0;

  // Size factor (0-30 points)
  const sizeFactor = Math.min(30, (element.size / 72) * 30);
  factors.push({ factor: 'size', contribution: sizeFactor });
  totalWeight += sizeFactor;

  // Weight factor (0-20 points)
  const weightFactor = ((element.weight - 400) / 500) * 20;
  factors.push({ factor: 'font-weight', contribution: Math.max(0, weightFactor) });
  totalWeight += Math.max(0, weightFactor);

  // Color/saturation factor (0-20 points)
  const colorFactor = (element.saturation / 100) * 20;
  factors.push({ factor: 'color-saturation', contribution: colorFactor });
  totalWeight += colorFactor;

  // Contrast factor (0-15 points)
  const contrastFactor = element.contrast * 15;
  factors.push({ factor: 'contrast', contribution: contrastFactor });
  totalWeight += contrastFactor;

  // Position factor (0-10 points)
  const positionPoints = {
    'above-fold': 10,
    'center': 8,
    'below-fold': 3,
  };
  factors.push({ factor: 'position', contribution: positionPoints[element.position] });
  totalWeight += positionPoints[element.position];

  // Animation factor (0-5 points)
  if (element.hasAnimation) {
    factors.push({ factor: 'animation', contribution: 5 });
    totalWeight += 5;
  }

  return {
    element: 'analyzed-element',
    weight: Math.min(100, totalWeight),
    factors,
  };
}

/**
 * Analyze hierarchy of multiple elements
 */
export function analyzeHierarchy(elements: ElementLevel[]): HierarchyAnalysis {
  const issues: HierarchyIssue[] = [];
  const recommendations: string[] = [];
  let score = 100;

  // Sort by visual weight
  const sorted = [...elements].sort((a, b) => b.visualWeight - a.visualWeight);

  // Check for competing elements (weights too close)
  for (let i = 0; i < sorted.length - 1; i++) {
    const current = sorted[i];
    const next = sorted[i + 1];
    const difference = current.visualWeight - next.visualWeight;

    if (current.level === 'primary' && next.level === 'primary') {
      issues.push({
        type: 'competing',
        description: `Multiple primary elements competing: ${current.element} and ${next.element}`,
        severity: 'error',
        suggestion: 'Reduce emphasis on one element to create clear hierarchy',
      });
      score -= 20;
    } else if (difference < 10 && current.level !== next.level) {
      issues.push({
        type: 'insufficient-contrast',
        description: `${current.element} and ${next.element} have similar visual weight despite different hierarchy levels`,
        severity: 'warning',
        suggestion: 'Increase differentiation through size, weight, or color',
      });
      score -= 10;
    }
  }

  // Check for missing primary element
  const hasPrimary = elements.some(e => e.level === 'primary');
  if (!hasPrimary && elements.length > 0) {
    issues.push({
      type: 'missing-primary',
      description: 'No clear primary focal point',
      severity: 'warning',
      suggestion: 'Establish one primary element to anchor the visual hierarchy',
    });
    score -= 15;
  }

  // Check for too many levels
  const uniqueLevels = new Set(elements.map(e => e.level));
  if (uniqueLevels.size > 3) {
    issues.push({
      type: 'too-many-levels',
      description: 'More than 3 hierarchy levels detected',
      severity: 'info',
      suggestion: 'Simplify to 3 levels maximum for clearer visual hierarchy',
    });
    score -= 5;
  }

  // Generate recommendations
  if (issues.length === 0) {
    recommendations.push('Visual hierarchy is well-established');
  } else {
    if (issues.some(i => i.type === 'competing')) {
      recommendations.push('Reduce visual weight of secondary elements');
    }
    if (issues.some(i => i.type === 'missing-primary')) {
      recommendations.push('Add a clear primary focal point using size, color, or position');
    }
    if (issues.some(i => i.type === 'insufficient-contrast')) {
      recommendations.push('Increase differentiation between hierarchy levels');
    }
  }

  return {
    levels: sorted,
    issues,
    score: Math.max(0, score),
    recommendations,
  };
}

// ==========================================
// UTILITY FUNCTIONS
// ==========================================

/**
 * Get emphasis level styles
 */
export function getEmphasisStyles(
  type: 'text' | 'interactive' | 'container',
  level: EmphasisLevel
): Record<string, unknown> {
  const presets = emphasisPresets[type] as Record<string, Record<string, unknown>>;
  return presets[level] || presets['secondary'];
}

/**
 * Generate Tailwind classes for emphasis level
 */
export function getEmphasisClasses(level: EmphasisLevel, type: 'text' | 'heading' | 'button' = 'text'): string {
  const textClasses = {
    primary: 'text-foreground font-semibold',
    secondary: 'text-muted-foreground',
    tertiary: 'text-muted-foreground/70 text-sm',
    muted: 'text-muted-foreground/50 text-xs',
  };

  const headingClasses = {
    primary: 'text-3xl font-bold tracking-tight',
    secondary: 'text-xl font-semibold',
    tertiary: 'text-lg font-medium',
    muted: 'text-sm font-normal text-muted-foreground',
  };

  const buttonClasses = {
    primary: 'bg-primary text-primary-foreground shadow-md',
    secondary: 'bg-secondary text-secondary-foreground',
    tertiary: 'bg-transparent hover:bg-accent',
    muted: 'bg-transparent text-muted-foreground',
  };

  const classes = { text: textClasses, heading: headingClasses, button: buttonClasses };
  return classes[type][level];
}

/**
 * Recommend hierarchy adjustments
 */
export function recommendHierarchy(context: {
  pageType?: string;
  primaryAction?: string;
  contentDensity?: 'low' | 'medium' | 'high';
}): {
  primaryEmphasis: string;
  secondaryEmphasis: string;
  contentStyle: string;
} {
  const { pageType, contentDensity = 'medium' } = context;

  const recommendations = {
    landing: {
      primaryEmphasis: 'Large hero headline + prominent CTA',
      secondaryEmphasis: 'Feature headings at moderate size',
      contentStyle: 'Generous whitespace, single column focus areas',
    },
    dashboard: {
      primaryEmphasis: 'Key metrics or primary action',
      secondaryEmphasis: 'Section headers and navigation',
      contentStyle: 'Dense but organized, clear data hierarchy',
    },
    article: {
      primaryEmphasis: 'Article title',
      secondaryEmphasis: 'Section headings (H2-H3)',
      contentStyle: 'Readable body text, clear heading progression',
    },
    form: {
      primaryEmphasis: 'Form title and submit button',
      secondaryEmphasis: 'Field labels',
      contentStyle: 'Clear input grouping, visible validation',
    },
  };

  const defaultRec = {
    primaryEmphasis: 'One clear focal point per section',
    secondaryEmphasis: 'Supporting content with reduced weight',
    contentStyle: contentDensity === 'high' 
      ? 'Tight spacing, clear boundaries'
      : 'Generous whitespace',
  };

  return recommendations[pageType as keyof typeof recommendations] || defaultRec;
}

/**
 * Calculate required contrast ratio
 */
export function getRequiredContrast(
  elementType: 'text-large' | 'text-normal' | 'ui-component' | 'decoration'
): { ratio: number; level: string } {
  const requirements = {
    'text-large': { ratio: 3.0, level: 'AA' }, // 18pt+ or 14pt bold
    'text-normal': { ratio: 4.5, level: 'AA' },
    'ui-component': { ratio: 3.0, level: 'AA' },
    'decoration': { ratio: 1.0, level: 'None' },
  };

  return requirements[elementType];
}
