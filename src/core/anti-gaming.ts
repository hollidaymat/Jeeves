/**
 * Anti-Gaming Detector
 * Detects patterns that suggest test gaming (e.g. inflated pass rates from
 * narrow scenario selection or response-time manipulation).
 */

import { getGrowthStats } from './growth-tracker.js';

export interface AntiGamingSignal {
  type: string;
  severity: 'low' | 'medium' | 'high';
  message: string;
  detail?: Record<string, unknown>;
}

/**
 * Analyze recent scenario runs for gaming signals.
 */
export function detectGamingSignals(): AntiGamingSignal[] {
  const signals: AntiGamingSignal[] = [];
  const stats = getGrowthStats();
  const runs = stats.recentScenarioRuns;

  if (runs.length < 10) return signals;

  // Signal: Perfect pass rate over many runs (suspicious)
  const passRate = stats.scenarioPassRate;
  if (passRate === 1 && runs.length >= 20) {
    signals.push({
      type: 'perfect_pass_rate',
      severity: 'medium',
      message: '100% pass rate over 20+ runs — may indicate narrow scenario selection',
      detail: { runCount: runs.length },
    });
  }

  // Signal: Same scenario run very frequently (potential overfitting)
  const byScenario = new Map<string, number>();
  for (const r of runs) {
    byScenario.set(r.scenario_id, (byScenario.get(r.scenario_id) ?? 0) + 1);
  }
  const maxRuns = Math.max(...byScenario.values());
  if (maxRuns > runs.length * 0.5) {
    const topScenario = [...byScenario.entries()].find(([, c]) => c === maxRuns)?.[0];
    signals.push({
      type: 'scenario_concentration',
      severity: 'low',
      message: `Single scenario dominates runs: ${topScenario} (${maxRuns}/${runs.length})`,
      detail: { scenarioId: topScenario, count: maxRuns },
    });
  }

  return signals;
}
