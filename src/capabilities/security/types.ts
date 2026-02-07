/**
 * Vercel Security Guardian — Type Definitions
 *
 * Shared types for the security monitoring, alerting, and automated-response
 * subsystem.  All thresholds intentionally default to conservative values so
 * the guardian can run out-of-the-box without configuration.
 */

// ============================================================================
// Thresholds
// ============================================================================

export interface SecurityThresholds {
  /** Percentage of requests returning 5xx (default: 5) */
  errorRate: number;
  /** p95 response time in milliseconds (default: 3000) */
  responseTime: number;
  /** Percentage increase in traffic over baseline (default: 300) */
  trafficSpike: number;
  /** New denied IPs per hour (default: 10) */
  newDeniedIPs: number;
  /** Consecutive failed deployments (default: 2) */
  failedDeploys: number;
}

export const DEFAULT_THRESHOLDS: SecurityThresholds = {
  errorRate: 5,
  responseTime: 3000,
  trafficSpike: 300,
  newDeniedIPs: 10,
  failedDeploys: 2,
};

// ============================================================================
// Enums / Unions
// ============================================================================

export type SecurityStatus = 'secure' | 'warning' | 'critical';
export type EventSeverity = 'high' | 'medium' | 'low' | 'info';
export type ResponseAction =
  | 'traffic_spike'
  | 'error_spike'
  | 'ssl_expiry'
  | 'deploy_failed'
  | 'bot_traffic';

// ============================================================================
// Event & Status Models
// ============================================================================

export interface SecurityEvent {
  id: string;
  projectId: string;
  projectName: string;
  type: ResponseAction;
  severity: EventSeverity;
  message: string;
  timestamp: string;
  autoActionsTaken: string[];
  resolved: boolean;
}

export interface ProjectSecurityStatus {
  projectId: string;
  projectName: string;
  domain: string;
  status: SecurityStatus;
  errorRate: number;
  responseTime: number;
  blockedToday: number;
  activeThreats: number;
  attackMode: boolean;
  lastChecked: string;
}

// ============================================================================
// Dashboard Aggregate
// ============================================================================

export interface SecurityDashboardData {
  portfolio: {
    totalProjects: number;
    allHealthy: boolean;
    totalBlocked: number;
    incidents24h: number;
  };
  projects: ProjectSecurityStatus[];
  recentEvents: SecurityEvent[];
}

// ============================================================================
// Persisted Events File Shape
// ============================================================================

export interface SecurityEventsFile {
  events: SecurityEvent[];
  lastUpdated: string;
}
