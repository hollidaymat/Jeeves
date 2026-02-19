/**
 * Skill Loader
 * Loads and manages agent skills from the skills directory
 */

import { readdir, readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Skills directory relative to project root
const SKILLS_DIR = join(__dirname, '../../skills');

export interface SkillMetadata {
  name: string;
  description: string;
  triggers?: string[];
  version?: string;
  author?: string;
}

export interface LoadedSkill {
  name: string;
  path: string;
  metadata: SkillMetadata;
  content: string;
  rulesDir?: string;
  hasRules: boolean;
}

// Cache loaded skills
let skillsCache: Map<string, LoadedSkill> | null = null;

// Track capabilities conversation state
let capabilitiesConversationActive = false;
let capabilitiesConversationExpiry = 0;

/**
 * Parse YAML-like frontmatter from SKILL.md
 */
function parseFrontmatter(content: string): { metadata: Partial<SkillMetadata>; body: string } {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  
  if (!frontmatterMatch) {
    return { metadata: {}, body: content };
  }

  const [, yamlContent, body] = frontmatterMatch;
  const metadata: Partial<SkillMetadata> = {};

  // Simple YAML parsing for key: value pairs
  for (const line of yamlContent.split('\n')) {
    const match = line.match(/^(\w+(?:-\w+)*):\s*(.+)$/);
    if (match) {
      const [, key, value] = match;
      const cleanValue = value.replace(/^["']|["']$/g, '').trim();
      
      switch (key) {
        case 'name':
          metadata.name = cleanValue;
          break;
        case 'description':
          metadata.description = cleanValue;
          break;
        case 'version':
          metadata.version = cleanValue;
          break;
        case 'author':
          metadata.author = cleanValue;
          break;
      }
    }
  }

  return { metadata, body };
}

/**
 * Load all skills from the skills directory
 */
export async function loadAllSkills(): Promise<Map<string, LoadedSkill>> {
  if (skillsCache) {
    return skillsCache;
  }

  const skills = new Map<string, LoadedSkill>();

  if (!existsSync(SKILLS_DIR)) {
    logger.debug('Skills directory not found', { path: SKILLS_DIR });
    return skills;
  }

  try {
    const entries = await readdir(SKILLS_DIR, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillDir = join(SKILLS_DIR, entry.name);
      const skillFile = join(skillDir, 'SKILL.md');

      if (!existsSync(skillFile)) continue;

      try {
        const content = await readFile(skillFile, 'utf-8');
        const { metadata, body } = parseFrontmatter(content);

        const rulesDir = join(skillDir, 'rules');
        const hasRules = existsSync(rulesDir);

        const skill: LoadedSkill = {
          name: metadata.name || entry.name,
          path: skillDir,
          metadata: {
            name: metadata.name || entry.name,
            description: metadata.description || '',
            version: metadata.version,
            author: metadata.author
          },
          content: body,
          rulesDir: hasRules ? rulesDir : undefined,
          hasRules
        };

        skills.set(entry.name, skill);
        logger.debug('Loaded skill', { name: skill.name, hasRules });
      } catch (err) {
        logger.warn('Failed to load skill', { skill: entry.name, error: String(err) });
      }
    }

    skillsCache = skills;
    logger.info(`Loaded ${skills.size} skills`);
  } catch (err) {
    logger.error('Failed to load skills', { error: String(err) });
  }

  return skills;
}

/**
 * Get a specific skill by name
 */
export async function getSkill(name: string): Promise<LoadedSkill | null> {
  const skills = await loadAllSkills();
  return skills.get(name) || null;
}

/**
 * Load specific rules from a skill
 */
export async function loadSkillRules(skillName: string, ruleNames?: string[]): Promise<string> {
  const skill = await getSkill(skillName);
  
  if (!skill || !skill.rulesDir) {
    return '';
  }

  const rulesContent: string[] = [];

  try {
    const entries = await readdir(skill.rulesDir);
    
    for (const file of entries) {
      // Skip template and section files
      if (file.startsWith('_')) continue;
      if (!file.endsWith('.md')) continue;

      // If specific rules requested, filter
      if (ruleNames && ruleNames.length > 0) {
        const ruleName = file.replace('.md', '');
        if (!ruleNames.some(r => ruleName.includes(r))) continue;
      }

      const rulePath = join(skill.rulesDir, file);
      const content = await readFile(rulePath, 'utf-8');
      rulesContent.push(`### ${file.replace('.md', '')}\n\n${content}`);
    }
  } catch (err) {
    logger.warn('Failed to load skill rules', { skill: skillName, error: String(err) });
  }

  return rulesContent.join('\n\n---\n\n');
}

/**
 * Build a skills summary for the system prompt
 */
export async function buildSkillsSummary(): Promise<string> {
  const skills = await loadAllSkills();
  
  if (skills.size === 0) {
    return '';
  }

  const lines: string[] = [
    '## AVAILABLE SKILLS',
    '',
    'You have access to these specialized skills. Reference them when relevant:',
    ''
  ];

  for (const [key, skill] of skills) {
    const ruleCount = skill.hasRules ? ' (has detailed rules)' : '';
    lines.push(`- **${skill.name}**${ruleCount}: ${skill.metadata.description}`);
  }

  lines.push('');
  lines.push('To use a skill, tell the user you\'re applying it and follow its guidelines.');
  lines.push('For skills with rules, you can load specific rules when needed.');

  return lines.join('\n');
}

/**
 * Detect which skills are relevant based on content/context
 */
export function detectRelevantSkills(content: string, projectType?: string): string[] {
  const relevant: string[] = [];
  const lower = content.toLowerCase();

  // React/Next.js detection
  if (lower.includes('react') || lower.includes('next.js') || lower.includes('nextjs') ||
      lower.includes('component') || lower.includes('hook') || lower.includes('usestate') ||
      lower.includes('.tsx') || lower.includes('.jsx')) {
    relevant.push('react-best-practices');
    relevant.push('composition-patterns');
  }

  // React Native detection
  if (lower.includes('react native') || lower.includes('expo') || 
      lower.includes('react-native') || lower.includes('mobile app')) {
    relevant.push('react-native-skills');
  }

  // UI/Design detection
  if (lower.includes('ui') || lower.includes('design') || lower.includes('ux') ||
      lower.includes('accessibility') || lower.includes('a11y') || 
      lower.includes('review') || lower.includes('audit')) {
    relevant.push('web-design-guidelines');
  }

  // Project type hints
  if (projectType) {
    const type = projectType.toLowerCase();
    if (type.includes('next') || type.includes('react')) {
      if (!relevant.includes('react-best-practices')) {
        relevant.push('react-best-practices');
      }
    }
    if (type.includes('native') || type.includes('expo')) {
      if (!relevant.includes('react-native-skills')) {
        relevant.push('react-native-skills');
      }
    }
  }

  return [...new Set(relevant)];
}

/**
 * Get context for relevant skills based on the prompt
 */
export async function getSkillContext(prompt: string, projectType?: string): Promise<string> {
  const relevantSkills = detectRelevantSkills(prompt, projectType);
  
  if (relevantSkills.length === 0) {
    return '';
  }

  const sections: string[] = [];

  for (const skillName of relevantSkills) {
    const skill = await getSkill(skillName);
    if (!skill) continue;

    // Include the skill's main content (without loading all rules to save tokens)
    sections.push(`### ${skill.name}\n\n${skill.content.substring(0, 2000)}`);
  }

  if (sections.length === 0) {
    return '';
  }

  return `\n## RELEVANT SKILLS\n\nThe following skills are relevant to this request:\n\n${sections.join('\n\n---\n\n')}`;
}

/**
 * Clear the skills cache (for reloading)
 */
export function clearSkillsCache(): void {
  skillsCache = null;
}

/**
 * Check if prompt is asking about Jeeves' capabilities
 * Also considers follow-up questions when in a capabilities conversation
 */
export function isCapabilitiesQuery(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  
  // Direct capability questions
  const directPatterns = [
    /what can you/,
    /your (capabilities|features|skills|abilities)/,
    /tell me about yourself/,
    /what do you do/,
    /new features/,
    /what's new/,
    /what did you learn/,
    /what (are|were) (the )?(new|added)/,
    /i added/,
    /we added/,
    /just added/,
    /take a look at (your|the new)/,
    /check out (your|the new)/,
    /tell me what you think/,
    /your new/
  ];
  
  if (directPatterns.some(p => p.test(lower))) {
    // Activate capabilities conversation mode for 5 minutes
    capabilitiesConversationActive = true;
    capabilitiesConversationExpiry = Date.now() + 5 * 60 * 1000;
    return true;
  }
  
  // Check if we're in an active capabilities conversation (for follow-ups)
  if (capabilitiesConversationActive && Date.now() < capabilitiesConversationExpiry) {
    // Follow-up patterns that should keep the capabilities context
    const followUpPatterns = [
      /what do you think/,
      /how do you feel/,
      /tell me more/,
      /elaborate/,
      /explain/,
      /which (one|feature)/,
      /favorite/,
      /most (useful|important|interesting)/,
      /excited about/,
      /about (that|this|it|them)/,
      /how does that/,
      /why is that/,
      /can you/,
      /do you like/,
      /opinion/,
      /thoughts/
    ];
    
    if (followUpPatterns.some(p => p.test(lower))) {
      // Extend the conversation window
      capabilitiesConversationExpiry = Date.now() + 5 * 60 * 1000;
      return true;
    }
    
    // Short responses that are likely follow-ups (< 15 words)
    const wordCount = prompt.split(/\s+/).length;
    if (wordCount < 15) {
      // Check for pronouns that reference previous context
      if (/\b(it|that|this|those|them|these)\b/.test(lower)) {
        capabilitiesConversationExpiry = Date.now() + 5 * 60 * 1000;
        return true;
      }
    }
  }
  
  return false;
}

/**
 * Reset capabilities conversation state (e.g., on clear history)
 */
export function resetCapabilitiesConversation(): void {
  capabilitiesConversationActive = false;
  capabilitiesConversationExpiry = 0;
}

/**
 * Check if currently in a capabilities follow-up conversation
 */
export function isCapabilitiesFollowUp(): boolean {
  return capabilitiesConversationActive && Date.now() < capabilitiesConversationExpiry;
}

/**
 * Load Jeeves capabilities description
 */
export async function getCapabilitiesContext(isFollowUp: boolean = false): Promise<string> {
  const capabilitiesPath = join(__dirname, '../../data/capabilities.md');
  const fallbackInRepo = join(__dirname, '../../docs/CAPABILITY_AUDIT.md');
  const fallbackCwd = join(process.cwd(), 'docs/CAPABILITY_AUDIT.md');
  const fallbackHome = join(process.env.HOME || process.env.USERPROFILE || '', 'docs', 'CAPABILITY_AUDIT.md');

  const pathToUse = existsSync(capabilitiesPath)
    ? capabilitiesPath
    : existsSync(fallbackInRepo)
      ? fallbackInRepo
      : existsSync(fallbackCwd)
        ? fallbackCwd
        : existsSync(fallbackHome)
          ? fallbackHome
          : null;
  logger.info('Loading capabilities', { path: pathToUse ?? capabilitiesPath, exists: !!pathToUse, isFollowUp });

  try {
    if (pathToUse) {
      const content = await readFile(pathToUse, 'utf-8');
      logger.info('Capabilities file loaded', { contentLength: content.length });

      if (isFollowUp) {
        // For follow-up questions, provide context without the heavy-handed instructions
        return `
## CONTEXT: CAPABILITIES CONVERSATION

You are in a conversation about your own capabilities and features. The document below describes what you can do. Use this information to continue the discussion naturally.

You already described these features. Now the user wants to discuss them further - share your thoughts, explain how features work, discuss what you find interesting or useful.

---

${content}

---

**Important**: This is a genuine conversation. Engage naturally and share your perspective on these features.`;
      }

      // Initial query - be explicit about using the info
      return `
## YOUR CAPABILITIES

The user is asking about your features or capabilities. Below is an accurate description of what you can do.

---

${content}

---

**Instructions**: Describe your capabilities naturally based on the above. For questions about "new features", highlight the "Recent Additions" section. Be helpful and conversational.`;
    } else {
      logger.warn('Capabilities file not found', { path: capabilitiesPath, fallbacks: [fallbackInRepo, fallbackCwd, fallbackHome] });
    }
  } catch (err) {
    logger.error('Failed to load capabilities', { error: String(err) });
  }

  return '';
}
