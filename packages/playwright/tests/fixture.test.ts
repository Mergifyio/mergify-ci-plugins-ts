import { describe, expect, it } from 'vitest';
import { applyQuarantine } from '../src/fixture.js';

type Status = 'passed' | 'failed' | 'timedOut' | 'interrupted' | 'skipped';

interface MockInfo {
  title: string;
  titlePath: string[];
  file: string;
  project: { name: string };
  status: Status;
  // Mirrors Playwright's TestInfo.expectedStatus enum (test.d.ts:2494) — the
  // fixture sets it to a non-default value (e.g. 'timedOut') under quarantine,
  // so the mock must accept the same range.
  expectedStatus: Status;
  annotations: Array<{ type: string; description?: string }>;
}

function mockInfo(overrides: Partial<MockInfo> = {}): MockInfo {
  return {
    title: 'adds numbers',
    // Real worker-side TestInfo.titlePath shape: [file, ...describes, title].
    // The runner-side TestCase.titlePath() prepends `['', project]` but the
    // worker's parent chain does not include the root/project suites — that
    // info lives on testInfo.project instead.
    titlePath: ['math.spec.ts', 'math', 'adds numbers'],
    file: '/repo/tests/math.spec.ts',
    project: { name: 'chromium' },
    status: 'passed',
    expectedStatus: 'passed',
    annotations: [],
    ...overrides,
  };
}

describe('applyQuarantine', () => {
  // Quarantine entries arriving from the backend carry the same ` [project]`
  // suffix `buildTestKey` produces — they're the same string the span name
  // is built from.
  const quarantineSet = new Set(['tests/math.spec.ts > math > adds numbers [chromium]']);

  it('mutates expectedStatus and pushes annotation when quarantined + failed', () => {
    const info = mockInfo({ status: 'failed' });
    applyQuarantine({ testInfo: info as never, quarantineSet, rootDir: '/repo' });
    expect(info.expectedStatus).toBe('failed');
    expect(info.annotations).toContainEqual({ type: 'mergify:quarantined' });
  });

  it('does not mutate when quarantined but passing (non-strict semantics)', () => {
    const info = mockInfo({ status: 'passed' });
    applyQuarantine({ testInfo: info as never, quarantineSet, rootDir: '/repo' });
    expect(info.expectedStatus).toBe('passed');
    expect(info.annotations).toEqual([]);
  });

  it('does not mutate when failing but not quarantined', () => {
    const info = mockInfo({
      status: 'failed',
      title: 'other',
      titlePath: ['math.spec.ts', 'math', 'other'],
    });
    applyQuarantine({ testInfo: info as never, quarantineSet, rootDir: '/repo' });
    expect(info.expectedStatus).toBe('passed');
    expect(info.annotations).toEqual([]);
  });

  it('does not absorb when the project name does not match the quarantine entry', () => {
    // Same logical test, different project — the per-(test, project) key
    // means a `[chromium]` quarantine entry must NOT match a `[firefox]`
    // failure, preserving the cross-browser visibility we want.
    const info = mockInfo({ status: 'failed', project: { name: 'firefox' } });
    applyQuarantine({ testInfo: info as never, quarantineSet, rootDir: '/repo' });
    expect(info.expectedStatus).toBe('passed');
    expect(info.annotations).toEqual([]);
  });

  it('is a no-op when the quarantine set is empty', () => {
    const info = mockInfo({ status: 'failed' });
    applyQuarantine({ testInfo: info as never, quarantineSet: new Set(), rootDir: '/repo' });
    expect(info.expectedStatus).toBe('passed');
  });

  it('mirrors expectedStatus to the actual status for timedOut', () => {
    const info = mockInfo({ status: 'timedOut' });
    applyQuarantine({ testInfo: info as never, quarantineSet, rootDir: '/repo' });
    // Playwright reconciles by equality (status === expectedStatus). Setting
    // 'failed' here would still leave the test reported as a failure because
    // 'timedOut' !== 'failed'. Mirroring is the only correct mutation.
    expect(info.expectedStatus).toBe('timedOut');
    expect(info.annotations).toContainEqual({ type: 'mergify:quarantined' });
  });

  it('mirrors expectedStatus to the actual status for interrupted', () => {
    const info = mockInfo({ status: 'interrupted' });
    applyQuarantine({ testInfo: info as never, quarantineSet, rootDir: '/repo' });
    expect(info.expectedStatus).toBe('interrupted');
    expect(info.annotations).toContainEqual({ type: 'mergify:quarantined' });
  });
});
