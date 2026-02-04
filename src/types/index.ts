/**
 * Signal Cursor Controller - Type Definitions
 */

// ============================================================================
// Message Types
// ============================================================================

export interface IncomingMessage {
  id: string;
  sender: string;
  content: string;
  timestamp: Date;
  interface: 'signal' | 'web' | 'mock';
  attachments?: Attachment[];
}

export interface Attachment {
  type: 'image' | 'audio' | 'file';
  path: string;
  mimeType: string;
}

export interface OutgoingMessage {
  recipient: string;
  content: string;
  replyTo?: string;
}

// ============================================================================
// Intent Parsing
// ============================================================================

export type ActionType = 
  | 'open_project'
  | 'open_file'
  | 'goto_line'
  | 'status'
  | 'help'
  | 'list_projects'
  | 'agent_start'
  | 'agent_ask'
  | 'agent_stop'
  | 'agent_status'
  | 'read_file'
  | 'edit_file'
  | 'apply_changes'
  | 'reject_changes'
  | 'show_diff'
  | 'terminal_run'      // Run a terminal command
  | 'terminal_npm'      // npm commands (install, run, etc)
  | 'terminal_git'      // git commands (status, pull, etc)
  | 'terminal_stop'     // Stop running terminal process
  | 'memory_history'    // Show conversation history
  | 'memory_clear'      // Clear conversation history
  | 'memory_summary'    // Show project summary
  | 'set_preference'    // Set a user preference
  | 'prd_submit'        // Submit a PRD for execution
  | 'prd_approve'       // Approve execution plan
  | 'prd_pause'         // Pause PRD execution
  | 'prd_resume'        // Resume PRD execution
  | 'prd_status'        // Check PRD execution status
  | 'prd_abort'         // Abort PRD execution
  | 'unknown'
  | 'denied';

// ============================================================================
// Terminal Commands
// ============================================================================

export interface TerminalCommand {
  type: 'npm' | 'git' | 'custom';
  command: string;
  args: string[];
  workingDir: string;
}

export interface TerminalResult {
  success: boolean;
  output: string;
  error?: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
  duration_ms: number;
}

export interface ParsedIntent {
  action: ActionType;
  target?: string;
  resolved_path?: string;
  command?: string;
  line?: number;
  prompt?: string;  // For agent commands
  terminal_command?: TerminalCommand;  // For terminal actions
  confidence: number;
  message?: string;
  raw_response?: string;
}

// ============================================================================
// Command Execution
// ============================================================================

export interface ExecutionResult {
  success: boolean;
  output?: string;
  error?: string;
  duration_ms: number;
}

// ============================================================================
// Project Scanner
// ============================================================================

export interface Project {
  name: string;
  path: string;
  type: 'node' | 'rust' | 'go' | 'python' | 'unknown';
  last_modified: Date;
}

export interface ProjectIndex {
  projects: Map<string, Project>;
  scanned_at: Date;
}

// ============================================================================
// Configuration
// ============================================================================

export interface Config {
  signal: {
    number: string;
    socket: string;
  };
  security: {
    allowed_numbers: string[];
    log_unauthorized: boolean;
    silent_deny: boolean;
  };
  claude: {
    model: string;
    haiku_model: string;
    max_tokens: number;
  };
  projects: {
    directories: string[];
    scan_depth: number;
    markers: string[];
    exclude: string[];
  };
  commands: {
    cursor: string;
  };
  terminal: {
    timeout_ms: number;
    max_output_lines: number;
    max_output_chars: number;
    allowed_npm_scripts: string[];
    allowed_git_commands: string[];
    custom_commands: Record<string, string>;
  };
  memory: {
    enabled: boolean;
    max_conversations_per_project: number;
    max_messages_per_conversation: number;
    storage_path: string;
    auto_summarize: boolean;
  };
  prd: {
    enabled: boolean;
    triggers: string[];
    auto_approve: boolean;
    checkpoint_frequency: 'per-phase' | 'hourly' | 'on-decision';
    auto_commit: boolean;
    branch_strategy: 'feature-branch' | 'direct' | 'none';
    pause_timeout_minutes: number;
  };
  server: {
    host: string;
    port: number;
  };
  rate_limits: {
    messages_per_minute: number;
    messages_per_hour: number;
    messages_per_day: number;
  };
}

// ============================================================================
// Logging
// ============================================================================

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  data?: Record<string, unknown>;
}

// ============================================================================
// Web UI / WebSocket
// ============================================================================

export interface WSMessage {
  type: 'command' | 'status' | 'log' | 'projects' | 'response' | 'agent_status' | 'pending_changes' | 'prd_status' | 'prd_checkpoint';
  payload: unknown;
}

export interface AgentStatus {
  active: boolean;
  workingDir?: string;
  uptime?: number;
  contextSize?: number;
}

export interface SystemStatus {
  uptime_seconds: number;
  interfaces: {
    signal: 'connected' | 'disconnected' | 'unavailable';
    web: 'connected' | 'disconnected';
  };
  projects_loaded: number;
  messages_today: number;
  last_command?: {
    action: string;
    timestamp: string;
    success: boolean;
  };
  agent?: AgentStatus;
}

// ============================================================================
// Memory & Context
// ============================================================================

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  filesDiscussed?: string[];  // Files mentioned in this message
}

export interface ProjectMemory {
  projectPath: string;
  projectName: string;
  conversations: ConversationMessage[];
  lastAccessed: string;
  filesDiscussed: string[];  // All files ever discussed
  summary?: string;  // AI-generated summary of work done
}

export interface UserPreferences {
  defaultProject?: string;
  preferredModel?: string;
  verboseMode?: boolean;
  autoApplyChanges?: boolean;
}

export interface MemoryStore {
  version: number;
  preferences: UserPreferences;
  projects: Record<string, ProjectMemory>;  // keyed by project path
  lastUpdated: string;
}

// ============================================================================
// PRD Execution (Phase 5)
// ============================================================================

export type PrdPhaseStatus = 'pending' | 'planning' | 'awaiting_approval' | 'executing' | 'paused' | 'completed' | 'failed';

export interface PrdPhase {
  id: string;
  name: string;
  description: string;
  estimatedDuration: string;  // e.g., "30min", "1hr"
  decisionPoints: string[];   // Questions that may need user input
  status: PrdPhaseStatus;
  startedAt?: string;
  completedAt?: string;
  result?: string;
  filesCreated?: string[];
  filesModified?: string[];
}

export interface ExecutionPlan {
  id: string;
  prdContent: string;         // Original PRD text
  projectPath: string;
  projectName: string;
  phases: PrdPhase[];
  totalEstimate: string;      // e.g., "4 hours"
  confidence: number;         // 0-100
  constraints: string[];      // User-specified constraints
  createdAt: string;
  approvedAt?: string;
  completedAt?: string;
  status: 'planning' | 'awaiting_approval' | 'executing' | 'paused' | 'completed' | 'failed';
  currentPhaseIndex: number;
  deviations: PrdDeviation[];
  branchName?: string;
}

export interface PrdDeviation {
  phase: string;
  prdSaid: string;
  actualDid: string;
  reasoning: string;
  timestamp: string;
}

export interface PrdCheckpoint {
  phaseId: string;
  phaseName: string;
  message: string;
  decisions: string[];
  filesChanged: string[];
  timestamp: string;
  requiresResponse: boolean;
}

export interface PrdModeConfig {
  enabled: boolean;
  triggers: string[];
  autoApprove: boolean;       // Skip plan approval step
  checkpointFrequency: 'per-phase' | 'hourly' | 'on-decision';
  autoCommit: boolean;
  branchStrategy: 'feature-branch' | 'direct' | 'none';
  pauseTimeoutMinutes: number; // How long to wait before auto-continuing
}

// ============================================================================
// Handler
// ============================================================================

export interface MessageInterface {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(message: OutgoingMessage): Promise<void>;
  onMessage(handler: (message: IncomingMessage) => Promise<void>): void;
}
