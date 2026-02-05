/**
 * Palette Generator
 * 
 * Generates complete color palettes from a single brand color.
 * Supports multiple aesthetics and light/dark modes.
 * 
 * Rule: Max 5 colors. Every color has a purpose. No decoration colors.
 */

import type { ColorTokens } from './tokens.js';

// ==========================================
// TYPES
// ==========================================

export type ColorMode = 'dark' | 'light';

export type Aesthetic = 
  | 'cyberpunk'
  | 'minimal'
  | 'warm'
  | 'editorial'
  | 'dashboard';

export interface PaletteConfig {
  baseColor: string;
  mode: ColorMode;
  aesthetic: Aesthetic;
  accentColor?: string;
}

export interface GeneratedPalette extends ColorTokens {
  meta: {
    baseColor: string;
    mode: ColorMode;
    aesthetic: Aesthetic;
    generatedAt: number;
  };
}

// ==========================================
// COLOR UTILITIES
// ==========================================

/**
 * Parse hex color to RGB
 */
function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : null;
}

/**
 * Convert RGB to hex
 */
function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b]
    .map(x => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Convert RGB to HSL
 */
function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  r /= 255;
  g /= 255;
  b /= 255;
  
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }
  
  return { h: h * 360, s: s * 100, l: l * 100 };
}

/**
 * Convert HSL to RGB
 */
function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  h /= 360;
  s /= 100;
  l /= 100;
  
  let r: number, g: number, b: number;
  
  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p: number, q: number, t: number) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1/6) return p + (q - p) * 6 * t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    };
    
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1/3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1/3);
  }
  
  return {
    r: Math.round(r * 255),
    g: Math.round(g * 255),
    b: Math.round(b * 255)
  };
}

/**
 * Adjust color lightness
 */
function adjustLightness(hex: string, amount: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  
  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
  hsl.l = Math.max(0, Math.min(100, hsl.l + amount));
  
  const newRgb = hslToRgb(hsl.h, hsl.s, hsl.l);
  return rgbToHex(newRgb.r, newRgb.g, newRgb.b);
}

/**
 * Get complementary color
 */
function getComplementary(hex: string): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  
  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
  hsl.h = (hsl.h + 180) % 360;
  
  const newRgb = hslToRgb(hsl.h, hsl.s, hsl.l);
  return rgbToHex(newRgb.r, newRgb.g, newRgb.b);
}

/**
 * Get analogous color (30 degrees offset)
 */
function getAnalogous(hex: string, offset: number = 30): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  
  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
  hsl.h = (hsl.h + offset + 360) % 360;
  
  const newRgb = hslToRgb(hsl.h, hsl.s, hsl.l);
  return rgbToHex(newRgb.r, newRgb.g, newRgb.b);
}

/**
 * Add alpha to hex color
 */
function hexWithAlpha(hex: string, alpha: number): string {
  const alphaHex = Math.round(alpha * 255).toString(16).padStart(2, '0');
  return hex + alphaHex;
}

// ==========================================
// AESTHETIC PALETTES
// ==========================================

/**
 * Cyberpunk palette - sci-fi, neon, dark
 */
function generateCyberpunkPalette(baseColor: string, mode: ColorMode): ColorTokens {
  const isLight = mode === 'light';
  
  return {
    background: isLight ? '#fafafa' : '#0c0c14',
    foreground: isLight ? '#18181b' : '#e4e4e7',
    primary: baseColor,
    primaryForeground: isLight ? '#fafafa' : '#0c0c14',
    secondary: getAnalogous(baseColor, 60),
    secondaryForeground: isLight ? '#18181b' : '#fafafa',
    accent: '#22d3ee',  // Cyan for cyberpunk
    accentForeground: isLight ? '#fafafa' : '#0c0c14',
    muted: isLight ? '#f4f4f5' : '#27272a',
    mutedForeground: isLight ? '#71717a' : '#a1a1aa',
    destructive: '#ef4444',
    destructiveForeground: '#fafafa',
    border: isLight ? '#e4e4e7' : '#3f3f46',
    input: isLight ? '#e4e4e7' : '#27272a',
    ring: baseColor,
    glow: hexWithAlpha(baseColor, 0.25),
  };
}

/**
 * Minimal palette - clean, professional
 */
function generateMinimalPalette(baseColor: string, mode: ColorMode): ColorTokens {
  const isLight = mode === 'light';
  
  return {
    background: isLight ? '#ffffff' : '#09090b',
    foreground: isLight ? '#09090b' : '#fafafa',
    primary: baseColor,
    primaryForeground: isLight ? '#fafafa' : '#09090b',
    secondary: isLight ? '#f4f4f5' : '#27272a',
    secondaryForeground: isLight ? '#18181b' : '#fafafa',
    accent: baseColor,
    accentForeground: isLight ? '#fafafa' : '#09090b',
    muted: isLight ? '#f4f4f5' : '#18181b',
    mutedForeground: '#71717a',
    destructive: '#ef4444',
    destructiveForeground: '#fafafa',
    border: isLight ? '#e4e4e7' : '#27272a',
    input: isLight ? '#e4e4e7' : '#27272a',
    ring: baseColor,
  };
}

/**
 * Warm palette - friendly, approachable
 */
function generateWarmPalette(baseColor: string, mode: ColorMode): ColorTokens {
  const isLight = mode === 'light';
  
  return {
    background: isLight ? '#fffbeb' : '#1c1917',
    foreground: isLight ? '#1c1917' : '#fafaf9',
    primary: baseColor,
    primaryForeground: isLight ? '#fafaf9' : '#1c1917',
    secondary: isLight ? '#fef3c7' : '#292524',
    secondaryForeground: isLight ? '#1c1917' : '#fafaf9',
    accent: '#f97316',  // Orange for warmth
    accentForeground: isLight ? '#fafaf9' : '#1c1917',
    muted: isLight ? '#fef3c7' : '#292524',
    mutedForeground: isLight ? '#78716c' : '#a8a29e',
    destructive: '#dc2626',
    destructiveForeground: '#fafaf9',
    border: isLight ? '#e7e5e4' : '#44403c',
    input: isLight ? '#e7e5e4' : '#44403c',
    ring: baseColor,
  };
}

/**
 * Editorial palette - content-focused, high contrast
 */
function generateEditorialPalette(baseColor: string, mode: ColorMode): ColorTokens {
  const isLight = mode === 'light';
  
  return {
    background: isLight ? '#ffffff' : '#000000',
    foreground: isLight ? '#000000' : '#ffffff',
    primary: baseColor,
    primaryForeground: isLight ? '#ffffff' : '#000000',
    secondary: isLight ? '#f5f5f5' : '#171717',
    secondaryForeground: isLight ? '#171717' : '#f5f5f5',
    accent: baseColor,
    accentForeground: isLight ? '#ffffff' : '#000000',
    muted: isLight ? '#f5f5f5' : '#171717',
    mutedForeground: isLight ? '#737373' : '#a3a3a3',
    destructive: '#dc2626',
    destructiveForeground: '#ffffff',
    border: isLight ? '#e5e5e5' : '#262626',
    input: isLight ? '#e5e5e5' : '#262626',
    ring: baseColor,
  };
}

/**
 * Dashboard palette - data-heavy, status colors
 */
function generateDashboardPalette(baseColor: string, mode: ColorMode): ColorTokens {
  const isLight = mode === 'light';
  
  return {
    background: isLight ? '#fafafa' : '#0a0a0a',
    foreground: isLight ? '#0a0a0a' : '#fafafa',
    primary: baseColor,
    primaryForeground: isLight ? '#fafafa' : '#0a0a0a',
    secondary: isLight ? '#f4f4f5' : '#18181b',
    secondaryForeground: isLight ? '#18181b' : '#f4f4f5',
    accent: '#3b82f6',  // Blue for data/info
    accentForeground: '#fafafa',
    muted: isLight ? '#f4f4f5' : '#18181b',
    mutedForeground: isLight ? '#71717a' : '#a1a1aa',
    destructive: '#ef4444',
    destructiveForeground: '#fafafa',
    border: isLight ? '#e4e4e7' : '#27272a',
    input: isLight ? '#e4e4e7' : '#27272a',
    ring: baseColor,
  };
}

// ==========================================
// MAIN GENERATOR
// ==========================================

/**
 * Generate a complete palette from configuration
 */
export function generatePalette(config: PaletteConfig): GeneratedPalette {
  const { baseColor, mode, aesthetic, accentColor } = config;
  
  let palette: ColorTokens;
  
  switch (aesthetic) {
    case 'cyberpunk':
      palette = generateCyberpunkPalette(baseColor, mode);
      break;
    case 'minimal':
      palette = generateMinimalPalette(baseColor, mode);
      break;
    case 'warm':
      palette = generateWarmPalette(baseColor, mode);
      break;
    case 'editorial':
      palette = generateEditorialPalette(baseColor, mode);
      break;
    case 'dashboard':
      palette = generateDashboardPalette(baseColor, mode);
      break;
    default:
      palette = generateMinimalPalette(baseColor, mode);
  }
  
  // Override accent if provided
  if (accentColor) {
    palette.accent = accentColor;
  }
  
  return {
    ...palette,
    meta: {
      baseColor,
      mode,
      aesthetic,
      generatedAt: Date.now(),
    },
  };
}

/**
 * Generate dark and light mode palettes
 */
export function generatePalettePair(
  baseColor: string,
  aesthetic: Aesthetic
): { dark: GeneratedPalette; light: GeneratedPalette } {
  return {
    dark: generatePalette({ baseColor, mode: 'dark', aesthetic }),
    light: generatePalette({ baseColor, mode: 'light', aesthetic }),
  };
}

/**
 * Infer best aesthetic from context
 */
export function inferAesthetic(context: {
  projectType?: string;
  keywords?: string[];
  existingColors?: string[];
}): Aesthetic {
  const { projectType, keywords = [] } = context;
  const allText = [projectType || '', ...keywords].join(' ').toLowerCase();
  
  if (allText.includes('dashboard') || allText.includes('analytics') || allText.includes('monitor')) {
    return 'dashboard';
  }
  
  if (allText.includes('blog') || allText.includes('content') || allText.includes('article')) {
    return 'editorial';
  }
  
  if (allText.includes('cyber') || allText.includes('tech') || allText.includes('ai') || allText.includes('terminal')) {
    return 'cyberpunk';
  }
  
  if (allText.includes('friendly') || allText.includes('casual') || allText.includes('community')) {
    return 'warm';
  }
  
  return 'minimal';
}

/**
 * Get status colors for dashboards
 */
export function getStatusColors(mode: ColorMode): Record<string, string> {
  const isLight = mode === 'light';
  
  return {
    success: isLight ? '#16a34a' : '#22c55e',
    warning: isLight ? '#ca8a04' : '#eab308',
    error: isLight ? '#dc2626' : '#ef4444',
    info: isLight ? '#2563eb' : '#3b82f6',
    neutral: isLight ? '#71717a' : '#a1a1aa',
  };
}

/**
 * Get chart colors for data visualization
 */
export function getChartColors(baseColor: string, count: number = 5): string[] {
  const colors: string[] = [baseColor];
  
  for (let i = 1; i < count; i++) {
    const offset = (360 / count) * i;
    colors.push(getAnalogous(baseColor, offset));
  }
  
  return colors;
}

// ==========================================
// EXPORTS
// ==========================================

export {
  hexToRgb,
  rgbToHex,
  rgbToHsl,
  hslToRgb,
  adjustLightness,
  getComplementary,
  getAnalogous,
  hexWithAlpha,
};
