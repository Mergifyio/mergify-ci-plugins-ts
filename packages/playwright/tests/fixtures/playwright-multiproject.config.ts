import { withMergify } from '@mergifyio/playwright';
import { defineConfig } from '@playwright/test';

const dir = process.env.PW_FIXTURE_DIR ?? './tests';

// Two named projects sharing the same spec. The integration suite uses this
// to verify that `(test, project)` is the unit of identification: each
// project's `flaky-test` is its own candidate, runs through its own phase-2
// reruns (scoped via `[project] > file > … > title` lines — the same
// Playwright `--test-list` wire format buildTestKey already produces), and
// produces its own verdict row in the summary.
export default withMergify(
  defineConfig({
    testDir: dir,
    outputDir: './test-results',
    reporter: 'list',
    use: {},
    projects: [{ name: 'node-a' }, { name: 'node-b' }],
  })
);
