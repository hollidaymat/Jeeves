/**
 * Behavior Module
 * 
 * Manages Jeeves' behavioral preferences and self-review capabilities:
 * - Behavior Engine: Weighted preferences that guide decisions
 * - Self-Review: Pre-submission quality checks
 */

export {
  BehaviorEngine,
  getBehaviorEngine,
  resetBehaviorEngine,
  type BehaviorCategory,
  type BehaviorPreference,
  type BehaviorProfile,
  type BehaviorDecision
} from './behavior-engine.js';

export {
  SelfReview,
  getSelfReview,
  type CheckCategory,
  type CheckStatus,
  type CheckResult,
  type ReviewResult,
  type ReviewConfig
} from './self-review.js';
