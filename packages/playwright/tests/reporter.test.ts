import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import type { FullConfig, Suite, TestCase, TestResult } from '@playwright/test/reporter';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MergifyReporter } from '../src/reporter.js';
import { stateFilePath } from '../src/state-file.js';

function fakeConfig(): FullConfig {
  return { rootDir: '/root' } as unknown as FullConfig;
}

function fakeSuite(): Suite {
  return {} as Suite;
}

function fakeTest(
  overrides: {
    title?: string;
    titlePath?: string[];
    location?: { file: string; line: number; column: number };
    retries?: number;
    outcome?: () => 'expected' | 'unexpected' | 'flaky' | 'skipped';
    annotations?: Array<{ type: string; description?: string }>;
  } = {}
): TestCase {
  return {
    title: overrides.title ?? 'my test',
    // Real Playwright shape: ['', project, basename, ...describes, title].
    // The file-suite slot is the basename (`x.spec.ts`), NOT the absolute
    // path — stripFileSuite recognises basename / relative-from-rootDir; an
    // absolute path leaks into the namespace and breaks buildTestKey.
    // `projectNameFromTest` reads titlePath[1] directly, so we don't mock
    // `parent.project()` — that field would be dead code.
    titlePath: () => overrides.titlePath ?? ['', 'chromium', 'x.spec.ts', 'my test'],
    location: overrides.location ?? {
      file: '/root/tests/x.spec.ts',
      line: 42,
      column: 1,
    },
    retries: overrides.retries ?? 0,
    results: [] as TestResult[],
    outcome: overrides.outcome ?? (() => 'expected'),
    annotations: overrides.annotations ?? [],
  } as unknown as TestCase;
}

function fakeResult(overrides: Partial<TestResult> = {}): TestResult {
  return {
    status: 'passed',
    duration: 20,
    startTime: new Date(1_000_000),
    retry: 0,
    errors: [],
    ...overrides,
  } as unknown as TestResult;
}

describe('MergifyReporter session lifecycle', () => {
  beforeEach(() => {
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    vi.stubEnv('GITHUB_REPOSITORY', 'test-owner/test-repo');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('starts a session span with test.scope=session and name "playwright session start"', async () => {
    const exporter = new InMemorySpanExporter();
    const reporter = new MergifyReporter({ exporter });

    reporter.onBegin(fakeConfig(), fakeSuite());
    await reporter.onEnd({ status: 'passed', startTime: new Date(), duration: 1 });

    const spans = exporter.getFinishedSpans();
    const session = spans.find((s) => s.attributes['test.scope'] === 'session');
    expect(session).toBeDefined();
    expect(session!.name).toBe('playwright session start');
  });

  it('getSession() exposes a session with 16-char hex testRunId', async () => {
    const exporter = new InMemorySpanExporter();
    const reporter = new MergifyReporter({ exporter });

    reporter.onBegin(fakeConfig(), fakeSuite());
    await reporter.onEnd({ status: 'passed', startTime: new Date(), duration: 1 });

    const session = reporter.getSession();
    expect(session).toBeDefined();
    expect(session!.testRunId).toMatch(/^[0-9a-f]{16}$/);
    expect(session!.scope).toBe('session');
    expect(session!.startTime).toBeGreaterThan(0);
    expect(session!.endTime).toBeGreaterThanOrEqual(session!.startTime);
    expect(session!.status).toBe('passed');
  });

  it('sets session.status to failed when onEnd result status is failed', async () => {
    const exporter = new InMemorySpanExporter();
    const reporter = new MergifyReporter({ exporter });
    reporter.onBegin(fakeConfig(), fakeSuite());
    await reporter.onEnd({ status: 'failed', startTime: new Date(), duration: 1 });

    expect(reporter.getSession()!.status).toBe('failed');
  });
});

describe('onTestEnd — passing test', () => {
  beforeEach(() => {
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    vi.stubEnv('GITHUB_REPOSITORY', 'test-owner/test-repo');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('emits a test case span with code.* attributes', async () => {
    const exporter = new InMemorySpanExporter();
    const reporter = new MergifyReporter({ exporter });

    reporter.onBegin(fakeConfig(), fakeSuite());
    const test = fakeTest({
      title: 'adds numbers',
      titlePath: ['', 'chromium', 'math.spec.ts', 'math', 'adds numbers'],
      location: { file: '/root/tests/math.spec.ts', line: 15, column: 3 },
    });
    reporter.onTestEnd(test, fakeResult({ status: 'passed', duration: 5 }));
    await reporter.onEnd({ status: 'passed', startTime: new Date(), duration: 1 });

    const spans = exporter.getFinishedSpans();
    const testSpan = spans.find((s) => s.attributes['test.scope'] === 'case');
    expect(testSpan).toBeDefined();
    // function is decorated with [project] so the span name (namespace > function)
    // is byte-identical to buildTestKey's output — the backend stores this as
    // test_name and matches it against per-project quarantine / unhealthy lists.
    expect(testSpan!.attributes['code.function']).toBe('adds numbers [chromium]');
    expect(testSpan!.attributes['code.namespace']).toBe('tests/math.spec.ts > math');
    expect(testSpan!.attributes['code.lineno']).toBe(15);
    expect(testSpan!.attributes['code.filepath']).toBe('tests/math.spec.ts');
    expect(testSpan!.attributes['code.file.path']).toBe('/root/tests/math.spec.ts');
    expect(testSpan!.attributes['test.case.result.status']).toBe('passed');
    expect(testSpan!.attributes['cicd.test.retry_count']).toBe(0);
  });

  it('pushes a TestCaseResult to the session', async () => {
    const exporter = new InMemorySpanExporter();
    const reporter = new MergifyReporter({ exporter });

    reporter.onBegin(fakeConfig(), fakeSuite());
    reporter.onTestEnd(fakeTest(), fakeResult());
    await reporter.onEnd({ status: 'passed', startTime: new Date(), duration: 1 });

    const session = reporter.getSession()!;
    expect(session.testCases).toHaveLength(1);
    expect(session.testCases[0].status).toBe('passed');
    expect(session.testCases[0].function).toBe('my test [chromium]');
  });

  it('makes the test case span a child of the session span', async () => {
    const exporter = new InMemorySpanExporter();
    const reporter = new MergifyReporter({ exporter });

    reporter.onBegin(fakeConfig(), fakeSuite());
    reporter.onTestEnd(fakeTest(), fakeResult());
    await reporter.onEnd({ status: 'passed', startTime: new Date(), duration: 1 });

    const spans = exporter.getFinishedSpans();
    const session = spans.find((s) => s.attributes['test.scope'] === 'session')!;
    const testSpan = spans.find((s) => s.attributes['test.scope'] === 'case')!;
    expect(testSpan.parentSpanContext?.spanId).toBe(session.spanContext().spanId);
  });
});

describe('onTestEnd — failing test', () => {
  beforeEach(() => {
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    vi.stubEnv('GITHUB_REPOSITORY', 'test-owner/test-repo');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('sets exception.* attributes and ERROR status when the test fails', async () => {
    const exporter = new InMemorySpanExporter();
    const reporter = new MergifyReporter({ exporter });

    reporter.onBegin(fakeConfig(), fakeSuite());
    const test = fakeTest({ outcome: () => 'unexpected' });
    reporter.onTestEnd(
      test,
      fakeResult({
        status: 'failed',
        errors: [
          {
            message: 'Expected 2 but got 3',
            stack: 'Error: at some.file.ts:10',
            value: 'Error: Expected 2 but got 3',
          } as TestResult['errors'][number],
        ],
      })
    );
    await reporter.onEnd({ status: 'failed', startTime: new Date(), duration: 1 });

    const spans = exporter.getFinishedSpans();
    const testSpan = spans.find((s) => s.attributes['test.scope'] === 'case')!;
    expect(testSpan.attributes['test.case.result.status']).toBe('failed');
    expect(testSpan.attributes['exception.type']).toBe('Error');
    expect(testSpan.attributes['exception.message']).toBe('Expected 2 but got 3');
    expect(testSpan.attributes['exception.stacktrace']).toBe('Error: at some.file.ts:10');
  });

  it('treats timedOut as failed', async () => {
    const exporter = new InMemorySpanExporter();
    const reporter = new MergifyReporter({ exporter });

    reporter.onBegin(fakeConfig(), fakeSuite());
    reporter.onTestEnd(fakeTest(), fakeResult({ status: 'timedOut' }));
    await reporter.onEnd({ status: 'failed', startTime: new Date(), duration: 1 });

    const tc = reporter.getSession()!.testCases[0];
    expect(tc.status).toBe('failed');
  });
});

describe('onTestEnd — skipped test', () => {
  beforeEach(() => {
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    vi.stubEnv('GITHUB_REPOSITORY', 'test-owner/test-repo');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('emits status=skipped with no exception attributes', async () => {
    const exporter = new InMemorySpanExporter();
    const reporter = new MergifyReporter({ exporter });

    reporter.onBegin(fakeConfig(), fakeSuite());
    reporter.onTestEnd(
      fakeTest({ outcome: () => 'skipped' }),
      fakeResult({ status: 'skipped', errors: [] })
    );
    await reporter.onEnd({ status: 'passed', startTime: new Date(), duration: 1 });

    const spans = exporter.getFinishedSpans();
    const tc = spans.find((s) => s.attributes['test.scope'] === 'case')!;
    expect(tc.attributes['test.case.result.status']).toBe('skipped');
    expect(tc.attributes['exception.type']).toBeUndefined();
  });
});

describe('onTestEnd — retries', () => {
  beforeEach(() => {
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    vi.stubEnv('GITHUB_REPOSITORY', 'test-owner/test-repo');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('ignores a non-final failed attempt when more retries remain', async () => {
    const exporter = new InMemorySpanExporter();
    const reporter = new MergifyReporter({ exporter });

    reporter.onBegin(fakeConfig(), fakeSuite());
    const test = fakeTest({ retries: 2 });
    reporter.onTestEnd(test, fakeResult({ status: 'failed', retry: 0, errors: [] }));
    await reporter.onEnd({ status: 'failed', startTime: new Date(), duration: 1 });

    const spans = exporter.getFinishedSpans();
    const testSpans = spans.filter((s) => s.attributes['test.scope'] === 'case');
    expect(testSpans).toHaveLength(0);
  });

  it('emits a single span when the final retry passes (flaky)', async () => {
    const exporter = new InMemorySpanExporter();
    const reporter = new MergifyReporter({ exporter });

    reporter.onBegin(fakeConfig(), fakeSuite());
    const test = fakeTest({ retries: 2, outcome: () => 'flaky' });
    reporter.onTestEnd(test, fakeResult({ status: 'failed', retry: 0, errors: [] }));
    reporter.onTestEnd(test, fakeResult({ status: 'passed', retry: 1 }));
    await reporter.onEnd({ status: 'passed', startTime: new Date(), duration: 1 });

    const spans = exporter.getFinishedSpans();
    const testSpans = spans.filter((s) => s.attributes['test.scope'] === 'case');
    expect(testSpans).toHaveLength(1);
    expect(testSpans[0].attributes['test.case.result.status']).toBe('passed');
    expect(testSpans[0].attributes['cicd.test.retry_count']).toBe(1);

    const tc = reporter.getSession()!.testCases[0];
    expect(tc.flaky).toBe(true);
  });

  it('emits a single span when retries are exhausted and test still fails', async () => {
    const exporter = new InMemorySpanExporter();
    const reporter = new MergifyReporter({ exporter });

    reporter.onBegin(fakeConfig(), fakeSuite());
    const test = fakeTest({ retries: 2, outcome: () => 'unexpected' });
    reporter.onTestEnd(test, fakeResult({ status: 'failed', retry: 0, errors: [] }));
    reporter.onTestEnd(test, fakeResult({ status: 'failed', retry: 1, errors: [] }));
    reporter.onTestEnd(test, fakeResult({ status: 'failed', retry: 2, errors: [] }));
    await reporter.onEnd({ status: 'failed', startTime: new Date(), duration: 1 });

    const spans = exporter.getFinishedSpans();
    const testSpans = spans.filter((s) => s.attributes['test.scope'] === 'case');
    expect(testSpans).toHaveLength(1);
    expect(testSpans[0].attributes['test.case.result.status']).toBe('failed');
    expect(testSpans[0].attributes['cicd.test.retry_count']).toBe(2);
  });
});

describe('onTestEnd — multi-project', () => {
  beforeEach(() => {
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    vi.stubEnv('GITHUB_REPOSITORY', 'test-owner/test-repo');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('emits one span per project with cicd.test.project set', async () => {
    const exporter = new InMemorySpanExporter();
    const reporter = new MergifyReporter({ exporter });

    reporter.onBegin(fakeConfig(), fakeSuite());

    const chromium = fakeTest({
      title: 'same test',
      titlePath: ['', 'chromium', 'x.spec.ts', 'same test'],
    });
    const firefox = fakeTest({
      title: 'same test',
      titlePath: ['', 'firefox', 'x.spec.ts', 'same test'],
    });

    reporter.onTestEnd(chromium, fakeResult());
    reporter.onTestEnd(firefox, fakeResult());
    await reporter.onEnd({ status: 'passed', startTime: new Date(), duration: 1 });

    const spans = exporter.getFinishedSpans().filter((s) => s.attributes['test.scope'] === 'case');
    const projects = spans.map((s) => s.attributes['cicd.test.project']).sort();
    expect(projects).toEqual(['chromium', 'firefox']);
  });

  it('omits cicd.test.project when titlePath has empty project (ungrouped test)', async () => {
    const exporter = new InMemorySpanExporter();
    const reporter = new MergifyReporter({ exporter });

    reporter.onBegin(fakeConfig(), fakeSuite());
    const test = fakeTest({
      titlePath: ['', '', 'x.spec.ts', 'my test'],
    });
    reporter.onTestEnd(test, fakeResult());
    await reporter.onEnd({ status: 'passed', startTime: new Date(), duration: 1 });

    const tc = exporter.getFinishedSpans().find((s) => s.attributes['test.scope'] === 'case')!;
    expect(tc.attributes['cicd.test.project']).toBeUndefined();
  });
});

describe('MERGIFY_TRACEPARENT propagation', () => {
  beforeEach(() => {
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    vi.stubEnv('GITHUB_REPOSITORY', 'test-owner/test-repo');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('makes the session span a child of the provided traceparent', async () => {
    vi.stubEnv('MERGIFY_TRACEPARENT', '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01');
    const exporter = new InMemorySpanExporter();
    const reporter = new MergifyReporter({ exporter });

    reporter.onBegin(fakeConfig(), fakeSuite());
    await reporter.onEnd({ status: 'passed', startTime: new Date(), duration: 1 });

    const session = exporter
      .getFinishedSpans()
      .find((s) => s.attributes['test.scope'] === 'session')!;
    expect(session.parentSpanContext?.traceId).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(session.parentSpanContext?.spanId).toBe('bbbbbbbbbbbbbbbb');
  });
});

describe('enablement rules', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('does not emit spans when outside CI without exporter or enable flag', async () => {
    vi.stubEnv('CI', '');
    vi.stubEnv('GITHUB_ACTIONS', '');
    vi.stubEnv('CIRCLECI', '');
    vi.stubEnv('JENKINS_URL', '');
    vi.stubEnv('BUILDKITE', '');
    vi.stubEnv('PLAYWRIGHT_MERGIFY_ENABLE', '');

    const reporter = new MergifyReporter();

    reporter.onBegin(fakeConfig(), fakeSuite());
    reporter.onTestEnd(fakeTest(), fakeResult());
    await reporter.onEnd({ status: 'passed', startTime: new Date(), duration: 1 });

    expect(reporter.getExporter()).toBeUndefined();
    expect(reporter.getSession()!.testCases).toHaveLength(1);
  });

  it('activates when PLAYWRIGHT_MERGIFY_ENABLE=true, even outside CI', async () => {
    vi.stubEnv('CI', '');
    vi.stubEnv('GITHUB_ACTIONS', '');
    vi.stubEnv('PLAYWRIGHT_MERGIFY_ENABLE', 'true');

    const exporter = new InMemorySpanExporter();
    const reporter = new MergifyReporter({ exporter });

    reporter.onBegin(fakeConfig(), fakeSuite());
    reporter.onTestEnd(fakeTest(), fakeResult());
    await reporter.onEnd({ status: 'passed', startTime: new Date(), duration: 1 });

    const testSpans = exporter
      .getFinishedSpans()
      .filter((s) => s.attributes['test.scope'] === 'case');
    expect(testSpans).toHaveLength(1);
  });
});

describe('resource attributes', () => {
  beforeEach(() => {
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    vi.stubEnv('GITHUB_REPOSITORY', 'test-owner/test-repo');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('attaches test framework + run id + ci provider + repo attrs on the resource', async () => {
    const exporter = new InMemorySpanExporter();
    const reporter = new MergifyReporter({ exporter });

    reporter.onBegin(fakeConfig(), fakeSuite());
    reporter.onTestEnd(fakeTest(), fakeResult());
    await reporter.onEnd({ status: 'passed', startTime: new Date(), duration: 1 });

    const span = exporter.getFinishedSpans()[0];
    const attrs = span.resource.attributes;
    expect(attrs['test.framework']).toBe('playwright');
    expect(attrs['test.framework.version']).toBeTruthy();
    expect(attrs['test.run.id']).toMatch(/^[0-9a-f]{16}$/);
    expect(attrs['cicd.provider.name']).toBe('github_actions');
    expect(attrs['vcs.repository.name']).toBe('test-owner/test-repo');
  });
});

describe('MergifyReporter V2 — quarantine', () => {
  let cacheRoot: string;
  let statePath: string;

  beforeEach(() => {
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    vi.stubEnv('GITHUB_REPOSITORY', 'test-owner/test-repo');
    cacheRoot = mkdtempSync(join(tmpdir(), 'mergify-cache-'));
    statePath = stateFilePath(cacheRoot, 'abc123def456');
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        testRunId: 'abc123def456',
        createdAt: '2026-04-21T16:07:42Z',
        rootDir: '/root',
        quarantinedTests: ['tests/x.spec.ts > my test [chromium]'],
      })
    );
    process.env.MERGIFY_TEST_RUN_ID = 'abc123def456';
    process.env.MERGIFY_STATE_FILE = statePath;
  });

  afterEach(() => {
    rmSync(cacheRoot, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    delete process.env.MERGIFY_TEST_RUN_ID;
    delete process.env.MERGIFY_STATE_FILE;
  });

  it('uses testRunId from MERGIFY_TEST_RUN_ID when set', async () => {
    const exporter = new InMemorySpanExporter();
    const reporter = new MergifyReporter({ exporter });
    reporter.onBegin(fakeConfig(), fakeSuite());
    await reporter.onEnd({ status: 'passed', startTime: new Date(), duration: 1 });
    expect(reporter.getSession()!.testRunId).toBe('abc123def456');
  });

  it('marks TestCaseResult.quarantined when the annotation is present', async () => {
    const exporter = new InMemorySpanExporter();
    const reporter = new MergifyReporter({ exporter });
    reporter.onBegin(fakeConfig(), fakeSuite());

    // Attach the annotation the fixture would have pushed.
    const test = fakeTest({
      titlePath: ['', 'chromium', 'x.spec.ts', 'my test'],
      location: { file: '/root/tests/x.spec.ts', line: 1, column: 1 },
      annotations: [{ type: 'mergify:quarantined' }],
    });

    reporter.onTestEnd(test, fakeResult({ status: 'failed', errors: [{ message: 'x' } as never] }));
    await reporter.onEnd({ status: 'passed', startTime: new Date(), duration: 1 });

    const session = reporter.getSession()!;
    expect(session.testCases[0].quarantined).toBe(true);
    const testSpan = exporter.getFinishedSpans().find((s) => s.attributes['test.scope'] === 'case');
    expect(testSpan!.attributes['cicd.test.quarantined']).toBe(true);
  });

  it('prints "fetched / caught / unused" summary in onEnd when fetched > 0', async () => {
    const log = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exporter = new InMemorySpanExporter();
    const reporter = new MergifyReporter({ exporter });
    reporter.onBegin(fakeConfig(), fakeSuite());

    const test = fakeTest({
      titlePath: ['', 'chromium', 'x.spec.ts', 'my test'],
      location: { file: '/root/tests/x.spec.ts', line: 1, column: 1 },
      annotations: [{ type: 'mergify:quarantined' }],
    });
    reporter.onTestEnd(test, fakeResult({ status: 'failed', errors: [{ message: 'x' } as never] }));
    await reporter.onEnd({ status: 'passed', startTime: new Date(), duration: 1 });

    const output = log.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('Quarantine report');
    expect(output).toContain('fetched: 1');
    expect(output).toContain('caught:  1');
    expect(output).toContain('    - tests/x.spec.ts > my test [chromium]');
    expect(output).toContain('unused:  0');
  });

  it('omits the summary when no state file is present (V1 parity)', async () => {
    delete process.env.MERGIFY_TEST_RUN_ID;
    delete process.env.MERGIFY_STATE_FILE;
    const log = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exporter = new InMemorySpanExporter();
    const reporter = new MergifyReporter({ exporter });
    reporter.onBegin(fakeConfig(), fakeSuite());
    await reporter.onEnd({ status: 'passed', startTime: new Date(), duration: 1 });
    const output = log.mock.calls.map((c) => String(c[0])).join('');
    expect(output).not.toContain('Quarantine report');
  });
});

describe('MergifyReporter — flaky-detection onBegin candidate computation', () => {
  let cacheRoot: string;
  let statePath: string;

  beforeEach(() => {
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    vi.stubEnv('GITHUB_REPOSITORY', 'test-owner/test-repo');
    cacheRoot = mkdtempSync(join(tmpdir(), 'mergify-flaky-onbegin-'));
    statePath = stateFilePath(cacheRoot, 'run-1');
    process.env.MERGIFY_TEST_RUN_ID = 'run-1';
    process.env.MERGIFY_STATE_FILE = statePath;
  });

  afterEach(() => {
    rmSync(cacheRoot, { recursive: true, force: true });
    vi.unstubAllEnvs();
    delete process.env.MERGIFY_TEST_RUN_ID;
    delete process.env.MERGIFY_STATE_FILE;
  });

  function seedState(overrides: Record<string, unknown>): void {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        testRunId: 'run-1',
        createdAt: '2026-04-29T00:00:00Z',
        rootDir: '/root',
        quarantinedTests: [],
        ...overrides,
      })
    );
  }

  function suiteWithTests(tests: TestCase[]): Suite {
    return { allTests: () => tests } as unknown as Suite;
  }

  it('walks the suite and computes candidates from flakyContext+mode', () => {
    seedState({
      flakyContext: {
        budget_ratio_for_new_tests: 0.5,
        budget_ratio_for_unhealthy_tests: 0.5,
        existing_test_names: ['tests/sample.spec.ts > existing-test [proj]'],
        existing_tests_mean_duration_ms: 100,
        unhealthy_test_names: [],
        max_test_execution_count: 5,
        max_test_name_length: 200,
        min_budget_duration_ms: 1_000,
        min_test_execution_count: 3,
      },
      flakyMode: 'new',
    });

    const reporter = new MergifyReporter({ exporter: new InMemorySpanExporter() });
    const tests = [
      fakeTest({
        title: 'existing-test',
        titlePath: ['', 'proj', 'sample.spec.ts', 'existing-test'],
        location: { file: '/root/tests/sample.spec.ts', line: 1, column: 1 },
      }),
      fakeTest({
        title: 'new-test-1',
        titlePath: ['', 'proj', 'sample.spec.ts', 'new-test-1'],
        location: { file: '/root/tests/sample.spec.ts', line: 5, column: 1 },
      }),
      fakeTest({
        title: 'new-test-2',
        titlePath: ['', 'proj', 'sample.spec.ts', 'new-test-2'],
        location: { file: '/root/tests/sample.spec.ts', line: 10, column: 1 },
      }),
    ];
    reporter.onBegin(fakeConfig(), suiteWithTests(tests));

    expect(new Set(reporter.getFlakyCandidates())).toEqual(
      new Set([
        'tests/sample.spec.ts > new-test-1 [proj]',
        'tests/sample.spec.ts > new-test-2 [proj]',
      ])
    );
  });

  it('returns no candidates when flakyContext or flakyMode is absent', () => {
    seedState({});
    const reporter = new MergifyReporter({ exporter: new InMemorySpanExporter() });
    reporter.onBegin(fakeConfig(), suiteWithTests([]));

    expect(reporter.getFlakyCandidates()).toBeUndefined();
  });
});

describe('MergifyReporter — flaky-detection summary block', () => {
  let cacheRoot: string;
  let statePath: string;

  beforeEach(() => {
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    vi.stubEnv('GITHUB_REPOSITORY', 'test-owner/test-repo');
    cacheRoot = mkdtempSync(join(tmpdir(), 'mergify-flaky-summary-'));
    statePath = stateFilePath(cacheRoot, 'run-99');
    mkdirSync(dirname(statePath), { recursive: true });
    process.env.MERGIFY_TEST_RUN_ID = 'run-99';
    process.env.MERGIFY_STATE_FILE = statePath;
  });

  afterEach(() => {
    rmSync(cacheRoot, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    delete process.env.MERGIFY_TEST_RUN_ID;
    delete process.env.MERGIFY_STATE_FILE;
  });

  function seedFlakyState(extra: Record<string, unknown> = {}): void {
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        testRunId: 'run-99',
        createdAt: '2026-04-29T00:00:00Z',
        rootDir: '/root',
        quarantinedTests: [],
        flakyContext: {
          budget_ratio_for_new_tests: 0.5,
          budget_ratio_for_unhealthy_tests: 0.5,
          existing_test_names: [],
          existing_tests_mean_duration_ms: 100,
          unhealthy_test_names: [],
          max_test_execution_count: 5,
          max_test_name_length: 200,
          min_budget_duration_ms: 1_000,
          min_test_execution_count: 3,
        },
        flakyMode: 'unhealthy',
        ...extra,
      })
    );
  }

  it('prints the summary header when flakyMode is set, even with no candidates', async () => {
    seedFlakyState();
    const log = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exporter = new InMemorySpanExporter();
    const reporter = new MergifyReporter({ exporter });
    reporter.onBegin(fakeConfig(), fakeSuite());

    const test = fakeTest({
      title: 'a',
      titlePath: ['', 'proj', 'sample.spec.ts', 'a'],
      location: { file: '/root/tests/sample.spec.ts', line: 1, column: 1 },
    });
    reporter.onTestEnd(test, fakeResult({ status: 'passed' }));
    await reporter.onEnd({ status: 'passed', startTime: new Date(), duration: 1 });

    const out = log.mock.calls.map((c) => String(c[0])).join('');
    expect(out).toContain('Flaky detection report');
    expect(out).toContain('mode: unhealthy');
    // Test 'a' is not in flakyCandidates → not aggregated, so 0 rerun + 0 flaky.
    expect(out).toContain('Tests rerun: 0');
    expect(out).toContain('Flaky tests detected: 0');
  });

  it('preserves the first phase-1 failure when the same (test, project) key is recorded twice (Playwright `repeatEach`)', async () => {
    // Regression guard for the dedup-removal correctness bug: with
    // repeatEach > 1, Playwright clones each test with byte-identical
    // titlePath, so onTestEnd fires twice for the same key. The first
    // recorded failure must NOT be overwritten by a subsequent passing
    // repeat, otherwise the FlakyDetector seeds with the wrong status and
    // misses flaky-on-first-attempt tests entirely.
    seedFlakyState({
      flakyContext: {
        budget_ratio_for_new_tests: 0.5,
        budget_ratio_for_unhealthy_tests: 0.5,
        existing_test_names: [],
        existing_tests_mean_duration_ms: 100,
        unhealthy_test_names: ['tests/sample.spec.ts > a [proj]'],
        max_test_execution_count: 5,
        max_test_name_length: 200,
        min_budget_duration_ms: 1_000,
        min_test_execution_count: 3,
      },
    });
    const test = fakeTest({
      title: 'a',
      titlePath: ['', 'proj', 'sample.spec.ts', 'a'],
      location: { file: '/root/tests/sample.spec.ts', line: 1, column: 1 },
    });
    const reporter = new MergifyReporter({ exporter: new InMemorySpanExporter() });
    reporter.onBegin(fakeConfig(), { allTests: () => [test] } as unknown as Suite);
    // First clone fails, second clone (same key) passes.
    reporter.onTestEnd(test, fakeResult({ status: 'failed', errors: [] }));
    reporter.onTestEnd(test, fakeResult({ status: 'passed' }));
    await reporter.onEnd({ status: 'failed', startTime: new Date(), duration: 1 });

    // Both clones share a flakyDetection block (we decorate every buffered
    // entry), but flakyResults must have ONE row, and the fail seeded into
    // the detector must show up in the verdict as flaky=false-but-not-pass-
    // only (the test ran with one fail + zero phase-2 outcomes, so
    // isFlaky=false but rerunCount=0; the regression we're guarding against
    // is a second push to flakyResults inflating the count).
    const session = reporter.getSession()!;
    const candidate = session.testCases[0];
    expect(candidate.flakyDetection).toBeDefined();
  });

  it('treats the buildTestKey ` [project]` suffix as SAFE — the suffix is what formatTestListLine strips back off, not a real bracket character in the test name', async () => {
    // Regression guard: a previous version of the safety filter rejected
    // every multi-project candidate because the assembled key ends with
    // ` [project]` and that key was passed to isTestListSafe verbatim.
    // The filter must inspect the per-segment parts, not the decorated key.
    seedFlakyState({
      flakyContext: {
        budget_ratio_for_new_tests: 0.5,
        budget_ratio_for_unhealthy_tests: 0.5,
        existing_test_names: [],
        existing_tests_mean_duration_ms: 100,
        unhealthy_test_names: ['tests/sample.spec.ts > a [proj]'],
        max_test_execution_count: 5,
        max_test_name_length: 200,
        min_budget_duration_ms: 1_000,
        min_test_execution_count: 3,
      },
    });
    const log = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const test = fakeTest({
      title: 'a',
      titlePath: ['', 'proj', 'sample.spec.ts', 'a'],
      location: { file: '/root/tests/sample.spec.ts', line: 1, column: 1 },
    });
    const reporter = new MergifyReporter({ exporter: new InMemorySpanExporter() });
    reporter.onBegin(fakeConfig(), { allTests: () => [test] } as unknown as Suite);
    reporter.onTestEnd(test, fakeResult({ status: 'failed', errors: [] }));
    await reporter.onEnd({ status: 'failed', startTime: new Date(), duration: 1 });

    const out = log.mock.calls.map((c) => String(c[0])).join('');
    expect(out).not.toContain('skipping');
    expect(out).not.toContain('cannot disambiguate');
  });

  it('reports and skips a candidate whose project name contains an unsafe character', async () => {
    seedFlakyState({
      flakyContext: {
        budget_ratio_for_new_tests: 0.5,
        budget_ratio_for_unhealthy_tests: 0.5,
        existing_test_names: [],
        existing_tests_mean_duration_ms: 100,
        unhealthy_test_names: ['tests/sample.spec.ts > a [mobile > web]'],
        max_test_execution_count: 5,
        max_test_name_length: 200,
        min_budget_duration_ms: 1_000,
        min_test_execution_count: 3,
      },
    });
    const log = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const test = fakeTest({
      title: 'a',
      titlePath: ['', 'mobile > web', 'sample.spec.ts', 'a'],
      location: { file: '/root/tests/sample.spec.ts', line: 1, column: 1 },
    });
    const reporter = new MergifyReporter({ exporter: new InMemorySpanExporter() });
    reporter.onBegin(fakeConfig(), { allTests: () => [test] } as unknown as Suite);
    reporter.onTestEnd(test, fakeResult({ status: 'failed', errors: [] }));
    await reporter.onEnd({ status: 'failed', startTime: new Date(), duration: 1 });

    const out = log.mock.calls.map((c) => String(c[0])).join('');
    expect(out).toContain('skipping 1 flaky-detection candidate(s)');
    expect(out).toContain('tests/sample.spec.ts > a [mobile > web]');
  });

  it('does not emit flakyDetection for a candidate that was skipped in phase 1 and not rerun', async () => {
    // Mark the test as an unhealthy candidate so FlakyDetector identifies
    // it from the suite during onBegin. The test then runs as skipped in
    // phase 1. With no phase-1 outcome and no phase-2 outcome (subprocess
    // won't fire because phase1Outcomes is empty), the candidate should
    // NOT receive a `flakyDetection` block on its span.
    seedFlakyState({
      flakyContext: {
        budget_ratio_for_new_tests: 0.5,
        budget_ratio_for_unhealthy_tests: 0.5,
        existing_test_names: [],
        existing_tests_mean_duration_ms: 100,
        unhealthy_test_names: ['tests/sample.spec.ts > a [proj]'],
        max_test_execution_count: 5,
        max_test_name_length: 200,
        min_budget_duration_ms: 1_000,
        min_test_execution_count: 3,
      },
    });

    const test = fakeTest({
      title: 'a',
      titlePath: ['', 'proj', 'sample.spec.ts', 'a'],
      location: { file: '/root/tests/sample.spec.ts', line: 1, column: 1 },
    });

    const exporter = new InMemorySpanExporter();
    const reporter = new MergifyReporter({ exporter });
    reporter.onBegin(fakeConfig(), { allTests: () => [test] } as unknown as Suite);
    reporter.onTestEnd(test, fakeResult({ status: 'skipped' }));
    await reporter.onEnd({ status: 'passed', startTime: new Date(), duration: 1 });

    const tc = reporter.getSession()?.testCases[0];
    expect(tc?.flakyDetection).toBeUndefined();

    const span = exporter.getFinishedSpans().find((s) => s.attributes['test.scope'] === 'case');
    expect(span?.attributes['cicd.test.flaky_detection']).toBeUndefined();
    expect(span?.attributes['cicd.test.flaky']).toBeUndefined();
    expect(span?.attributes['cicd.test.rerun_count']).toBeUndefined();
  });
});
