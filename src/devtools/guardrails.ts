// Jeeves dev test 3
/**
 * Guardrails (devtools)
 * Safety system preventing dangerous autonomous changes.
 */

export interface GuardrailResult {
  allowed: boolean;
  reason?: string;
  requiresApproval?: boolean;
}

export interface DevTaskForGuardrails {
  description: string;
  requestedBy: string;
}

const FORBIDDEN_PATTERNS = [
  /\brm\s+-rf\b/,
  /\bprocess\.exit\s*\(/,
  /\beval\s*\(/,
  /child_process\.(exec|spawn)\s*\(/,
  /ALLOWED_EXECUTABLES/,
  /PROTECTED_FILES/,
  /FORBIDDEN_PATTERNS/,
  /writeFile.*config\.json/,
  /writeFile.*\.env/,
  /\bDROP\s+TABLE\b/i,
  /\bDELETE\s+FROM\s+.*knowledge\b/i,
];

const MAX_FILES_PER_TASK = 10;
const MAX_LINES_PER_FILE = 500;

export function checkGuardrails(task: DevTaskForGuardrails): GuardrailResult {
  const desc = task.description.toLowerCase();

  if (desc.includes('trust') && desc.includes('level')) {
    return { allowed: false, reason: 'Cannot autonomously modify trust system' };
  }
  if (desc.includes('guardrail') || (desc.includes('security') && desc.includes('disable'))) {
    return { allowed: false, reason: 'Cannot modify guardrails or disable security' };
  }
  if (desc.includes('shell') && desc.includes('whitelist')) {
    return { allowed: false, reason: 'Cannot modify shell command whitelist' };
  }

  if (task.requestedBy === 'self') {
    if (desc.includes('delete') || desc.includes('remove') || desc.includes('drop')) {
      return { allowed: false, reason: 'Self-initiated destructive tasks not allowed' };
    }
  }

  return { allowed: true };
}

export function validateCodeSafety(content: string, _filePath: string): GuardrailResult {
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(content)) {
      return {
        allowed: false,
        reason: `Code contains forbidden pattern: ${pattern.toString()}`,
      };
    }
  }
  const lines = content.split('\n').length;
  if (lines > MAX_LINES_PER_FILE) {
    return {
      allowed: false,
      reason: `File exceeds ${MAX_LINES_PER_FILE} line limit (${lines} lines)`,
    };
  }
  return { allowed: true };
}
