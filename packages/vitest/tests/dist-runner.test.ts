import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startVitest } from 'vitest/node';
// Same scenario as runner.test.ts but consuming the BUILT package, the way a
// real consumer does — this is the path #169 crashed on.
// eslint-disable-next-line import/no-unresolved
import { MergifyReporter } from '../dist/index.mjs';

const fixturesDir = resolve(import.meta.dirname, 'fixtures');

describe('Quarantine runner (dist build)', () => {
  beforeEach(() => {
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    vi.stubEnv('GITHUB_REPOSITORY', 'test-owner/test-repo');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('quarantined failing test does not fail the run', async () => {
    const reporter = new MergifyReporter({
      quarantineList: ['failing.test.ts > math > fails intentionally'],
    });
    const vitest = await startVitest('test', [], {
      root: fixturesDir,
      include: ['failing.test.ts'],
      reporters: [reporter],
      watch: false,
    });
    await vitest?.close();
    expect(reporter.getSession()!.status).toBe('passed');
  });
});
