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
  private mode: FlakyDetectionMode;
  private candidates: Set<string> = new Set();
  private budgetMs: number;
  private perTestDeadlineMs: number = 0;
  private testMetrics: Map<string, TestMetrics> = new Map();
  private tooSlowTests: string[] = [];

  constructor(context: FlakyDetectionContext, mode: FlakyDetectionMode) {
    this.context = context;
    this.mode = mode;

    const budgetRatio =
      mode === 'new'
        ? context.budget_ratio_for_new_tests
        : context.budget_ratio_for_unhealthy_tests;
    this.budgetMs = budgetRatio * context.existing_tests_mean_duration_ms;
  }

  /**
   * Register session test names to compute candidates and per-test budgets.
   * When test names are known upfront (e.g. vitest), call this before running
   * tests. When they aren't (e.g. Playwright global setup), skip this call —
   * isCandidate() will fall back to checking against the context lists directly.
   */
  setTestNames(allTestNames: string[]): void {
    const existingSet = new Set(this.context.existing_test_names);
    const unhealthySet = new Set(this.context.unhealthy_test_names);

    const existingTestsInSession = allTestNames.filter((t) => existingSet.has(t)).length;

    if (this.mode === 'new') {
      this.candidates = new Set(
        allTestNames.filter(
          (t) => !existingSet.has(t) && t.length <= this.context.max_test_name_length
        )
      );
    } else {
      this.candidates = new Set(
        allTestNames.filter(
          (t) => unhealthySet.has(t) && t.length <= this.context.max_test_name_length
        )
      );
    }

    const totalDurationMs =
      this.context.existing_tests_mean_duration_ms * existingTestsInSession;
    this.budgetMs = Math.max(
      this.budgetMs,
      totalDurationMs *
        (this.mode === 'new'
          ? this.context.budget_ratio_for_new_tests
          : this.context.budget_ratio_for_unhealthy_tests)
    );
    this.budgetMs = Math.max(this.budgetMs, this.context.min_budget_duration_ms);

    this.perTestDeadlineMs =
      this.candidates.size > 0 ? this.budgetMs / this.candidates.size : 0;
  }

  isCandidate(testName: string): boolean {
    // If setTestNames was called, use the pre-computed candidate set
    if (this.candidates.size > 0) {
      return this.candidates.has(testName);
    }
    // Fallback: check against the context lists directly
    if (testName.length > this.context.max_test_name_length) return false;
    if (this.mode === 'new') {
      return !this.context.existing_test_names.includes(testName);
    }
    return this.context.unhealthy_test_names.includes(testName);
  }

  /** Calculate max repeats for a candidate test. Call after first execution to use actual duration. */
  getMaxRepeats(testName: string, initialDurationMs: number): number {
    const metrics = this.getOrCreateMetrics(testName);
    metrics.initialDurationMs = initialDurationMs;

    // Use per-test deadline when available (setTestNames was called),
    // otherwise fall back to the full budget as the deadline for this test
    const deadline =
      this.perTestDeadlineMs > 0
        ? this.perTestDeadlineMs
        : Math.max(this.budgetMs, this.context.min_budget_duration_ms);

    // Check if test is too slow for even min_test_execution_count
    if (initialDurationMs * this.context.min_test_execution_count > deadline) {
      metrics.tooSlow = true;
      this.tooSlowTests.push(testName);
      return 0;
    }

    // How many reruns fit in the deadline?
    const maxByBudget =
      initialDurationMs > 0 ? Math.floor(deadline / initialDurationMs) - 1 : 0;
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
