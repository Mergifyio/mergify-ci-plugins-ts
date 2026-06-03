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
 * Build the namespace for a Playwright test as `<filepath> > <describes>`.
 * `titlePath()` is `['', projectName, filePath, ...describes, testTitle]`
 * (Playwright places an empty root-suite name at index 0); we take the
 * describe segments and prepend the caller-normalized filepath so the
 * resulting span name is filepath-qualified, matching the vitest convention
 * (avoiding collisions when two files share a describe+test name).
 *
 * The project name is intentionally NOT part of the namespace — it is appended
 * to the test title via `buildTestKey` / `buildTestFunction` instead, so the
 * span name reads `<file> > <describes> > <title> [project]`.
 */
export function extractNamespace(filepath: string, titlePath: readonly string[]): string {
  const describes = stripFileSuite(titlePath.slice(2, -1), filepath);
  const parts = [filepath, ...describes].filter((p) => p.length > 0);
  return parts.join(' > ');
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
 * Decorate a test title with its project name. Used for both `buildTestKey`
 * (matching against backend quarantine / flaky-detection lists) and for the
 * emitted span's `function` field, so the span name ends with `[project]` too.
 * Returns the bare title when project is empty/undefined — single-project
 * suites keep the old key shape and stay backward-compatible.
 */
export function buildTestFunction(title: string, project: string | undefined): string {
  return project && project.length > 0 ? `${title} [${project}]` : title;
}

/**
 * Build the matching key for a Playwright test: the same string the Mergify
 * backend stores as `test_name` (derived from the emitted span name). Used
 * both for quarantine list matching and for flaky-detection candidate
 * matching.
 *
 * Includes the project as a ` [project]` suffix so that the same test running
 * in two projects (e.g. `chromium` + `firefox`) is identified as two distinct
 * tests — the backend stores per-project entries, quarantine / unhealthy
 * lists from the API arrive per-project, and a Firefox-only flake never
 * absorbs a Chrome regression.
 *
 * Must match the span name produced by `emitTestCaseSpan` in @mergifyio/ci-core:
 *   namespace > function  (when namespace is non-empty)
 *   function              (when namespace is empty)
 * where `namespace` is `extractNamespace(filepath, titlePath)` and the function
 * is decorated with `[project]` via `buildTestFunction`. The filter step below
 * drops the empty prefix in the namespace-empty case so the equality holds in
 * both.
 */
export function buildTestKey(
  filepath: string,
  titlePath: readonly string[],
  title: string
): string {
  const project = titlePath[1] ?? '';
  const describes = stripFileSuite(titlePath.slice(2, -1), filepath);
  const decoratedTitle = buildTestFunction(title, project);
  const parts = [filepath, ...describes, decoratedTitle].filter((p) => p.length > 0);
  return parts.join(' > ');
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
 * computes the project from `testInfo.project.name`.
 */
export function buildTestKeyFromInfo(
  filepath: string,
  infoTitlePath: readonly string[],
  project: string | undefined,
  title: string
): string {
  const describes = stripFileSuite(infoTitlePath.slice(1, -1), filepath);
  const decoratedTitle = buildTestFunction(title, project);
  const parts = [filepath, ...describes, decoratedTitle].filter((p) => p.length > 0);
  return parts.join(' > ');
}

/**
 * Convert a key produced by `buildTestKey` into a single `--test-list` line
 * that Playwright's loader can parse.
 *
 * Playwright's loader reads project scoping from a leading `[project]` token
 * (see `loadTestList` in `playwright/lib/runner/index.js`), and matches the
 * remaining `file > describes > title` against `test.titlePath()`. Because we
 * append `[project]` to the END of the key (so it appears in span names and
 * the backend's test_name), we have to strip that trailing suffix before
 * writing the test-list line — otherwise Playwright would try to match a
 * test whose title literally ends with `[project]` and find nothing.
 *
 * The whole line uses ` > ` as the separator. Playwright accepts `>` and `›`
 * interchangeably but picks ONE per line (whichever is found) and splits the
 * entire line on it; mixing `›` between the project bracket and `>` inside
 * the bareKey makes the loader split on `›` and treat the bareKey body as a
 * single un-split token, so the test never matches.
 *
 * The suffix strip is exact (`endsWith(' [project]')`), not a regex parse, so
 * a title that legitimately ends in `[something]` is unaffected as long as
 * `something` is not the current project name.
 */
export function formatTestListLine(key: string, project: string | undefined): string {
  if (!project || project.length === 0) return key;
  const suffix = ` [${project}]`;
  const bareKey = key.endsWith(suffix) ? key.slice(0, -suffix.length) : key;
  return `[${project}] > ${bareKey}`;
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
