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
 * `TestCase.titlePath()` is `['', projectName, filePath, ...describes, testTitle]`
 * (Playwright places an empty root-suite name at index 0). We take the
 * describe segments and prepend the caller-normalized filepath so the
 * resulting span name is filepath-qualified, matching the vitest convention
 * (avoiding collisions when two files share a describe+test name).
 */
export function extractNamespace(filepath: string, titlePath: readonly string[]): string {
  const describes = stripFileSuite(titlePath.slice(2, -1), filepath);
  const parts = [filepath, ...describes].filter((p) => p.length > 0);
  return parts.join(' > ');
}

/**
 * At runtime, Playwright exposes the test's file as a suite in `titlePath`
 * (e.g. `[project, file, 'sample.spec.ts', ...describes, title]`), so
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
 * Build the matching key for a Playwright test: the same string the Mergify
 * backend stores as `test_name` (derived from the emitted span name). Used
 * both for quarantine list matching and for flaky-detection candidate
 * matching.
 *
 * Takes `TestCase.titlePath()` which has shape
 *   `['', projectName, file, ...describes, title]`
 * — Playwright places the project at index 1 with an empty string at index 0
 * (the root suite). For the `TestInfo.titlePath` shape used inside fixtures
 * (which omits the project entirely), use `buildTestKeyFromInfo`.
 *
 * Must match the span name produced by `emitTestCaseSpan` in @mergifyio/ci-core:
 *   namespace > function  (when namespace is non-empty)
 *   function              (when namespace is empty)
 * where `namespace` is `extractNamespace(filepath, titlePath)`. The filter step
 * below drops the empty prefix in the second case so the equality holds in both.
 */
export function buildTestKey(
  filepath: string,
  titlePath: readonly string[],
  title: string
): string {
  return buildTestKeyParts(filepath, titlePath, title).join(' > ');
}

/**
 * Same logic as `buildTestKey`, but returns the segments as an array instead
 * of joining them. Used to build `--test-list` lines where the separator
 * must be applied at segment boundaries only — joining-then-replacing the
 * string would silently corrupt a describe-block name that happens to
 * contain the separator literal.
 */
export function buildTestKeyParts(
  filepath: string,
  titlePath: readonly string[],
  title: string
): readonly string[] {
  return assembleKeyParts(filepath, titlePath.slice(2, -1), title);
}

/**
 * Variant of `buildTestKey` for `TestInfo.titlePath` — which, unlike
 * `TestCase.titlePath()`, has shape `[file, ...describes, title]` (no project
 * name, no leading empty). Used by the quarantine fixture, which only has
 * access to a `TestInfo`.
 */
export function buildTestKeyFromInfo(
  filepath: string,
  infoTitlePath: readonly string[],
  title: string
): string {
  return assembleKeyParts(filepath, infoTitlePath.slice(0, -1), title).join(' > ');
}

/**
 * Shared inner of the three public key builders: stripFileSuite the candidate
 * describes (Playwright re-exposes the spec file as a runtime suite),
 * prepend the filepath, append the title, and drop empties.
 */
function assembleKeyParts(
  filepath: string,
  rawDescribes: readonly string[],
  title: string
): readonly string[] {
  const describes = stripFileSuite(rawDescribes, filepath);
  return [filepath, ...describes, title].filter((p) => p.length > 0);
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
 * Return the project name a TestCase belongs to. Walks up the suite chain
 * asking each `parent.project()` (Playwright attaches the project to the
 * project-level suite, not always the immediate parent). Returns undefined
 * when no project is set (an unnamed default project, or a config without
 * any `projects` array).
 */
export function projectNameFromTest(test: TestCase): string | undefined {
  let suite: { parent?: unknown; project?: () => { name: string } | undefined } | undefined =
    test.parent;
  while (suite) {
    const project = suite.project?.();
    if (project?.name && project.name.length > 0) return project.name;
    suite = suite.parent as typeof suite;
  }
  return undefined;
}
