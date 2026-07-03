import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FlakyDetectionContext } from '@mergifyio/ci-core';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startVitest } from 'vitest/node';
import { MergifyReporter } from '../src/reporter.js';

const fixturesDir = resolve(import.meta.dirname, 'fixtures');

const flakyContext: FlakyDetectionContext = {
  budget_ratio_for_new_tests: 1.0,
  budget_ratio_for_unhealthy_tests: 1.0,
  existing_test_names: [],
  existing_tests_mean_duration_ms: 100,
  unhealthy_test_names: [],
  max_test_execution_count: 5,
  max_test_name_length: 255,
  min_budget_duration_ms: 10_000,
  min_test_execution_count: 2,
};

describe('Flaky detection runner', () => {
  beforeEach(() => {
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    vi.stubEnv('GITHUB_REPOSITORY', 'test-owner/test-repo');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reruns candidate test and detects flakiness', async () => {
    const exporter = new InMemorySpanExporter();
    const reporter = new MergifyReporter({
      exporter,
      flakyContext,
      flakyMode: 'new',
    });

    const vitest = await startVitest('test', [], {
      root: fixturesDir,
      include: ['flaky.test.ts'],
      reporters: [reporter],
      watch: false,
    });
    await vitest?.close();

    const session = reporter.getSession();
    expect(session).toBeDefined();

    // Check spans for flaky detection attributes
    const spans = exporter.getFinishedSpans();
    const testSpan = spans.find((s) => s.attributes['test.scope'] === 'case');

    expect(testSpan).toBeDefined();
    expect(testSpan!.attributes['cicd.test.flaky_detection']).toBe(true);
    expect(testSpan!.attributes['cicd.test.new']).toBe(true);
    expect(testSpan!.attributes['cicd.test.rerun_count']).toBeGreaterThan(0);
  });

  it('does not rerun tests that are not candidates', async () => {
    const exporter = new InMemorySpanExporter();
    // All tests are "existing" so none are candidates in "new" mode
    const ctx = {
      ...flakyContext,
      existing_test_names: ['passing.test.ts > math > adds numbers'],
    };
    const reporter = new MergifyReporter({
      exporter,
      flakyContext: ctx,
      flakyMode: 'new',
    });

    const vitest = await startVitest('test', [], {
      root: fixturesDir,
      include: ['passing.test.ts'],
      reporters: [reporter],
      watch: false,
    });
    await vitest?.close();

    const spans = exporter.getFinishedSpans();
    const testSpan = spans.find((s) => s.attributes['test.scope'] === 'case');

    expect(testSpan).toBeDefined();
    // No flaky detection attributes since test is existing
    expect(testSpan!.attributes['cicd.test.flaky_detection']).toBeUndefined();
  });

  it('skips flaky detection on draft pull requests', async () => {
    // Drive the env-gated path (token + repo + mode set) so the only reason
    // detection is skipped is the draft guard, then assert the
    // flaky-detection-context endpoint is never fetched.
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ quarantined_tests: [] }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('MERGIFY_TOKEN', 'test-token');
    vi.stubEnv('_MERGIFY_TEST_NEW_FLAKY_DETECTION', 'new');

    const eventDir = mkdtempSync(join(tmpdir(), 'mergify-event-'));
    writeFileSync(join(eventDir, 'event.json'), JSON.stringify({ pull_request: { draft: true } }));
    vi.stubEnv('GITHUB_EVENT_NAME', 'pull_request');
    vi.stubEnv('GITHUB_EVENT_PATH', join(eventDir, 'event.json'));

    const exporter = new InMemorySpanExporter();
    const reporter = new MergifyReporter({ exporter });

    const vitest = await startVitest('test', [], {
      root: fixturesDir,
      include: ['passing.test.ts'],
      reporters: [reporter],
      watch: false,
    });
    await vitest?.close();

    // The draft guard short-circuits before the flaky-detection-context fetch.
    const fetchedFlakyContext = fetchMock.mock.calls.some((call) =>
      String(call[0]).includes('flaky-detection-context')
    );
    expect(fetchedFlakyContext).toBe(false);
    const spans = exporter.getFinishedSpans();
    const testSpan = spans.find((s) => s.attributes['test.scope'] === 'case');
    expect(testSpan).toBeDefined();
    expect(testSpan!.attributes['cicd.test.flaky_detection']).toBeUndefined();

    rmSync(eventDir, { recursive: true, force: true });
  });
});
