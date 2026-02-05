/**
 * Deliberate Practice System
 * 
 * Tracks performance and identifies areas for improvement:
 * - Weekly performance reviews
 * - Skill tracking across domains
 * - Targeted practice recommendations
 * - Progress tracking over time
 */

import { logger } from '../../utils/logger.js';
import * as fs from 'fs';
import * as path from 'path';

// ==========================================
// TYPES
// ==========================================

export type SkillDomain = 
  | 'coding'
  | 'debugging'
  | 'architecture'
  | 'communication'
  | 'testing'
  | 'documentation'
  | 'refactoring'
  | 'performance';

export interface SkillMetric {
  domain: SkillDomain;
  name: string;
  score: number;  // 0-100
  samples: number;  // Number of observations
  lastUpdated: number;
  trend: 'improving' | 'stable' | 'declining';
  history: { score: number; timestamp: number }[];
}

export interface PerformanceEntry {
  id: string;
  timestamp: number;
  domain: SkillDomain;
  activity: string;
  outcome: 'excellent' | 'good' | 'satisfactory' | 'needs_improvement' | 'poor';
  score: number;  // 0-100
  notes?: string;
  context?: Record<string, unknown>;
}

export interface WeeklyReview {
  id: string;
  weekStart: number;
  weekEnd: number;
  createdAt: number;
  
  // Performance summary
  totalActivities: number;
  averageScore: number;
  byDomain: Record<SkillDomain, { count: number; avgScore: number }>;
  
  // Insights
  strengths: string[];
  weaknesses: string[];
  trends: { domain: SkillDomain; trend: string }[];
  
  // Recommendations
  practiceRecommendations: PracticeRecommendation[];
  
  // Goals
  weeklyGoals: Goal[];
  previousGoalsStatus: { goal: string; achieved: boolean }[];
}

export interface PracticeRecommendation {
  domain: SkillDomain;
  skill: string;
  reason: string;
  exercises: string[];
  priority: 'high' | 'medium' | 'low';
}

export interface Goal {
  id: string;
  description: string;
  domain: SkillDomain;
  targetScore?: number;
  deadline?: number;
  status: 'pending' | 'in_progress' | 'achieved' | 'missed';
}

// ==========================================
// SCORING CONSTANTS
// ==========================================

const OUTCOME_SCORES: Record<PerformanceEntry['outcome'], number> = {
  excellent: 95,
  good: 80,
  satisfactory: 65,
  needs_improvement: 45,
  poor: 25
};

const DOMAIN_EXERCISES: Record<SkillDomain, string[]> = {
  coding: [
    'Implement a data structure from scratch',
    'Solve algorithm challenges',
    'Build a small CLI tool',
    'Practice typing speed and accuracy'
  ],
  debugging: [
    'Practice with intentionally buggy code',
    'Learn new debugging tools',
    'Document debugging sessions',
    'Study common error patterns'
  ],
  architecture: [
    'Review and critique existing designs',
    'Practice diagramming systems',
    'Study design patterns',
    'Analyze open source architectures'
  ],
  communication: [
    'Practice explaining technical concepts simply',
    'Write clear commit messages',
    'Document code thoroughly',
    'Practice active listening'
  ],
  testing: [
    'Write tests for edge cases',
    'Practice TDD on small features',
    'Learn new testing frameworks',
    'Improve test coverage metrics'
  ],
  documentation: [
    'Write README files',
    'Document APIs clearly',
    'Create tutorials',
    'Review and improve existing docs'
  ],
  refactoring: [
    'Practice small refactors with tests',
    'Learn refactoring patterns',
    'Identify code smells',
    'Measure improvement metrics'
  ],
  performance: [
    'Profile code and identify bottlenecks',
    'Learn optimization techniques',
    'Practice benchmarking',
    'Study caching strategies'
  ]
};

// ==========================================
// DELIBERATE PRACTICE ENGINE
// ==========================================

export class DeliberatePractice {
  private skills: Map<string, SkillMetric> = new Map();
  private entries: PerformanceEntry[] = [];
  private reviews: Map<string, WeeklyReview> = new Map();
  private goals: Map<string, Goal> = new Map();
  private persistPath: string;
  
  constructor(dataDir: string = '.jeeves') {
    this.persistPath = path.join(dataDir, 'practice.json');
    this.load();
    this.initializeSkills();
  }
  
  private load(): void {
    try {
      if (fs.existsSync(this.persistPath)) {
        const data = JSON.parse(fs.readFileSync(this.persistPath, 'utf-8'));
        this.skills = new Map(Object.entries(data.skills || {}));
        this.entries = data.entries || [];
        this.reviews = new Map(Object.entries(data.reviews || {}));
        this.goals = new Map(Object.entries(data.goals || {}));
      }
    } catch (error) {
      logger.debug('Failed to load practice data', { error: String(error) });
    }
  }
  
  private persist(): void {
    try {
      const dataDir = path.dirname(this.persistPath);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      
      fs.writeFileSync(this.persistPath, JSON.stringify({
        skills: Object.fromEntries(this.skills),
        entries: this.entries.slice(-1000),  // Keep last 1000
        reviews: Object.fromEntries(this.reviews),
        goals: Object.fromEntries(this.goals)
      }, null, 2));
    } catch (error) {
      logger.error('Failed to persist practice data', { error: String(error) });
    }
  }
  
  private initializeSkills(): void {
    const domains: SkillDomain[] = [
      'coding', 'debugging', 'architecture', 'communication',
      'testing', 'documentation', 'refactoring', 'performance'
    ];
    
    for (const domain of domains) {
      const key = `skill_${domain}`;
      if (!this.skills.has(key)) {
        this.skills.set(key, {
          domain,
          name: domain.charAt(0).toUpperCase() + domain.slice(1),
          score: 50,  // Start at neutral
          samples: 0,
          lastUpdated: Date.now(),
          trend: 'stable',
          history: []
        });
      }
    }
  }
  
  // ==========================================
  // PERFORMANCE TRACKING
  // ==========================================
  
  /**
   * Record a performance entry
   */
  recordPerformance(
    domain: SkillDomain,
    activity: string,
    outcome: PerformanceEntry['outcome'],
    notes?: string
  ): PerformanceEntry {
    const entry: PerformanceEntry = {
      id: `perf_${Date.now()}`,
      timestamp: Date.now(),
      domain,
      activity,
      outcome,
      score: OUTCOME_SCORES[outcome],
      notes
    };
    
    this.entries.push(entry);
    this.updateSkillMetric(domain, entry.score);
    this.persist();
    
    logger.debug('Performance recorded', { domain, outcome, score: entry.score });
    
    return entry;
  }
  
  /**
   * Update skill metric based on new entry
   */
  private updateSkillMetric(domain: SkillDomain, score: number): void {
    const key = `skill_${domain}`;
    const skill = this.skills.get(key);
    
    if (!skill) return;
    
    // Weighted moving average (recent scores matter more)
    const weight = 0.3;  // New observation weight
    skill.score = skill.score * (1 - weight) + score * weight;
    skill.samples++;
    skill.lastUpdated = Date.now();
    
    // Update history
    skill.history.push({ score: skill.score, timestamp: Date.now() });
    if (skill.history.length > 100) {
      skill.history.shift();
    }
    
    // Calculate trend
    skill.trend = this.calculateTrend(skill.history);
  }
  
  private calculateTrend(
    history: { score: number; timestamp: number }[]
  ): 'improving' | 'stable' | 'declining' {
    if (history.length < 5) return 'stable';
    
    const recent = history.slice(-5);
    const older = history.slice(-10, -5);
    
    if (older.length === 0) return 'stable';
    
    const recentAvg = recent.reduce((s, h) => s + h.score, 0) / recent.length;
    const olderAvg = older.reduce((s, h) => s + h.score, 0) / older.length;
    
    const diff = recentAvg - olderAvg;
    
    if (diff > 5) return 'improving';
    if (diff < -5) return 'declining';
    return 'stable';
  }
  
  // ==========================================
  // WEEKLY REVIEWS
  // ==========================================
  
  /**
   * Generate weekly review
   */
  generateWeeklyReview(): WeeklyReview {
    const now = Date.now();
    const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
    
    // Get this week's entries
    const weekEntries = this.entries.filter(e => e.timestamp >= weekAgo);
    
    // Calculate by-domain stats
    const byDomain: Record<SkillDomain, { count: number; avgScore: number }> = {} as Record<SkillDomain, { count: number; avgScore: number }>;
    const domains: SkillDomain[] = [
      'coding', 'debugging', 'architecture', 'communication',
      'testing', 'documentation', 'refactoring', 'performance'
    ];
    
    for (const domain of domains) {
      const domainEntries = weekEntries.filter(e => e.domain === domain);
      byDomain[domain] = {
        count: domainEntries.length,
        avgScore: domainEntries.length > 0
          ? domainEntries.reduce((s, e) => s + e.score, 0) / domainEntries.length
          : 0
      };
    }
    
    // Identify strengths and weaknesses
    const strengths: string[] = [];
    const weaknesses: string[] = [];
    
    for (const [domain, stats] of Object.entries(byDomain)) {
      if (stats.count > 0) {
        if (stats.avgScore >= 80) {
          strengths.push(`Strong ${domain} performance (${stats.avgScore.toFixed(0)}% avg)`);
        } else if (stats.avgScore < 60) {
          weaknesses.push(`${domain} needs attention (${stats.avgScore.toFixed(0)}% avg)`);
        }
      }
    }
    
    // Get skill trends
    const trends: { domain: SkillDomain; trend: string }[] = [];
    for (const skill of this.skills.values()) {
      if (skill.trend !== 'stable') {
        trends.push({ domain: skill.domain, trend: skill.trend });
      }
    }
    
    // Generate practice recommendations
    const recommendations = this.generateRecommendations(byDomain, weekEntries);
    
    // Check previous goals
    const previousGoalsStatus = this.checkGoalProgress();
    
    // Create new goals
    const weeklyGoals = this.suggestWeeklyGoals(byDomain);
    
    const review: WeeklyReview = {
      id: `review_${Date.now()}`,
      weekStart: weekAgo,
      weekEnd: now,
      createdAt: now,
      totalActivities: weekEntries.length,
      averageScore: weekEntries.length > 0
        ? weekEntries.reduce((s, e) => s + e.score, 0) / weekEntries.length
        : 0,
      byDomain,
      strengths,
      weaknesses,
      trends,
      practiceRecommendations: recommendations,
      weeklyGoals,
      previousGoalsStatus
    };
    
    this.reviews.set(review.id, review);
    this.persist();
    
    logger.debug('Weekly review generated', { 
      activities: review.totalActivities,
      avgScore: review.averageScore.toFixed(1)
    });
    
    return review;
  }
  
  /**
   * Generate practice recommendations based on performance
   */
  private generateRecommendations(
    byDomain: Record<SkillDomain, { count: number; avgScore: number }>,
    _entries: PerformanceEntry[]
  ): PracticeRecommendation[] {
    const recommendations: PracticeRecommendation[] = [];
    
    // Find lowest performing domains
    const sortedDomains = Object.entries(byDomain)
      .filter(([_, stats]) => stats.count > 0)
      .sort(([_, a], [__, b]) => a.avgScore - b.avgScore);
    
    for (const [domain, stats] of sortedDomains.slice(0, 3)) {
      if (stats.avgScore < 80) {
        const exercises = DOMAIN_EXERCISES[domain as SkillDomain] || [];
        
        recommendations.push({
          domain: domain as SkillDomain,
          skill: domain,
          reason: stats.avgScore < 60 
            ? 'Significantly below target performance'
            : 'Room for improvement',
          exercises: exercises.slice(0, 2),
          priority: stats.avgScore < 60 ? 'high' : 'medium'
        });
      }
    }
    
    // Add recommendation for domains with no activity
    const inactiveDomains = Object.entries(byDomain)
      .filter(([_, stats]) => stats.count === 0)
      .map(([domain]) => domain as SkillDomain);
    
    if (inactiveDomains.length > 0) {
      const domain = inactiveDomains[0];
      recommendations.push({
        domain,
        skill: domain,
        reason: 'No recent practice in this area',
        exercises: (DOMAIN_EXERCISES[domain] || []).slice(0, 2),
        priority: 'low'
      });
    }
    
    return recommendations;
  }
  
  /**
   * Suggest weekly goals
   */
  private suggestWeeklyGoals(
    byDomain: Record<SkillDomain, { count: number; avgScore: number }>
  ): Goal[] {
    const goals: Goal[] = [];
    
    // Goal for weakest domain
    const weakest = Object.entries(byDomain)
      .filter(([_, stats]) => stats.count > 0)
      .sort(([_, a], [__, b]) => a.avgScore - b.avgScore)[0];
    
    if (weakest && weakest[1].avgScore < 80) {
      goals.push({
        id: `goal_${Date.now()}_1`,
        description: `Improve ${weakest[0]} score to 70%`,
        domain: weakest[0] as SkillDomain,
        targetScore: 70,
        deadline: Date.now() + 7 * 24 * 60 * 60 * 1000,
        status: 'pending'
      });
    }
    
    // Goal for consistency
    goals.push({
      id: `goal_${Date.now()}_2`,
      description: 'Complete at least 10 activities across all domains',
      domain: 'coding',  // Default
      deadline: Date.now() + 7 * 24 * 60 * 60 * 1000,
      status: 'pending'
    });
    
    // Store goals
    for (const goal of goals) {
      this.goals.set(goal.id, goal);
    }
    
    return goals;
  }
  
  /**
   * Check progress on existing goals
   */
  private checkGoalProgress(): { goal: string; achieved: boolean }[] {
    const results: { goal: string; achieved: boolean }[] = [];
    
    for (const goal of this.goals.values()) {
      if (goal.status === 'pending' || goal.status === 'in_progress') {
        const skill = this.skills.get(`skill_${goal.domain}`);
        const achieved = goal.targetScore 
          ? (skill?.score || 0) >= goal.targetScore
          : false;
        
        results.push({
          goal: goal.description,
          achieved
        });
        
        goal.status = achieved ? 'achieved' : 
          (goal.deadline && Date.now() > goal.deadline) ? 'missed' : 'in_progress';
      }
    }
    
    return results;
  }
  
  // ==========================================
  // QUERIES
  // ==========================================
  
  /**
   * Get current skill levels
   */
  getSkillLevels(): SkillMetric[] {
    return Array.from(this.skills.values());
  }
  
  /**
   * Get skill by domain
   */
  getSkill(domain: SkillDomain): SkillMetric | undefined {
    return this.skills.get(`skill_${domain}`);
  }
  
  /**
   * Get recent reviews
   */
  getRecentReviews(limit: number = 5): WeeklyReview[] {
    return Array.from(this.reviews.values())
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }
  
  /**
   * Get active goals
   */
  getActiveGoals(): Goal[] {
    return Array.from(this.goals.values())
      .filter(g => g.status === 'pending' || g.status === 'in_progress');
  }
  
  // ==========================================
  // REPORTING
  // ==========================================
  
  /**
   * Format weekly review as markdown
   */
  formatReview(review: WeeklyReview): string {
    const lines: string[] = [];
    
    lines.push('# Weekly Performance Review');
    lines.push(`**Period:** ${new Date(review.weekStart).toLocaleDateString()} - ${new Date(review.weekEnd).toLocaleDateString()}`);
    lines.push('');
    
    lines.push('## Summary');
    lines.push(`- Total Activities: ${review.totalActivities}`);
    lines.push(`- Average Score: ${review.averageScore.toFixed(1)}%`);
    lines.push('');
    
    if (review.strengths.length > 0) {
      lines.push('## Strengths');
      review.strengths.forEach(s => lines.push(`- ✅ ${s}`));
      lines.push('');
    }
    
    if (review.weaknesses.length > 0) {
      lines.push('## Areas for Improvement');
      review.weaknesses.forEach(w => lines.push(`- ⚠️ ${w}`));
      lines.push('');
    }
    
    if (review.trends.length > 0) {
      lines.push('## Trends');
      review.trends.forEach(t => {
        const icon = t.trend === 'improving' ? '📈' : '📉';
        lines.push(`- ${icon} ${t.domain}: ${t.trend}`);
      });
      lines.push('');
    }
    
    if (review.practiceRecommendations.length > 0) {
      lines.push('## Practice Recommendations');
      for (const rec of review.practiceRecommendations) {
        lines.push(`### ${rec.domain.charAt(0).toUpperCase() + rec.domain.slice(1)} [${rec.priority}]`);
        lines.push(`_${rec.reason}_`);
        lines.push('Exercises:');
        rec.exercises.forEach(e => lines.push(`- ${e}`));
        lines.push('');
      }
    }
    
    if (review.weeklyGoals.length > 0) {
      lines.push('## Goals for Next Week');
      review.weeklyGoals.forEach(g => lines.push(`- [ ] ${g.description}`));
    }
    
    return lines.join('\n');
  }
  
  /**
   * Get overall statistics
   */
  getStats(): {
    totalEntries: number;
    averageScore: number;
    topDomain: SkillDomain | null;
    weakestDomain: SkillDomain | null;
    activeGoals: number;
  } {
    const skills = Array.from(this.skills.values()).filter(s => s.samples > 0);
    
    const sorted = [...skills].sort((a, b) => b.score - a.score);
    
    return {
      totalEntries: this.entries.length,
      averageScore: skills.length > 0
        ? skills.reduce((s, sk) => s + sk.score, 0) / skills.length
        : 0,
      topDomain: sorted[0]?.domain || null,
      weakestDomain: sorted[sorted.length - 1]?.domain || null,
      activeGoals: Array.from(this.goals.values())
        .filter(g => g.status === 'pending' || g.status === 'in_progress').length
    };
  }
}

// ==========================================
// SINGLETON INSTANCE
// ==========================================

let instance: DeliberatePractice | null = null;

export function getDeliberatePractice(dataDir?: string): DeliberatePractice {
  if (!instance) {
    instance = new DeliberatePractice(dataDir);
  }
  return instance;
}
