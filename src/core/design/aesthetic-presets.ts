/**
 * Aesthetic Presets
 * 
 * Complete design presets for different aesthetic styles.
 * 
 * Rule: Presets are starting points, not constraints. Customize based on brand.
 */

import type { DesignTokens, ColorTokens } from './tokens.js';
import type { FontPairingName } from './typography.js';
import type { LayoutPatternName } from './layout-patterns.js';

// ==========================================
// TYPES
// ==========================================

export type AestheticName =
  | 'cyberpunk'
  | 'minimal-saas'
  | 'warm-editorial'
  | 'dashboard-pro'
  | 'marketing-bold'
  | 'documentation'
  | 'ecommerce'
  | 'creative-agency';

export interface AestheticPreset {
  name: AestheticName;
  displayName: string;
  description: string;
  tags: string[];
  tokens: Partial<DesignTokens>;
  typography: TypographyPreset;
  layout: LayoutPreset;
  effects: EffectsPreset;
  components: ComponentStylePreset;
}

export interface TypographyPreset {
  fontPairing: FontPairingName;
  headingStyle: 'uppercase' | 'capitalize' | 'normal';
  letterSpacing: 'tight' | 'normal' | 'wide';
  lineHeight: 'tight' | 'normal' | 'relaxed';
}

export interface LayoutPreset {
  primaryLayout: LayoutPatternName;
  containerWidth: 'narrow' | 'normal' | 'wide' | 'full';
  density: 'compact' | 'comfortable' | 'spacious';
  borderRadius: 'none' | 'small' | 'medium' | 'large' | 'full';
}

export interface EffectsPreset {
  shadows: 'none' | 'subtle' | 'medium' | 'dramatic';
  borders: 'none' | 'subtle' | 'prominent';
  animations: 'minimal' | 'moderate' | 'expressive';
  specialEffects?: string[]; // e.g., ['neon-glow', 'scanlines']
}

export interface ComponentStylePreset {
  buttonStyle: 'solid' | 'outline' | 'ghost' | 'gradient';
  cardStyle: 'flat' | 'raised' | 'bordered' | 'glass';
  inputStyle: 'minimal' | 'bordered' | 'filled';
  navStyle: 'minimal' | 'pills' | 'underline' | 'bordered';
}

// ==========================================
// AESTHETIC PRESETS
// ==========================================

export const aestheticPresets: Record<AestheticName, AestheticPreset> = {
  // Cyberpunk - Dark, neon accents, futuristic
  cyberpunk: {
    name: 'cyberpunk',
    displayName: 'Cyberpunk',
    description: 'Dark theme with neon accents, glitch effects, and futuristic typography',
    tags: ['dark', 'neon', 'futuristic', 'tech', 'gaming'],
    tokens: {
      colors: {
        primary: { DEFAULT: '#00ffff', foreground: '#000000' },
        secondary: { DEFAULT: '#1a1a2e', foreground: '#00ffff' },
        accent: { DEFAULT: '#ff00ff', foreground: '#000000' },
        background: '#0a0a0f',
        foreground: '#e0e0e0',
        card: { DEFAULT: '#12121a', foreground: '#e0e0e0' },
        muted: { DEFAULT: '#1a1a2e', foreground: '#808090' },
        border: '#2a2a3e',
        destructive: { DEFAULT: '#ff0044', foreground: '#ffffff' },
        success: { DEFAULT: '#00ff88', foreground: '#000000' },
        warning: { DEFAULT: '#ffcc00', foreground: '#000000' },
        info: { DEFAULT: '#00ccff', foreground: '#000000' },
      } as ColorTokens,
      radius: {
        sm: '2px',
        DEFAULT: '4px',
        md: '6px',
        lg: '8px',
        xl: '12px',
        full: '9999px',
      },
    },
    typography: {
      fontPairing: 'cyber',
      headingStyle: 'uppercase',
      letterSpacing: 'wide',
      lineHeight: 'normal',
    },
    layout: {
      primaryLayout: 'dashboard',
      containerWidth: 'wide',
      density: 'comfortable',
      borderRadius: 'small',
    },
    effects: {
      shadows: 'dramatic',
      borders: 'subtle',
      animations: 'expressive',
      specialEffects: ['neon-glow', 'scanlines', 'glitch-text'],
    },
    components: {
      buttonStyle: 'gradient',
      cardStyle: 'bordered',
      inputStyle: 'bordered',
      navStyle: 'pills',
    },
  },

  // Minimal SaaS - Clean, professional, trustworthy
  'minimal-saas': {
    name: 'minimal-saas',
    displayName: 'Minimal SaaS',
    description: 'Clean, professional design focused on clarity and trust',
    tags: ['clean', 'professional', 'saas', 'business', 'light'],
    tokens: {
      colors: {
        primary: { DEFAULT: '#0066ff', foreground: '#ffffff' },
        secondary: { DEFAULT: '#f4f4f5', foreground: '#18181b' },
        accent: { DEFAULT: '#8b5cf6', foreground: '#ffffff' },
        background: '#ffffff',
        foreground: '#18181b',
        card: { DEFAULT: '#ffffff', foreground: '#18181b' },
        muted: { DEFAULT: '#f4f4f5', foreground: '#71717a' },
        border: '#e4e4e7',
        destructive: { DEFAULT: '#ef4444', foreground: '#ffffff' },
        success: { DEFAULT: '#22c55e', foreground: '#ffffff' },
        warning: { DEFAULT: '#f59e0b', foreground: '#ffffff' },
        info: { DEFAULT: '#3b82f6', foreground: '#ffffff' },
      } as ColorTokens,
      radius: {
        sm: '4px',
        DEFAULT: '8px',
        md: '12px',
        lg: '16px',
        xl: '24px',
        full: '9999px',
      },
    },
    typography: {
      fontPairing: 'inter',
      headingStyle: 'normal',
      letterSpacing: 'normal',
      lineHeight: 'relaxed',
    },
    layout: {
      primaryLayout: 'marketing',
      containerWidth: 'normal',
      density: 'comfortable',
      borderRadius: 'medium',
    },
    effects: {
      shadows: 'subtle',
      borders: 'subtle',
      animations: 'minimal',
    },
    components: {
      buttonStyle: 'solid',
      cardStyle: 'raised',
      inputStyle: 'bordered',
      navStyle: 'minimal',
    },
  },

  // Warm Editorial - Rich, readable, content-focused
  'warm-editorial': {
    name: 'warm-editorial',
    displayName: 'Warm Editorial',
    description: 'Rich, warm design optimized for long-form content and readability',
    tags: ['editorial', 'warm', 'readable', 'content', 'blog'],
    tokens: {
      colors: {
        primary: { DEFAULT: '#b45309', foreground: '#ffffff' },
        secondary: { DEFAULT: '#fef3c7', foreground: '#78350f' },
        accent: { DEFAULT: '#dc2626', foreground: '#ffffff' },
        background: '#fffbf5',
        foreground: '#292524',
        card: { DEFAULT: '#ffffff', foreground: '#292524' },
        muted: { DEFAULT: '#f5f5f4', foreground: '#78716c' },
        border: '#e7e5e4',
        destructive: { DEFAULT: '#dc2626', foreground: '#ffffff' },
        success: { DEFAULT: '#16a34a', foreground: '#ffffff' },
        warning: { DEFAULT: '#ca8a04', foreground: '#ffffff' },
        info: { DEFAULT: '#2563eb', foreground: '#ffffff' },
      } as ColorTokens,
    },
    typography: {
      fontPairing: 'serif-sans',
      headingStyle: 'normal',
      letterSpacing: 'normal',
      lineHeight: 'relaxed',
    },
    layout: {
      primaryLayout: 'content',
      containerWidth: 'narrow',
      density: 'spacious',
      borderRadius: 'small',
    },
    effects: {
      shadows: 'subtle',
      borders: 'none',
      animations: 'minimal',
    },
    components: {
      buttonStyle: 'solid',
      cardStyle: 'flat',
      inputStyle: 'minimal',
      navStyle: 'underline',
    },
  },

  // Dashboard Pro - Dense, functional, data-focused
  'dashboard-pro': {
    name: 'dashboard-pro',
    displayName: 'Dashboard Pro',
    description: 'Dense, functional design optimized for data-heavy applications',
    tags: ['dashboard', 'data', 'functional', 'enterprise', 'dark'],
    tokens: {
      colors: {
        primary: { DEFAULT: '#6366f1', foreground: '#ffffff' },
        secondary: { DEFAULT: '#1e1e2e', foreground: '#e2e2e9' },
        accent: { DEFAULT: '#22c55e', foreground: '#000000' },
        background: '#0f0f17',
        foreground: '#e2e2e9',
        card: { DEFAULT: '#1a1a27', foreground: '#e2e2e9' },
        muted: { DEFAULT: '#27273a', foreground: '#9090a0' },
        border: '#2e2e42',
        destructive: { DEFAULT: '#f43f5e', foreground: '#ffffff' },
        success: { DEFAULT: '#22c55e', foreground: '#000000' },
        warning: { DEFAULT: '#eab308', foreground: '#000000' },
        info: { DEFAULT: '#0ea5e9', foreground: '#ffffff' },
      } as ColorTokens,
      spacing: {
        xs: '0.25rem',
        sm: '0.5rem',
        md: '0.75rem',
        lg: '1rem',
        xl: '1.5rem',
        '2xl': '2rem',
      },
    },
    typography: {
      fontPairing: 'geist',
      headingStyle: 'normal',
      letterSpacing: 'normal',
      lineHeight: 'tight',
    },
    layout: {
      primaryLayout: 'dashboard',
      containerWidth: 'full',
      density: 'compact',
      borderRadius: 'small',
    },
    effects: {
      shadows: 'subtle',
      borders: 'prominent',
      animations: 'minimal',
    },
    components: {
      buttonStyle: 'solid',
      cardStyle: 'bordered',
      inputStyle: 'filled',
      navStyle: 'bordered',
    },
  },

  // Marketing Bold - Eye-catching, conversion-focused
  'marketing-bold': {
    name: 'marketing-bold',
    displayName: 'Marketing Bold',
    description: 'Eye-catching design with bold typography and strong CTAs',
    tags: ['marketing', 'bold', 'landing', 'conversion', 'vibrant'],
    tokens: {
      colors: {
        primary: { DEFAULT: '#7c3aed', foreground: '#ffffff' },
        secondary: { DEFAULT: '#fef3c7', foreground: '#7c3aed' },
        accent: { DEFAULT: '#f97316', foreground: '#ffffff' },
        background: '#ffffff',
        foreground: '#0f172a',
        card: { DEFAULT: '#f8fafc', foreground: '#0f172a' },
        muted: { DEFAULT: '#f1f5f9', foreground: '#64748b' },
        border: '#e2e8f0',
        destructive: { DEFAULT: '#ef4444', foreground: '#ffffff' },
        success: { DEFAULT: '#10b981', foreground: '#ffffff' },
        warning: { DEFAULT: '#f59e0b', foreground: '#ffffff' },
        info: { DEFAULT: '#3b82f6', foreground: '#ffffff' },
      } as ColorTokens,
    },
    typography: {
      fontPairing: 'rounded',
      headingStyle: 'normal',
      letterSpacing: 'tight',
      lineHeight: 'normal',
    },
    layout: {
      primaryLayout: 'marketing',
      containerWidth: 'wide',
      density: 'spacious',
      borderRadius: 'large',
    },
    effects: {
      shadows: 'medium',
      borders: 'none',
      animations: 'moderate',
    },
    components: {
      buttonStyle: 'gradient',
      cardStyle: 'raised',
      inputStyle: 'bordered',
      navStyle: 'pills',
    },
  },

  // Documentation - Clear, navigable, developer-friendly
  documentation: {
    name: 'documentation',
    displayName: 'Documentation',
    description: 'Clear, organized design optimized for technical documentation',
    tags: ['docs', 'technical', 'developer', 'clear', 'organized'],
    tokens: {
      colors: {
        primary: { DEFAULT: '#3b82f6', foreground: '#ffffff' },
        secondary: { DEFAULT: '#f1f5f9', foreground: '#1e293b' },
        accent: { DEFAULT: '#0ea5e9', foreground: '#ffffff' },
        background: '#ffffff',
        foreground: '#1e293b',
        card: { DEFAULT: '#f8fafc', foreground: '#1e293b' },
        muted: { DEFAULT: '#f1f5f9', foreground: '#64748b' },
        border: '#e2e8f0',
        destructive: { DEFAULT: '#ef4444', foreground: '#ffffff' },
        success: { DEFAULT: '#22c55e', foreground: '#ffffff' },
        warning: { DEFAULT: '#f59e0b', foreground: '#ffffff' },
        info: { DEFAULT: '#3b82f6', foreground: '#ffffff' },
      } as ColorTokens,
    },
    typography: {
      fontPairing: 'mono-heavy',
      headingStyle: 'normal',
      letterSpacing: 'normal',
      lineHeight: 'relaxed',
    },
    layout: {
      primaryLayout: 'sidebar',
      containerWidth: 'normal',
      density: 'comfortable',
      borderRadius: 'small',
    },
    effects: {
      shadows: 'none',
      borders: 'subtle',
      animations: 'minimal',
    },
    components: {
      buttonStyle: 'outline',
      cardStyle: 'bordered',
      inputStyle: 'bordered',
      navStyle: 'minimal',
    },
  },

  // E-commerce - Browsable, trustworthy, purchase-focused
  ecommerce: {
    name: 'ecommerce',
    displayName: 'E-commerce',
    description: 'Browsable design focused on product discovery and trust',
    tags: ['shop', 'products', 'retail', 'trust', 'browsable'],
    tokens: {
      colors: {
        primary: { DEFAULT: '#16a34a', foreground: '#ffffff' },
        secondary: { DEFAULT: '#f4f4f5', foreground: '#18181b' },
        accent: { DEFAULT: '#f97316', foreground: '#ffffff' },
        background: '#ffffff',
        foreground: '#171717',
        card: { DEFAULT: '#ffffff', foreground: '#171717' },
        muted: { DEFAULT: '#f5f5f5', foreground: '#737373' },
        border: '#e5e5e5',
        destructive: { DEFAULT: '#dc2626', foreground: '#ffffff' },
        success: { DEFAULT: '#16a34a', foreground: '#ffffff' },
        warning: { DEFAULT: '#ca8a04', foreground: '#ffffff' },
        info: { DEFAULT: '#2563eb', foreground: '#ffffff' },
      } as ColorTokens,
    },
    typography: {
      fontPairing: 'system',
      headingStyle: 'normal',
      letterSpacing: 'normal',
      lineHeight: 'normal',
    },
    layout: {
      primaryLayout: 'grid',
      containerWidth: 'wide',
      density: 'comfortable',
      borderRadius: 'medium',
    },
    effects: {
      shadows: 'medium',
      borders: 'subtle',
      animations: 'moderate',
    },
    components: {
      buttonStyle: 'solid',
      cardStyle: 'raised',
      inputStyle: 'bordered',
      navStyle: 'minimal',
    },
  },

  // Creative Agency - Expressive, unique, portfolio-focused
  'creative-agency': {
    name: 'creative-agency',
    displayName: 'Creative Agency',
    description: 'Expressive design for showcasing creative work',
    tags: ['creative', 'portfolio', 'agency', 'artistic', 'unique'],
    tokens: {
      colors: {
        primary: { DEFAULT: '#000000', foreground: '#ffffff' },
        secondary: { DEFAULT: '#f5f5f5', foreground: '#000000' },
        accent: { DEFAULT: '#ff3366', foreground: '#ffffff' },
        background: '#ffffff',
        foreground: '#000000',
        card: { DEFAULT: '#fafafa', foreground: '#000000' },
        muted: { DEFAULT: '#f0f0f0', foreground: '#666666' },
        border: '#e0e0e0',
        destructive: { DEFAULT: '#ff0000', foreground: '#ffffff' },
        success: { DEFAULT: '#00cc66', foreground: '#ffffff' },
        warning: { DEFAULT: '#ffcc00', foreground: '#000000' },
        info: { DEFAULT: '#0066ff', foreground: '#ffffff' },
      } as ColorTokens,
    },
    typography: {
      fontPairing: 'geist',
      headingStyle: 'uppercase',
      letterSpacing: 'wide',
      lineHeight: 'tight',
    },
    layout: {
      primaryLayout: 'marketing',
      containerWidth: 'full',
      density: 'spacious',
      borderRadius: 'none',
    },
    effects: {
      shadows: 'none',
      borders: 'prominent',
      animations: 'expressive',
    },
    components: {
      buttonStyle: 'ghost',
      cardStyle: 'flat',
      inputStyle: 'minimal',
      navStyle: 'minimal',
    },
  },
};

// ==========================================
// UTILITY FUNCTIONS
// ==========================================

/**
 * Get aesthetic preset by name
 */
export function getAestheticPreset(name: AestheticName): AestheticPreset {
  return aestheticPresets[name];
}

/**
 * Get all presets matching tags
 */
export function getPresetsByTags(tags: string[]): AestheticPreset[] {
  return Object.values(aestheticPresets).filter((preset) =>
    tags.some((tag) => preset.tags.includes(tag))
  );
}

/**
 * Recommend aesthetic based on project context
 */
export function recommendAesthetic(context: {
  industry?: string;
  tone?: string;
  contentType?: string;
  targetAudience?: string;
}): AestheticName {
  const { industry, tone, contentType, targetAudience } = context;
  const allText = [industry, tone, contentType, targetAudience]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  // Industry/type matching
  if (allText.includes('game') || allText.includes('cyber') || allText.includes('tech')) {
    return 'cyberpunk';
  }
  if (allText.includes('saas') || allText.includes('b2b') || allText.includes('enterprise')) {
    return 'minimal-saas';
  }
  if (allText.includes('blog') || allText.includes('article') || allText.includes('magazine')) {
    return 'warm-editorial';
  }
  if (allText.includes('dashboard') || allText.includes('analytics') || allText.includes('admin')) {
    return 'dashboard-pro';
  }
  if (allText.includes('landing') || allText.includes('marketing') || allText.includes('startup')) {
    return 'marketing-bold';
  }
  if (allText.includes('docs') || allText.includes('documentation') || allText.includes('developer')) {
    return 'documentation';
  }
  if (allText.includes('shop') || allText.includes('ecommerce') || allText.includes('product')) {
    return 'ecommerce';
  }
  if (allText.includes('creative') || allText.includes('agency') || allText.includes('portfolio')) {
    return 'creative-agency';
  }

  // Default to minimal-saas as safe choice
  return 'minimal-saas';
}

/**
 * Merge preset with custom overrides
 */
export function customizePreset(
  baseName: AestheticName,
  overrides: Partial<AestheticPreset>
): AestheticPreset {
  const base = aestheticPresets[baseName];

  return {
    ...base,
    ...overrides,
    tokens: {
      ...base.tokens,
      ...overrides.tokens,
    },
    typography: {
      ...base.typography,
      ...overrides.typography,
    },
    layout: {
      ...base.layout,
      ...overrides.layout,
    },
    effects: {
      ...base.effects,
      ...overrides.effects,
    },
    components: {
      ...base.components,
      ...overrides.components,
    },
  };
}

/**
 * Generate CSS custom properties from preset
 */
export function presetToCSS(preset: AestheticPreset): string {
  const lines: string[] = [':root {'];

  // Add color tokens
  if (preset.tokens.colors) {
    const colors = preset.tokens.colors;
    for (const [key, value] of Object.entries(colors)) {
      if (typeof value === 'string') {
        lines.push(`  --color-${key}: ${value};`);
      } else if (typeof value === 'object' && value !== null) {
        lines.push(`  --color-${key}: ${value.DEFAULT};`);
        lines.push(`  --color-${key}-foreground: ${value.foreground};`);
      }
    }
  }

  // Add radius tokens
  if (preset.tokens.radius) {
    for (const [key, value] of Object.entries(preset.tokens.radius)) {
      const radiusKey = key === 'DEFAULT' ? 'radius' : `radius-${key}`;
      lines.push(`  --${radiusKey}: ${value};`);
    }
  }

  // Add spacing tokens
  if (preset.tokens.spacing) {
    for (const [key, value] of Object.entries(preset.tokens.spacing)) {
      lines.push(`  --spacing-${key}: ${value};`);
    }
  }

  lines.push('}');

  return lines.join('\n');
}

/**
 * Get contrasting preset (light/dark counterpart)
 */
export function getContrastingPreset(name: AestheticName): AestheticName | null {
  const contrastMap: Partial<Record<AestheticName, AestheticName>> = {
    'cyberpunk': 'minimal-saas',
    'minimal-saas': 'dashboard-pro',
    'dashboard-pro': 'minimal-saas',
    'warm-editorial': 'documentation',
  };

  return contrastMap[name] || null;
}
