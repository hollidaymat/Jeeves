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
  | 'unknown'
  | 'denied';

export interface ParsedIntent {
  action: ActionType;
  target?: string;
  resolved_path?: string;
  command?: string;
  line?: number;
  prompt?: string;  // For agent commands
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
  type: 'command' | 'status' | 'log' | 'projects' | 'response' | 'agent_status' | 'pending_changes';
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
// Handler
// ============================================================================

export interface MessageInterface {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(message: OutgoingMessage): Promise<void>;
  onMessage(handler: (message: IncomingMessage) => Promise<void>): void;
}
