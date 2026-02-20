/**
 * Antigravity Orchestrator types
 * Shared across PRD intake, spec generator, executor, validator, observer.
 */

export interface PRDRequest {
  title: string;
  description: string;
  acceptance_criteria?: string[];
  /** Optional: project root for context (e.g. from active project). */
  projectPath?: string;
}

export interface AntigravitySpec {
  task_id: string;
  title: string;
  description: string;
  acceptance_criteria: string[];
  files_to_modify: string[];
  files_to_create: string[];
  dependencies: string[];
  test_command: string;
  estimated_complexity: 'low' | 'medium' | 'high';
  context: {
    architecture_notes: string;
    existing_patterns: string[];
    gotchas: string[];
    previous_winning_patterns?: string[];
    common_mistakes?: string[];
  };
}

export interface ExecutionResult {
  task_id: string;
  status: 'completed' | 'failed';
  artifacts?: string[];
  test_results: {
    passed: boolean;
    error?: string;
    output?: string;
  };
  duration_ms: number;
  stdout?: string;
  stderr?: string;
  /** When ANTIGRAVITY_SERVE_WEB=true, URL to open in browser for QA. */
  serve_web_url?: string;
}

export interface IterationResult {
  status: 'success' | 'escalate' | 'retry';
  iteration_count?: number;
  code_quality?: string;
  ready_to_deploy?: boolean;
  error?: string;
  message?: string;
  iteration?: number;
  action?: 'jeeves_fixes' | 'antigravity_retry';
  fix?: string;
  feedback?: string;
}

export interface OrchestrationResult {
  success: boolean;
  needsClarification?: boolean;
  questions?: string[];
  task_id?: string;
  status?: 'success' | 'escalated' | 'in_progress' | 'handoff';
  message: string;
  iteration_count?: number;
  final_code?: string;
  /** Set when handoffOnly: spec file path for Antigravity. */
  spec_path?: string;
}

export interface Playbook {
  pattern: string;
  success_rate: number;
  avg_iterations: number;
  common_errors: string[];
  winning_spec_template: string;
  last_updated: number;
}

export interface InteractionRecord {
  task_id: string;
  prd: string;
  spec_generated: AntigravitySpec;
  executions: Array<{
    iteration: number;
    antigravity_input: string;
    antigravity_output: string;
    test_result: 'pass' | 'fail';
    error?: string;
    jeeves_action?: string;
  }>;
  final_status: 'success' | 'escalated' | 'user_helped';
  total_iterations: number;
  total_duration_ms: number;
  generated_code?: string;
  test_results?: unknown;
}
