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
  path?: string;           // File path (for Signal attachments)
  data?: string;           // Base64 data (for web uploads)
  name?: string;           // Original filename
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
  | 'trust_status'      // Show current trust level
  | 'trust_upgrade'     // Request trust upgrade
  | 'trust_history'     // Show trust history
  | 'show_learned'      // Show learned preferences
  | 'remember'          // Save a personality preference
  | 'set_role'          // Set Jeeves' role/identity
  | 'add_trait'         // Add a personality trait
  | 'browse'            // Navigate to a URL and get content
  | 'screenshot'        // Take a screenshot of a page
  | 'browser_click'     // Click an element on the page
  | 'browser_type'      // Type text into an element
  | 'browser_close'     // Close the browser
  | 'dev_start'         // Start dev server
  | 'dev_stop'          // Stop dev server
  | 'dev_preview'       // Open dev server in browser
  | 'dev_status'        // Get dev server status
  | 'api_get'           // API test: GET request
  | 'api_post'          // API test: POST request
  | 'api_put'           // API test: PUT request
  | 'api_patch'         // API test: PATCH request
  | 'api_delete'        // API test: DELETE request
  | 'api_history'       // API test: show request history
  | 'execute_plan'      // Execute pending plan
  | 'set_model'         // Set model (haiku/sonnet/opus/auto)
  | 'list_backups'      // List available backups for a file
  | 'restore_backup'    // Restore a file from backup
  | 'show_cost'         // Show cost/budget information
  | 'show_builds'       // Show build history
  | 'show_lessons'      // Show lessons learned
  | 'compact_session'   // Compact/summarize long conversation history
  | 'create_project'    // Create a new project
  | 'autonomous_build'  // Autonomous build from PRD
  | 'agent_build'       // Build with agent
  | 'apply_last'        // Apply last suggested changes
  // Homelab actions
  | 'homelab_status'          // Full system status
  | 'homelab_containers'      // List containers
  | 'homelab_resources'       // CPU/RAM/disk usage
  | 'homelab_temps'           // CPU temperature
  | 'homelab_service_start'   // Start a service
  | 'homelab_service_stop'    // Stop a service
  | 'homelab_service_restart' // Restart a service
  | 'homelab_logs'            // Get service logs
  | 'homelab_update'          // Update a service
  | 'homelab_update_all'      // Update all services
  | 'homelab_install'         // Install a service
  | 'homelab_uninstall'       // Uninstall a service
  | 'homelab_diagnose'        // Run diagnostics on a service
  | 'homelab_stacks'          // List docker compose stacks
  | 'homelab_health'          // Run health checks
  | 'homelab_self_test'       // Run self-test suite
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

// Image attachment from web interface
export interface ImageAttachment {
  name: string;
  data: string; // base64 data URL
  mimeType?: string;
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
  requiresAsync?: boolean;  // Action needs async handling
  data?: Record<string, unknown>;  // Additional data for the action
  attachments?: ImageAttachment[];  // Image attachments from web interface
  // Token optimization tracking
  resolutionMethod?: 'pattern' | 'llm';  // How intent was resolved
  estimatedCost?: number;  // Estimated cost in dollars (0 for pattern-matched)
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
    checkpoint_frequency: 'per-phase' | 'hourly' | 'on-decision' | 'none';
    auto_commit: boolean;
    branch_strategy: 'feature-branch' | 'direct' | 'none';
    pause_timeout_minutes: number;
  };
  trust: {
    enabled: boolean;
    initial_level: TrustLevelNumber;
    successful_tasks_required: number;
    rollbacks_allowed: number;
    time_at_level_minimum_days: number;
    monthly_spend_limit: number;
    per_task_spend_limit: number;
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
  safety: {
    backupEnabled: boolean;
    backupRetentionHours: number;
    maxShrinkagePercent: number;
    validateContent: boolean;
    atomicWrites: boolean;
    gitAutoStash: boolean;
  };
  homelab: HomelabConfig;
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
  type: 'command' | 'status' | 'log' | 'projects' | 'response' | 'agent_status' | 'pending_changes' | 'prd_status' | 'prd_checkpoint' | 'stream_start' | 'stream_chunk' | 'stream_end';
  payload: unknown;
}

export interface AgentStatus {
  active: boolean;
  workingDir?: string;
  uptime?: number;
  contextSize?: number;
  pendingChanges?: number;
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
  generalConversations: ConversationMessage[];  // non-project conversations
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
  decisions?: string[];       // Technical decisions made (what was chosen)
  decisionPoints?: string[];  // Legacy: Questions (deprecated, use decisions)
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
// Trust System (Phase 6)
// ============================================================================

export type TrustLevelNumber = 1 | 2 | 3 | 4 | 5;

export interface TrustLevelPermissions {
  name: 'supervised' | 'semi-autonomous' | 'trusted' | 'autonomous' | 'full-trust';
  canCommit: boolean;
  canSpend: boolean | { max: number };
  canContact: boolean | { draftsOnly?: boolean; preApprovedTemplates?: boolean };
  checkpointFrequency: 'every-change' | 'per-phase' | 'per-task' | 'on-completion';
  requiresApproval: string[];
}

export interface TrustHistoryEntry {
  date: string;
  level: TrustLevelNumber;
  reason: string;
  taskId?: string;
}

export interface TaskRecord {
  id: string;
  type: 'prd' | 'edit' | 'terminal' | 'other';
  description: string;
  startedAt: string;
  completedAt?: string;
  success: boolean;
  rollback: boolean;
  spendAmount?: number;
  corrections: number;  // Number of user corrections during task
}

export interface TrustState {
  currentLevel: TrustLevelNumber;
  history: TrustHistoryEntry[];
  taskHistory: TaskRecord[];
  successfulTasksAtLevel: number;
  daysAtLevel: number;
  levelStartDate: string;
  totalSpend: number;
  totalSpendLimit: number;
}

export interface LearnedPreferences {
  codeStyle: {
    prefersFunctionalComponents?: boolean;
    prefersNamedExports?: boolean;
    errorHandlingPattern?: string;
    preferredLibraries?: Record<string, boolean>;
    projectStructure?: string;
    testingApproach?: string;
    confidence: number;
  };
  communication: {
    prefersConcisenessOver?: 'thoroughness' | 'detail';
    checkpointFrequency?: 'per-phase' | 'per-task' | 'on-completion';
    wantsExplanationsFor?: string[];
    doesNotWantExplanationsFor?: string[];
    confidence: number;
  };
  decisions: {
    whenUncertain?: 'ask' | 'decide' | 'conservative';
    deviationThreshold?: 'low' | 'medium' | 'high';
    autonomousSpendingLimit?: number;
    confidence: number;
  };
  personality: {
    role?: string;  // e.g., "AI employee, not assistant"
    traits: string[];  // e.g., ["direct", "professional", "proactive"]
    rememberStatements: string[];  // Explicit things user told Jeeves to remember
    dontDoStatements: string[];  // Things user said NOT to do
    confidence: number;
  };
  corrections: CorrectionRecord[];
}

export interface CorrectionRecord {
  timestamp: string;
  original: string;
  corrected: string;
  category: 'code-style' | 'library' | 'approach' | 'communication' | 'other';
  learned: string;  // What was learned from this correction
}

export interface TrustConfig {
  enabled: boolean;
  initialLevel: TrustLevelNumber;
  successfulTasksRequired: number;
  rollbacksAllowed: number;
  timeAtLevelMinimumDays: number;
  monthlySpendLimit: number;
  perTaskSpendLimit: number;
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

// ============================================================================
// Browser Automation (Web Browsing)
// ============================================================================

export type BrowserActionType = 
  | 'navigate'
  | 'screenshot'
  | 'get_content'
  | 'click'
  | 'type'
  | 'scroll'
  | 'wait';

export interface BrowserAction {
  type: BrowserActionType;
  url?: string;
  selector?: string;
  text?: string;
  waitMs?: number;
  options?: BrowserActionOptions;
}

export interface BrowserActionOptions {
  waitForNavigation?: boolean;
  fullPage?: boolean;  // For screenshots
  extractStyles?: boolean;
  maxContentLength?: number;
}

export interface BrowserResult {
  success: boolean;
  action: BrowserActionType;
  url?: string;
  title?: string;
  content?: string;  // Sanitized text/markdown content
  screenshotPath?: string;
  screenshotBase64?: string;
  error?: string;
  securityWarnings?: string[];
  actionLog?: BrowserActionLogEntry[];
}

export interface BrowserActionLogEntry {
  timestamp: string;
  action: BrowserActionType;
  target?: string;  // URL or selector
  result: 'success' | 'failed' | 'blocked';
  reason?: string;
}

export interface BrowserSecurityConfig {
  allowedDomains?: string[];  // Whitelist for interactive actions
  blockedDomains?: string[];  // Blacklist
  maxContentLength: number;
  stripScripts: boolean;
  stripStyles: boolean;
  stripComments: boolean;
  detectInjection: boolean;
  incognito: boolean;
  blockDownloads: boolean;
  blockPopups: boolean;
}

export interface InjectionPattern {
  pattern: RegExp;
  severity: 'low' | 'medium' | 'high';
  description: string;
}

// ============================================================================
// Homelab Types
// ============================================================================

export type ServiceTier = 'core' | 'media' | 'services' | 'databases' | 'monitoring';
export type ServicePriority = 'critical' | 'high' | 'medium' | 'low';
export type ServiceState = 'running' | 'stopped' | 'error' | 'unknown' | 'restarting';

export interface ServiceDefinition {
  name: string;
  tier: ServiceTier;
  image: string;
  ports: number[];
  ram: string;                   // e.g., '256MB'
  purpose: string;
  priority: ServicePriority;
  depends: string[];
  type?: 'container' | 'system-service';
  devices?: string[];            // e.g., ['/dev/dri:/dev/dri']
  networkMode?: string;          // e.g., 'host'
  healthEndpoint?: string;       // HTTP health check URL
  healthPort?: number;           // TCP health check port
}

export interface ServiceStatus {
  name: string;
  state: ServiceState;
  uptime?: string;
  cpu?: string;
  memory?: string;
  memoryLimit?: string;
  restarts?: number;
  lastError?: string;
}

export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  state: ServiceState;
  status: string;               // Docker's status string (e.g., "Up 3 hours")
  ports: string[];
  created: string;
  health?: string;              // healthy | unhealthy | starting | none
}

export interface ContainerStats {
  name: string;
  cpuPercent: string;
  memUsage: string;
  memLimit: string;
  memPercent: string;
  netIO: string;
  blockIO: string;
}

export interface SystemResourceStatus {
  cpu: {
    usagePercent: number;
    loadAverage: [number, number, number];   // 1m, 5m, 15m
    cores: number;
  };
  ram: {
    totalMB: number;
    usedMB: number;
    freeMB: number;
    availableMB: number;
    usagePercent: number;
  };
  disk: {
    filesystem: string;
    totalGB: number;
    usedGB: number;
    availableGB: number;
    usagePercent: number;
    mountPoint: string;
  }[];
  temperature: {
    celsius: number;
    status: 'normal' | 'warning' | 'critical';
  } | null;
  network?: {
    interface: string;
    rxBytes: number;
    txBytes: number;
  }[];
}

export interface HomelabThresholds {
  cpu: { warning: number; critical: number };
  ram: { warning: number; critical: number };
  disk: { warning: number; critical: number };
  temp: { warning: number; critical: number };
}

export interface ThresholdAlert {
  metric: 'cpu' | 'ram' | 'disk' | 'temp';
  level: 'warning' | 'critical';
  value: number;
  threshold: number;
  message: string;
}

export interface HealthCheckResult {
  service: string;
  healthy: boolean;
  checks: {
    type: 'http' | 'tcp' | 'docker' | 'command';
    target: string;
    passed: boolean;
    responseTime?: number;
    error?: string;
  }[];
  timestamp: string;
}

export interface StackInfo {
  name: string;
  path: string;
  services: string[];
  running: boolean;
}

export interface ShellCommandResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  duration_ms: number;
  command: string;
}

export interface HomelabConfig {
  enabled: boolean;
  stacksDir: string;
  configsDir: string;
  backupsDir: string;
  dataDir: string;
  maxRamMB: number;
  monitorInterval: number;
  thresholds: HomelabThresholds;
}
