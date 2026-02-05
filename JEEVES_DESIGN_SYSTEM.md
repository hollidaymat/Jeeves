# Jeeves Design Capabilities

## The Problem

Most AI-generated UI is:
- Generic (looks like every other AI output)
- Inconsistent (different patterns on each page)
- Safe but boring (gray buttons, white backgrounds)
- Inaccessible (contrast failures, no focus states)

Jeeves should produce designs that look **intentional**.

---

## Core Principle

**Design is constrained creativity.** More constraints = more cohesion.

Jeeves doesn't freestyle. He works within systems:
- Defined color palette (3-5 colors, no more)
- Type scale (predetermined sizes)
- Spacing scale (4px or 8px base)
- Component library (shadcn/ui as foundation)
- Layout patterns (flexbox-first)

---

## 1. Design Token System

Every project gets tokens. Jeeves references these, never raw values.

```javascript
// design-tokens.js
const tokens = {
  colors: {
    // Semantic - what it means
    background: 'var(--background)',
    foreground: 'var(--foreground)',
    primary: 'var(--primary)',
    accent: 'var(--accent)',
    muted: 'var(--muted)',
    destructive: 'var(--destructive)',
    
    // Never use raw hex in components
  },
  
  typography: {
    // Scale - each step is purposeful
    xs: '0.75rem',    // 12px - captions, labels
    sm: '0.875rem',   // 14px - secondary text
    base: '1rem',     // 16px - body
    lg: '1.125rem',   // 18px - lead text
    xl: '1.25rem',    // 20px - h4
    '2xl': '1.5rem',  // 24px - h3
    '3xl': '1.875rem',// 30px - h2
    '4xl': '2.25rem', // 36px - h1
    '5xl': '3rem',    // 48px - display
  },
  
  spacing: {
    // 4px base, consistent rhythm
    0: '0',
    1: '0.25rem',  // 4px
    2: '0.5rem',   // 8px
    3: '0.75rem',  // 12px
    4: '1rem',     // 16px
    5: '1.25rem',  // 20px
    6: '1.5rem',   // 24px
    8: '2rem',     // 32px
    10: '2.5rem', // 40px
    12: '3rem',   // 48px
    16: '4rem',   // 64px
  },
  
  radius: {
    none: '0',
    sm: '0.25rem',
    md: '0.375rem',
    lg: '0.5rem',
    xl: '0.75rem',
    full: '9999px',
  },
  
  shadows: {
    sm: '0 1px 2px 0 rgb(0 0 0 / 0.05)',
    md: '0 4px 6px -1px rgb(0 0 0 / 0.1)',
    lg: '0 10px 15px -3px rgb(0 0 0 / 0.1)',
    glow: '0 0 20px var(--accent)',  // For cyberpunk aesthetic
  }
};
```

**Rule:** If Jeeves writes `#3b82f6` instead of `var(--primary)`, it's wrong.

---

## 2. Color Palette Generation

Given a brand color or aesthetic, generate a complete palette.

```javascript
// palette-generator.js

function generatePalette(baseColor, mode = 'dark', aesthetic = 'cyberpunk') {
  const palettes = {
    cyberpunk: {
      dark: {
        background: '#0c0c14',        // Deep navy-black
        foreground: '#e4e4e7',        // Off-white
        primary: baseColor,            // User's brand color
        accent: '#22d3ee',            // Cyan
        secondary: '#a855f7',         // Purple
        muted: '#27272a',             // Zinc-800
        mutedForeground: '#a1a1aa',   // Zinc-400
        destructive: '#ef4444',       // Red
        border: '#3f3f46',            // Zinc-700
        glow: baseColor + '40',       // Brand with alpha for glow
      }
    },
    
    minimal: {
      dark: {
        background: '#09090b',
        foreground: '#fafafa',
        primary: baseColor,
        accent: baseColor,
        muted: '#18181b',
        mutedForeground: '#71717a',
        border: '#27272a',
      },
      light: {
        background: '#ffffff',
        foreground: '#09090b',
        primary: baseColor,
        accent: baseColor,
        muted: '#f4f4f5',
        mutedForeground: '#71717a',
        border: '#e4e4e7',
      }
    },
    
    warm: {
      dark: {
        background: '#1c1917',        // Stone-900
        foreground: '#fafaf9',
        primary: baseColor,
        accent: '#f97316',            // Orange
        muted: '#292524',
        border: '#44403c',
      }
    }
  };
  
  return palettes[aesthetic]?.[mode] || palettes.minimal[mode];
}
```

**Rule:** Max 5 colors. Every color has a purpose. No decoration colors.

---

## 3. Typography Pairing

Pre-defined font combinations that work.

```javascript
const fontPairings = {
  // Modern tech
  'geist': {
    heading: 'Geist',
    body: 'Geist',
    mono: 'Geist Mono',
    style: 'Clean, technical, modern'
  },
  
  // Editorial
  'serif-sans': {
    heading: 'Playfair Display',
    body: 'Inter',
    mono: 'JetBrains Mono',
    style: 'Elegant, editorial, high-end'
  },
  
  // Friendly
  'rounded': {
    heading: 'Nunito',
    body: 'Inter',
    mono: 'Fira Code',
    style: 'Approachable, friendly, soft'
  },
  
  // Brutalist
  'mono-heavy': {
    heading: 'Space Grotesk',
    body: 'Space Grotesk',
    mono: 'Space Mono',
    style: 'Bold, technical, brutalist'
  },
  
  // Cyberpunk (for Jeeves dashboard)
  'cyber': {
    heading: 'Orbitron',
    body: 'Rajdhani',
    mono: 'Share Tech Mono',
    style: 'Futuristic, sci-fi, technical'
  }
};
```

**Rule:** Max 2 font families per project. Weights create hierarchy, not new fonts.

---

## 4. Layout Patterns Library

Pre-built patterns Jeeves can apply:

```javascript
const layoutPatterns = {
  // Page layouts
  'centered-content': 'max-w-4xl mx-auto px-4',
  'full-bleed': 'w-full',
  'sidebar-main': 'grid grid-cols-[280px_1fr]',
  'holy-grail': 'grid grid-cols-[200px_1fr_200px]',
  
  // Section layouts
  'section-padded': 'py-16 md:py-24',
  'section-tight': 'py-8 md:py-12',
  
  // Card layouts
  'card-grid-2': 'grid grid-cols-1 md:grid-cols-2 gap-6',
  'card-grid-3': 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6',
  'card-grid-4': 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4',
  
  // Bento layouts
  'bento-featured': 'grid grid-cols-2 md:grid-cols-4 gap-4 [&>*:first-child]:col-span-2 [&>*:first-child]:row-span-2',
  
  // List layouts
  'stack': 'flex flex-col gap-4',
  'stack-tight': 'flex flex-col gap-2',
  'inline': 'flex flex-wrap gap-2',
  
  // Hero layouts
  'hero-centered': 'flex flex-col items-center text-center gap-6',
  'hero-split': 'grid md:grid-cols-2 gap-12 items-center',
};
```

**Rule:** Flexbox first. Grid for 2D layouts. Never floats. Never absolute unless truly necessary.

---

## 5. Component Composition Patterns

How to build complex UI from primitives:

```javascript
const componentPatterns = {
  // Stats display
  'stat-card': {
    structure: 'Card > CardContent > [icon, value, label, trend]',
    example: `
      <Card>
        <CardContent className="p-6">
          <div className="flex items-center gap-4">
            <div className="p-3 rounded-lg bg-primary/10">
              <Icon className="h-6 w-6 text-primary" />
            </div>
            <div>
              <p className="text-2xl font-bold">{value}</p>
              <p className="text-sm text-muted-foreground">{label}</p>
            </div>
          </div>
        </CardContent>
      </Card>
    `
  },
  
  // Data table with actions
  'data-table-row': {
    structure: 'tr > [checkbox, avatar+name, metadata, status-badge, actions-dropdown]',
    pattern: 'First column: selection. Second: primary identifier. Middle: metadata. Last: actions.'
  },
  
  // Form sections
  'form-section': {
    structure: 'div > [heading, description, fields]',
    pattern: 'Group related fields. Heading explains what. Description explains why.'
  },
  
  // Empty states
  'empty-state': {
    structure: 'div.centered > [icon, heading, description, action]',
    pattern: 'Icon sets mood. Heading states fact. Description suggests action. Button enables it.'
  },
  
  // Feature cards
  'feature-card': {
    structure: 'Card > [icon, heading, description]',
    pattern: 'Icon is decorative, not functional. Keep descriptions under 2 lines.'
  }
};
```

---

## 6. Visual Hierarchy Rules

Encoded rules for what stands out:

```javascript
const hierarchyRules = {
  // Size creates hierarchy
  sizing: {
    'primary-action': 'text-base px-6 py-3',      // Largest
    'secondary-action': 'text-sm px-4 py-2',      // Medium
    'tertiary-action': 'text-sm px-3 py-1.5',     // Smallest
  },
  
  // Color creates hierarchy
  emphasis: {
    'highest': 'text-foreground',                 // Full contrast
    'high': 'text-foreground/90',                 // Slightly muted
    'medium': 'text-muted-foreground',            // Secondary info
    'low': 'text-muted-foreground/70',            // Tertiary info
  },
  
  // Weight creates hierarchy
  weights: {
    'display': 'font-bold',                       // Page titles
    'heading': 'font-semibold',                   // Section titles
    'subheading': 'font-medium',                  // Card titles
    'body': 'font-normal',                        // Content
    'caption': 'font-normal text-sm',             // Metadata
  },
  
  // Space creates hierarchy
  spacing: {
    'between-sections': 'gap-16',                 // Major divisions
    'between-groups': 'gap-8',                    // Related content
    'between-items': 'gap-4',                     // List items
    'between-elements': 'gap-2',                  // Tight grouping
  }
};
```

**Rule:** Only one thing can be loudest. Everything else supports it.

---

## 7. Animation Principles

Purposeful motion, not decoration:

```javascript
const animations = {
  // Micro-interactions
  'button-press': 'active:scale-95 transition-transform',
  'hover-lift': 'hover:-translate-y-1 hover:shadow-lg transition-all',
  'hover-glow': 'hover:shadow-[0_0_20px_var(--accent)] transition-shadow',
  
  // State changes
  'fade-in': 'animate-in fade-in duration-200',
  'slide-up': 'animate-in slide-in-from-bottom-4 duration-300',
  'scale-in': 'animate-in zoom-in-95 duration-200',
  
  // Loading states
  'pulse': 'animate-pulse',
  'spin': 'animate-spin',
  'skeleton': 'bg-muted animate-pulse rounded',
  
  // Cyberpunk specific
  'glow-pulse': 'animate-[glow-pulse_2s_ease-in-out_infinite]',
  'scan-line': 'animate-[scan_8s_linear_infinite]',
};

// CSS keyframes for cyberpunk
const keyframes = `
  @keyframes glow-pulse {
    0%, 100% { box-shadow: 0 0 5px var(--accent); }
    50% { box-shadow: 0 0 20px var(--accent), 0 0 30px var(--accent); }
  }
  
  @keyframes scan {
    0% { background-position: 0% 0%; }
    100% { background-position: 0% 100%; }
  }
`;
```

**Rule:** Animation should explain, not distract. If removing it loses meaning, keep it. Otherwise cut it.

---

## 8. Accessibility Baseline

Non-negotiable requirements:

```javascript
const a11yRules = {
  // Contrast minimums
  contrast: {
    'normal-text': 4.5,      // WCAG AA
    'large-text': 3.0,       // 18px+ or 14px bold
    'ui-components': 3.0,    // Buttons, inputs
  },
  
  // Focus states
  focus: {
    required: true,
    style: 'focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2',
    neverRemove: true,       // Never outline-none without replacement
  },
  
  // Touch targets
  touchTargets: {
    minimum: '44px',         // Apple HIG
    recommended: '48px',     // Material
  },
  
  // Screen reader
  srOnly: {
    pattern: 'sr-only',
    useFor: ['icon-only buttons', 'decorative content with meaning'],
  },
  
  // Required attributes
  required: {
    images: 'alt',
    buttons: 'aria-label (if icon-only)',
    inputs: 'label or aria-label',
    modals: 'aria-labelledby, aria-describedby',
  }
};
```

**Rule:** Accessibility is not optional. Jeeves checks every component.

---

## 9. Design Review Checklist

Before delivering any UI, Jeeves validates:

```javascript
const designReview = {
  consistency: [
    'All colors from token palette?',
    'All spacing from scale?',
    'All typography from scale?',
    'Component patterns followed?',
  ],
  
  hierarchy: [
    'Clear primary action per view?',
    'Visual weight matches importance?',
    'Reading flow is logical?',
  ],
  
  responsiveness: [
    'Works at 320px width?',
    'Works at 1920px width?',
    'Touch targets adequate on mobile?',
    'Text readable at all sizes?',
  ],
  
  accessibility: [
    'Contrast ratios pass?',
    'Focus states visible?',
    'Alt text on images?',
    'Labels on inputs?',
  ],
  
  polish: [
    'Consistent border radius?',
    'Consistent shadow depth?',
    'Hover states on interactive elements?',
    'Loading states defined?',
    'Empty states defined?',
    'Error states defined?',
  ]
};
```

---

## 10. Design Aesthetic Presets

Quick-apply aesthetics for different project types:

```javascript
const aestheticPresets = {
  'cyberpunk-operator': {
    description: 'Sci-fi command center. Jeeves dashboard style.',
    palette: {
      background: '#0c0c14',
      foreground: '#e4e4e7',
      primary: '#22d3ee',
      secondary: '#a855f7',
      accent: '#22d3ee',
    },
    fonts: ['Orbitron', 'Rajdhani', 'Share Tech Mono'],
    effects: ['glow', 'scan-lines', 'gradient-borders'],
    radius: 'sm',
    density: 'compact',
  },
  
  'minimal-saas': {
    description: 'Clean, professional SaaS. Vercel/Linear style.',
    palette: 'neutral with single accent',
    fonts: ['Inter', 'Inter', 'JetBrains Mono'],
    effects: ['subtle-shadows', 'smooth-transitions'],
    radius: 'md',
    density: 'comfortable',
  },
  
  'warm-friendly': {
    description: 'Approachable, human. Notion/Slack style.',
    palette: 'warm neutrals with playful accent',
    fonts: ['Nunito', 'Inter', 'Fira Code'],
    effects: ['rounded-corners', 'soft-shadows'],
    radius: 'lg',
    density: 'spacious',
  },
  
  'editorial': {
    description: 'Content-focused. Medium/Substack style.',
    palette: 'high-contrast black/white, minimal accent',
    fonts: ['Playfair Display', 'Source Serif', 'Inconsolata'],
    effects: ['minimal', 'typography-focused'],
    radius: 'none',
    density: 'readable',
  },
  
  'dashboard-dense': {
    description: 'Data-heavy monitoring. Grafana/Datadog style.',
    palette: 'dark with status colors',
    fonts: ['Inter', 'Inter', 'JetBrains Mono'],
    effects: ['compact-cards', 'status-indicators'],
    radius: 'sm',
    density: 'compact',
  }
};
```

---

## 11. Implementation: Design-Aware PRD Processing

When Jeeves receives a PRD, extract design requirements:

```javascript
async function extractDesignRequirements(prd) {
  // Detect explicit mentions
  const explicit = {
    colors: extractMentioned(prd, ['color', 'palette', 'theme']),
    aesthetic: extractMentioned(prd, ['style', 'look', 'feel', 'vibe']),
    reference: extractUrls(prd),  // Screenshots, inspiration links
  };
  
  // Infer from project type
  const inferred = {
    dashboard: prd.includes('dashboard') ? 'dashboard-dense' : null,
    saas: prd.includes('saas') || prd.includes('pricing') ? 'minimal-saas' : null,
    blog: prd.includes('blog') || prd.includes('content') ? 'editorial' : null,
  };
  
  // Generate or select palette
  const aesthetic = explicit.aesthetic || Object.values(inferred).find(Boolean) || 'minimal-saas';
  
  return {
    aesthetic,
    preset: aestheticPresets[aesthetic],
    customizations: explicit,
    tokens: generateTokens(aesthetic, explicit),
  };
}
```

---

## 12. Integration with Cognitive Architecture

Design decisions go through the same OODA loop:

```javascript
// During Orient phase
async function orientDesign(task, context) {
  return {
    // What design system exists?
    existingTokens: await findTokens(context.project),
    existingComponents: await findComponents(context.project),
    
    // What's the target aesthetic?
    aesthetic: context.designRequirements?.aesthetic || inferAesthetic(task),
    
    // What patterns apply?
    applicablePatterns: matchPatterns(task, layoutPatterns, componentPatterns),
    
    // What constraints exist?
    constraints: {
      mustMatch: context.existingTokens ? 'existing system' : null,
      accessibility: 'WCAG AA minimum',
      responsive: 'mobile-first',
    }
  };
}

// During Act phase - validate before write
async function validateDesign(component) {
  const issues = [];
  
  // Check token usage
  if (hasRawColors(component)) {
    issues.push('Uses raw color values instead of tokens');
  }
  
  // Check accessibility
  const a11y = await auditAccessibility(component);
  if (a11y.violations.length > 0) {
    issues.push(...a11y.violations);
  }
  
  // Check consistency
  if (!followsPatterns(component)) {
    issues.push('Deviates from established patterns');
  }
  
  return {
    valid: issues.length === 0,
    issues,
    autoFix: generateFixes(issues),
  };
}
```

---

## Summary

Jeeves produces good design by:

1. **Working within constraints** - Tokens, not raw values
2. **Following patterns** - Established layouts, not freestyle
3. **Validating output** - Accessibility, consistency checks
4. **Learning preferences** - Your aesthetic choices persist
5. **Asking when uncertain** - "Should this match the existing dashboard or be distinct?"

The goal: designs that look **intentional**, not generated.
