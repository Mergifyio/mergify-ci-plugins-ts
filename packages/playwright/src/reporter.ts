import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import {
  createTracing,
  emitTestCaseSpan,
  endSessionSpan,
  envToBool,
  FlakyDetector,
  generateTestRunId,
  getRepoName,
  isInCI,
  startSessionSpan,
  type TestCaseResult,
  type TestRunSession,
  type TracingContext,
} from '@mergifyio/ci-core';
import type { Span } from '@opentelemetry/api';
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';
import * as playwrightResource from './resources/playwright.js';
import { readStateFile, type SharedState, writeStateFile } from './state-file.js';
import type { MergifyReporterOptions } from './types.js';
import {
  buildTestKey,
  extractNamespace,
  mapStatus,
  projectNameFromTest,
  toPosix,
} from './utils.js';

const DEFAULT_API_URL = 'https://api.mergify.com';

interface RerunOutcome {
  status: 'passed' | 'failed' | 'skipped';
  duration: number;
}

export class MergifyReporter implements Reporter {
  private options: MergifyReporterOptions;
  private session: TestRunSession | undefined;
  private tracing: TracingContext | null = null;
  private sessionSpan: Span | undefined;
  private config: FullConfig | undefined;
  private quarantineFetchedCount = 0;
  private quarantineFetchedNames: string[] = [];
  private quarantinedCaught: string[] = [];
  private flakyResults: Array<{
    name: string;
    new: boolean;
    flaky: boolean;
    rerunCount: number;
  }> = [];

  // Multi-process flaky-detection state.
  private isRerunMode = false;
  private rerunFile: string | undefined;
  private flakyCandidatesSet: Set<string> | null = null;
  private flakyMode: 'new' | 'unhealthy' | null = null;
  /** Buffer of (testCaseResult, key) pairs awaiting span emission. */
  private buffered: Array<{ result: TestCaseResult; key: string }> = [];
  /** Phase-1 outcomes for candidates (one entry per candidate that ran). */
  private phase1Outcomes: Map<string, { status: 'passed' | 'failed'; duration: number }> =
    new Map();

  constructor(options?: MergifyReporterOptions) {
    this.options = options ?? {};
  }

  printsToStdio(): boolean {
    return false;
  }

  onBegin(config: FullConfig, suite: Suite): void {
    this.config = config;

    // Subprocess "rerun mode" — short-circuits the entire pipeline. The
    // parent reporter set `MERGIFY_RERUN_FILE` to the path of a JSONL file
    // we append per-attempt outcomes to. No tracing, no quarantine summary,
    // no span emission.
    this.rerunFile = process.env.MERGIFY_RERUN_FILE;
    if (this.rerunFile) {
      this.isRerunMode = true;
      mkdirSync(dirname(this.rerunFile), { recursive: true });
      // Initialise the file (truncate). Each subsequent onTestEnd appends.
      writeFileSync(this.rerunFile, '');
      return;
    }

    const envId = process.env.MERGIFY_TEST_RUN_ID;
    const testRunId = envId ?? generateTestRunId();
    const token = this.options.token ?? process.env.MERGIFY_TOKEN;
    const apiUrl = this.options.apiUrl ?? process.env.MERGIFY_API_URL ?? DEFAULT_API_URL;
    const repoName = getRepoName();

    const enabled =
      isInCI() ||
      envToBool(process.env.PLAYWRIGHT_MERGIFY_ENABLE, false) ||
      !!this.options.exporter;

    if (enabled) {
      this.tracing = createTracing({
        token,
        repoName,
        apiUrl,
        testRunId,
        frameworkAttributes: playwrightResource.detect(),
        tracerName: '@mergifyio/playwright',
        exporter: this.options.exporter,
      });
    }

    if (!this.tracing && enabled) {
      if (!token) {
        process.stderr.write(
          '[@mergifyio/playwright] MERGIFY_TOKEN not set, skipping CI Insights reporting\n'
        );
      } else if (!repoName) {
        process.stderr.write(
          '[@mergifyio/playwright] Could not detect repository name, skipping CI Insights reporting\n'
        );
      }
    }

    const statePath = process.env.MERGIFY_STATE_FILE;
    if (statePath) {
      const state = readStateFile(statePath);
      if (state) {
        this.quarantineFetchedCount = state.quarantinedTests.length;
        this.quarantineFetchedNames = state.quarantinedTests;
        if (state.flakyCandidates) {
          this.flakyCandidatesSet = new Set(state.flakyCandidates);
        }
        if (state.flakyMode) {
          this.flakyMode = state.flakyMode;
        }
      }
    }

    this.session = {
      testRunId,
      scope: 'session',
      startTime: Date.now(),
      status: 'passed',
      testCases: [],
    };

    if (this.tracing) {
      this.sessionSpan = startSessionSpan(this.tracing, 'playwright session start');
    }

    this.enrichStateForFlakyDetection(config, suite);

    // After enrichment, refresh the candidates set in case onBegin just wrote
    // them to the state file.
    if (statePath && !this.flakyCandidatesSet) {
      const state = readStateFile(statePath);
      if (state?.flakyCandidates) {
        this.flakyCandidatesSet = new Set(state.flakyCandidates);
      }
    }
  }

  private enrichStateForFlakyDetection(config: FullConfig, suite: Suite): void {
    const statePath = process.env.MERGIFY_STATE_FILE;
    if (!statePath) return;
    const state = readStateFile(statePath);
    if (!state?.flakyContext || !state.flakyMode) return;

    // Defensive: some test fixtures pass an empty suite shape. In production
    // Playwright always provides allTests; in unit tests we tolerate its
    // absence to keep this code path safe.
    if (typeof suite.allTests !== 'function') return;

    const allTestNames = suite.allTests().map((tc) => {
      const absolute = tc.location?.file ?? '';
      const filepath = toPosix(config.rootDir ? relative(config.rootDir, absolute) : absolute);
      return buildTestKey(filepath, tc.titlePath(), tc.title);
    });

    const detector = new FlakyDetector(state.flakyContext, state.flakyMode, allTestNames);
    const enriched: SharedState = {
      ...state,
      flakyCandidates: [...detector.candidates],
      flakyPerTestDeadlineMs: detector.perTestDeadlineMs,
    };

    try {
      writeStateFile(statePath, enriched);
    } catch (err) {
      process.stderr.write(
        `[@mergifyio/playwright] failed to enrich state for flaky detection: ${String(err)}\n`
      );
    }
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    // Rerun mode: just append a JSONL line and return.
    if (this.isRerunMode && this.rerunFile) {
      const rootDir = this.config?.rootDir ?? '';
      const filepath = toPosix(rootDir ? relative(rootDir, test.location?.file ?? '') : '');
      const key = buildTestKey(filepath, test.titlePath(), test.title);
      const line = `${JSON.stringify({
        key,
        status: result.status,
        duration: result.duration,
      })}\n`;
      try {
        appendFileSync(this.rerunFile, line);
      } catch (err) {
        process.stderr.write(
          `[@mergifyio/playwright] failed to write rerun outcome: ${String(err)}\n`
        );
      }
      return;
    }

    if (!this.session) return;

    const retries = test.retries ?? 0;
    const isFinal =
      result.status === 'passed' || result.status === 'skipped' || result.retry >= retries;

    if (!isFinal) return;

    const rootDir = this.config?.rootDir ?? '';
    const absoluteFilepath = test.location?.file ?? '';
    const filepath = toPosix(rootDir ? relative(rootDir, absoluteFilepath) : absoluteFilepath);

    const titlePath = test.titlePath();
    const namespace = extractNamespace(filepath, titlePath);
    const project = projectNameFromTest(test);
    const key = buildTestKey(filepath, titlePath, test.title);

    const testCaseResult: TestCaseResult = {
      filepath,
      absoluteFilepath,
      function: test.title,
      lineno: test.location?.line ?? 0,
      namespace,
      scope: 'case',
      status: mapStatus(result.status),
      duration: result.duration,
      startTime: result.startTime.getTime(),
      retryCount: result.retry,
      flaky: test.outcome() === 'flaky',
    };

    if (project !== undefined) {
      testCaseResult.project = project;
    }

    if (result.status !== 'passed' && result.status !== 'skipped' && result.errors.length > 0) {
      const firstError = result.errors[0];
      const type =
        typeof firstError.value === 'string'
          ? (firstError.value.split(':')[0] ?? 'Error')
          : 'Error';
      testCaseResult.error = {
        type,
        message: firstError.message ?? '',
        stacktrace: firstError.stack ?? '',
      };
    }

    const isQuarantined = test.annotations.some((a) => a.type === 'mergify:quarantined');
    if (isQuarantined) {
      testCaseResult.quarantined = true;
      this.quarantinedCaught.push(key);
    }

    // Existing wrapBody-pushed annotation (kept for back-compat with the
    // abandoned in-test orchestration; harmless when absent).
    const flakyAnno = test.annotations.find((a) => a.type === 'mergify:flakyDetection');
    if (flakyAnno?.description) {
      try {
        const parsed = JSON.parse(flakyAnno.description) as {
          new?: unknown;
          flaky?: unknown;
          rerunCount?: unknown;
        };
        if (
          typeof parsed.new === 'boolean' &&
          typeof parsed.flaky === 'boolean' &&
          typeof parsed.rerunCount === 'number'
        ) {
          testCaseResult.flakyDetection = {
            new: parsed.new,
            flaky: parsed.flaky,
            rerunCount: parsed.rerunCount,
          };
          this.flakyResults.push({
            name: key,
            new: parsed.new,
            flaky: parsed.flaky,
            rerunCount: parsed.rerunCount,
          });
        }
      } catch {
        // malformed JSON — skip silently
      }
    }

    // Record phase-1 outcome for candidates, used to compute repeat-each
    // count and to seed the aggregation in onEnd. Skipped tests are excluded
    // — recording them as either pass or fail can produce misleading flaky
    // verdicts when phase 2 actually runs the test (rare but possible if
    // skip conditions differ across phases).
    if (this.flakyCandidatesSet?.has(key) && result.status !== 'skipped') {
      const phase1Status: 'passed' | 'failed' = result.status === 'passed' ? 'passed' : 'failed';
      this.phase1Outcomes.set(key, { status: phase1Status, duration: result.duration });
    }

    this.session.testCases.push(testCaseResult);

    // Buffer for deferred span emission. Spans are emitted at the end of
    // onEnd, after the rerun subprocess (if any) has produced phase-2
    // outcomes — at which point we can augment with flakyDetection.
    this.buffered.push({ result: testCaseResult, key });
  }

  async onEnd(result: FullResult): Promise<void> {
    // Rerun mode: nothing to do — outcomes were appended in onTestEnd.
    if (this.isRerunMode) return;

    if (!this.session) return;

    const reason: 'passed' | 'failed' | 'interrupted' =
      result.status === 'passed'
        ? 'passed'
        : result.status === 'interrupted'
          ? 'interrupted'
          : 'failed';

    this.session.endTime = Date.now();
    this.session.status = reason;

    // Phase 2: spawn rerun subprocess for any candidates that ran.
    const rerunOutcomes = await this.runFlakyDetectionPhase2();

    // Augment buffered TestCaseResults with flakyDetection metadata before
    // emitting spans.
    for (const { result: tcr, key } of this.buffered) {
      const phase2 = rerunOutcomes.get(key);
      if (!this.flakyCandidatesSet?.has(key) || !this.flakyMode) continue;

      const phase1 = this.phase1Outcomes.get(key);
      const allOutcomes: Array<'passed' | 'failed'> = [];
      if (phase1) allOutcomes.push(phase1.status);
      if (phase2) {
        for (const o of phase2) {
          if (o.status === 'passed' || o.status === 'failed') allOutcomes.push(o.status);
        }
      }
      const isFlaky = allOutcomes.includes('passed') && allOutcomes.includes('failed');
      const rerunCount = phase2?.length ?? 0;

      tcr.flakyDetection = {
        new: this.flakyMode === 'new',
        flaky: isFlaky,
        rerunCount,
      };
      this.flakyResults.push({
        name: key,
        new: this.flakyMode === 'new',
        flaky: isFlaky,
        rerunCount,
      });
    }

    // Emit all buffered spans now.
    if (this.tracing && this.sessionSpan) {
      for (const { result: tcr } of this.buffered) {
        emitTestCaseSpan(this.tracing.tracer, this.sessionSpan, tcr);
      }
    }

    if (this.quarantineFetchedCount > 0) {
      const unused = this.quarantineFetchedCount - this.quarantinedCaught.length;
      process.stderr.write('[@mergifyio/playwright] Quarantine report:\n');
      process.stderr.write(`  fetched: ${this.quarantineFetchedCount}\n`);
      process.stderr.write(`  caught:  ${this.quarantinedCaught.length}\n`);
      for (const name of this.quarantinedCaught) {
        process.stderr.write(`    - ${name}\n`);
      }
      process.stderr.write(`  unused:  ${unused}\n`);
      if (unused > 0) {
        const caughtSet = new Set(this.quarantinedCaught);
        const unusedNames = this.quarantineFetchedNames.filter((n) => !caughtSet.has(n));
        for (const name of unusedNames) {
          process.stderr.write(`    - ${name}\n`);
        }
      }
    }

    // Flaky detection summary
    if (this.flakyMode) {
      process.stderr.write('[@mergifyio/playwright] Flaky detection report:\n');
      process.stderr.write(`  mode: ${this.flakyMode}\n`);
      process.stderr.write(`  Tests rerun: ${this.flakyResults.length}\n`);

      const flakyTests = this.flakyResults.filter((r) => r.flaky);
      process.stderr.write(`  Flaky tests detected: ${flakyTests.length}\n`);
      for (const t of flakyTests) {
        process.stderr.write(`    - ${t.name} (reruns: ${t.rerunCount})\n`);
      }
    }

    if (this.tracing && this.sessionSpan) {
      try {
        await endSessionSpan(this.tracing, this.sessionSpan, reason);
      } catch (err) {
        const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
        process.stderr.write(`[@mergifyio/playwright] Failed to flush spans: ${detail}\n`);
      }
    }
  }

  /**
   * If any flaky-detection candidates ran, spawn a single subprocess that
   * re-runs them via `--grep <regex> --repeat-each=N`. Returns a map of
   * candidate key → list of phase-2 attempt outcomes. Returns an empty map
   * when there are no candidates to rerun, when subprocess spawning is
   * disabled (no config), or on subprocess error (which is logged but not
   * propagated — we soft-fail flaky detection).
   */
  private async runFlakyDetectionPhase2(): Promise<Map<string, RerunOutcome[]>> {
    const out = new Map<string, RerunOutcome[]>();
    if (!this.flakyMode || this.phase1Outcomes.size === 0) return out;

    const statePath = process.env.MERGIFY_STATE_FILE;
    if (!statePath) return out;
    const state = readStateFile(statePath);
    if (!state?.flakyContext || state.flakyPerTestDeadlineMs === undefined) return out;

    // Compute repeat-each from the average phase-1 duration. Playwright
    // reports 0ms for very fast tests; in that case fall back to the
    // backend-provided mean duration so we still issue reruns.
    const durations = [...this.phase1Outcomes.values()].map((v) => v.duration);
    const avgDuration =
      durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
    const effectiveDuration =
      avgDuration > 0
        ? avgDuration
        : Math.max(1, state.flakyContext.existing_tests_mean_duration_ms);
    const byBudget = Math.floor(state.flakyPerTestDeadlineMs / effectiveDuration);
    const repeatEach = Math.max(
      1,
      Math.min(byBudget, state.flakyContext.max_test_execution_count - 1)
    );

    // Build a grep regex from candidate test titles. We escape regex
    // metacharacters and join with `|`. Playwright's `--grep` matches
    // against the joined title path (describes + title), not the file
    // path, so candidates with the same leaf title in different files
    // will all be re-run — the aggregation step still filters JSONL
    // entries by full-key membership in `flakyCandidatesSet`, so this is
    // wasted CI time but not incorrect results. Sharper filtering would
    // require switching off `--grep` to a list-then-filter approach;
    // deferred.
    const titles = [...this.phase1Outcomes.keys()]
      .map((k) => k.split(' > ').pop() ?? k)
      .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const grepPattern = `(${titles.join('|')})`;

    const cliEntry = this.findPlaywrightBin();
    if (!cliEntry) return out;

    const configPath = this.config?.configFile;
    if (!configPath) return out;

    const rerunFile = join(
      tmpdir(),
      `mergify-rerun-${process.env.MERGIFY_TEST_RUN_ID ?? generateTestRunId()}.jsonl`
    );

    const spawnEnv = {
      ...process.env,
      MERGIFY_RERUN_FILE: rerunFile,
    };

    const child = spawnSync(
      process.execPath,
      [
        cliEntry,
        'test',
        '--config',
        configPath,
        '--grep',
        grepPattern,
        `--repeat-each=${repeatEach}`,
      ],
      { encoding: 'utf8', env: spawnEnv, cwd: this.config?.rootDir ?? process.cwd() }
    );

    if (child.error) {
      process.stderr.write(
        `[@mergifyio/playwright] flaky-detection rerun subprocess failed to start: ${String(child.error)}\n`
      );
      return out;
    }

    // Parse JSONL outcomes. We try to read the file regardless of exit
    // code — the subprocess may have written valid lines before crashing,
    // and we'd rather use partial data than throw it away. But a non-zero
    // exit combined with an empty/missing file is suspicious; surface it.
    let raw: string;
    try {
      raw = readFileSync(rerunFile, 'utf8');
    } catch {
      raw = '';
    }
    if (child.status !== 0 && raw.trim().length === 0) {
      const detail = [child.stdout, child.stderr]
        .filter((s) => s && s.trim().length > 0)
        .join('\n')
        .slice(0, 2_000);
      process.stderr.write(
        `[@mergifyio/playwright] flaky-detection rerun subprocess exited with status ${child.status}` +
          ` (signal=${child.signal ?? 'none'}) and produced no outcomes${detail ? `:\n${detail}` : ''}\n`
      );
    }
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as {
          key?: unknown;
          status?: unknown;
          duration?: unknown;
        };
        if (
          typeof parsed.key !== 'string' ||
          typeof parsed.status !== 'string' ||
          typeof parsed.duration !== 'number'
        ) {
          continue;
        }
        const status =
          parsed.status === 'passed' || parsed.status === 'failed' || parsed.status === 'skipped'
            ? parsed.status
            : 'failed';
        const list = out.get(parsed.key) ?? [];
        list.push({ status, duration: parsed.duration });
        out.set(parsed.key, list);
      } catch {
        // skip malformed line
      }
    }
    // Best-effort cleanup of the temp JSONL — leave it on disk if removal
    // fails. The OS will eventually purge tmpdir contents.
    try {
      unlinkSync(rerunFile);
    } catch {
      // ignore
    }
    return out;
  }

  private findPlaywrightBin(): string | undefined {
    // Resolve Playwright's CLI script via the user's installed
    // @playwright/test package. `require.resolve` follows the same module
    // resolution Playwright did when loading our reporter, so we get the
    // exact CLI matching the parent process's Playwright version.
    try {
      const requireFn = createRequire(import.meta.url);
      // The package's `bin` entry points to `cli.js` at the package root.
      const pkgPath = requireFn.resolve('@playwright/test/package.json');
      return join(dirname(pkgPath), 'cli.js');
    } catch {
      return undefined;
    }
  }

  getSession(): TestRunSession | undefined {
    return this.session;
  }

  getExporter() {
    return this.tracing?.exporter;
  }
}

export default MergifyReporter;
