/**
 * Animation System
 * 
 * Animation principles and effects library, including cyberpunk-style effects.
 * 
 * Rule: Animations serve a purpose - feedback, guidance, or delight. Never purely decorative blocking animations.
 */

// ==========================================
// TYPES
// ==========================================

export type AnimationPurpose = 'feedback' | 'guidance' | 'delight' | 'state-change';
export type AnimationTiming = 'instant' | 'fast' | 'normal' | 'slow' | 'deliberate';
export type EasingType = 'linear' | 'ease' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'spring' | 'bounce';

export interface AnimationConfig {
  duration: number; // in ms
  easing: string;
  delay?: number;
  iterations?: number;
  fill?: 'none' | 'forwards' | 'backwards' | 'both';
}

export interface AnimationPreset {
  name: string;
  purpose: AnimationPurpose;
  description: string;
  config: AnimationConfig;
  keyframes: string;
  cssClass?: string;
  tailwindClass?: string;
}

export interface TransitionPreset {
  name: string;
  properties: string[];
  duration: number;
  easing: string;
  cssValue: string;
  tailwindClass: string;
}

export interface CyberpunkEffect {
  name: string;
  description: string;
  css: string;
  keyframes?: string;
  customProperties?: Record<string, string>;
}

// ==========================================
// TIMING CONSTANTS
// ==========================================

export const timings = {
  instant: 50,    // Micro-interactions, tooltips
  fast: 150,      // Button feedback, hovers
  normal: 300,    // Most transitions
  slow: 500,      // Complex state changes
  deliberate: 800, // Dramatic reveals
} as const;

export const easings = {
  linear: 'linear',
  ease: 'ease',
  easeIn: 'ease-in',
  easeOut: 'ease-out',
  easeInOut: 'ease-in-out',
  // Custom cubic-bezier curves
  spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
  bounce: 'cubic-bezier(0.68, -0.55, 0.265, 1.55)',
  snappy: 'cubic-bezier(0.4, 0, 0.2, 1)',
  smooth: 'cubic-bezier(0.25, 0.1, 0.25, 1)',
  // Cyberpunk-specific
  glitch: 'steps(10, end)',
  matrix: 'cubic-bezier(0.7, 0, 0.3, 1)',
} as const;

// ==========================================
// TRANSITION PRESETS
// ==========================================

export const transitionPresets: Record<string, TransitionPreset> = {
  // Basic transitions
  colors: {
    name: 'Colors',
    properties: ['color', 'background-color', 'border-color'],
    duration: timings.fast,
    easing: easings.ease,
    cssValue: 'color 150ms ease, background-color 150ms ease, border-color 150ms ease',
    tailwindClass: 'transition-colors duration-150',
  },
  opacity: {
    name: 'Opacity',
    properties: ['opacity'],
    duration: timings.normal,
    easing: easings.ease,
    cssValue: 'opacity 300ms ease',
    tailwindClass: 'transition-opacity duration-300',
  },
  transform: {
    name: 'Transform',
    properties: ['transform'],
    duration: timings.normal,
    easing: easings.snappy,
    cssValue: 'transform 300ms cubic-bezier(0.4, 0, 0.2, 1)',
    tailwindClass: 'transition-transform duration-300',
  },
  all: {
    name: 'All',
    properties: ['all'],
    duration: timings.normal,
    easing: easings.ease,
    cssValue: 'all 300ms ease',
    tailwindClass: 'transition-all duration-300',
  },
  // Interactive
  button: {
    name: 'Button',
    properties: ['transform', 'box-shadow', 'background-color'],
    duration: timings.fast,
    easing: easings.snappy,
    cssValue: 'transform 150ms cubic-bezier(0.4, 0, 0.2, 1), box-shadow 150ms ease, background-color 150ms ease',
    tailwindClass: 'transition-all duration-150 ease-out',
  },
  card: {
    name: 'Card',
    properties: ['transform', 'box-shadow'],
    duration: timings.normal,
    easing: easings.smooth,
    cssValue: 'transform 300ms cubic-bezier(0.25, 0.1, 0.25, 1), box-shadow 300ms ease',
    tailwindClass: 'transition-all duration-300',
  },
};

// ==========================================
// ANIMATION PRESETS
// ==========================================

export const animationPresets: Record<string, AnimationPreset> = {
  // Entrance animations
  fadeIn: {
    name: 'Fade In',
    purpose: 'state-change',
    description: 'Simple fade in from transparent',
    config: {
      duration: timings.normal,
      easing: easings.ease,
      fill: 'forwards',
    },
    keyframes: `
      @keyframes fadeIn {
        from { opacity: 0; }
        to { opacity: 1; }
      }
    `,
    tailwindClass: 'animate-fade-in',
  },
  slideInUp: {
    name: 'Slide In Up',
    purpose: 'state-change',
    description: 'Slide up from below with fade',
    config: {
      duration: timings.normal,
      easing: easings.snappy,
      fill: 'forwards',
    },
    keyframes: `
      @keyframes slideInUp {
        from {
          opacity: 0;
          transform: translateY(16px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }
    `,
    tailwindClass: 'animate-slide-in-up',
  },
  slideInDown: {
    name: 'Slide In Down',
    purpose: 'state-change',
    description: 'Slide down from above with fade',
    config: {
      duration: timings.normal,
      easing: easings.snappy,
      fill: 'forwards',
    },
    keyframes: `
      @keyframes slideInDown {
        from {
          opacity: 0;
          transform: translateY(-16px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }
    `,
    tailwindClass: 'animate-slide-in-down',
  },
  scaleIn: {
    name: 'Scale In',
    purpose: 'state-change',
    description: 'Scale up from small with fade',
    config: {
      duration: timings.normal,
      easing: easings.spring,
      fill: 'forwards',
    },
    keyframes: `
      @keyframes scaleIn {
        from {
          opacity: 0;
          transform: scale(0.95);
        }
        to {
          opacity: 1;
          transform: scale(1);
        }
      }
    `,
    tailwindClass: 'animate-scale-in',
  },
  // Feedback animations
  pulse: {
    name: 'Pulse',
    purpose: 'feedback',
    description: 'Attention-grabbing pulse',
    config: {
      duration: 2000,
      easing: easings.ease,
      iterations: Infinity,
    },
    keyframes: `
      @keyframes pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.5; }
      }
    `,
    tailwindClass: 'animate-pulse',
  },
  shake: {
    name: 'Shake',
    purpose: 'feedback',
    description: 'Error/warning shake',
    config: {
      duration: 500,
      easing: easings.ease,
    },
    keyframes: `
      @keyframes shake {
        0%, 100% { transform: translateX(0); }
        10%, 30%, 50%, 70%, 90% { transform: translateX(-4px); }
        20%, 40%, 60%, 80% { transform: translateX(4px); }
      }
    `,
    tailwindClass: 'animate-shake',
  },
  bounce: {
    name: 'Bounce',
    purpose: 'delight',
    description: 'Playful bounce effect',
    config: {
      duration: 1000,
      easing: easings.ease,
      iterations: Infinity,
    },
    keyframes: `
      @keyframes bounce {
        0%, 100% { transform: translateY(0); }
        50% { transform: translateY(-10px); }
      }
    `,
    tailwindClass: 'animate-bounce',
  },
  // Loading animations
  spin: {
    name: 'Spin',
    purpose: 'feedback',
    description: 'Loading spinner rotation',
    config: {
      duration: 1000,
      easing: easings.linear,
      iterations: Infinity,
    },
    keyframes: `
      @keyframes spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }
    `,
    tailwindClass: 'animate-spin',
  },
  skeleton: {
    name: 'Skeleton',
    purpose: 'feedback',
    description: 'Skeleton loading shimmer',
    config: {
      duration: 1500,
      easing: easings.ease,
      iterations: Infinity,
    },
    keyframes: `
      @keyframes skeleton {
        0% { background-position: 200% 0; }
        100% { background-position: -200% 0; }
      }
    `,
    tailwindClass: 'animate-shimmer',
  },
};

// ==========================================
// CYBERPUNK EFFECTS
// ==========================================

export const cyberpunkEffects: Record<string, CyberpunkEffect> = {
  // Glitch text effect
  glitchText: {
    name: 'Glitch Text',
    description: 'Text with random glitch distortion',
    keyframes: `
      @keyframes glitch {
        0%, 100% {
          transform: translate(0);
          text-shadow: none;
        }
        20% {
          transform: translate(-2px, 2px);
          text-shadow: -2px 0 #00ffff, 2px 0 #ff00ff;
        }
        40% {
          transform: translate(-2px, -2px);
          text-shadow: 2px 0 #00ffff, -2px 0 #ff00ff;
        }
        60% {
          transform: translate(2px, 2px);
          text-shadow: -2px 0 #ff00ff, 2px 0 #00ffff;
        }
        80% {
          transform: translate(2px, -2px);
          text-shadow: 2px 0 #ff00ff, -2px 0 #00ffff;
        }
      }
    `,
    css: `
      .glitch-text {
        animation: glitch 0.5s ease-in-out infinite;
        animation-play-state: paused;
      }
      .glitch-text:hover {
        animation-play-state: running;
      }
    `,
  },

  // Neon glow
  neonGlow: {
    name: 'Neon Glow',
    description: 'Pulsing neon glow effect',
    keyframes: `
      @keyframes neonPulse {
        0%, 100% {
          box-shadow: 
            0 0 5px var(--neon-color),
            0 0 10px var(--neon-color),
            0 0 20px var(--neon-color);
        }
        50% {
          box-shadow: 
            0 0 10px var(--neon-color),
            0 0 20px var(--neon-color),
            0 0 40px var(--neon-color);
        }
      }
    `,
    css: `
      .neon-glow {
        --neon-color: #00ffff;
        animation: neonPulse 2s ease-in-out infinite;
      }
    `,
    customProperties: {
      '--neon-color': '#00ffff',
    },
  },

  // Scanlines overlay
  scanlines: {
    name: 'Scanlines',
    description: 'CRT-style scanline overlay',
    css: `
      .scanlines::after {
        content: '';
        position: absolute;
        inset: 0;
        background: repeating-linear-gradient(
          0deg,
          rgba(0, 0, 0, 0.15) 0px,
          rgba(0, 0, 0, 0.15) 1px,
          transparent 1px,
          transparent 2px
        );
        pointer-events: none;
      }
    `,
  },

  // Holographic shimmer
  holographic: {
    name: 'Holographic',
    description: 'Rainbow holographic shimmer',
    keyframes: `
      @keyframes holographic {
        0% {
          background-position: 0% 50%;
        }
        50% {
          background-position: 100% 50%;
        }
        100% {
          background-position: 0% 50%;
        }
      }
    `,
    css: `
      .holographic {
        background: linear-gradient(
          45deg,
          #ff00ff,
          #00ffff,
          #ff00ff,
          #00ffff
        );
        background-size: 400% 400%;
        animation: holographic 3s ease infinite;
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
      }
    `,
  },

  // Data stream effect
  dataStream: {
    name: 'Data Stream',
    description: 'Matrix-style falling data effect',
    keyframes: `
      @keyframes dataFall {
        0% {
          transform: translateY(-100%);
          opacity: 0;
        }
        10% {
          opacity: 1;
        }
        90% {
          opacity: 1;
        }
        100% {
          transform: translateY(100%);
          opacity: 0;
        }
      }
    `,
    css: `
      .data-stream {
        animation: dataFall 2s linear infinite;
        animation-delay: var(--delay, 0s);
      }
    `,
    customProperties: {
      '--delay': '0s',
    },
  },

  // Electric border
  electricBorder: {
    name: 'Electric Border',
    description: 'Animated electric current border',
    keyframes: `
      @keyframes electricFlow {
        0% {
          background-position: 0% 0%;
        }
        100% {
          background-position: 200% 0%;
        }
      }
    `,
    css: `
      .electric-border {
        position: relative;
        border: 2px solid transparent;
        background: 
          linear-gradient(var(--bg-color, #0a0a0a), var(--bg-color, #0a0a0a)) padding-box,
          linear-gradient(90deg, #00ffff, #ff00ff, #00ffff) border-box;
        background-size: 100% 100%, 200% 100%;
        animation: electricFlow 2s linear infinite;
      }
    `,
    customProperties: {
      '--bg-color': '#0a0a0a',
    },
  },

  // Cyber grid background
  cyberGrid: {
    name: 'Cyber Grid',
    description: 'Perspective cyber grid background',
    css: `
      .cyber-grid {
        background: 
          linear-gradient(90deg, rgba(0, 255, 255, 0.1) 1px, transparent 1px),
          linear-gradient(rgba(0, 255, 255, 0.1) 1px, transparent 1px);
        background-size: 50px 50px;
        perspective: 500px;
        transform-style: preserve-3d;
      }
    `,
  },

  // Chromatic aberration
  chromaticAberration: {
    name: 'Chromatic Aberration',
    description: 'RGB split effect on hover',
    css: `
      .chromatic {
        position: relative;
      }
      .chromatic:hover {
        text-shadow: 
          -2px 0 #ff0000,
          2px 0 #00ffff;
      }
    `,
  },

  // Flicker effect
  flicker: {
    name: 'Flicker',
    description: 'Neon sign flicker',
    keyframes: `
      @keyframes flicker {
        0%, 100% { opacity: 1; }
        33% { opacity: 0.8; }
        66% { opacity: 0.9; }
        90% { opacity: 0.3; }
        95% { opacity: 1; }
      }
    `,
    css: `
      .flicker {
        animation: flicker 4s ease-in-out infinite;
      }
    `,
  },
};

// ==========================================
// UTILITY FUNCTIONS
// ==========================================

/**
 * Get animation by name
 */
export function getAnimation(name: string): AnimationPreset | undefined {
  return animationPresets[name];
}

/**
 * Get transition by name
 */
export function getTransition(name: string): TransitionPreset | undefined {
  return transitionPresets[name];
}

/**
 * Get cyberpunk effect by name
 */
export function getCyberpunkEffect(name: string): CyberpunkEffect | undefined {
  return cyberpunkEffects[name];
}

/**
 * Generate CSS for animation
 */
export function generateAnimationCSS(preset: AnimationPreset): string {
  const { config, keyframes } = preset;
  const animationValue = [
    preset.name.replace(/\s/g, '-').toLowerCase(),
    `${config.duration}ms`,
    config.easing,
    config.delay ? `${config.delay}ms` : '',
    config.iterations === Infinity ? 'infinite' : (config.iterations || 1),
    config.fill || '',
  ].filter(Boolean).join(' ');

  return `
${keyframes}

.animate-${preset.name.replace(/\s/g, '-').toLowerCase()} {
  animation: ${animationValue};
}
  `.trim();
}

/**
 * Generate all animation keyframes for CSS file
 */
export function generateAllKeyframes(): string {
  const keyframes: string[] = [];

  for (const preset of Object.values(animationPresets)) {
    keyframes.push(preset.keyframes);
  }

  for (const effect of Object.values(cyberpunkEffects)) {
    if (effect.keyframes) {
      keyframes.push(effect.keyframes);
    }
  }

  return keyframes.join('\n\n');
}

/**
 * Generate Tailwind animation config
 */
export function generateTailwindAnimationConfig(): Record<string, unknown> {
  const animation: Record<string, string> = {};
  const keyframes: Record<string, Record<string, Record<string, string>>> = {};

  for (const [key, preset] of Object.entries(animationPresets)) {
    const animName = key.replace(/([A-Z])/g, '-$1').toLowerCase();
    animation[animName] = `${animName} ${preset.config.duration}ms ${preset.config.easing}`;

    // Parse keyframes (simplified)
    keyframes[animName] = parseKeyframes(preset.keyframes);
  }

  return {
    animation,
    keyframes,
  };
}

/**
 * Parse keyframe string to object (simplified)
 */
function parseKeyframes(keyframeStr: string): Record<string, Record<string, string>> {
  // This is a simplified parser - in production you'd want a proper CSS parser
  const result: Record<string, Record<string, string>> = {};

  // Basic parsing for common patterns
  const matches = keyframeStr.matchAll(/([\d%]+(?:,\s*[\d%]+)*)\s*\{([^}]+)\}/g);

  for (const match of matches) {
    const selectors = match[1].split(',').map(s => s.trim());
    const properties = match[2].trim();

    for (const selector of selectors) {
      result[selector] = {};
      const propMatches = properties.matchAll(/([a-z-]+):\s*([^;]+);?/gi);
      for (const propMatch of propMatches) {
        result[selector][propMatch[1]] = propMatch[2].trim();
      }
    }
  }

  return result;
}

/**
 * Get animation timing based on purpose
 */
export function getTimingForPurpose(purpose: AnimationPurpose): number {
  const purposeTimings = {
    feedback: timings.fast,
    guidance: timings.normal,
    delight: timings.slow,
    'state-change': timings.normal,
  };

  return purposeTimings[purpose];
}

/**
 * Generate stagger delay for list items
 */
export function generateStaggerDelays(
  itemCount: number,
  baseDelay: number = 50,
  maxDelay: number = 500
): number[] {
  const delays: number[] = [];
  for (let i = 0; i < itemCount; i++) {
    delays.push(Math.min(i * baseDelay, maxDelay));
  }
  return delays;
}

/**
 * Recommend animation based on context
 */
export function recommendAnimation(context: {
  action: 'enter' | 'exit' | 'feedback' | 'loading' | 'hover';
  element: 'modal' | 'dropdown' | 'toast' | 'list-item' | 'button' | 'page';
  aesthetic?: 'cyberpunk' | 'minimal' | 'default';
}): { animation: string; timing: number; easing: string } {
  const { action, element, aesthetic } = context;

  // Default recommendations
  const recommendations = {
    enter: {
      modal: { animation: 'scaleIn', timing: timings.normal, easing: easings.spring },
      dropdown: { animation: 'slideInDown', timing: timings.fast, easing: easings.snappy },
      toast: { animation: 'slideInUp', timing: timings.fast, easing: easings.snappy },
      'list-item': { animation: 'fadeIn', timing: timings.fast, easing: easings.ease },
      button: { animation: 'none', timing: 0, easing: easings.ease },
      page: { animation: 'fadeIn', timing: timings.slow, easing: easings.ease },
    },
    feedback: {
      button: { animation: 'pulse', timing: timings.fast, easing: easings.ease },
      modal: { animation: 'shake', timing: timings.normal, easing: easings.ease },
    },
    loading: {
      button: { animation: 'spin', timing: 1000, easing: easings.linear },
    },
  };

  const fallback = { animation: 'fadeIn', timing: timings.normal, easing: easings.ease };

  // Add cyberpunk flair if requested
  if (aesthetic === 'cyberpunk') {
    return {
      animation: 'glitchText',
      timing: 500,
      easing: easings.glitch,
    };
  }

  const actionRecs = recommendations[action as keyof typeof recommendations];
  if (!actionRecs) return fallback;

  return actionRecs[element as keyof typeof actionRecs] || fallback;
}
