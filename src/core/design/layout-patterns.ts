/**
 * Layout Patterns Library
 * 
 * Pre-built layout patterns for common page structures.
 * 
 * Rule: Use 4/8pt grid. Consistent spacing creates visual rhythm.
 */

// ==========================================
// TYPES
// ==========================================

export type LayoutPatternName =
  | 'dashboard'
  | 'marketing'
  | 'content'
  | 'form'
  | 'list'
  | 'grid'
  | 'split'
  | 'centered'
  | 'sidebar';

export interface LayoutPattern {
  name: LayoutPatternName;
  description: string;
  structure: LayoutStructure;
  spacing: LayoutSpacing;
  responsive: ResponsiveRules;
  cssGrid?: string;
  cssFlexbox?: string;
  tailwindClasses?: string;
}

export interface LayoutStructure {
  areas: string[];
  columns?: string;
  rows?: string;
  gap: string;
  padding: string;
  maxWidth?: string;
  alignment?: 'start' | 'center' | 'end' | 'stretch';
}

export interface LayoutSpacing {
  sectionGap: string;
  componentGap: string;
  elementGap: string;
  containerPadding: string;
}

export interface ResponsiveRules {
  mobile: Partial<LayoutStructure>;
  tablet?: Partial<LayoutStructure>;
  desktop?: Partial<LayoutStructure>;
}

export interface ContainerWidth {
  sm: string;
  md: string;
  lg: string;
  xl: string;
  '2xl': string;
  full: string;
}

// ==========================================
// CONTAINER WIDTHS
// ==========================================

export const containerWidths: ContainerWidth = {
  sm: '640px',
  md: '768px',
  lg: '1024px',
  xl: '1280px',
  '2xl': '1536px',
  full: '100%',
};

// ==========================================
// SPACING PRESETS
// ==========================================

export const spacingPresets = {
  tight: {
    sectionGap: '2rem',     // 32px
    componentGap: '1rem',   // 16px
    elementGap: '0.5rem',   // 8px
    containerPadding: '1rem',
  },
  normal: {
    sectionGap: '4rem',     // 64px
    componentGap: '1.5rem', // 24px
    elementGap: '0.75rem',  // 12px
    containerPadding: '1.5rem',
  },
  relaxed: {
    sectionGap: '6rem',     // 96px
    componentGap: '2rem',   // 32px
    elementGap: '1rem',     // 16px
    containerPadding: '2rem',
  },
};

// ==========================================
// LAYOUT PATTERNS
// ==========================================

export const layoutPatterns: Record<LayoutPatternName, LayoutPattern> = {
  // Dashboard - sidebar + main content with header
  dashboard: {
    name: 'dashboard',
    description: 'Application dashboard with sidebar navigation',
    structure: {
      areas: ['sidebar', 'header', 'main'],
      columns: '280px 1fr',
      rows: '64px 1fr',
      gap: '0',
      padding: '0',
    },
    spacing: spacingPresets.tight,
    responsive: {
      mobile: {
        columns: '1fr',
        rows: '64px auto 1fr',
      },
    },
    cssGrid: `
      display: grid;
      grid-template-columns: 280px 1fr;
      grid-template-rows: 64px 1fr;
      grid-template-areas:
        "sidebar header"
        "sidebar main";
      min-height: 100vh;
    `,
    tailwindClasses: 'grid grid-cols-[280px_1fr] grid-rows-[64px_1fr] min-h-screen',
  },
  
  // Marketing - full-width sections
  marketing: {
    name: 'marketing',
    description: 'Marketing page with full-width hero and sections',
    structure: {
      areas: ['hero', 'features', 'testimonials', 'cta', 'footer'],
      columns: '1fr',
      gap: '0',
      padding: '0',
      maxWidth: 'full',
    },
    spacing: spacingPresets.relaxed,
    responsive: {
      mobile: {},
    },
    cssFlexbox: `
      display: flex;
      flex-direction: column;
      min-height: 100vh;
    `,
    tailwindClasses: 'flex flex-col min-h-screen',
  },
  
  // Content - article/blog layout
  content: {
    name: 'content',
    description: 'Content-focused layout for articles and documentation',
    structure: {
      areas: ['header', 'toc', 'content', 'footer'],
      columns: '1fr min(65ch, 100%) 1fr',
      gap: '2rem',
      padding: '2rem',
      maxWidth: '1200px',
      alignment: 'center',
    },
    spacing: spacingPresets.normal,
    responsive: {
      mobile: {
        columns: '1fr',
        padding: '1rem',
      },
    },
    cssGrid: `
      display: grid;
      grid-template-columns: 1fr min(65ch, 100%) 1fr;
      gap: 2rem;
      padding: 2rem;
      max-width: 1200px;
      margin: 0 auto;
    `,
    tailwindClasses: 'grid grid-cols-[1fr_min(65ch,100%)_1fr] gap-8 p-8 max-w-5xl mx-auto',
  },
  
  // Form - centered form layout
  form: {
    name: 'form',
    description: 'Centered form with consistent field spacing',
    structure: {
      areas: ['form'],
      columns: 'minmax(0, 480px)',
      gap: '1.5rem',
      padding: '2rem',
      maxWidth: '480px',
      alignment: 'center',
    },
    spacing: {
      sectionGap: '2rem',
      componentGap: '1.5rem',
      elementGap: '0.5rem',
      containerPadding: '2rem',
    },
    responsive: {
      mobile: {
        padding: '1rem',
      },
    },
    cssFlexbox: `
      display: flex;
      flex-direction: column;
      gap: 1.5rem;
      max-width: 480px;
      margin: 0 auto;
      padding: 2rem;
    `,
    tailwindClasses: 'flex flex-col gap-6 max-w-md mx-auto p-8',
  },
  
  // List - vertical list with items
  list: {
    name: 'list',
    description: 'Vertical list layout with consistent item spacing',
    structure: {
      areas: ['header', 'filters', 'list', 'pagination'],
      columns: '1fr',
      gap: '1rem',
      padding: '1.5rem',
      maxWidth: '800px',
    },
    spacing: spacingPresets.tight,
    responsive: {
      mobile: {
        padding: '1rem',
      },
    },
    cssFlexbox: `
      display: flex;
      flex-direction: column;
      gap: 1rem;
      max-width: 800px;
    `,
    tailwindClasses: 'flex flex-col gap-4 max-w-3xl',
  },
  
  // Grid - card grid layout
  grid: {
    name: 'grid',
    description: 'Responsive card grid with auto-fit columns',
    structure: {
      areas: ['header', 'grid', 'pagination'],
      columns: 'repeat(auto-fit, minmax(280px, 1fr))',
      gap: '1.5rem',
      padding: '1.5rem',
    },
    spacing: spacingPresets.normal,
    responsive: {
      mobile: {
        columns: '1fr',
        gap: '1rem',
        padding: '1rem',
      },
    },
    cssGrid: `
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 1.5rem;
    `,
    tailwindClasses: 'grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-6',
  },
  
  // Split - 50/50 or asymmetric split
  split: {
    name: 'split',
    description: 'Two-column split layout (hero with image, features)',
    structure: {
      areas: ['left', 'right'],
      columns: '1fr 1fr',
      gap: '4rem',
      padding: '4rem',
      alignment: 'center',
    },
    spacing: spacingPresets.relaxed,
    responsive: {
      mobile: {
        columns: '1fr',
        gap: '2rem',
        padding: '1.5rem',
      },
    },
    cssGrid: `
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 4rem;
      align-items: center;
      padding: 4rem;
    `,
    tailwindClasses: 'grid grid-cols-2 gap-16 items-center p-16 max-md:grid-cols-1 max-md:gap-8 max-md:p-6',
  },
  
  // Centered - simple centered content
  centered: {
    name: 'centered',
    description: 'Centered content with max-width constraint',
    structure: {
      areas: ['content'],
      columns: '1fr',
      gap: '2rem',
      padding: '4rem 2rem',
      maxWidth: '640px',
      alignment: 'center',
    },
    spacing: spacingPresets.normal,
    responsive: {
      mobile: {
        padding: '2rem 1rem',
      },
    },
    cssFlexbox: `
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      max-width: 640px;
      margin: 0 auto;
      padding: 4rem 2rem;
    `,
    tailwindClasses: 'flex flex-col items-center text-center max-w-xl mx-auto py-16 px-8',
  },
  
  // Sidebar - content with fixed sidebar
  sidebar: {
    name: 'sidebar',
    description: 'Main content with fixed or sticky sidebar',
    structure: {
      areas: ['sidebar', 'main'],
      columns: '300px 1fr',
      gap: '2rem',
      padding: '1.5rem',
    },
    spacing: spacingPresets.normal,
    responsive: {
      mobile: {
        columns: '1fr',
        gap: '1rem',
      },
    },
    cssGrid: `
      display: grid;
      grid-template-columns: 300px 1fr;
      gap: 2rem;
    `,
    tailwindClasses: 'grid grid-cols-[300px_1fr] gap-8 max-md:grid-cols-1',
  },
};

// ==========================================
// UTILITY FUNCTIONS
// ==========================================

/**
 * Get layout pattern by name
 */
export function getLayoutPattern(name: LayoutPatternName): LayoutPattern {
  return layoutPatterns[name];
}

/**
 * Generate CSS for a layout pattern
 */
export function generateLayoutCSS(pattern: LayoutPattern, breakpoint?: 'mobile' | 'tablet' | 'desktop'): string {
  if (breakpoint === 'mobile' && pattern.responsive.mobile) {
    const base = pattern.cssGrid || pattern.cssFlexbox || '';
    const mobileOverrides = structureToCSS(pattern.responsive.mobile);
    return `${base}\n@media (max-width: 768px) {\n${mobileOverrides}\n}`;
  }
  
  return pattern.cssGrid || pattern.cssFlexbox || '';
}

/**
 * Convert structure to CSS properties
 */
function structureToCSS(structure: Partial<LayoutStructure>): string {
  const rules: string[] = [];
  
  if (structure.columns) {
    rules.push(`grid-template-columns: ${structure.columns};`);
  }
  if (structure.rows) {
    rules.push(`grid-template-rows: ${structure.rows};`);
  }
  if (structure.gap) {
    rules.push(`gap: ${structure.gap};`);
  }
  if (structure.padding) {
    rules.push(`padding: ${structure.padding};`);
  }
  if (structure.maxWidth) {
    rules.push(`max-width: ${structure.maxWidth};`);
  }
  
  return rules.map(r => `  ${r}`).join('\n');
}

/**
 * Get responsive Tailwind classes for a layout
 */
export function getResponsiveLayoutClasses(
  pattern: LayoutPattern
): { base: string; sm?: string; md?: string; lg?: string } {
  const base = pattern.tailwindClasses || '';
  
  // Parse mobile overrides into responsive classes
  // This is simplified - in practice you'd need more sophisticated mapping
  
  return {
    base,
    md: base, // Desktop (md and up)
  };
}

/**
 * Recommend layout pattern based on page type
 */
export function recommendLayout(context: {
  pageType?: string;
  contentType?: string;
  hasNavigation?: boolean;
  hasSidebar?: boolean;
}): LayoutPatternName {
  const { pageType, contentType, hasNavigation, hasSidebar } = context;
  const allText = [pageType, contentType].filter(Boolean).join(' ').toLowerCase();
  
  if (allText.includes('dashboard') || allText.includes('admin') || allText.includes('app')) {
    return 'dashboard';
  }
  
  if (allText.includes('landing') || allText.includes('marketing') || allText.includes('home')) {
    return 'marketing';
  }
  
  if (allText.includes('article') || allText.includes('blog') || allText.includes('docs')) {
    return 'content';
  }
  
  if (allText.includes('form') || allText.includes('auth') || allText.includes('login') || allText.includes('signup')) {
    return 'form';
  }
  
  if (allText.includes('list') || allText.includes('table') || allText.includes('inbox')) {
    return 'list';
  }
  
  if (allText.includes('gallery') || allText.includes('products') || allText.includes('cards')) {
    return 'grid';
  }
  
  if (hasSidebar) {
    return 'sidebar';
  }
  
  return 'centered';
}

// ==========================================
// GRID HELPERS
// ==========================================

/**
 * Generate a responsive grid template
 */
export function generateResponsiveGrid(
  minItemWidth: number = 280,
  gap: string = '1.5rem'
): string {
  return `
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(${minItemWidth}px, 1fr));
    gap: ${gap};
  `.trim();
}

/**
 * Generate column layout with specified counts
 */
export function generateColumnGrid(
  columns: { mobile: number; tablet?: number; desktop: number },
  gap: string = '1.5rem'
): { css: string; tailwind: string } {
  const tablet = columns.tablet || Math.ceil((columns.mobile + columns.desktop) / 2);
  
  return {
    css: `
      display: grid;
      grid-template-columns: repeat(${columns.mobile}, 1fr);
      gap: ${gap};
      
      @media (min-width: 768px) {
        grid-template-columns: repeat(${tablet}, 1fr);
      }
      
      @media (min-width: 1024px) {
        grid-template-columns: repeat(${columns.desktop}, 1fr);
      }
    `.trim(),
    tailwind: `grid grid-cols-${columns.mobile} md:grid-cols-${tablet} lg:grid-cols-${columns.desktop} gap-6`,
  };
}

/**
 * Get semantic section spacing
 */
export function getSectionSpacing(density: 'tight' | 'normal' | 'relaxed' = 'normal'): {
  py: string;
  gap: string;
  tailwind: string;
} {
  const presets = {
    tight: { py: '3rem', gap: '2rem', tailwind: 'py-12 space-y-8' },
    normal: { py: '5rem', gap: '3rem', tailwind: 'py-20 space-y-12' },
    relaxed: { py: '7rem', gap: '4rem', tailwind: 'py-28 space-y-16' },
  };
  
  return presets[density];
}
