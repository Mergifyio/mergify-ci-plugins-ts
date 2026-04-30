import { splitRepoName } from './utils.js';

export type FlakyDetectionContext = {
  budget_ratio_for_new_tests: number;
  budget_ratio_for_unhealthy_tests: number;
  existing_test_names: string[];
  existing_tests_mean_duration_ms: number;
  unhealthy_test_names: string[];
  max_test_execution_count: number;
  max_test_name_length: number;
  min_budget_duration_ms: number;
  min_test_execution_count: number;
};

export type FlakyDetectionMode = 'new' | 'unhealthy';

export type FlakyDetectionConfig = {
  apiUrl: string;
  token: string;
  repoName: string;
};

export async function fetchFlakyDetectionContext(
  config: FlakyDetectionConfig,
  logger: (msg: string) => void
): Promise<FlakyDetectionContext | null> {
  const { owner, repo } = splitRepoName(config.repoName);
  const url = `${config.apiUrl}/v1/ci/${owner}/repositories/${repo}/flaky-detection-context`;

  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(10_000),
    });

    if (response.status === 402) {
      logger('Flaky detection not available (no subscription)');
      return null;
    }

    if (!response.ok) {
      logger(`Failed to fetch flaky detection context: HTTP ${response.status}`);
      return null;
    }

    return (await response.json()) as FlakyDetectionContext;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      logger('Flaky detection API request timed out');
    } else {
      logger(`Failed to fetch flaky detection context: ${err}`);
    }
    return null;
  }
}

type TestMetrics = {
  outcomes: Set<string>;
  rerunCount: number;
  initialDurationMs: number;
  tooSlow: boolean;
};

export class FlakyDetector {
  private context: FlakyDetectionContext;
  public readonly mode: FlakyDetectionMode;
  public readonly candidates: Set<string>;
  private existingTestsInSession: Set<string>;
  private budgetMs: number;
  public readonly perTestDeadlineMs: number;
  private testMetrics: Map<string, TestMetrics> = new Map();
  private tooSlowTests: string[] = [];

  constructor(context: FlakyDetectionContext, mode: FlakyDetectionMode, allTestNames: string[]) {
    this.context = context;
    this.mode = mode;

    const { candidates, existingTestsInSession, budgetMs, perTestDeadlineMs } =
      FlakyDetector.computeFromTestList(context, mode, allTestNames);

    this.candidates = candidates;
    this.existingTestsInSession = existingTestsInSession;
    this.budgetMs = budgetMs;
    this.perTestDeadlineMs = perTestDeadlineMs;
  }

  private static computeFromTestList(
    context: FlakyDetectionContext,
    mode: FlakyDetectionMode,
    allTestNames: string[]
  ): {
    candidates: Set<string>;
    existingTestsInSession: Set<string>;
    budgetMs: number;
    perTestDeadlineMs: number;
  } {
    const existingSet = new Set(context.existing_test_names);
    const unhealthySet = new Set(context.unhealthy_test_names);

    const existingTestsInSession = new Set(allTestNames.filter((t) => existingSet.has(t)));

    const candidates =
      mode === 'new'
        ? new Set(
            allTestNames.filter(
              (t) => !existingSet.has(t) && t.length <= context.max_test_name_length
            )
          )
        : new Set(
            allTestNames.filter(
              (t) => unhealthySet.has(t) && t.length <= context.max_test_name_length
            )
          );

    const budgetRatio =
      mode === 'new'
        ? context.budget_ratio_for_new_tests
        : context.budget_ratio_for_unhealthy_tests;
    const totalDurationMs = context.existing_tests_mean_duration_ms * existingTestsInSession.size;
    const budgetMs = Math.max(budgetRatio * totalDurationMs, context.min_budget_duration_ms);
    const perTestDeadlineMs = candidates.size > 0 ? budgetMs / candidates.size : 0;

    return { candidates, existingTestsInSession, budgetMs, perTestDeadlineMs };
  }

  isCandidate(testName: string): boolean {
    return this.candidates.has(testName);
  }

  /** Calculate max repeats for a candidate test. Call after first execution to use actual duration. */
  getMaxRepeats(testName: string, initialDurationMs: number): number {
    const metrics = this.getOrCreateMetrics(testName);
    metrics.initialDurationMs = initialDurationMs;

    // Check if test is too slow for even min_test_execution_count
    if (initialDurationMs * this.context.min_test_execution_count > this.perTestDeadlineMs) {
      metrics.tooSlow = true;
      this.tooSlowTests.push(testName);
      return 0;
    }

    // How many reruns fit in the per-test deadline?
    const maxByBudget =
      initialDurationMs > 0 ? Math.floor(this.perTestDeadlineMs / initialDurationMs) - 1 : 0;
    // Cap by max_test_execution_count (subtract 1 for the initial run)
    return Math.max(0, Math.min(maxByBudget, this.context.max_test_execution_count - 1));
  }

  recordOutcome(testName: string, outcome: 'pass' | 'fail'): void {
    const metrics = this.getOrCreateMetrics(testName);
    metrics.outcomes.add(outcome);
    metrics.rerunCount++;
  }

  isFlaky(testName: string): boolean {
    const metrics = this.testMetrics.get(testName);
    if (!metrics) return false;
    return metrics.outcomes.has('pass') && metrics.outcomes.has('fail');
  }

  getRerunCount(testName: string): number {
    return this.testMetrics.get(testName)?.rerunCount ?? 0;
  }

  isTooSlow(testName: string): boolean {
    return this.testMetrics.get(testName)?.tooSlow ?? false;
  }

  /** Get summary data for the terminal report. */
  getSummary(): {
    mode: FlakyDetectionMode;
    budgetMs: number;
    candidateCount: number;
    rerunTests: Array<{ name: string; rerunCount: number; flaky: boolean; outcomes: string[] }>;
    tooSlowTests: string[];
  } {
    const rerunTests: Array<{
      name: string;
      rerunCount: number;
      flaky: boolean;
      outcomes: string[];
    }> = [];

    for (const [name, metrics] of this.testMetrics) {
      if (metrics.rerunCount > 0) {
        rerunTests.push({
          name,
          rerunCount: metrics.rerunCount,
          flaky: this.isFlaky(name),
          outcomes: [...metrics.outcomes],
        });
      }
    }

    return {
      mode: this.mode,
      budgetMs: this.budgetMs,
      candidateCount: this.candidates.size,
      rerunTests,
      tooSlowTests: this.tooSlowTests,
    };
  }

  private getOrCreateMetrics(testName: string): TestMetrics {
    let metrics = this.testMetrics.get(testName);
    if (!metrics) {
      metrics = { outcomes: new Set(), rerunCount: 0, initialDurationMs: 0, tooSlow: false };
      this.testMetrics.set(testName, metrics);
    }
    return metrics;
  }
}
