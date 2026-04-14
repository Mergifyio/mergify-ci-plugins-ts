import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import type {
  FullConfig,
  FullResult,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';
import { describe, expect, it } from 'vitest';
import { MergifyPlaywrightReporter } from '../src/reporter.js';

function createMockConfig(): FullConfig {
  return {} as FullConfig;
}

function createMockSuite(): Suite {
  return { allTests: () => [] } as unknown as Suite;
}

function createMockTest(overrides: {
  title: string;
  titlePath: string[];
  file: string;
  line: number;
  outcome?: 'expected' | 'unexpected' | 'flaky' | 'skipped';
}): TestCase {
  return {
    title: overrides.title,
    titlePath: () => overrides.titlePath,
    location: { file: overrides.file, line: overrides.line, column: 0 },
    outcome: () => overrides.outcome ?? 'expected',
  } as unknown as TestCase;
}

function createMockResult(overrides: {
  status: TestResult['status'];
  startTime?: Date;
  duration?: number;
  errors?: Array<{ message?: string; stack?: string }>;
  retry?: number;
}): TestResult {
  return {
    status: overrides.status,
    startTime: overrides.startTime ?? new Date(),
    duration: overrides.duration ?? 100,
    errors: overrides.errors ?? [],
    retry: overrides.retry ?? 0,
    attachments: [],
    stdout: [],
    stderr: [],
    steps: [],
  } as unknown as TestResult;
}

describe('MergifyPlaywrightReporter', () => {
  it('records a passing test as an OTel span', async () => {
    const exporter = new InMemorySpanExporter();
    const reporter = new MergifyPlaywrightReporter({ exporter });

    reporter.onBegin(createMockConfig(), createMockSuite());

    reporter.onTestEnd(
      createMockTest({
        title: 'adds numbers',
        titlePath: ['', '', 'tests/math.spec.ts', 'math', 'adds numbers'],
        file: 'tests/math.spec.ts',
        line: 5,
      }),
      createMockResult({ status: 'passed' })
    );

    await reporter.onEnd({ status: 'passed' } as FullResult);

    const spans = exporter.getFinishedSpans();
    // Session span + 1 test span
    expect(spans.length).toBe(2);

    const testSpan = spans.find((s) => s.name === 'math > adds numbers');
    expect(testSpan).toBeDefined();
    expect(testSpan!.attributes['test.case.result.status']).toBe('passed');
    expect(testSpan!.attributes['code.function']).toBe('adds numbers');
    expect(testSpan!.attributes['code.namespace']).toBe('math');
  });

  it('records a failing test with error attributes', async () => {
    const exporter = new InMemorySpanExporter();
    const reporter = new MergifyPlaywrightReporter({ exporter });

    reporter.onBegin(createMockConfig(), createMockSuite());

    reporter.onTestEnd(
      createMockTest({
        title: 'fails',
        titlePath: ['', '', 'tests/fail.spec.ts', 'suite', 'fails'],
        file: 'tests/fail.spec.ts',
        line: 10,
        outcome: 'unexpected',
      }),
      createMockResult({
        status: 'failed',
        errors: [{ message: 'Expected true to be false', stack: 'Error: Expected true...' }],
      })
    );

    await reporter.onEnd({ status: 'failed' } as FullResult);

    const spans = exporter.getFinishedSpans();
    const testSpan = spans.find((s) => s.name === 'suite > fails');
    expect(testSpan).toBeDefined();
    expect(testSpan!.attributes['test.case.result.status']).toBe('failed');
    expect(testSpan!.attributes['exception.message']).toBe('Expected true to be false');
  });

  it('records a skipped test', async () => {
    const exporter = new InMemorySpanExporter();
    const reporter = new MergifyPlaywrightReporter({ exporter });

    reporter.onBegin(createMockConfig(), createMockSuite());

    reporter.onTestEnd(
      createMockTest({
        title: 'skipped test',
        titlePath: ['', '', 'tests/skip.spec.ts', 'suite', 'skipped test'],
        file: 'tests/skip.spec.ts',
        line: 3,
        outcome: 'skipped',
      }),
      createMockResult({ status: 'skipped' })
    );

    await reporter.onEnd({ status: 'passed' } as FullResult);

    const spans = exporter.getFinishedSpans();
    const testSpan = spans.find((s) => s.name === 'suite > skipped test');
    expect(testSpan).toBeDefined();
    expect(testSpan!.attributes['test.case.result.status']).toBe('skipped');
  });
});
