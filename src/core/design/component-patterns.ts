/**
 * Component Composition Patterns
 * 
 * Compound component patterns and composition rules.
 * 
 * Rule: Slots > Props for flexible components. Composition over configuration.
 */

// ==========================================
// TYPES
// ==========================================

export type ComponentCategory =
  | 'navigation'
  | 'content'
  | 'form'
  | 'feedback'
  | 'overlay'
  | 'layout'
  | 'data-display';

export type ComponentSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';
export type ComponentVariant = 'primary' | 'secondary' | 'ghost' | 'outline' | 'destructive';

export interface ComponentPattern {
  name: string;
  category: ComponentCategory;
  description: string;
  slots: SlotDefinition[];
  variants?: VariantDefinition[];
  sizes?: SizeDefinition[];
  states: StateDefinition[];
  anatomy: ComponentAnatomy;
  accessibility: AccessibilityRequirements;
  examples: ComponentExample[];
}

export interface SlotDefinition {
  name: string;
  description: string;
  required: boolean;
  defaultContent?: string;
  accepts?: string[]; // Types of elements that can go in this slot
}

export interface VariantDefinition {
  name: string;
  description: string;
  styles: {
    base: string;
    hover?: string;
    active?: string;
    focus?: string;
    disabled?: string;
  };
}

export interface SizeDefinition {
  name: ComponentSize;
  height: string;
  padding: string;
  fontSize: string;
  iconSize?: string;
}

export interface StateDefinition {
  name: string;
  description: string;
  visualIndicator: string;
}

export interface ComponentAnatomy {
  container: string;
  parts: AnatomyPart[];
}

export interface AnatomyPart {
  name: string;
  element: string;
  role?: string;
  required: boolean;
}

export interface AccessibilityRequirements {
  role?: string;
  ariaAttributes: string[];
  keyboardInteraction?: KeyboardInteraction[];
  focusManagement?: string;
  announcements?: string[];
}

export interface KeyboardInteraction {
  key: string;
  action: string;
}

export interface ComponentExample {
  name: string;
  description: string;
  code: string;
}

// ==========================================
// COMPONENT PATTERNS
// ==========================================

export const componentPatterns: Record<string, ComponentPattern> = {
  // Button with compound parts
  button: {
    name: 'Button',
    category: 'form',
    description: 'Interactive button with multiple variants and sizes',
    slots: [
      { name: 'leftIcon', description: 'Icon before label', required: false },
      { name: 'children', description: 'Button label/content', required: true },
      { name: 'rightIcon', description: 'Icon after label', required: false },
    ],
    variants: [
      {
        name: 'primary',
        description: 'Main call-to-action',
        styles: {
          base: 'bg-primary text-primary-foreground',
          hover: 'hover:bg-primary/90',
          active: 'active:scale-[0.98]',
          focus: 'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
          disabled: 'disabled:opacity-50 disabled:pointer-events-none',
        },
      },
      {
        name: 'secondary',
        description: 'Secondary actions',
        styles: {
          base: 'bg-secondary text-secondary-foreground',
          hover: 'hover:bg-secondary/80',
        },
      },
      {
        name: 'ghost',
        description: 'Minimal visual weight',
        styles: {
          base: 'bg-transparent',
          hover: 'hover:bg-accent hover:text-accent-foreground',
        },
      },
      {
        name: 'outline',
        description: 'Border-only style',
        styles: {
          base: 'border border-input bg-background',
          hover: 'hover:bg-accent hover:text-accent-foreground',
        },
      },
      {
        name: 'destructive',
        description: 'Dangerous/destructive actions',
        styles: {
          base: 'bg-destructive text-destructive-foreground',
          hover: 'hover:bg-destructive/90',
        },
      },
    ],
    sizes: [
      { name: 'xs', height: '24px', padding: '0 8px', fontSize: '12px', iconSize: '14px' },
      { name: 'sm', height: '32px', padding: '0 12px', fontSize: '13px', iconSize: '16px' },
      { name: 'md', height: '40px', padding: '0 16px', fontSize: '14px', iconSize: '18px' },
      { name: 'lg', height: '48px', padding: '0 24px', fontSize: '16px', iconSize: '20px' },
      { name: 'xl', height: '56px', padding: '0 32px', fontSize: '18px', iconSize: '24px' },
    ],
    states: [
      { name: 'default', description: 'Normal state', visualIndicator: 'Standard colors' },
      { name: 'hover', description: 'Mouse over', visualIndicator: 'Lightened/darkened bg' },
      { name: 'active', description: 'Being pressed', visualIndicator: 'Slight scale down' },
      { name: 'focus', description: 'Keyboard focus', visualIndicator: 'Ring outline' },
      { name: 'disabled', description: 'Not interactive', visualIndicator: 'Reduced opacity' },
      { name: 'loading', description: 'Processing action', visualIndicator: 'Spinner replaces icon' },
    ],
    anatomy: {
      container: 'button',
      parts: [
        { name: 'leftIcon', element: 'span', required: false },
        { name: 'label', element: 'span', required: true },
        { name: 'rightIcon', element: 'span', required: false },
        { name: 'spinner', element: 'span', required: false },
      ],
    },
    accessibility: {
      role: 'button',
      ariaAttributes: ['aria-disabled', 'aria-busy', 'aria-pressed'],
      keyboardInteraction: [
        { key: 'Enter', action: 'Activate button' },
        { key: 'Space', action: 'Activate button' },
      ],
      focusManagement: 'Naturally focusable, uses focus-visible',
    },
    examples: [
      {
        name: 'Primary with icon',
        description: 'Standard primary button with left icon',
        code: '<Button variant="primary" leftIcon={<Plus />}>Add Item</Button>',
      },
    ],
  },

  // Card with compound parts
  card: {
    name: 'Card',
    category: 'content',
    description: 'Container for grouped content with optional header and footer',
    slots: [
      { name: 'header', description: 'Card header area', required: false },
      { name: 'title', description: 'Card title', required: false },
      { name: 'description', description: 'Card description/subtitle', required: false },
      { name: 'content', description: 'Main card content', required: true },
      { name: 'footer', description: 'Card footer area', required: false },
      { name: 'actions', description: 'Action buttons', required: false },
    ],
    states: [
      { name: 'default', description: 'Normal state', visualIndicator: 'Standard elevation' },
      { name: 'hover', description: 'Interactive cards', visualIndicator: 'Elevated shadow' },
      { name: 'selected', description: 'Selected state', visualIndicator: 'Ring/border highlight' },
    ],
    anatomy: {
      container: 'article',
      parts: [
        { name: 'root', element: 'div', role: 'article', required: true },
        { name: 'header', element: 'header', required: false },
        { name: 'title', element: 'h3', required: false },
        { name: 'description', element: 'p', required: false },
        { name: 'content', element: 'div', required: true },
        { name: 'footer', element: 'footer', required: false },
      ],
    },
    accessibility: {
      role: 'article',
      ariaAttributes: ['aria-labelledby'],
      focusManagement: 'Card itself not focusable, internal elements are',
    },
    examples: [
      {
        name: 'Basic card',
        description: 'Simple card with content',
        code: `<Card>
  <CardHeader>
    <CardTitle>Title</CardTitle>
    <CardDescription>Description</CardDescription>
  </CardHeader>
  <CardContent>Content here</CardContent>
  <CardFooter>Footer actions</CardFooter>
</Card>`,
      },
    ],
  },

  // Dialog/Modal
  dialog: {
    name: 'Dialog',
    category: 'overlay',
    description: 'Modal dialog for focused interactions',
    slots: [
      { name: 'trigger', description: 'Element that opens dialog', required: false },
      { name: 'header', description: 'Dialog header with title', required: false },
      { name: 'title', description: 'Dialog title', required: true },
      { name: 'description', description: 'Dialog description', required: false },
      { name: 'content', description: 'Main dialog content', required: true },
      { name: 'footer', description: 'Dialog footer with actions', required: false },
      { name: 'close', description: 'Close button', required: false },
    ],
    states: [
      { name: 'closed', description: 'Dialog hidden', visualIndicator: 'Not in DOM or hidden' },
      { name: 'open', description: 'Dialog visible', visualIndicator: 'Centered with backdrop' },
      { name: 'opening', description: 'Animating in', visualIndicator: 'Scale up animation' },
      { name: 'closing', description: 'Animating out', visualIndicator: 'Scale down animation' },
    ],
    anatomy: {
      container: 'div',
      parts: [
        { name: 'overlay', element: 'div', role: 'presentation', required: true },
        { name: 'content', element: 'div', role: 'dialog', required: true },
        { name: 'header', element: 'div', required: false },
        { name: 'title', element: 'h2', required: true },
        { name: 'description', element: 'p', required: false },
        { name: 'body', element: 'div', required: true },
        { name: 'footer', element: 'div', required: false },
        { name: 'close', element: 'button', required: true },
      ],
    },
    accessibility: {
      role: 'dialog',
      ariaAttributes: ['aria-modal', 'aria-labelledby', 'aria-describedby'],
      keyboardInteraction: [
        { key: 'Escape', action: 'Close dialog' },
        { key: 'Tab', action: 'Cycle focus within dialog' },
      ],
      focusManagement: 'Focus trap, return focus on close',
      announcements: ['Dialog opened', 'Dialog closed'],
    },
    examples: [],
  },

  // Navigation
  navigation: {
    name: 'Navigation',
    category: 'navigation',
    description: 'Site or app navigation component',
    slots: [
      { name: 'logo', description: 'Brand/logo area', required: false },
      { name: 'items', description: 'Nav items container', required: true },
      { name: 'item', description: 'Individual nav item', required: true },
      { name: 'actions', description: 'CTA/actions area', required: false },
      { name: 'mobile-trigger', description: 'Mobile menu button', required: false },
    ],
    states: [
      { name: 'default', description: 'Normal state', visualIndicator: 'Standard appearance' },
      { name: 'active', description: 'Current page/section', visualIndicator: 'Highlighted/underlined' },
      { name: 'expanded', description: 'Mobile menu open', visualIndicator: 'Full menu visible' },
    ],
    anatomy: {
      container: 'nav',
      parts: [
        { name: 'root', element: 'nav', role: 'navigation', required: true },
        { name: 'list', element: 'ul', required: true },
        { name: 'item', element: 'li', required: true },
        { name: 'link', element: 'a', required: true },
      ],
    },
    accessibility: {
      role: 'navigation',
      ariaAttributes: ['aria-label', 'aria-current'],
      keyboardInteraction: [
        { key: 'Tab', action: 'Navigate between items' },
        { key: 'Enter/Space', action: 'Activate link' },
      ],
    },
    examples: [],
  },

  // Input
  input: {
    name: 'Input',
    category: 'form',
    description: 'Text input field with optional addons',
    slots: [
      { name: 'label', description: 'Field label', required: true },
      { name: 'prefix', description: 'Content before input', required: false },
      { name: 'input', description: 'The input element', required: true },
      { name: 'suffix', description: 'Content after input', required: false },
      { name: 'description', description: 'Helper text', required: false },
      { name: 'error', description: 'Error message', required: false },
    ],
    states: [
      { name: 'default', description: 'Empty state', visualIndicator: 'Standard border' },
      { name: 'focus', description: 'Has focus', visualIndicator: 'Highlighted border/ring' },
      { name: 'filled', description: 'Has value', visualIndicator: 'Standard appearance' },
      { name: 'error', description: 'Validation error', visualIndicator: 'Red border, error text' },
      { name: 'disabled', description: 'Not editable', visualIndicator: 'Muted colors, no cursor' },
    ],
    anatomy: {
      container: 'div',
      parts: [
        { name: 'wrapper', element: 'div', required: true },
        { name: 'label', element: 'label', required: true },
        { name: 'inputWrapper', element: 'div', required: true },
        { name: 'prefix', element: 'span', required: false },
        { name: 'input', element: 'input', required: true },
        { name: 'suffix', element: 'span', required: false },
        { name: 'description', element: 'p', required: false },
        { name: 'error', element: 'p', role: 'alert', required: false },
      ],
    },
    accessibility: {
      ariaAttributes: ['aria-invalid', 'aria-describedby', 'aria-required'],
      focusManagement: 'Native input focus',
      announcements: ['Error message when invalid'],
    },
    examples: [],
  },

  // Table/DataTable
  dataTable: {
    name: 'DataTable',
    category: 'data-display',
    description: 'Data table with sorting, filtering, and pagination',
    slots: [
      { name: 'toolbar', description: 'Table controls (search, filters)', required: false },
      { name: 'header', description: 'Column headers', required: true },
      { name: 'body', description: 'Table body with rows', required: true },
      { name: 'row', description: 'Individual data row', required: true },
      { name: 'cell', description: 'Individual cell', required: true },
      { name: 'pagination', description: 'Pagination controls', required: false },
      { name: 'empty', description: 'Empty state content', required: false },
    ],
    states: [
      { name: 'default', description: 'Normal state', visualIndicator: 'Standard table' },
      { name: 'loading', description: 'Fetching data', visualIndicator: 'Skeleton or spinner' },
      { name: 'empty', description: 'No data', visualIndicator: 'Empty state message' },
      { name: 'error', description: 'Load failed', visualIndicator: 'Error message' },
    ],
    anatomy: {
      container: 'div',
      parts: [
        { name: 'root', element: 'div', required: true },
        { name: 'table', element: 'table', role: 'grid', required: true },
        { name: 'thead', element: 'thead', required: true },
        { name: 'tbody', element: 'tbody', required: true },
        { name: 'tr', element: 'tr', role: 'row', required: true },
        { name: 'th', element: 'th', role: 'columnheader', required: true },
        { name: 'td', element: 'td', role: 'gridcell', required: true },
      ],
    },
    accessibility: {
      role: 'grid',
      ariaAttributes: ['aria-rowcount', 'aria-colcount', 'aria-sort'],
      keyboardInteraction: [
        { key: 'Arrow keys', action: 'Navigate cells' },
        { key: 'Enter', action: 'Activate cell/row' },
      ],
    },
    examples: [],
  },

  // Toast/Notification
  toast: {
    name: 'Toast',
    category: 'feedback',
    description: 'Brief notification message',
    slots: [
      { name: 'icon', description: 'Status icon', required: false },
      { name: 'title', description: 'Toast title', required: false },
      { name: 'description', description: 'Toast message', required: true },
      { name: 'action', description: 'Optional action button', required: false },
      { name: 'close', description: 'Dismiss button', required: false },
    ],
    variants: [
      { name: 'default', description: 'Neutral toast', styles: { base: 'bg-background border' } },
      { name: 'success', description: 'Success message', styles: { base: 'bg-green-50 border-green-200' } },
      { name: 'error', description: 'Error message', styles: { base: 'bg-red-50 border-red-200' } },
      { name: 'warning', description: 'Warning message', styles: { base: 'bg-yellow-50 border-yellow-200' } },
    ],
    states: [
      { name: 'entering', description: 'Animating in', visualIndicator: 'Slide + fade in' },
      { name: 'visible', description: 'On screen', visualIndicator: 'Fully visible' },
      { name: 'exiting', description: 'Animating out', visualIndicator: 'Slide + fade out' },
    ],
    anatomy: {
      container: 'div',
      parts: [
        { name: 'viewport', element: 'ol', required: true },
        { name: 'root', element: 'li', role: 'status', required: true },
        { name: 'icon', element: 'span', required: false },
        { name: 'content', element: 'div', required: true },
        { name: 'title', element: 'div', required: false },
        { name: 'description', element: 'div', required: true },
        { name: 'action', element: 'button', required: false },
        { name: 'close', element: 'button', required: false },
      ],
    },
    accessibility: {
      role: 'status',
      ariaAttributes: ['aria-live', 'aria-atomic'],
      announcements: ['Toast content announced to screen readers'],
    },
    examples: [],
  },
};

// ==========================================
// UTILITY FUNCTIONS
// ==========================================

/**
 * Get pattern by name
 */
export function getComponentPattern(name: string): ComponentPattern | undefined {
  return componentPatterns[name];
}

/**
 * Get all patterns in a category
 */
export function getPatternsByCategory(category: ComponentCategory): ComponentPattern[] {
  return Object.values(componentPatterns).filter(p => p.category === category);
}

/**
 * Generate component interface from pattern
 */
export function generateComponentInterface(pattern: ComponentPattern): string {
  const propsLines: string[] = [];
  
  // Add variant prop if variants exist
  if (pattern.variants && pattern.variants.length > 0) {
    const variantNames = pattern.variants.map(v => `'${v.name}'`).join(' | ');
    propsLines.push(`  variant?: ${variantNames};`);
  }
  
  // Add size prop if sizes exist
  if (pattern.sizes && pattern.sizes.length > 0) {
    const sizeNames = pattern.sizes.map(s => `'${s.name}'`).join(' | ');
    propsLines.push(`  size?: ${sizeNames};`);
  }
  
  // Add slots as props
  for (const slot of pattern.slots) {
    const optionalMark = slot.required ? '' : '?';
    propsLines.push(`  ${slot.name}${optionalMark}: React.ReactNode;`);
  }
  
  // Add state props
  propsLines.push(`  disabled?: boolean;`);
  propsLines.push(`  className?: string;`);
  
  return `interface ${pattern.name}Props {\n${propsLines.join('\n')}\n}`;
}

/**
 * Get variant classes for a component
 */
export function getVariantClasses(
  pattern: ComponentPattern,
  variant: string,
  state?: string
): string {
  const variantDef = pattern.variants?.find(v => v.name === variant);
  if (!variantDef) return '';
  
  const classes = [variantDef.styles.base];
  
  if (!state || state === 'default') {
    if (variantDef.styles.hover) classes.push(variantDef.styles.hover);
    if (variantDef.styles.active) classes.push(variantDef.styles.active);
    if (variantDef.styles.focus) classes.push(variantDef.styles.focus);
    if (variantDef.styles.disabled) classes.push(variantDef.styles.disabled);
  }
  
  return classes.join(' ');
}

/**
 * Get size classes for a component
 */
export function getSizeClasses(
  pattern: ComponentPattern,
  size: ComponentSize
): { height: string; padding: string; fontSize: string } | undefined {
  return pattern.sizes?.find(s => s.name === size);
}

/**
 * Generate accessibility props for a component
 */
export function getAccessibilityProps(
  pattern: ComponentPattern,
  state: Record<string, unknown> = {}
): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  
  if (pattern.accessibility.role) {
    props.role = pattern.accessibility.role;
  }
  
  // Map common state to aria attributes
  if (state.disabled) {
    props['aria-disabled'] = true;
  }
  if (state.loading) {
    props['aria-busy'] = true;
  }
  if (state.expanded !== undefined) {
    props['aria-expanded'] = state.expanded;
  }
  if (state.selected !== undefined) {
    props['aria-selected'] = state.selected;
  }
  if (state.invalid) {
    props['aria-invalid'] = true;
  }
  
  return props;
}

// ==========================================
// COMPOUND COMPONENT HELPERS
// ==========================================

/**
 * Create compound component context pattern
 */
export function createCompoundPattern(name: string): string {
  return `
// ${name} Context
const ${name}Context = createContext<${name}ContextValue | null>(null);

function use${name}Context() {
  const context = useContext(${name}Context);
  if (!context) {
    throw new Error(\`use${name}Context must be used within ${name}\`);
  }
  return context;
}

// Root component
const ${name}Root = forwardRef<HTMLDivElement, ${name}Props>(
  ({ children, ...props }, ref) => {
    return (
      <${name}Context.Provider value={{ /* context value */ }}>
        <div ref={ref} {...props}>
          {children}
        </div>
      </${name}Context.Provider>
    );
  }
);

// Sub-components
const ${name}Header = forwardRef<HTMLDivElement, ComponentProps>(
  ({ children, ...props }, ref) => {
    return <div ref={ref} {...props}>{children}</div>;
  }
);

// Compound export
export const ${name} = Object.assign(${name}Root, {
  Header: ${name}Header,
  // ... other sub-components
});
`.trim();
}
