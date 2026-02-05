/**
 * Typography System
 * 
 * Pre-defined font pairings and type scale management.
 * 
 * Rule: Max 2 font families per project. Weights create hierarchy, not new fonts.
 */

// ==========================================
// TYPES
// ==========================================

export type FontPairingName = 
  | 'geist'
  | 'serif-sans'
  | 'rounded'
  | 'mono-heavy'
  | 'cyber'
  | 'inter'
  | 'system';

export interface FontPairing {
  name: FontPairingName;
  heading: string;
  body: string;
  mono: string;
  style: string;
  weights: {
    heading: number[];
    body: number[];
  };
  googleFontsUrl?: string;
}

export interface TextStyle {
  fontSize: string;
  fontWeight: number;
  lineHeight: string;
  letterSpacing?: string;
  fontFamily: 'heading' | 'body' | 'mono';
  textTransform?: 'uppercase' | 'lowercase' | 'capitalize' | 'none';
}

export interface TypeScale {
  display: TextStyle;
  h1: TextStyle;
  h2: TextStyle;
  h3: TextStyle;
  h4: TextStyle;
  lead: TextStyle;
  body: TextStyle;
  bodySmall: TextStyle;
  caption: TextStyle;
  overline: TextStyle;
  code: TextStyle;
}

// ==========================================
// FONT PAIRINGS
// ==========================================

export const fontPairings: Record<FontPairingName, FontPairing> = {
  // Modern tech - clean and technical
  geist: {
    name: 'geist',
    heading: 'Geist',
    body: 'Geist',
    mono: 'Geist Mono',
    style: 'Clean, technical, modern',
    weights: {
      heading: [500, 600, 700],
      body: [400, 500],
    },
    // Geist is typically self-hosted or via Vercel
  },
  
  // Editorial - elegant, high-end
  'serif-sans': {
    name: 'serif-sans',
    heading: 'Playfair Display',
    body: 'Inter',
    mono: 'JetBrains Mono',
    style: 'Elegant, editorial, high-end',
    weights: {
      heading: [500, 600, 700],
      body: [400, 500],
    },
    googleFontsUrl: 'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@500;600;700&family=Inter:wght@400;500&family=JetBrains+Mono&display=swap',
  },
  
  // Friendly - approachable, soft
  rounded: {
    name: 'rounded',
    heading: 'Nunito',
    body: 'Inter',
    mono: 'Fira Code',
    style: 'Approachable, friendly, soft',
    weights: {
      heading: [600, 700, 800],
      body: [400, 500],
    },
    googleFontsUrl: 'https://fonts.googleapis.com/css2?family=Nunito:wght@600;700;800&family=Inter:wght@400;500&family=Fira+Code&display=swap',
  },
  
  // Brutalist - bold, technical
  'mono-heavy': {
    name: 'mono-heavy',
    heading: 'Space Grotesk',
    body: 'Space Grotesk',
    mono: 'Space Mono',
    style: 'Bold, technical, brutalist',
    weights: {
      heading: [500, 600, 700],
      body: [400, 500],
    },
    googleFontsUrl: 'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Space+Mono&display=swap',
  },
  
  // Cyberpunk - futuristic, sci-fi
  cyber: {
    name: 'cyber',
    heading: 'Orbitron',
    body: 'Rajdhani',
    mono: 'Share Tech Mono',
    style: 'Futuristic, sci-fi, technical',
    weights: {
      heading: [500, 600, 700],
      body: [400, 500, 600],
    },
    googleFontsUrl: 'https://fonts.googleapis.com/css2?family=Orbitron:wght@500;600;700&family=Rajdhani:wght@400;500;600&family=Share+Tech+Mono&display=swap',
  },
  
  // Inter - versatile, modern
  inter: {
    name: 'inter',
    heading: 'Inter',
    body: 'Inter',
    mono: 'JetBrains Mono',
    style: 'Versatile, modern, clean',
    weights: {
      heading: [500, 600, 700],
      body: [400, 500],
    },
    googleFontsUrl: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono&display=swap',
  },
  
  // System fonts - fastest loading
  system: {
    name: 'system',
    heading: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    body: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    mono: 'ui-monospace, SFMono-Regular, Menlo, Monaco, monospace',
    style: 'Native, fast, familiar',
    weights: {
      heading: [500, 600, 700],
      body: [400, 500],
    },
  },
};

// ==========================================
// TYPE SCALE
// ==========================================

/**
 * Default type scale with semantic naming
 */
export const defaultTypeScale: TypeScale = {
  display: {
    fontSize: '3rem',      // 48px
    fontWeight: 700,
    lineHeight: '1.1',
    letterSpacing: '-0.02em',
    fontFamily: 'heading',
  },
  h1: {
    fontSize: '2.25rem',   // 36px
    fontWeight: 700,
    lineHeight: '1.2',
    letterSpacing: '-0.02em',
    fontFamily: 'heading',
  },
  h2: {
    fontSize: '1.875rem',  // 30px
    fontWeight: 600,
    lineHeight: '1.25',
    letterSpacing: '-0.01em',
    fontFamily: 'heading',
  },
  h3: {
    fontSize: '1.5rem',    // 24px
    fontWeight: 600,
    lineHeight: '1.3',
    fontFamily: 'heading',
  },
  h4: {
    fontSize: '1.25rem',   // 20px
    fontWeight: 600,
    lineHeight: '1.4',
    fontFamily: 'heading',
  },
  lead: {
    fontSize: '1.125rem',  // 18px
    fontWeight: 400,
    lineHeight: '1.6',
    fontFamily: 'body',
  },
  body: {
    fontSize: '1rem',      // 16px
    fontWeight: 400,
    lineHeight: '1.5',
    fontFamily: 'body',
  },
  bodySmall: {
    fontSize: '0.875rem',  // 14px
    fontWeight: 400,
    lineHeight: '1.5',
    fontFamily: 'body',
  },
  caption: {
    fontSize: '0.75rem',   // 12px
    fontWeight: 400,
    lineHeight: '1.4',
    fontFamily: 'body',
  },
  overline: {
    fontSize: '0.75rem',   // 12px
    fontWeight: 600,
    lineHeight: '1.4',
    letterSpacing: '0.1em',
    fontFamily: 'body',
    textTransform: 'uppercase',
  },
  code: {
    fontSize: '0.875rem',  // 14px
    fontWeight: 400,
    lineHeight: '1.6',
    fontFamily: 'mono',
  },
};

// ==========================================
// UTILITY FUNCTIONS
// ==========================================

/**
 * Get font pairing by name
 */
export function getFontPairing(name: FontPairingName): FontPairing {
  return fontPairings[name] || fontPairings.system;
}

/**
 * Generate CSS font-family declarations
 */
export function generateFontFamilyCSS(pairing: FontPairing): string {
  return `
    --font-heading: ${pairing.heading};
    --font-body: ${pairing.body};
    --font-mono: ${pairing.mono};
  `.trim();
}

/**
 * Generate @font-face or @import declarations
 */
export function generateFontImport(pairing: FontPairing): string | null {
  if (pairing.googleFontsUrl) {
    return `@import url('${pairing.googleFontsUrl}');`;
  }
  return null;
}

/**
 * Convert text style to CSS properties
 */
export function textStyleToCSS(style: TextStyle, pairing: FontPairing): string {
  const fontFamily = 
    style.fontFamily === 'heading' ? pairing.heading :
    style.fontFamily === 'body' ? pairing.body :
    pairing.mono;
  
  let css = `
    font-size: ${style.fontSize};
    font-weight: ${style.fontWeight};
    line-height: ${style.lineHeight};
    font-family: ${fontFamily};
  `;
  
  if (style.letterSpacing) {
    css += `letter-spacing: ${style.letterSpacing};\n`;
  }
  
  if (style.textTransform) {
    css += `text-transform: ${style.textTransform};\n`;
  }
  
  return css.trim();
}

/**
 * Convert text style to Tailwind classes
 */
export function textStyleToTailwind(style: TextStyle): string {
  const classes: string[] = [];
  
  // Font size mapping
  const sizeMap: Record<string, string> = {
    '0.75rem': 'text-xs',
    '0.875rem': 'text-sm',
    '1rem': 'text-base',
    '1.125rem': 'text-lg',
    '1.25rem': 'text-xl',
    '1.5rem': 'text-2xl',
    '1.875rem': 'text-3xl',
    '2.25rem': 'text-4xl',
    '3rem': 'text-5xl',
  };
  classes.push(sizeMap[style.fontSize] || 'text-base');
  
  // Font weight mapping
  const weightMap: Record<number, string> = {
    400: 'font-normal',
    500: 'font-medium',
    600: 'font-semibold',
    700: 'font-bold',
    800: 'font-extrabold',
  };
  classes.push(weightMap[style.fontWeight] || 'font-normal');
  
  // Line height mapping
  const leadingMap: Record<string, string> = {
    '1.1': 'leading-none',
    '1.2': 'leading-tight',
    '1.25': 'leading-tight',
    '1.3': 'leading-snug',
    '1.4': 'leading-snug',
    '1.5': 'leading-normal',
    '1.6': 'leading-relaxed',
    '1.75': 'leading-loose',
  };
  classes.push(leadingMap[style.lineHeight] || 'leading-normal');
  
  // Font family
  const familyMap: Record<string, string> = {
    heading: 'font-heading',
    body: 'font-body',
    mono: 'font-mono',
  };
  classes.push(familyMap[style.fontFamily]);
  
  // Letter spacing
  if (style.letterSpacing === '-0.02em') {
    classes.push('tracking-tight');
  } else if (style.letterSpacing === '-0.01em') {
    classes.push('tracking-tight');
  } else if (style.letterSpacing === '0.1em') {
    classes.push('tracking-widest');
  }
  
  // Text transform
  if (style.textTransform === 'uppercase') {
    classes.push('uppercase');
  } else if (style.textTransform === 'lowercase') {
    classes.push('lowercase');
  } else if (style.textTransform === 'capitalize') {
    classes.push('capitalize');
  }
  
  return classes.join(' ');
}

/**
 * Generate complete type scale CSS
 */
export function generateTypeScaleCSS(scale: TypeScale, pairing: FontPairing): string {
  const entries = Object.entries(scale) as [keyof TypeScale, TextStyle][];
  
  return entries
    .map(([name, style]) => `.text-${name} {\n  ${textStyleToCSS(style, pairing)}\n}`)
    .join('\n\n');
}

/**
 * Get responsive text style (scales down on mobile)
 */
export function getResponsiveTextStyle(
  style: TextStyle,
  mobileScale: number = 0.85
): { base: TextStyle; mobile: TextStyle } {
  const baseSizeNum = parseFloat(style.fontSize);
  const mobileSize = `${(baseSizeNum * mobileScale).toFixed(3)}rem`;
  
  return {
    base: style,
    mobile: {
      ...style,
      fontSize: mobileSize,
    },
  };
}

/**
 * Calculate fluid typography (clamp-based)
 */
export function getFluidFontSize(
  minSize: number,  // rem
  maxSize: number,  // rem
  minViewport: number = 320,  // px
  maxViewport: number = 1200  // px
): string {
  const slope = (maxSize - minSize) / (maxViewport - minViewport);
  const intercept = minSize - slope * minViewport;
  
  const clampMin = `${minSize}rem`;
  const clampPreferred = `calc(${intercept.toFixed(4)}rem + ${(slope * 100).toFixed(4)}vw)`;
  const clampMax = `${maxSize}rem`;
  
  return `clamp(${clampMin}, ${clampPreferred}, ${clampMax})`;
}

// ==========================================
// PAIRING RECOMMENDATIONS
// ==========================================

/**
 * Recommend font pairing based on project type
 */
export function recommendFontPairing(context: {
  projectType?: string;
  aesthetic?: string;
  keywords?: string[];
}): FontPairingName {
  const allText = [
    context.projectType || '',
    context.aesthetic || '',
    ...(context.keywords || []),
  ].join(' ').toLowerCase();
  
  if (allText.includes('cyber') || allText.includes('tech') || allText.includes('ai')) {
    return 'cyber';
  }
  
  if (allText.includes('editorial') || allText.includes('blog') || allText.includes('magazine')) {
    return 'serif-sans';
  }
  
  if (allText.includes('friendly') || allText.includes('casual') || allText.includes('playful')) {
    return 'rounded';
  }
  
  if (allText.includes('brutalist') || allText.includes('developer') || allText.includes('terminal')) {
    return 'mono-heavy';
  }
  
  if (allText.includes('minimal') || allText.includes('clean') || allText.includes('modern')) {
    return 'inter';
  }
  
  // Default to Geist for tech projects
  if (allText.includes('saas') || allText.includes('dashboard') || allText.includes('app')) {
    return 'geist';
  }
  
  return 'inter';
}
