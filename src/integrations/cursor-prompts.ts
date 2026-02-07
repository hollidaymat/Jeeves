/**
 * Cursor Agent Prompt Templates
 * 
 * Structured prompts for launching Cursor background agents.
 * Each template includes project context, requirements, and rules
 * to ensure consistent, safe, high-quality code output.
 */

// ============================================================================
// Types
// ============================================================================

export interface TaskSpec {
  id: string;
  type: 'feature' | 'bugfix' | 'refactor' | 'general';
  summary: string;
  description: string;
  project: string;
  repository: string;
  branch: string;
  requirements: string[];
  relatedFiles: string[];
  estimatedComplexity: 'low' | 'medium' | 'high';
  techStack?: string;
  conventions?: string;
}

// ============================================================================
// Shared Rules
// ============================================================================

const SHARED_RULES = `## Rules
- Do NOT delete or remove existing code unless explicitly told to
- Make targeted changes only — do not refactor unrelated code
- Follow existing code conventions and patterns
- Commit with clear messages prefixed with [jeeves]
- If unsure about a change, leave a TODO comment
- Run tests if they exist before completing
- Create a pull request to main when done
- PR title: [Jeeves] {summary}
- Include a summary of all changes in the PR description`;

// ============================================================================
// Templates
// ============================================================================

export function buildFeaturePrompt(task: TaskSpec): string {
  return `## Feature Request
${task.description}

## Project: ${task.project}
${task.techStack ? `Tech stack: ${task.techStack}` : ''}
${task.conventions ? `Conventions: ${task.conventions}` : 'Style: Match existing patterns in the codebase'}

## Files to reference
${task.relatedFiles.length > 0 ? task.relatedFiles.map(f => `- ${f}`).join('\n') : 'Agent should determine relevant files'}

## Requirements
${task.requirements.map(r => `- ${r}`).join('\n')}

${SHARED_RULES}

## On completion
- Create a pull request to main
- Title: [Jeeves] ${task.summary}
- Branch: ${task.branch}`;
}

export function buildBugfixPrompt(task: TaskSpec): string {
  return `## Bug Fix
${task.description}

## Project: ${task.project}

## Likely files
${task.relatedFiles.length > 0 ? task.relatedFiles.map(f => `- ${f}`).join('\n') : 'Agent should investigate'}

## Requirements
${task.requirements.map(r => `- ${r}`).join('\n')}

${SHARED_RULES}
- Fix the bug, don't refactor surrounding code
- Add a test if a test framework exists

## On completion
- Commit message: [jeeves] fix: ${task.summary}
- Create PR to main
- Branch: ${task.branch}`;
}

export function buildRefactorPrompt(task: TaskSpec): string {
  return `## Refactor
${task.description}

## Scope
Only touch files listed. Do not expand scope.
${task.relatedFiles.length > 0 ? task.relatedFiles.map(f => `- ${f}`).join('\n') : 'Agent should determine scope carefully'}

## Requirements
${task.requirements.map(r => `- ${r}`).join('\n')}

${SHARED_RULES}
- Preserve all existing functionality — no behavior changes
- Run existing tests after changes

## On completion
- Commit message: [jeeves] refactor: ${task.summary}
- Create PR to main
- Branch: ${task.branch}`;
}

export function buildGeneralPrompt(task: TaskSpec): string {
  return `## Task
${task.description}

## Project: ${task.project}
${task.techStack ? `Tech stack: ${task.techStack}` : ''}

## Context
${task.relatedFiles.length > 0 ? `Related files:\n${task.relatedFiles.map(f => `- ${f}`).join('\n')}` : 'Agent should determine relevant files'}

## Requirements
${task.requirements.map(r => `- ${r}`).join('\n')}

${SHARED_RULES}

## On completion
- Create a pull request to main
- Title: [Jeeves] ${task.summary}
- Branch: ${task.branch}`;
}

// ============================================================================
// Main Builder
// ============================================================================

export function buildPrompt(task: TaskSpec): string {
  switch (task.type) {
    case 'feature':
      return buildFeaturePrompt(task);
    case 'bugfix':
      return buildBugfixPrompt(task);
    case 'refactor':
      return buildRefactorPrompt(task);
    default:
      return buildGeneralPrompt(task);
  }
}
