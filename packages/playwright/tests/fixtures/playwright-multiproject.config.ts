import { withMergify } from '@mergifyio/playwright';
import { defineConfig } from '@playwright/test';

const dir = process.env.PW_FIXTURE_DIR ?? './tests';

// Two projects sharing the same spec — used by the multi-project integration
// test to exercise the `[project] › <key>` test-list scoping and per-project
// rerun-count tracking introduced by MRGFY-7470.
export default withMergify(
  defineConfig({
    testDir: dir,
    outputDir: './test-results',
    reporter: 'list',
    use: {},
    projects: [{ name: 'node-a' }, { name: 'node-b' }],
  })
);
