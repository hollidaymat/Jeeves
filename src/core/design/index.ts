/**
 * Jeeves Design System
 * 
 * A comprehensive design system for AI-driven UI development.
 * Integrates with the Jeeves Cognitive Architecture for intelligent design decisions.
 * 
 * Core Modules:
 * - tokens: Design tokens (colors, typography, spacing, radius, shadows)
 * - palette-generator: Color palette generation from brand colors
 * - typography: Font pairings and type scales
 * - layout-patterns: Pre-built layout patterns
 * - component-patterns: Component composition patterns
 * - visual-hierarchy: Visual hierarchy rules and analysis
 * - animation: Animation system with cyberpunk effects
 * - accessibility: Accessibility baseline checker
 * - aesthetic-presets: Complete aesthetic presets
 * - design-review: Design review checklist system
 * - prd-extractor: PRD design requirements extractor
 * - cognitive-integration: OODA loop integration for design decisions
 */

import type { DesignTokens } from './tokens.js';
import type { FontPairingName } from './typography.js';
import type { LayoutPatternName } from './layout-patterns.js';
import type { AestheticName } from './aesthetic-presets.js';

// Design Tokens
export {
  type DesignTokens,
  type ColorTokens,
  type TypographyTokens,
  type SpacingTokens,
  type RadiusTokens,
  type ShadowTokens,
  defaultTokens,
  tokensToCSSVars,
  tokensToTailwindTheme,
} from './tokens.js';

// Palette Generator
export {
  type ColorMode,
  type Aesthetic,
  type PaletteConfig,
  type GeneratedPalette,
  generatePalette,
  inferAesthetic,
  hexToRgb,
  rgbToHex,
  adjustLightness,
  getComplementary,
  getAnalogous,
  hexWithAlpha,
} from './palette-generator.js';

// Typography
export {
  type FontPairingName,
  type FontPairing,
  type TypeScale,
  type TextStyle,
  fontPairings,
  defaultTypeScale,
  textStyleToCSS,
  textStyleToTailwind,
  recommendFontPairing,
} from './typography.js';

// Layout Patterns
export {
  type LayoutPatternName,
  type LayoutPattern,
  type LayoutStructure,
  type LayoutSpacing,
  type ResponsiveRules,
  containerWidths,
  spacingPresets,
  layoutPatterns,
  getLayoutPattern,
  generateLayoutCSS,
  getResponsiveLayoutClasses,
  recommendLayout,
  generateResponsiveGrid,
  generateColumnGrid,
  getSectionSpacing,
} from './layout-patterns.js';

// Component Patterns
export {
  type ComponentCategory,
  type ComponentSize,
  type ComponentVariant,
  type ComponentPattern,
  type SlotDefinition,
  type VariantDefinition,
  type SizeDefinition,
  type StateDefinition,
  type AccessibilityRequirements,
  componentPatterns,
  getComponentPattern,
  getPatternsByCategory,
  generateComponentInterface,
  getVariantClasses,
  getSizeClasses,
  getAccessibilityProps,
  createCompoundPattern,
} from './component-patterns.js';

// Visual Hierarchy
export {
  type EmphasisLevel,
  type ContrastLevel,
  type HierarchyRule,
  type VisualWeight,
  type HierarchyAnalysis,
  type HierarchyIssue,
  hierarchyRules,
  emphasisPresets,
  calculateVisualWeight,
  analyzeHierarchy,
  getEmphasisStyles,
  getEmphasisClasses,
  recommendHierarchy,
  getRequiredContrast,
} from './visual-hierarchy.js';

// Animation
export {
  type AnimationPurpose,
  type AnimationTiming,
  type EasingType,
  type AnimationConfig,
  type AnimationPreset,
  type TransitionPreset,
  type CyberpunkEffect,
  timings,
  easings,
  transitionPresets,
  animationPresets,
  cyberpunkEffects,
  getAnimation,
  getTransition,
  getCyberpunkEffect,
  generateAnimationCSS,
  generateAllKeyframes,
  generateTailwindAnimationConfig,
  getTimingForPurpose,
  generateStaggerDelays,
  recommendAnimation,
} from './animation.js';

// Accessibility
export {
  type WCAGLevel,
  type IssueCategory,
  type IssueSeverity,
  type AccessibilityRule,
  type AccessibilityIssue,
  type AccessibilityReport,
  type AccessibilityChecklist,
  type ChecklistItem,
  accessibilityRules,
  accessibilityBaseline,
  getRelativeLuminance,
  getContrastRatio,
  isLargeText,
  getRequiredContrastRatio,
  checkAccessibility,
  checkColorContrast,
  suggestAccessibleColor,
  getChecklistForLevel,
} from './accessibility.js';

// Aesthetic Presets
export {
  type AestheticName,
  type AestheticPreset,
  type TypographyPreset,
  type LayoutPreset,
  type EffectsPreset,
  type ComponentStylePreset,
  aestheticPresets,
  getAestheticPreset,
  getPresetsByTags,
  recommendAesthetic,
  customizePreset,
  presetToCSS,
  getContrastingPreset,
} from './aesthetic-presets.js';

// Design Review
export {
  type ReviewCategory,
  type ReviewStatus,
  type ReviewCheckItem,
  type ReviewContext,
  type ReviewResult,
  type DesignReview,
  type ReviewSummary,
  designReviewChecklist,
  getChecklistByCategory,
  getAllCategories,
  runAutomatedChecks,
  calculateReviewScore,
  createDesignReview,
  generateReviewReport,
} from './design-review.js';

// PRD Extractor
export {
  type PRDAnalysis,
  type ProductType,
  type AudienceProfile,
  type DesignRequirement,
  type RequirementType,
  type ColorRequirement,
  type PageDesign,
  type ComponentNeed,
  type DesignConstraint,
  quickExtract,
  deepExtract,
  generateDesignBrief,
  extractComponentList,
} from './prd-extractor.js';

// Cognitive Integration (OODA Loop)
export {
  type DesignContext,
  type DesignDecision,
  type DesignDecisionType,
  type OODAObservation,
  type OODAOrientation,
  type OODADecision,
  type OODAAction,
  type DesignOODAResult,
  type DesignRule,
  type DesignRisk,
  observe,
  orient,
  decide,
  act,
  runDesignOODA,
  quickDesignDecision,
} from './cognitive-integration.js';

// ==========================================
// CONVENIENCE EXPORTS
// ==========================================

/**
 * Quick start: Get design system for a project type
 */
export async function getDesignSystem(options: {
  projectName: string;
  projectType: string;
  darkMode?: boolean;
  brandColor?: string;
}): Promise<{
  aesthetic: AestheticName;
  tokens: DesignTokens;
  layout: LayoutPatternName;
  typography: FontPairingName;
}> {
  // Import dynamically to avoid circular deps
  const { runDesignOODA } = await import('./cognitive-integration.js');
  const { defaultTokens } = await import('./tokens.js');
  
  const result = await runDesignOODA({
    projectName: options.projectName,
    projectDescription: options.projectType,
    existingBrandColors: options.brandColor ? [options.brandColor] : undefined,
    userPreferences: {
      darkMode: options.darkMode,
    },
  });
  
  return {
    aesthetic: result.decision.recommendedAesthetic,
    tokens: result.action.designTokens,
    layout: result.decision.recommendedLayout,
    typography: result.decision.recommendedTypography,
  };
}
