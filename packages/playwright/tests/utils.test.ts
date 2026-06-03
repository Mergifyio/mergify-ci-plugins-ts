import { describe, expect, it } from 'vitest';
import {
  buildTestKey,
  buildTestKeyFromInfo,
  buildTestKeyParts,
  extractNamespace,
  isTestListSafe,
  mapStatus,
  projectNameFromTest,
  toPosix,
} from '../src/utils.js';

describe('extractNamespace', () => {
  // The namespace carries the `[project] >` prefix so the assembled span
  // name (`namespace > function`) comes out as Playwright's idiomatic
  // `[project] > file > describes > title`. When project is empty the
  // prefix is omitted and the namespace matches the previous shape.
  it('prefixes [project] then filepath then the describe chain', () => {
    expect(
      extractNamespace('tests/foo.spec.ts', [
        '',
        'chromium',
        'tests/foo.spec.ts',
        'outer',
        'inner',
        'my test',
      ])
    ).toBe('[chromium] > tests/foo.spec.ts > outer > inner');
  });

  it('returns just `[project] > filepath` when there is no describe', () => {
    expect(
      extractNamespace('tests/foo.spec.ts', ['', 'chromium', 'tests/foo.spec.ts', 'my test'])
    ).toBe('[chromium] > tests/foo.spec.ts');
  });

  it('omits the `[project]` prefix when the project slot is empty', () => {
    expect(
      extractNamespace('tests/foo.spec.ts', ['', '', 'tests/foo.spec.ts', 'outer', 'my test'])
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
      '[chromium] > tests/sample.spec.ts'
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

describe('buildTestKey', () => {
  it('prepends `[project] >` to the key when project is set', () => {
    expect(
      buildTestKey(
        'tests/auth.spec.ts',
        ['', 'chromium', 'tests/auth.spec.ts', 'Login', 'submits form'],
        'submits form'
      )
    ).toBe('[chromium] > tests/auth.spec.ts > Login > submits form');
  });

  it('omits `[project] >` when the project slot is empty (single unnamed project)', () => {
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

  it('agrees with extractNamespace + " > " + title (parity guard)', () => {
    // The span name is built as `${namespace} > ${function}` in
    // ci-core/spans.ts. `function` is the bare title; the project lives in
    // namespace via the `[project] >` prefix. This guard keeps the two key
    // sources from drifting.
    const filepath = 'tests/foo.spec.ts';
    const titlePath = ['', 'chromium', 'tests/foo.spec.ts', 'Outer', 'Inner', 'case name'];
    const title = 'case name';
    expect(buildTestKey(filepath, titlePath, title)).toBe(
      `${extractNamespace(filepath, titlePath)} > ${title}`
    );
  });

  it('dedupes the file suite from titlePath (Playwright runtime format)', () => {
    // At runtime Playwright exposes the test file as a Suite, so titlePath is
    //   ['', 'node', 'sample.spec.ts', 'quarantined-fails']
    // Without the dedup step the key would have a duplicated filepath
    // segment.
    expect(
      buildTestKey(
        'tests/sample.spec.ts',
        ['', 'node', 'sample.spec.ts', 'quarantined-fails'],
        'quarantined-fails'
      )
    ).toBe('[node] > tests/sample.spec.ts > quarantined-fails');
  });

  it('dedupes when titlePath contains the full filepath rather than the basename', () => {
    expect(
      buildTestKey(
        'tests/sample.spec.ts',
        ['', 'node', 'tests/sample.spec.ts', 'describe', 'case'],
        'case'
      )
    ).toBe('[node] > tests/sample.spec.ts > describe > case');
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
    expect(fromInfo).toBe('[node] > tests/sample.spec.ts > Outer > flaky-test');
  });

  it('handles a flat test (no describes)', () => {
    expect(
      buildTestKeyFromInfo(
        'sample.spec.ts',
        ['sample.spec.ts', 'quarantined-fails'],
        'node',
        'quarantined-fails'
      )
    ).toBe('[node] > sample.spec.ts > quarantined-fails');
  });

  it('omits the `[project] >` prefix when project is the empty string', () => {
    expect(
      buildTestKeyFromInfo('sample.spec.ts', ['sample.spec.ts', 'my test'], '', 'my test')
    ).toBe('sample.spec.ts > my test');
  });
});

describe('buildTestKeyParts', () => {
  // The parts function returns the unfiltered body segments so the safety
  // check can audit each one individually before phase 2 writes it to a
  // --test-list line. The assembled `buildTestKey` carries `[project]`
  // brackets at its head, which would always fail isTestListSafe by
  // construction — that's why we audit segments + project separately, not
  // the assembled key.
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
