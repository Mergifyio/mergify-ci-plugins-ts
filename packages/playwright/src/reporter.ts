import { createRequire } from 'node:module';
import type { TestCaseResult, TestRunSession, TracingContext } from '@mergifyio/ci-core';
import {
  createTracing,
  extractNamespace,
  generateTestRunId,
  getRepoName,
  isInCI,
} from '@mergifyio/ci-core';
import { type Span, SpanStatusCode, context, trace } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import type { SpanExporter } from '@opentelemetry/sdk-trace-base';
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';
import { MERGIFY_STATE_PATH } from './global-setup.js';
import * as playwrightResource from './resources/playwright.js';
import { readState } from './state.js';

const DEFAULT_API_URL = 'https://api.mergify.com';

export interface MergifyPlaywrightReporterOptions {
  apiUrl?: string;
  token?: string;
  exporter?: SpanExporter;
}

function getPlaywrightVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('@playwright/test/package.json') as { version: string };
    return pkg.version;
  } catch {
    return 'unknown';
  }
}

function mapStatus(status: TestResult['status']): 'passed' | 'failed' | 'skipped' {
  switch (status) {
    case 'passed':
      return 'passed';
    case 'failed':
    case 'timedOut':
    case 'interrupted':
      return 'failed';
    case 'skipped':
      return 'skipped';
    default:
      return 'failed';
  }
}

export class MergifyPlaywrightReporter implements Reporter {
  private session: TestRunSession | undefined;
  private tracing: TracingContext | null = null;
  private sessionSpan: Span | undefined;
  private options: MergifyPlaywrightReporterOptions;
  private quarantineList: Set<string> = new Set();
  private quarantinedCaught: string[] = [];
  private nonQuarantinedFailures = 0;

  constructor(options?: MergifyPlaywrightReporterOptions) {
    this.options = options ?? {};
  }

  // Playwright reporters don't have a built-in logger object
  private log(msg: string): void {
    // eslint-disable-next-line no-console
    console.log(msg);
  }

  onBegin(_config: FullConfig, _suite: Suite): void {
    const testRunId = generateTestRunId();
    const token = this.options.token ?? process.env.MERGIFY_TOKEN;
    const apiUrl = this.options.apiUrl ?? process.env.MERGIFY_API_URL ?? DEFAULT_API_URL;
    const repoName = getRepoName();
    const playwrightVersion = getPlaywrightVersion();

    const enabled = isInCI() || !!this.options.exporter;

    if (enabled) {
      this.tracing = createTracing({
        token,
        repoName,
        apiUrl,
        testRunId,
        frameworkAttributes: playwrightResource.detect(playwrightVersion),
        tracerName: '@mergifyio/playwright',
        exporter: this.options.exporter,
      });
    }

    if (!this.tracing && enabled) {
      if (!token) {
        this.log('[@mergifyio/playwright] MERGIFY_TOKEN not set, skipping CI Insights reporting');
      } else if (!repoName) {
        this.log(
          '[@mergifyio/playwright] Could not detect repository name, skipping CI Insights reporting'
        );
      }
    }

    // Load quarantine list from state file
    const state = readState(MERGIFY_STATE_PATH);
    if (!state && enabled) {
      this.log(
        '[@mergifyio/playwright] State file not found — did you configure mergifyGlobalSetup as globalSetup in your Playwright config?'
      );
    }
    if (state && state.quarantineList.length > 0) {
      this.quarantineList = new Set(state.quarantineList);
    }

    this.session = {
      testRunId,
      scope: 'session',
      startTime: Date.now(),
      status: 'passed',
      testCases: [],
    };

    if (this.tracing) {
      let parentContext = context.active();

      const traceparent = process.env.MERGIFY_TRACEPARENT;
      if (traceparent) {
        const carrier = { traceparent };
        const propagator = new W3CTraceContextPropagator();
        parentContext = propagator.extract(context.active(), carrier, {
          get(c: Record<string, string>, key: string) {
            return c[key];
          },
          keys(c: Record<string, string>) {
            return Object.keys(c);
          },
        });
      }

      this.sessionSpan = this.tracing.tracer.startSpan(
        'playwright session start',
        { attributes: { 'test.scope': 'session' } },
        parentContext
      );
    }
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (!this.session) return;

    const titlePath = test.titlePath().filter(Boolean).slice(1);
    const fullName = titlePath.join(' > ');
    const testName = test.title;
    const namespace = extractNamespace(fullName, testName);
    const filepath = test.location.file;
    const lineno = test.location.line;
    const isFlaky = test.outcome() === 'flaky';
    const isQuarantined = this.quarantineList.has(fullName);
    const status = mapStatus(result.status);

    if (isQuarantined && status === 'failed') {
      this.quarantinedCaught.push(fullName);
    } else if (status === 'failed') {
      this.nonQuarantinedFailures++;
    }

    const startTimeMs = result.startTime.getTime();
    const duration = result.duration;

    const testCaseResult: TestCaseResult = {
      filepath,
      absoluteFilepath: filepath,
      function: testName,
      lineno,
      namespace,
      scope: 'case',
      status,
      duration,
      startTime: startTimeMs,
      retryCount: result.retry,
      flaky: isFlaky,
    };

    if (status === 'failed' && result.errors.length > 0) {
      const firstError = result.errors[0];
      testCaseResult.error = {
        type: firstError.message?.split('\n')[0] ?? 'Error',
        message: firstError.message ?? '',
        stacktrace: firstError.stack ?? '',
      };
    }

    this.session.testCases.push(testCaseResult);

    // Create OTel span for this test case
    if (this.tracing && this.sessionSpan) {
      const parentCtx = trace.setSpan(context.active(), this.sessionSpan);
      const endTimeMs = startTimeMs + duration;

      const span = this.tracing.tracer.startSpan(
        fullName,
        {
          attributes: {
            'code.filepath': filepath,
            'code.function': testName,
            'code.lineno': lineno,
            'code.namespace': namespace,
            'code.file.path': filepath,
            'code.line.number': lineno,
            'test.scope': 'case',
            'test.case.result.status': status,
            'cicd.test.quarantined': isQuarantined,
            'cicd.test.flaky': isFlaky,
          },
          startTime: startTimeMs,
        },
        parentCtx
      );

      if (testCaseResult.error) {
        span.setAttributes({
          'exception.type': testCaseResult.error.type,
          'exception.message': testCaseResult.error.message,
          'exception.stacktrace': testCaseResult.error.stacktrace,
        });
      }

      if (status === 'failed') {
        span.setStatus({ code: SpanStatusCode.ERROR });
      } else {
        span.setStatus({ code: SpanStatusCode.OK });
      }

      span.end(endTimeMs);
    }
  }

  async onEnd(
    result: FullResult
  ): Promise<{ status?: FullResult['status'] } | undefined | void> {
    if (!this.session) return;

    this.session.endTime = Date.now();

    // If the only failures were quarantined, override the result to pass
    const allFailuresQuarantined =
      result.status === 'failed' &&
      this.quarantinedCaught.length > 0 &&
      this.nonQuarantinedFailures === 0;

    this.session.status =
      result.status === 'passed' || allFailuresQuarantined ? 'passed' : 'failed';

    // Print quarantine summary
    if (this.quarantineList.size > 0) {
      this.log('');
      this.log('[@mergifyio/playwright] Quarantine report:');
      this.log(`  Quarantined tests fetched: ${this.quarantineList.size}`);

      if (this.quarantinedCaught.length > 0) {
        this.log(
          `  Quarantined tests caught (failures absorbed): ${this.quarantinedCaught.length}`
        );
        for (const name of this.quarantinedCaught) {
          this.log(`    - ${name}`);
        }
      }

      const unusedCount = this.quarantineList.size - this.quarantinedCaught.length;
      if (unusedCount > 0) {
        this.log(`  Unused quarantine entries: ${unusedCount}`);
      }
    }

    if (this.sessionSpan) {
      if (result.status !== 'passed' && !allFailuresQuarantined) {
        this.sessionSpan.setStatus({ code: SpanStatusCode.ERROR });
      } else {
        this.sessionSpan.setStatus({ code: SpanStatusCode.OK });
      }
      this.sessionSpan.end();
    }

    if (this.tracing) {
      try {
        await this.tracing.tracerProvider.forceFlush();
      } catch (err) {
        this.log(`[@mergifyio/playwright] Failed to flush spans: ${err}`);
      }
      if (this.tracing.ownsExporter) {
        try {
          await this.tracing.tracerProvider.shutdown();
        } catch {
          // ignore shutdown errors
        }
      }
    }

    if (allFailuresQuarantined) {
      return { status: 'passed' };
    }
  }

  getSession(): TestRunSession | undefined {
    return this.session;
  }

  getExporter(): SpanExporter | undefined {
    return this.tracing?.exporter;
  }
}

export default MergifyPlaywrightReporter;
