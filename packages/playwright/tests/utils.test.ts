import { describe, expect, it } from 'vitest';
import {
  buildTestFunction,
  buildTestKey,
  buildTestKeyFromInfo,
  buildTestKeyParts,
  extractNamespace,
  formatTestListLine,
  isTestListSafe,
  mapStatus,
  projectNameFromTest,
  toPosix,
} from '../src/utils.js';

describe('extractNamespace', () => {
  it('prefixes the describe chain with the filepath', () => {
    expect(
      extractNamespace('tests/foo.spec.ts', [
        '',
        'chromium',
        'tests/foo.spec.ts',
        'outer',
        'inner',
        'my test',
      ])
    ).toBe('tests/foo.spec.ts > outer > inner');
  });

  it('returns just the filepath when there is no describe', () => {
    expect(
      extractNamespace('tests/foo.spec.ts', ['', 'chromium', 'tests/foo.spec.ts', 'my test'])
    ).toBe('tests/foo.spec.ts');
  });

  it('handles a single describe', () => {
    expect(
      extractNamespace('tests/foo.spec.ts', [
        '',
        'chromium',
        'tests/foo.spec.ts',
        'outer',
        'my test',
      ])
    ).toBe('tests/foo.spec.ts > outer');
  });

  it('drops empty segments so the result has no leading or trailing separator', () => {
    expect(extractNamespace('', ['', '', '', 'outer', 'my test'])).toBe('outer');
  });
});

describe('toPosix', () => {
  it('is a no-op on POSIX-style paths', () => {
    expect(toPosix('tests/sample.spec.ts')).toBe('tests/sample.spec.ts');
  });

  it('replaces backslashes with forward slashes (Windows input)', () => {
    expect(toPosix('tests\\sample.spec.ts')).toBe('tests/sample.spec.ts');
  });

  it('handles mixed separators', () => {
    expect(toPosix('packages\\core/src\\types.ts')).toBe('packages/core/src/types.ts');
  });

  it('returns empty string unchanged', () => {
    expect(toPosix('')).toBe('');
  });
});

describe('extractNamespace — Windows-style input', () => {
  it('produces POSIX-separated output when the caller pre-normalizes with toPosix', () => {
    const winPath = toPosix('tests\\sample.spec.ts');
    expect(extractNamespace(winPath, ['', 'chromium', 'sample.spec.ts', 'my test'])).toBe(
      'tests/sample.spec.ts'
    );
  });
});

describe('mapStatus', () => {
  it.each([
    ['passed', 'passed'],
    ['skipped', 'skipped'],
    ['failed', 'failed'],
    ['timedOut', 'failed'],
    ['interrupted', 'failed'],
  ] as const)('maps %s to %s', (input, expected) => {
    expect(mapStatus(input)).toBe(expected);
  });
});

describe('projectNameFromTest', () => {
  it('returns titlePath[1] as the project name (real Playwright shape)', () => {
    const fakeTest = {
      titlePath: () => ['', 'firefox', 'tests/x.spec.ts', 'my test'],
    } as unknown as Parameters<typeof projectNameFromTest>[0];
    expect(projectNameFromTest(fakeTest)).toBe('firefox');
  });

  it('returns undefined when titlePath[1] is empty (unnamed default project)', () => {
    const fakeTest = {
      titlePath: () => ['', '', 'tests/x.spec.ts', 'my test'],
    } as unknown as Parameters<typeof projectNameFromTest>[0];
    expect(projectNameFromTest(fakeTest)).toBeUndefined();
  });
});

describe('buildTestFunction', () => {
  it('returns the bare title when project is undefined', () => {
    expect(buildTestFunction('my test', undefined)).toBe('my test');
  });

  it('returns the bare title when project is empty', () => {
    expect(buildTestFunction('my test', '')).toBe('my test');
  });

  it('appends [project] when project is non-empty', () => {
    expect(buildTestFunction('my test', 'firefox')).toBe('my test [firefox]');
  });
});

describe('buildTestKey', () => {
  it('appends [project] to the key when project is set', () => {
    expect(
      buildTestKey(
        'tests/auth.spec.ts',
        ['', 'chromium', 'tests/auth.spec.ts', 'Login', 'submits form'],
        'submits form'
      )
    ).toBe('tests/auth.spec.ts > Login > submits form [chromium]');
  });

  it('omits [project] when the project slot is empty (single unnamed project)', () => {
    expect(
      buildTestKey(
        'tests/auth.spec.ts',
        ['', '', 'tests/auth.spec.ts', 'submits form'],
        'submits form'
      )
    ).toBe('tests/auth.spec.ts > submits form');
  });

  it('drops empty segments (no filepath, no describes, no project)', () => {
    expect(buildTestKey('', ['', '', '', 'Outer', 'my test'], 'my test')).toBe('Outer > my test');
  });

  it('agrees with extractNamespace + " > " + decorated title (parity guard)', () => {
    const filepath = 'tests/foo.spec.ts';
    const titlePath = ['', 'chromium', 'tests/foo.spec.ts', 'Outer', 'Inner', 'case name'];
    const title = 'case name';
    expect(buildTestKey(filepath, titlePath, title)).toBe(
      `${extractNamespace(filepath, titlePath)} > ${title} [chromium]`
    );
  });

  it('matches the span-name formula when namespace is empty and no project', () => {
    const filepath = '';
    const titlePath = ['', '', '', 'solo'];
    const title = 'solo';
    const namespace = extractNamespace(filepath, titlePath);
    const decoratedTitle = buildTestFunction(title, titlePath[1]);
    const expectedSpanName =
      namespace.length > 0 ? `${namespace} > ${decoratedTitle}` : decoratedTitle;
    expect(buildTestKey(filepath, titlePath, title)).toBe(expectedSpanName);
  });

  it('dedupes the file suite from titlePath (Playwright runtime format)', () => {
    // At runtime Playwright exposes the test file as a Suite, so titlePath is
    //   ['', 'node', 'sample.spec.ts', 'quarantined-fails']
    // Without the dedup step the key would be
    //   "tests/sample.spec.ts > sample.spec.ts > quarantined-fails [node]"
    expect(
      buildTestKey(
        'tests/sample.spec.ts',
        ['', 'node', 'sample.spec.ts', 'quarantined-fails'],
        'quarantined-fails'
      )
    ).toBe('tests/sample.spec.ts > quarantined-fails [node]');
  });

  it('dedupes when titlePath contains the full filepath rather than the basename', () => {
    expect(
      buildTestKey(
        'tests/sample.spec.ts',
        ['', 'node', 'tests/sample.spec.ts', 'describe', 'case'],
        'case'
      )
    ).toBe('tests/sample.spec.ts > describe > case [node]');
  });
});

describe('buildTestKeyFromInfo', () => {
  // TestInfo.titlePath in the worker has shape [file, ...describes, title]
  // with NO project / root prefix — project comes from testInfo.project.name
  // and must be passed in separately. Round-trip must equal buildTestKey on
  // the same logical test so the backend match succeeds.
  it('produces the same key as buildTestKey for the same logical test', () => {
    const filepath = 'tests/sample.spec.ts';
    const fromInfo = buildTestKeyFromInfo(
      filepath,
      ['sample.spec.ts', 'Outer', 'flaky-test'],
      'node',
      'flaky-test'
    );
    const fromCase = buildTestKey(
      filepath,
      ['', 'node', 'sample.spec.ts', 'Outer', 'flaky-test'],
      'flaky-test'
    );
    expect(fromInfo).toBe(fromCase);
    expect(fromInfo).toBe('tests/sample.spec.ts > Outer > flaky-test [node]');
  });

  it('handles a flat test (no describes)', () => {
    expect(
      buildTestKeyFromInfo(
        'sample.spec.ts',
        ['sample.spec.ts', 'quarantined-fails'],
        'node',
        'quarantined-fails'
      )
    ).toBe('sample.spec.ts > quarantined-fails [node]');
  });

  it('omits [project] when project is the empty string (unnamed default project)', () => {
    expect(
      buildTestKeyFromInfo('sample.spec.ts', ['sample.spec.ts', 'my test'], '', 'my test')
    ).toBe('sample.spec.ts > my test');
  });
});

describe('formatTestListLine', () => {
  it('returns the key as-is when project is undefined', () => {
    expect(formatTestListLine('tests/x.spec.ts > my test', undefined)).toBe(
      'tests/x.spec.ts > my test'
    );
  });

  it('returns the key as-is when project is empty', () => {
    expect(formatTestListLine('tests/x.spec.ts > my test', '')).toBe('tests/x.spec.ts > my test');
  });

  it('strips the trailing [project] suffix and prepends [project] >', () => {
    // ` > ` is used as the separator throughout the line — mixing in `›`
    // breaks Playwright's loadTestList which picks one delimiter per line.
    expect(formatTestListLine('tests/x.spec.ts > my test [firefox]', 'firefox')).toBe(
      '[firefox] > tests/x.spec.ts > my test'
    );
  });

  it('throws when the key does not end with the expected `[project]` suffix', () => {
    // The defensive fallback the previous version had silently produced a
    // valid-looking line that pointed at a different test. A mismatched
    // (key, project) pair is a caller bug; surface it loudly instead of
    // emitting a line that Playwright will dutifully run against the wrong
    // candidate.
    expect(() => formatTestListLine('tests/x.spec.ts > my test', 'firefox')).toThrowError(
      /does not end with project suffix/
    );
  });
});

describe('buildTestKeyParts', () => {
  // The parts function returns the unfiltered segments so the safety check
  // can audit each one individually before phase 2 writes it to a
  // --test-list line. The full assembled `buildTestKey` always ends in
  // ` [project]`, which carries `[` / `]` and would fail isTestListSafe by
  // construction — that's why we audit segments, not the key.
  it('returns [filepath, ...describes, title] after stripFileSuite', () => {
    expect(
      buildTestKeyParts(
        'tests/sample.spec.ts',
        ['', 'node', 'sample.spec.ts', 'Outer', 'flaky-test'],
        'flaky-test'
      )
    ).toEqual(['tests/sample.spec.ts', 'Outer', 'flaky-test']);
  });

  it('handles flat tests (no describes)', () => {
    expect(
      buildTestKeyParts(
        'sample.spec.ts',
        ['', 'node', 'sample.spec.ts', 'quarantined-fails'],
        'quarantined-fails'
      )
    ).toEqual(['sample.spec.ts', 'quarantined-fails']);
  });
});

describe('isTestListSafe', () => {
  // Playwright's `loadTestList` (lib/runner/index.js:2578-2584) splits each
  // line on `>` (or `›`, whichever appears first) and then requires a
  // leading `[…]` bracket to close on the SAME token. A `>` / `[` / `]` /
  // `›` / newline inside a project name, file path, describe, or title
  // therefore throws "Malformed test description" and aborts the entire
  // phase-2 subprocess. `runFlakyDetectionPhase2` pre-filters via this
  // predicate so one unrepresentable name can't collapse every verdict.
  it.each([
    ['bare ascii', true],
    ['mobile > web', false],
    ['chrome [test]', false],
    ['tests/[id].spec.ts', false],
    ['line\nbreak', false],
    ['unicode ›', false],
  ] as const)('isTestListSafe(%j) → %s', (input, expected) => {
    expect(isTestListSafe(input)).toBe(expected);
  });
});
