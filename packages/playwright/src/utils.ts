import type { TestCase } from '@playwright/test/reporter';

/**
 * Normalize a path to POSIX separators. Quarantine keys and span names must be
 * stable across platforms — the backend stores them as strings and compares
 * byte-for-byte — so every filepath flowing into `extractNamespace`,
 * `stripFileSuite`, or `buildTestKey` MUST pass through this first.
 *
 * No-op on POSIX (input already has no backslashes); maps `\` → `/` on Windows.
 */
export function toPosix(p: string): string {
  return p.replaceAll('\\', '/');
}

/**
 * Build the namespace for a Playwright test — the qualifier portion of the
 * emitted span name, NOT counting the test's own title.
 *
 * `titlePath()` is `['', projectName, filePath, ...describes, testTitle]`
 * (Playwright places an empty root-suite name at index 0). We assemble
 * `[project] > <filepath> > <describes>` so the eventual span name (
 * `${namespace} > ${function}`, computed by `emitTestCaseSpan` in
 * `@mergifyio/ci-core`) reads
 *
 *   [project] > file > describes > title
 *
 * — Playwright's own display and `--test-list` wire format. The `[project] >`
 * prefix is omitted when the project is empty/unnamed so single-project
 * repos keep the file-first shape.
 */
export function extractNamespace(filepath: string, titlePath: readonly string[]): string {
  const project = titlePath[1] ?? '';
  const describes = stripFileSuite(titlePath.slice(2, -1), filepath);
  const segments =
    project.length > 0 ? [`[${project}]`, filepath, ...describes] : [filepath, ...describes];
  return segments.filter((p) => p.length > 0).join(' > ');
}

/**
 * At runtime, Playwright exposes the test's file as a suite in `titlePath`
 * (e.g. `['', project, file, 'sample.spec.ts', ...describes, title]`), so
 * `titlePath.slice(2, -1)` picks up the filepath again and we'd end up
 * emitting `tests/sample.spec.ts > sample.spec.ts > ...`. Drop any describe
 * entry whose value equals the filepath or its basename.
 *
 * `filepath` must already be POSIX-normalized by the caller (see `toPosix`).
 * The basename split below is deliberately POSIX-only.
 */
export function stripFileSuite(describes: readonly string[], filepath: string): readonly string[] {
  if (filepath.length === 0) return describes;
  const basename = filepath.split('/').pop() ?? '';
  return describes.filter((d) => d !== filepath && d !== basename);
}

/**
 * Shared inner of `buildTestKey` and `buildTestKeyFromInfo`. Strips the file
 * suite from the raw describes, prepends `[project] >` when project is
 * non-empty, and joins with ` > ` (dropping empty segments so the
 * namespace-empty case still produces a clean key).
 */
function assembleKey(
  filepath: string,
  rawDescribes: readonly string[],
  project: string,
  title: string
): string {
  const describes = stripFileSuite(rawDescribes, filepath);
  const segments =
    project.length > 0
      ? [`[${project}]`, filepath, ...describes, title]
      : [filepath, ...describes, title];
  return segments.filter((p) => p.length > 0).join(' > ');
}

/**
 * Build the matching key for a Playwright test: the same string the Mergify
 * backend stores as `test_name` (derived from the emitted span name). Used
 * both for quarantine list matching and for flaky-detection candidate
 * matching.
 *
 * Includes the project as a `[project] >` prefix so that the same test
 * running in two projects (e.g. `chromium` + `firefox`) is identified as
 * two distinct tests — the backend stores per-project entries, quarantine
 * / unhealthy lists from the API arrive per-project, and a Firefox-only
 * flake never absorbs a Chrome regression. The shape matches Playwright's
 * own reporter and `--test-list` format byte-for-byte, so the key can flow
 * straight into the phase-2 rerun subprocess with no reformatting.
 *
 * Must match the span name produced by `emitTestCaseSpan` in
 * @mergifyio/ci-core:
 *   namespace > function  (when namespace is non-empty)
 *   function              (when namespace is empty)
 * where `namespace` is `extractNamespace(filepath, titlePath)` and contains
 * the `[project] >` prefix when applicable, so the assembled span name
 * comes out as `[project] > file > describes > title`.
 */
export function buildTestKey(
  filepath: string,
  titlePath: readonly string[],
  title: string
): string {
  return assembleKey(filepath, titlePath.slice(2, -1), titlePath[1] ?? '', title);
}

/**
 * Variant of `buildTestKey` for `TestInfo.titlePath` rather than
 * `TestCase.titlePath()`. The worker-side `TestInfo.titlePath` has shape
 *   `[file, ...describes, title]`
 * (no root-suite slot, no project slot — those live on `testInfo.project`
 * instead and must be passed explicitly), whereas `TestCase.titlePath()` on
 * the runner side is `['', project, file, ...describes, title]`. They are
 * NOT interchangeable, even though both feed into the same key string.
 *
 * Used by the quarantine fixture, which only has access to a `TestInfo` and
 * reads the project from `testInfo.project.name`.
 */
export function buildTestKeyFromInfo(
  filepath: string,
  infoTitlePath: readonly string[],
  project: string,
  title: string
): string {
  return assembleKey(filepath, infoTitlePath.slice(1, -1), project, title);
}

/**
 * Return the individual segments (filepath, ...describes, title) that
 * `buildTestKey` assembles into the key body, AFTER the file-suite dedup
 * but BEFORE the project prefix is prepended and BEFORE empty filtering.
 * Each segment must independently satisfy `isTestListSafe` for the
 * candidate to survive phase-2 `--test-list` round-tripping. The project
 * itself is checked separately by the caller because it's stored as a
 * sibling field, not part of the title path.
 */
export function buildTestKeyParts(
  filepath: string,
  titlePath: readonly string[],
  title: string
): readonly string[] {
  const describes = stripFileSuite(titlePath.slice(2, -1), filepath);
  return [filepath, ...describes, title];
}

/**
 * Characters that Playwright's `loadTestList` cannot disambiguate in a
 * single segment:
 *  - `>` and `›` are both accepted as the segment separator; either inside
 *    a segment confuses the single-delimiter split.
 *  - `[` / `]` collide with the optional `[project]` prefix parser.
 *  - `\n` splits a single test description into two malformed lines.
 *
 * Any candidate carrying one of these in its project name, file path,
 * describe segments, or title cannot be safely scoped via `--test-list`.
 * The check is per-segment — the assembled key legitimately contains
 * `[project]`-shaped brackets at its head, so the predicate must NOT be
 * applied to the full key string.
 */
const TEST_LIST_UNSAFE = /[[\]>\n]|›/u;

/**
 * Return true when the string can flow through Playwright's `--test-list`
 * loader (`loadTestList` in `playwright/lib/runner/index.js`) as a single
 * segment without mis-parsing. Used to filter phase-2 candidates so a
 * single unrepresentable name (or project name, or file path containing
 * `[`) can't crash the whole subprocess.
 */
export function isTestListSafe(s: string): boolean {
  return !TEST_LIST_UNSAFE.test(s);
}

/**
 * Map a Playwright TestResult.status to our 3-value status.
 */
export function mapStatus(
  status: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted'
): 'passed' | 'failed' | 'skipped' {
  if (status === 'passed') return 'passed';
  if (status === 'skipped') return 'skipped';
  return 'failed';
}

/**
 * Return the project name from a TestCase by reading index 1 of titlePath.
 * Playwright's `titlePath()` is `['', projectName, file, ...describes, title]`
 * — index 0 is the (empty) root-suite name, index 1 is the project. Returns
 * undefined when no project is named (default unnamed project, or a config
 * without any `projects` array).
 */
export function projectNameFromTest(test: TestCase): string | undefined {
  const project = test.titlePath()[1];
  return project && project.length > 0 ? project : undefined;
}
