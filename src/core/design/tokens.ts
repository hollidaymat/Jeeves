/**
 * Design Token System
 * 
 * Centralized design tokens for consistent styling:
 * - Semantic colors (not raw hex values)
 * - Typography scale
 * - Spacing scale (4px base)
 * - Border radius
 * - Shadows
 * 
 * Rule: Never use raw values in components. Always reference tokens.
 */

// ==========================================
// TYPES
// ==========================================

export interface ColorTokens {
  background: string;
  foreground: string;
  primary: string;
  primaryForeground: string;
  secondary: string;
  secondaryForeground: string;
  accent: string;
  accentForeground: string;
  muted: string;
  mutedForeground: string;
  destructive: string;
  destructiveForeground: string;
  border: string;
  input: string;
  ring: string;
  glow?: string;
}

export interface TypographyTokens {
  fontFamily: {
    heading: string;
    body: string;
    mono: string;
  };
  fontSize: {
    xs: string;
    sm: string;
    base: string;
    lg: string;
    xl: string;
    '2xl': string;
    '3xl': string;
    '4xl': string;
    '5xl': string;
  };
  fontWeight: {
    normal: number;
    medium: number;
    semibold: number;
    bold: number;
  };
  lineHeight: {
    tight: string;
    normal: string;
    relaxed: string;
  };
}

export interface SpacingTokens {
  0: string;
  1: string;
  2: string;
  3: string;
  4: string;
  5: string;
  6: string;
  8: string;
  10: string;
  12: string;
  16: string;
  20: string;
  24: string;
}

export interface RadiusTokens {
  none: string;
  sm: string;
  md: string;
  lg: string;
  xl: string;
  '2xl': string;
  full: string;
}

export interface ShadowTokens {
  none: string;
  sm: string;
  md: string;
  lg: string;
  xl: string;
  glow: string;
  glowLg: string;
}

export interface DesignTokens {
  colors: ColorTokens;
  typography: TypographyTokens;
  spacing: SpacingTokens;
  radius: RadiusTokens;
  shadows: ShadowTokens;
}

// ==========================================
// DEFAULT TOKENS
// ==========================================

/**
 * Typography scale (rem-based for accessibility)
 */
export const typographyScale: TypographyTokens['fontSize'] = {
  xs: '0.75rem',      // 12px - captions, labels
  sm: '0.875rem',     // 14px - secondary text
  base: '1rem',       // 16px - body text
  lg: '1.125rem',     // 18px - lead text
  xl: '1.25rem',      // 20px - h4
  '2xl': '1.5rem',    // 24px - h3
  '3xl': '1.875rem',  // 30px - h2
  '4xl': '2.25rem',   // 36px - h1
  '5xl': '3rem',      // 48px - display
};

/**
 * Spacing scale (4px base for consistent rhythm)
 */
export const spacingScale: SpacingTokens = {
  0: '0',
  1: '0.25rem',   // 4px
  2: '0.5rem',    // 8px
  3: '0.75rem',   // 12px
  4: '1rem',      // 16px
  5: '1.25rem',   // 20px
  6: '1.5rem',    // 24px
  8: '2rem',      // 32px
  10: '2.5rem',   // 40px
  12: '3rem',     // 48px
  16: '4rem',     // 64px
  20: '5rem',     // 80px
  24: '6rem',     // 96px
};

/**
 * Border radius scale
 */
export const radiusScale: RadiusTokens = {
  none: '0',
  sm: '0.25rem',    // 4px
  md: '0.375rem',   // 6px
  lg: '0.5rem',     // 8px
  xl: '0.75rem',    // 12px
  '2xl': '1rem',    // 16px
  full: '9999px',   // Pill/circle
};

/**
 * Shadow scale
 */
export const shadowScale: ShadowTokens = {
  none: 'none',
  sm: '0 1px 2px 0 rgb(0 0 0 / 0.05)',
  md: '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
  lg: '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)',
  xl: '0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)',
  glow: '0 0 20px var(--accent)',
  glowLg: '0 0 40px var(--accent), 0 0 60px var(--accent)',
};

/**
 * Default dark mode colors (cyberpunk aesthetic)
 */
export const defaultDarkColors: ColorTokens = {
  background: '#0c0c14',
  foreground: '#e4e4e7',
  primary: '#22d3ee',
  primaryForeground: '#0c0c14',
  secondary: '#a855f7',
  secondaryForeground: '#fafafa',
  accent: '#22d3ee',
  accentForeground: '#0c0c14',
  muted: '#27272a',
  mutedForeground: '#a1a1aa',
  destructive: '#ef4444',
  destructiveForeground: '#fafafa',
  border: '#3f3f46',
  input: '#27272a',
  ring: '#22d3ee',
  glow: 'rgba(34, 211, 238, 0.25)',
};

/**
 * Default light mode colors
 */
export const defaultLightColors: ColorTokens = {
  background: '#ffffff',
  foreground: '#09090b',
  primary: '#0ea5e9',
  primaryForeground: '#fafafa',
  secondary: '#f4f4f5',
  secondaryForeground: '#18181b',
  accent: '#0ea5e9',
  accentForeground: '#fafafa',
  muted: '#f4f4f5',
  mutedForeground: '#71717a',
  destructive: '#ef4444',
  destructiveForeground: '#fafafa',
  border: '#e4e4e7',
  input: '#e4e4e7',
  ring: '#0ea5e9',
};

/**
 * Default typography settings
 */
export const defaultTypography: TypographyTokens = {
  fontFamily: {
    heading: 'Geist, system-ui, sans-serif',
    body: 'Geist, system-ui, sans-serif',
    mono: 'Geist Mono, monospace',
  },
  fontSize: typographyScale,
  fontWeight: {
    normal: 400,
    medium: 500,
    semibold: 600,
    bold: 700,
  },
  lineHeight: {
    tight: '1.25',
    normal: '1.5',
    relaxed: '1.75',
  },
};

/**
 * Complete default token set (dark mode)
 */
export const defaultTokens: DesignTokens = {
  colors: defaultDarkColors,
  typography: defaultTypography,
  spacing: spacingScale,
  radius: radiusScale,
  shadows: shadowScale,
};

// ==========================================
// TOKEN UTILITIES
// ==========================================

/**
 * Generate CSS custom properties from tokens
 */
export function tokensToCSSVars(tokens: DesignTokens): Record<string, string> {
  const vars: Record<string, string> = {};
  
  // Colors
  for (const [key, value] of Object.entries(tokens.colors)) {
    vars[`--${kebabCase(key)}`] = value;
  }
  
  // Typography
  for (const [key, value] of Object.entries(tokens.typography.fontSize)) {
    vars[`--font-size-${key}`] = value;
  }
  
  vars['--font-heading'] = tokens.typography.fontFamily.heading;
  vars['--font-body'] = tokens.typography.fontFamily.body;
  vars['--font-mono'] = tokens.typography.fontFamily.mono;
  
  // Spacing
  for (const [key, value] of Object.entries(tokens.spacing)) {
    vars[`--spacing-${key}`] = value;
  }
  
  // Radius
  for (const [key, value] of Object.entries(tokens.radius)) {
    vars[`--radius-${key}`] = value;
  }
  
  // Shadows
  for (const [key, value] of Object.entries(tokens.shadows)) {
    vars[`--shadow-${key}`] = value;
  }
  
  return vars;
}

/**
 * Generate CSS string from tokens
 */
export function tokensToCSSString(tokens: DesignTokens, selector: string = ':root'): string {
  const vars = tokensToCSSVars(tokens);
  
  const declarations = Object.entries(vars)
    .map(([key, value]) => `  ${key}: ${value};`)
    .join('\n');
  
  return `${selector} {\n${declarations}\n}`;
}

/**
 * Merge partial tokens with defaults
 */
export function mergeTokens(
  base: DesignTokens,
  overrides: Partial<DesignTokens>
): DesignTokens {
  return {
    colors: { ...base.colors, ...overrides.colors },
    typography: {
      ...base.typography,
      ...overrides.typography,
      fontFamily: {
        ...base.typography.fontFamily,
        ...overrides.typography?.fontFamily,
      },
      fontSize: {
        ...base.typography.fontSize,
        ...overrides.typography?.fontSize,
      },
      fontWeight: {
        ...base.typography.fontWeight,
        ...overrides.typography?.fontWeight,
      },
      lineHeight: {
        ...base.typography.lineHeight,
        ...overrides.typography?.lineHeight,
      },
    },
    spacing: { ...base.spacing, ...overrides.spacing },
    radius: { ...base.radius, ...overrides.radius },
    shadows: { ...base.shadows, ...overrides.shadows },
  };
}

/**
 * Get token value by path (e.g., "colors.primary")
 */
export function getToken(tokens: DesignTokens, path: string): string | undefined {
  const parts = path.split('.');
  let current: unknown = tokens;
  
  for (const part of parts) {
    if (current && typeof current === 'object' && part in current) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  
  return typeof current === 'string' ? current : undefined;
}

/**
 * Validate that a value is a token reference (not raw value)
 */
export function isTokenReference(value: string): boolean {
  return value.startsWith('var(--') || value.startsWith('--');
}

/**
 * Check if a color value is a raw hex/rgb instead of a token
 */
export function isRawColorValue(value: string): boolean {
  const rawPatterns = [
    /^#[0-9a-fA-F]{3,8}$/,           // Hex
    /^rgb\(/,                         // RGB
    /^rgba\(/,                        // RGBA
    /^hsl\(/,                         // HSL
    /^hsla\(/,                        // HSLA
  ];
  
  return rawPatterns.some(pattern => pattern.test(value.trim()));
}

// ==========================================
// HELPERS
// ==========================================

function kebabCase(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase();
}

// ==========================================
// TAILWIND CONFIG GENERATOR
// ==========================================

/**
 * Generate Tailwind theme extension from tokens
 */
export function tokensToTailwindTheme(tokens: DesignTokens): Record<string, unknown> {
  return {
    colors: {
      background: 'var(--background)',
      foreground: 'var(--foreground)',
      primary: {
        DEFAULT: 'var(--primary)',
        foreground: 'var(--primary-foreground)',
      },
      secondary: {
        DEFAULT: 'var(--secondary)',
        foreground: 'var(--secondary-foreground)',
      },
      accent: {
        DEFAULT: 'var(--accent)',
        foreground: 'var(--accent-foreground)',
      },
      muted: {
        DEFAULT: 'var(--muted)',
        foreground: 'var(--muted-foreground)',
      },
      destructive: {
        DEFAULT: 'var(--destructive)',
        foreground: 'var(--destructive-foreground)',
      },
      border: 'var(--border)',
      input: 'var(--input)',
      ring: 'var(--ring)',
    },
    fontFamily: {
      heading: tokens.typography.fontFamily.heading.split(',').map(f => f.trim()),
      body: tokens.typography.fontFamily.body.split(',').map(f => f.trim()),
      mono: tokens.typography.fontFamily.mono.split(',').map(f => f.trim()),
    },
    fontSize: tokens.typography.fontSize,
    spacing: tokens.spacing,
    borderRadius: {
      ...tokens.radius,
      DEFAULT: tokens.radius.md,
    },
    boxShadow: tokens.shadows,
  };
}
