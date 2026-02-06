/**
 * Cognitive Integration for Design System
 * 
 * Integrates the Design System with Jeeves' OODA Loop for design decisions.
 * 
 * Observe -> Orient -> Decide -> Act applied to design tasks.
 */

import { generateText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import type { AestheticName, AestheticPreset } from './aesthetic-presets.js';
import { getAestheticPreset, recommendAesthetic } from './aesthetic-presets.js';
import type { DesignTokens } from './tokens.js';
import { defaultTokens } from './tokens.js';
import type { LayoutPatternName } from './layout-patterns.js';
import { recommendLayout } from './layout-patterns.js';
import type { FontPairingName } from './typography.js';
import { recommendFontPairing } from './typography.js';
import type { PRDAnalysis } from './prd-extractor.js';
import { quickExtract } from './prd-extractor.js';
import type { AccessibilityReport } from './accessibility.js';
import { checkColorContrast } from './accessibility.js';
import type { ReviewSummary } from './design-review.js';

// ==========================================
// TYPES
// ==========================================

export interface DesignContext {
  // Project information
  projectName: string;
  projectDescription?: string;
  prdContent?: string;
  existingBrandColors?: string[];
  
  // Current state
  currentPage?: string;
  currentComponents?: string[];
  
  // User preferences
  userPreferences?: {
    darkMode?: boolean;
    aesthetic?: AestheticName;
    accessibility?: 'standard' | 'enhanced';
  };
  
  // Previous decisions
  previousDecisions?: DesignDecision[];
}

export interface DesignDecision {
  timestamp: Date;
  type: DesignDecisionType;
  choice: string;
  reasoning: string;
  confidence: number; // 0-1
  alternatives?: string[];
}

export type DesignDecisionType =
  | 'aesthetic'
  | 'layout'
  | 'typography'
  | 'color'
  | 'component'
  | 'spacing'
  | 'animation'
  | 'accessibility';

export interface OODAObservation {
  // What we see
  projectType: string;
  targetAudience: string;
  technicalLevel: string;
  deviceFocus: string;
  
  // Constraints detected
  hasExistingBrand: boolean;
  requiresDarkMode: boolean;
  requiresAccessibility: boolean;
  
  // Content characteristics
  contentDensity: 'low' | 'medium' | 'high';
  primaryActions: string[];
  dataTypes: string[];
}

export interface OODAOrientation {
  // Mental models to apply
  applicablePatterns: string[];
  relevantRules: DesignRule[];
  similarProjects: string[];
  
  // Risk assessment
  designRisks: DesignRisk[];
  
  // Priority ranking
  priorities: {
    usability: number; // 1-10
    aesthetics: number;
    performance: number;
    accessibility: number;
  };
}

export interface DesignRule {
  id: string;
  rule: string;
  applicability: number; // 0-1
}

export interface DesignRisk {
  risk: string;
  severity: 'low' | 'medium' | 'high';
  mitigation: string;
}

export interface OODADecision {
  // What to do
  recommendedAesthetic: AestheticName;
  recommendedLayout: LayoutPatternName;
  recommendedTypography: FontPairingName;
  tokenOverrides: Partial<DesignTokens>;
  
  // Why
  reasoning: string[];
  tradeoffs: string[];
  
  // Confidence
  confidence: number;
  uncertainties: string[];
}

export interface OODAAction {
  // Concrete outputs
  designTokens: DesignTokens;
  cssVariables: Record<string, string>;
  tailwindConfig: Record<string, unknown>;
  componentStyles: Record<string, string>;
  
  // Documentation
  designBrief: string;
  styleguideNotes: string[];
  
  // Next steps
  recommendedNextSteps: string[];
}

export interface DesignOODAResult {
  observation: OODAObservation;
  orientation: OODAOrientation;
  decision: OODADecision;
  action: OODAAction;
  
  // Meta
  processingTime: number;
  confidenceScore: number;
}

// ==========================================
// DESIGN RULES DATABASE
// ==========================================

const designRules: DesignRule[] = [
  { id: 'contrast', rule: 'Text must have 4.5:1 contrast ratio for WCAG AA', applicability: 1.0 },
  { id: 'hierarchy-3', rule: 'Maximum 3 levels of visual emphasis per viewport', applicability: 0.9 },
  { id: 'cta-prominent', rule: 'Primary CTA should be the most visually prominent element', applicability: 0.95 },
  { id: 'spacing-scale', rule: 'Use 4/8pt spacing grid for consistency', applicability: 0.85 },
  { id: 'font-limit', rule: 'Limit to 2-3 font families maximum', applicability: 0.9 },
  { id: 'color-limit', rule: 'Limit palette to 5-7 colors maximum', applicability: 0.8 },
  { id: 'touch-target', rule: 'Interactive elements minimum 44x44px on mobile', applicability: 0.95 },
  { id: 'loading-states', rule: 'All async operations need loading states', applicability: 0.9 },
  { id: 'error-states', rule: 'Error states must be clear and actionable', applicability: 0.95 },
  { id: 'focus-visible', rule: 'All interactive elements need visible focus states', applicability: 1.0 },
];

// ==========================================
// OODA LOOP IMPLEMENTATION
// ==========================================

/**
 * OBSERVE: Gather information about the design context
 */
export function observe(context: DesignContext): OODAObservation {
  // Extract from PRD if available
  const prdAnalysis = context.prdContent ? quickExtract(context.prdContent) : null;
  
  // Determine project type from description or PRD
  const projectType = prdAnalysis?.productType || 
    inferProjectType(context.projectDescription || '');
  
  // Detect constraints
  const hasExistingBrand = (context.existingBrandColors?.length || 0) > 0;
  const requiresDarkMode = context.userPreferences?.darkMode || 
    /dark\s*mode|dark\s*theme/i.test(context.projectDescription || '');
  const requiresAccessibility = context.userPreferences?.accessibility === 'enhanced' ||
    /wcag|accessibility|a11y/i.test(context.projectDescription || '');
  
  // Infer content characteristics
  let contentDensity: 'low' | 'medium' | 'high' = 'medium';
  if (/dashboard|analytics|data|admin/i.test(projectType)) {
    contentDensity = 'high';
  } else if (/landing|marketing|portfolio/i.test(projectType)) {
    contentDensity = 'low';
  }
  
  return {
    projectType,
    targetAudience: prdAnalysis?.targetAudience?.primary || 'General users',
    technicalLevel: prdAnalysis?.targetAudience?.technicalLevel || 'intermediate',
    deviceFocus: prdAnalysis?.targetAudience?.devicePreference || 'balanced',
    hasExistingBrand,
    requiresDarkMode,
    requiresAccessibility,
    contentDensity,
    primaryActions: extractActions(context.projectDescription || ''),
    dataTypes: extractDataTypes(context.projectDescription || ''),
  };
}

/**
 * ORIENT: Analyze observations and apply mental models
 */
export function orient(observation: OODAObservation): OODAOrientation {
  // Find applicable design patterns
  const applicablePatterns = findApplicablePatterns(observation);
  
  // Filter rules by applicability
  const relevantRules = designRules.filter(rule => {
    if (observation.requiresAccessibility && rule.id.includes('contrast')) {
      return true;
    }
    return rule.applicability > 0.8;
  });
  
  // Identify design risks
  const risks = identifyRisks(observation);
  
  // Calculate priorities based on context
  const priorities = calculatePriorities(observation);
  
  return {
    applicablePatterns,
    relevantRules,
    similarProjects: findSimilarProjects(observation.projectType),
    designRisks: risks,
    priorities,
  };
}

/**
 * DECIDE: Make design decisions based on orientation
 */
export function decide(
  observation: OODAObservation,
  orientation: OODAOrientation,
  context: DesignContext
): OODADecision {
  // Choose aesthetic
  const recommendedAesthetic = context.userPreferences?.aesthetic ||
    recommendAesthetic({
      industry: observation.projectType,
      tone: observation.contentDensity === 'high' ? 'professional' : 'dynamic',
      contentType: observation.projectType,
      targetAudience: observation.targetAudience,
    });
  
  // Choose layout
  const recommendedLayout = recommendLayout({
    pageType: context.currentPage || observation.projectType,
    contentType: observation.contentDensity,
    hasSidebar: observation.contentDensity === 'high',
  });
  
  // Choose typography
  const recommendedTypography = recommendFontPairing({
    aesthetic: recommendedAesthetic,
  });
  
  // Apply token overrides
  const tokenOverrides: Partial<DesignTokens> = {};
  
  // If existing brand colors, incorporate them
  if (context.existingBrandColors && context.existingBrandColors.length > 0) {
    tokenOverrides.colors = {
      ...defaultTokens.colors,
      primary: context.existingBrandColors[0],
    };
  }
  
  // Generate reasoning
  const reasoning = generateReasoning(observation, orientation, recommendedAesthetic);
  const tradeoffs = identifyTradeoffs(orientation);
  
  // Calculate confidence
  const confidence = calculateConfidence(observation, orientation);
  const uncertainties = findUncertainties(observation, context);
  
  return {
    recommendedAesthetic,
    recommendedLayout,
    recommendedTypography,
    tokenOverrides,
    reasoning,
    tradeoffs,
    confidence,
    uncertainties,
  };
}

/**
 * ACT: Generate concrete design outputs
 */
export function act(
  decision: OODADecision,
  context: DesignContext
): OODAAction {
  // Get aesthetic preset
  const preset = getAestheticPreset(decision.recommendedAesthetic);
  
  // Merge tokens with overrides
  const designTokens: DesignTokens = {
    ...defaultTokens,
    ...preset.tokens,
    ...decision.tokenOverrides,
    colors: {
      ...defaultTokens.colors,
      ...preset.tokens?.colors,
      ...decision.tokenOverrides?.colors,
    },
  } as DesignTokens;
  
  // Generate CSS variables
  const cssVariables = tokensToCSSVars(designTokens);
  
  // Generate Tailwind config
  const tailwindConfig = tokensToTailwindConfig(designTokens);
  
  // Generate component styles
  const componentStyles = generateComponentStyles(preset);
  
  // Generate design brief
  const designBrief = generateDesignBrief(decision, context);
  
  // Style guide notes
  const styleguideNotes = generateStyleguideNotes(decision, preset);
  
  // Recommended next steps
  const recommendedNextSteps = generateNextSteps(decision, context);
  
  return {
    designTokens,
    cssVariables,
    tailwindConfig,
    componentStyles,
    designBrief,
    styleguideNotes,
    recommendedNextSteps,
  };
}

// ==========================================
// MAIN ENTRY POINT
// ==========================================

/**
 * Run the full OODA loop for design decisions
 */
export async function runDesignOODA(context: DesignContext): Promise<DesignOODAResult> {
  const startTime = Date.now();
  
  // OBSERVE
  const observation = observe(context);
  
  // ORIENT
  const orientation = orient(observation);
  
  // DECIDE
  const decision = decide(observation, orientation, context);
  
  // ACT
  const action = act(decision, context);
  
  const processingTime = Date.now() - startTime;
  
  return {
    observation,
    orientation,
    decision,
    action,
    processingTime,
    confidenceScore: decision.confidence,
  };
}

/**
 * Quick design decision for simple cases
 */
export function quickDesignDecision(projectType: string, darkMode: boolean = false): {
  aesthetic: AestheticName;
  layout: LayoutPatternName;
  typography: FontPairingName;
} {
  const context: DesignContext = {
    projectName: 'Quick Decision',
    projectDescription: projectType,
    userPreferences: { darkMode },
  };
  
  const observation = observe(context);
  const orientation = orient(observation);
  const decision = decide(observation, orientation, context);
  
  return {
    aesthetic: decision.recommendedAesthetic,
    layout: decision.recommendedLayout,
    typography: decision.recommendedTypography,
  };
}

// ==========================================
// HELPER FUNCTIONS
// ==========================================

function inferProjectType(description: string): string {
  const text = description.toLowerCase();
  
  if (/dashboard|admin|analytics/.test(text)) return 'saas-dashboard';
  if (/landing|marketing|homepage/.test(text)) return 'marketing-site';
  if (/shop|store|ecommerce|product/.test(text)) return 'e-commerce';
  if (/docs|documentation|guide/.test(text)) return 'documentation';
  if (/blog|article|editorial/.test(text)) return 'blog-editorial';
  
  return 'saas-dashboard'; // Default
}

function extractActions(description: string): string[] {
  const actionPatterns = [
    /sign\s*up/gi,
    /login/gi,
    /subscribe/gi,
    /buy|purchase/gi,
    /download/gi,
    /contact/gi,
    /start\s*free/gi,
    /get\s*started/gi,
  ];
  
  const actions: string[] = [];
  for (const pattern of actionPatterns) {
    if (pattern.test(description)) {
      actions.push(pattern.source.replace(/\\s\*/g, ' '));
    }
  }
  
  return actions.length > 0 ? actions : ['Get Started'];
}

function extractDataTypes(description: string): string[] {
  const dataPatterns = [
    /chart|graph/gi,
    /table/gi,
    /metrics|stats/gi,
    /list/gi,
    /form/gi,
    /image|media/gi,
    /video/gi,
  ];
  
  const types: string[] = [];
  for (const pattern of dataPatterns) {
    if (pattern.test(description)) {
      types.push(pattern.source.replace(/\|/g, '/'));
    }
  }
  
  return types;
}

function findApplicablePatterns(observation: OODAObservation): string[] {
  const patterns: string[] = [];
  
  if (observation.contentDensity === 'high') {
    patterns.push('Dense Dashboard Pattern', 'Data Table Pattern', 'Filter Panel Pattern');
  }
  if (observation.contentDensity === 'low') {
    patterns.push('Hero Section Pattern', 'Feature Grid Pattern', 'CTA Block Pattern');
  }
  if (observation.requiresAccessibility) {
    patterns.push('Accessible Form Pattern', 'Skip Link Pattern', 'ARIA Live Region Pattern');
  }
  
  return patterns;
}

function identifyRisks(observation: OODAObservation): DesignRisk[] {
  const risks: DesignRisk[] = [];
  
  if (observation.contentDensity === 'high') {
    risks.push({
      risk: 'Information overload',
      severity: 'medium',
      mitigation: 'Use progressive disclosure and clear visual hierarchy',
    });
  }
  
  if (observation.requiresDarkMode && !observation.requiresAccessibility) {
    risks.push({
      risk: 'Dark mode may reduce contrast',
      severity: 'medium',
      mitigation: 'Test all color combinations in both modes',
    });
  }
  
  if (observation.deviceFocus === 'mobile-first' && observation.contentDensity === 'high') {
    risks.push({
      risk: 'Dense content on mobile screens',
      severity: 'high',
      mitigation: 'Prioritize content and use collapsible sections',
    });
  }
  
  return risks;
}

function calculatePriorities(observation: OODAObservation): OODAOrientation['priorities'] {
  // Start with balanced priorities
  const priorities = { usability: 8, aesthetics: 7, performance: 7, accessibility: 7 };
  
  // Adjust based on context
  if (observation.requiresAccessibility) {
    priorities.accessibility = 10;
    priorities.usability = 9;
  }
  
  if (observation.contentDensity === 'high') {
    priorities.usability = 9;
    priorities.performance = 8;
  }
  
  if (observation.projectType.includes('marketing')) {
    priorities.aesthetics = 9;
  }
  
  return priorities;
}

function findSimilarProjects(projectType: string): string[] {
  const similar: Record<string, string[]> = {
    'saas-dashboard': ['Notion', 'Linear', 'Figma'],
    'marketing-site': ['Stripe', 'Vercel', 'Linear'],
    'e-commerce': ['Shopify', 'Apple Store', 'Nike'],
    'documentation': ['Stripe Docs', 'Tailwind Docs', 'Next.js Docs'],
    'blog-editorial': ['Medium', 'Substack', 'The Verge'],
  };
  
  return similar[projectType] || ['Stripe', 'Linear'];
}

function generateReasoning(
  observation: OODAObservation,
  orientation: OODAOrientation,
  aesthetic: AestheticName
): string[] {
  const reasons: string[] = [];
  
  reasons.push(`Selected "${aesthetic}" aesthetic to match ${observation.projectType} requirements`);
  
  if (observation.requiresAccessibility) {
    reasons.push('Prioritized high contrast and clear focus states for accessibility');
  }
  
  if (observation.contentDensity === 'high') {
    reasons.push('Applied compact spacing for data-dense interface');
  }
  
  if (orientation.priorities.aesthetics >= 9) {
    reasons.push('Emphasized visual polish for marketing/brand impact');
  }
  
  return reasons;
}

function identifyTradeoffs(orientation: OODAOrientation): string[] {
  const tradeoffs: string[] = [];
  
  if (orientation.priorities.aesthetics > 8 && orientation.priorities.performance > 8) {
    tradeoffs.push('Rich visuals may impact initial load time');
  }
  
  if (orientation.priorities.usability > 8 && orientation.priorities.aesthetics > 8) {
    tradeoffs.push('Some aesthetic choices constrained by usability requirements');
  }
  
  return tradeoffs;
}

function calculateConfidence(observation: OODAObservation, orientation: OODAOrientation): number {
  let confidence = 0.7; // Base confidence
  
  // More information = more confidence
  if (observation.primaryActions.length > 0) confidence += 0.1;
  if (observation.dataTypes.length > 0) confidence += 0.1;
  if (orientation.applicablePatterns.length > 2) confidence += 0.05;
  
  // Risks reduce confidence
  confidence -= orientation.designRisks.filter(r => r.severity === 'high').length * 0.1;
  
  return Math.max(0.3, Math.min(1, confidence));
}

function findUncertainties(observation: OODAObservation, context: DesignContext): string[] {
  const uncertainties: string[] = [];
  
  if (!context.prdContent) {
    uncertainties.push('No detailed PRD available - recommendations based on limited context');
  }
  
  if (!context.existingBrandColors) {
    uncertainties.push('No brand colors specified - using aesthetic defaults');
  }
  
  if (observation.technicalLevel === 'intermediate') {
    uncertainties.push('Audience technical level unclear - assuming intermediate');
  }
  
  return uncertainties;
}

function tokensToCSSVars(tokens: DesignTokens): Record<string, string> {
  const vars: Record<string, string> = {};
  
  // Colors
  for (const [key, value] of Object.entries(tokens.colors)) {
    if (typeof value === 'string') {
      vars[`--color-${key}`] = value;
    } else if (value && typeof value === 'object') {
      vars[`--color-${key}`] = value.DEFAULT;
      vars[`--color-${key}-foreground`] = value.foreground;
    }
  }
  
  // Spacing
  for (const [key, value] of Object.entries(tokens.spacing)) {
    vars[`--spacing-${key}`] = value;
  }
  
  // Radius
  for (const [key, value] of Object.entries(tokens.radius)) {
    const name = key === 'DEFAULT' ? 'radius' : `radius-${key}`;
    vars[`--${name}`] = value;
  }
  
  return vars;
}

function tokensToTailwindConfig(tokens: DesignTokens): Record<string, unknown> {
  return {
    theme: {
      extend: {
        colors: tokens.colors,
        spacing: tokens.spacing,
        borderRadius: tokens.radius,
      },
    },
  };
}

function generateComponentStyles(preset: AestheticPreset): Record<string, string> {
  return {
    button: preset.components.buttonStyle,
    card: preset.components.cardStyle,
    input: preset.components.inputStyle,
    nav: preset.components.navStyle,
  };
}

function generateDesignBrief(decision: OODADecision, context: DesignContext): string {
  return `
# Design Brief: ${context.projectName}

## Aesthetic Direction
Using the **${decision.recommendedAesthetic}** aesthetic with **${decision.recommendedLayout}** layout pattern.

## Typography
Recommended font pairing: **${decision.recommendedTypography}**

## Key Design Decisions
${decision.reasoning.map(r => `- ${r}`).join('\n')}

## Tradeoffs Considered
${decision.tradeoffs.map(t => `- ${t}`).join('\n')}

## Confidence: ${Math.round(decision.confidence * 100)}%
${decision.uncertainties.length > 0 ? `
### Uncertainties
${decision.uncertainties.map(u => `- ${u}`).join('\n')}
` : ''}
`.trim();
}

function generateStyleguideNotes(decision: OODADecision, preset: AestheticPreset): string[] {
  return [
    `Primary aesthetic: ${preset.displayName}`,
    `Typography style: ${preset.typography.headingStyle} headings, ${preset.typography.letterSpacing} letter-spacing`,
    `Animation approach: ${preset.effects.animations}`,
    `Border radius: ${preset.layout.borderRadius}`,
    `Spacing density: ${preset.layout.density}`,
  ];
}

function generateNextSteps(decision: OODADecision, context: DesignContext): string[] {
  const steps: string[] = [];
  
  steps.push(`1. Apply ${decision.recommendedAesthetic} design tokens to project`);
  steps.push(`2. Implement ${decision.recommendedLayout} layout pattern`);
  steps.push(`3. Configure typography with ${decision.recommendedTypography} font pairing`);
  
  if (decision.uncertainties.length > 0) {
    steps.push('4. Review uncertainties and gather additional context if needed');
  }
  
  steps.push('5. Run design review checklist before shipping');
  
  return steps;
}
