/**
 * PRD Design Requirements Extractor
 * 
 * Extract design requirements from Product Requirements Documents.
 * 
 * Rule: Design decisions should be traceable to product requirements.
 */

import { generateText } from '../llm/traced-llm.js';
import { anthropic } from '@ai-sdk/anthropic';
import type { AestheticName } from './aesthetic-presets.js';
import type { LayoutPatternName } from './layout-patterns.js';
import type { FontPairingName } from './typography.js';

// ==========================================
// TYPES
// ==========================================

export interface PRDAnalysis {
  // Core product information
  productName: string;
  productType: ProductType;
  targetAudience: AudienceProfile;
  
  // Design requirements
  designRequirements: DesignRequirement[];
  
  // Extracted preferences
  aestheticRecommendation: AestheticName;
  layoutRecommendations: LayoutPatternName[];
  fontRecommendation: FontPairingName;
  colorRequirements: ColorRequirement;
  
  // Feature-specific design needs
  pageDesigns: PageDesign[];
  componentNeeds: ComponentNeed[];
  
  // Constraints
  constraints: DesignConstraint[];
  
  // Summary
  designBrief: string;
}

export type ProductType =
  | 'saas-dashboard'
  | 'marketing-site'
  | 'e-commerce'
  | 'documentation'
  | 'blog-editorial'
  | 'mobile-app'
  | 'portfolio'
  | 'internal-tool'
  | 'api-platform'
  | 'social-platform';

export interface AudienceProfile {
  primary: string;
  secondary?: string;
  technicalLevel: 'novice' | 'intermediate' | 'expert';
  ageRange?: string;
  devicePreference: 'mobile-first' | 'desktop-first' | 'balanced';
}

export interface DesignRequirement {
  id: string;
  source: string; // Quote from PRD
  type: RequirementType;
  priority: 'must-have' | 'should-have' | 'nice-to-have';
  designImplication: string;
}

export type RequirementType =
  | 'branding'
  | 'accessibility'
  | 'responsiveness'
  | 'performance'
  | 'interaction'
  | 'content'
  | 'navigation'
  | 'data-visualization'
  | 'user-flow'
  | 'tone';

export interface ColorRequirement {
  primaryBrandColor?: string;
  colorMood: 'professional' | 'playful' | 'serious' | 'energetic' | 'calm' | 'bold';
  darkModeRequired: boolean;
  highContrastRequired: boolean;
  existingPalette?: string[];
}

export interface PageDesign {
  pageName: string;
  pageType: string;
  purpose: string;
  requiredSections: string[];
  keyActions: string[];
  dataToDisplay: string[];
  layoutSuggestion: LayoutPatternName;
}

export interface ComponentNeed {
  componentType: string;
  usageContext: string;
  variants?: string[];
  interactions?: string[];
  dataRequirements?: string[];
}

export interface DesignConstraint {
  type: 'technical' | 'brand' | 'accessibility' | 'timeline' | 'budget';
  description: string;
  impact: string;
}

// ==========================================
// PRD PATTERNS
// ==========================================

const productTypePatterns: Record<string, ProductType> = {
  'dashboard|admin|analytics|metrics': 'saas-dashboard',
  'landing|marketing|homepage|conversion': 'marketing-site',
  'shop|store|cart|checkout|product|ecommerce': 'e-commerce',
  'docs|documentation|api|guide|reference': 'documentation',
  'blog|article|editorial|magazine|content': 'blog-editorial',
  'app|mobile|ios|android|native': 'mobile-app',
  'portfolio|agency|creative|showcase': 'portfolio',
  'internal|admin|backoffice|operations': 'internal-tool',
  'api|developer|platform|sdk|integration': 'api-platform',
  'social|community|forum|messaging': 'social-platform',
};

const colorMoodPatterns: Record<string, ColorRequirement['colorMood']> = {
  'enterprise|corporate|business|professional|trust': 'professional',
  'fun|friendly|casual|playful|young': 'playful',
  'serious|formal|legal|finance|medical': 'serious',
  'dynamic|energetic|exciting|vibrant|action': 'energetic',
  'calm|peaceful|wellness|spa|mindful': 'calm',
  'bold|striking|impact|attention|strong': 'bold',
};

// ==========================================
// EXTRACTION FUNCTIONS
// ==========================================

/**
 * Quick heuristic extraction from PRD text
 */
export function quickExtract(prdText: string): Partial<PRDAnalysis> {
  const text = prdText.toLowerCase();
  
  // Detect product type
  let productType: ProductType = 'saas-dashboard';
  for (const [pattern, type] of Object.entries(productTypePatterns)) {
    if (new RegExp(pattern).test(text)) {
      productType = type;
      break;
    }
  }
  
  // Detect color mood
  let colorMood: ColorRequirement['colorMood'] = 'professional';
  for (const [pattern, mood] of Object.entries(colorMoodPatterns)) {
    if (new RegExp(pattern).test(text)) {
      colorMood = mood;
      break;
    }
  }
  
  // Detect dark mode requirement
  const darkModeRequired = /dark\s*mode|dark\s*theme|night\s*mode/.test(text);
  
  // Detect accessibility requirements
  const highContrastRequired = /wcag|accessibility|a11y|contrast|screen\s*reader/.test(text);
  
  // Detect audience technical level
  let technicalLevel: AudienceProfile['technicalLevel'] = 'intermediate';
  if (/developer|engineer|technical|api|sdk/.test(text)) {
    technicalLevel = 'expert';
  } else if (/consumer|everyone|simple|easy/.test(text)) {
    technicalLevel = 'novice';
  }
  
  // Detect device preference
  let devicePreference: AudienceProfile['devicePreference'] = 'balanced';
  if (/mobile.?first|app|ios|android|phone/.test(text)) {
    devicePreference = 'mobile-first';
  } else if (/desktop|enterprise|dashboard|admin/.test(text)) {
    devicePreference = 'desktop-first';
  }
  
  // Map to aesthetic
  const aestheticMap: Record<ProductType, AestheticName> = {
    'saas-dashboard': 'minimal-saas',
    'marketing-site': 'marketing-bold',
    'e-commerce': 'ecommerce',
    'documentation': 'documentation',
    'blog-editorial': 'warm-editorial',
    'mobile-app': 'minimal-saas',
    'portfolio': 'creative-agency',
    'internal-tool': 'dashboard-pro',
    'api-platform': 'documentation',
    'social-platform': 'minimal-saas',
  };
  
  return {
    productType,
    targetAudience: {
      primary: 'To be determined',
      technicalLevel,
      devicePreference,
    },
    aestheticRecommendation: aestheticMap[productType],
    colorRequirements: {
      colorMood,
      darkModeRequired,
      highContrastRequired,
    },
    constraints: highContrastRequired ? [{
      type: 'accessibility',
      description: 'WCAG compliance required',
      impact: 'All color choices must meet contrast requirements',
    }] : [],
  };
}

/**
 * Deep extraction using LLM
 */
export async function deepExtract(prdText: string): Promise<PRDAnalysis> {
  const prompt = `Analyze this Product Requirements Document and extract design requirements.

PRD:
${prdText}

Extract the following in JSON format:
{
  "productName": "name of the product",
  "productType": "one of: saas-dashboard, marketing-site, e-commerce, documentation, blog-editorial, mobile-app, portfolio, internal-tool, api-platform, social-platform",
  "targetAudience": {
    "primary": "primary user description",
    "secondary": "secondary user if any",
    "technicalLevel": "novice|intermediate|expert",
    "ageRange": "age range if mentioned",
    "devicePreference": "mobile-first|desktop-first|balanced"
  },
  "designRequirements": [
    {
      "id": "req-1",
      "source": "exact quote from PRD",
      "type": "branding|accessibility|responsiveness|performance|interaction|content|navigation|data-visualization|user-flow|tone",
      "priority": "must-have|should-have|nice-to-have",
      "designImplication": "what this means for design"
    }
  ],
  "colorRequirements": {
    "primaryBrandColor": "hex if specified",
    "colorMood": "professional|playful|serious|energetic|calm|bold",
    "darkModeRequired": true/false,
    "highContrastRequired": true/false
  },
  "pageDesigns": [
    {
      "pageName": "page name",
      "pageType": "type of page",
      "purpose": "what the page does",
      "requiredSections": ["section names"],
      "keyActions": ["primary actions"],
      "dataToDisplay": ["data elements"],
      "layoutSuggestion": "dashboard|marketing|content|form|list|grid|split|centered|sidebar"
    }
  ],
  "componentNeeds": [
    {
      "componentType": "type of component needed",
      "usageContext": "where/how it's used",
      "variants": ["variant names if any"],
      "interactions": ["interaction types"]
    }
  ],
  "constraints": [
    {
      "type": "technical|brand|accessibility|timeline|budget",
      "description": "what the constraint is",
      "impact": "how it affects design"
    }
  ],
  "designBrief": "2-3 sentence summary of overall design direction"
}

Return only valid JSON.`;

  try {
    const result = await generateText({
      model: anthropic('claude-sonnet-4-20250514'),
      prompt,
      temperature: 0.3,
    });
    
    const parsed = JSON.parse(result.text);
    
    // Add recommendations based on extracted data
    const aestheticRecommendation = mapToAesthetic(parsed.productType, parsed.colorRequirements);
    const layoutRecommendations = extractLayoutRecommendations(parsed.pageDesigns || []);
    const fontRecommendation = recommendFont(parsed.targetAudience, parsed.colorRequirements);
    
    return {
      ...parsed,
      aestheticRecommendation,
      layoutRecommendations,
      fontRecommendation,
    };
  } catch (error) {
    // Fall back to quick extract
    const quick = quickExtract(prdText);
    return {
      productName: 'Unknown',
      productType: quick.productType || 'saas-dashboard',
      targetAudience: quick.targetAudience || {
        primary: 'General users',
        technicalLevel: 'intermediate',
        devicePreference: 'balanced',
      },
      designRequirements: [],
      aestheticRecommendation: quick.aestheticRecommendation || 'minimal-saas',
      layoutRecommendations: ['dashboard'],
      fontRecommendation: 'inter',
      colorRequirements: quick.colorRequirements || {
        colorMood: 'professional',
        darkModeRequired: false,
        highContrastRequired: false,
      },
      pageDesigns: [],
      componentNeeds: [],
      constraints: quick.constraints || [],
      designBrief: 'Design requirements extraction failed. Using defaults.',
    };
  }
}

/**
 * Map product type to aesthetic
 */
function mapToAesthetic(
  productType: ProductType,
  colorRequirements: ColorRequirement
): AestheticName {
  // Special case for dark mode tech products
  if (colorRequirements.darkModeRequired && 
      (productType === 'saas-dashboard' || productType === 'api-platform')) {
    return 'dashboard-pro';
  }
  
  const map: Record<ProductType, AestheticName> = {
    'saas-dashboard': 'minimal-saas',
    'marketing-site': 'marketing-bold',
    'e-commerce': 'ecommerce',
    'documentation': 'documentation',
    'blog-editorial': 'warm-editorial',
    'mobile-app': 'minimal-saas',
    'portfolio': 'creative-agency',
    'internal-tool': 'dashboard-pro',
    'api-platform': 'documentation',
    'social-platform': 'minimal-saas',
  };
  
  return map[productType] || 'minimal-saas';
}

/**
 * Extract layout recommendations from page designs
 */
function extractLayoutRecommendations(pageDesigns: PageDesign[]): LayoutPatternName[] {
  const layouts = new Set<LayoutPatternName>();
  
  for (const page of pageDesigns) {
    if (page.layoutSuggestion) {
      layouts.add(page.layoutSuggestion);
    }
  }
  
  if (layouts.size === 0) {
    layouts.add('marketing');
    layouts.add('dashboard');
  }
  
  return Array.from(layouts);
}

/**
 * Recommend font pairing based on audience and mood
 */
function recommendFont(
  audience: AudienceProfile,
  colorRequirements: ColorRequirement
): FontPairingName {
  // Developer/technical audience
  if (audience.technicalLevel === 'expert') {
    return 'mono-heavy';
  }
  
  // Mood-based
  switch (colorRequirements.colorMood) {
    case 'playful':
      return 'rounded';
    case 'serious':
    case 'professional':
      return 'inter';
    case 'calm':
      return 'serif-sans';
    case 'bold':
    case 'energetic':
      return 'geist';
    default:
      return 'inter';
  }
}

// ==========================================
// REPORT GENERATION
// ==========================================

/**
 * Generate design brief from PRD analysis
 */
export function generateDesignBrief(analysis: PRDAnalysis): string {
  const lines: string[] = [
    `# Design Brief: ${analysis.productName}`,
    '',
    '## Product Overview',
    '',
    `**Type:** ${analysis.productType}`,
    `**Target Audience:** ${analysis.targetAudience.primary}`,
    `**Technical Level:** ${analysis.targetAudience.technicalLevel}`,
    `**Device Focus:** ${analysis.targetAudience.devicePreference}`,
    '',
    '## Design Direction',
    '',
    `**Recommended Aesthetic:** ${analysis.aestheticRecommendation}`,
    `**Font Pairing:** ${analysis.fontRecommendation}`,
    `**Color Mood:** ${analysis.colorRequirements.colorMood}`,
    `**Dark Mode:** ${analysis.colorRequirements.darkModeRequired ? 'Required' : 'Not required'}`,
    '',
  ];
  
  if (analysis.designRequirements.length > 0) {
    lines.push('## Key Design Requirements');
    lines.push('');
    for (const req of analysis.designRequirements.slice(0, 5)) {
      lines.push(`- **${req.priority}**: ${req.designImplication}`);
    }
    lines.push('');
  }
  
  if (analysis.pageDesigns.length > 0) {
    lines.push('## Page Designs Needed');
    lines.push('');
    for (const page of analysis.pageDesigns) {
      lines.push(`### ${page.pageName}`);
      lines.push(`- **Purpose:** ${page.purpose}`);
      lines.push(`- **Layout:** ${page.layoutSuggestion}`);
      lines.push(`- **Key Actions:** ${page.keyActions.join(', ')}`);
      lines.push('');
    }
  }
  
  if (analysis.constraints.length > 0) {
    lines.push('## Design Constraints');
    lines.push('');
    for (const constraint of analysis.constraints) {
      lines.push(`- **${constraint.type}**: ${constraint.description}`);
    }
    lines.push('');
  }
  
  lines.push('## Summary');
  lines.push('');
  lines.push(analysis.designBrief);
  
  return lines.join('\n');
}

/**
 * Extract component list for design system
 */
export function extractComponentList(analysis: PRDAnalysis): {
  core: string[];
  specific: string[];
  priority: string[];
} {
  const coreComponents = [
    'Button',
    'Input',
    'Card',
    'Navigation',
    'Typography',
  ];
  
  const specificComponents = analysis.componentNeeds.map(c => c.componentType);
  
  // Prioritize based on requirements
  const priority = analysis.designRequirements
    .filter(r => r.priority === 'must-have')
    .flatMap(r => {
      if (r.type === 'data-visualization') return ['Chart', 'Table', 'Stats'];
      if (r.type === 'navigation') return ['Navigation', 'Breadcrumb', 'Tabs'];
      if (r.type === 'interaction') return ['Modal', 'Toast', 'Dropdown'];
      return [];
    });
  
  return {
    core: coreComponents,
    specific: [...new Set(specificComponents)],
    priority: [...new Set(priority)],
  };
}
