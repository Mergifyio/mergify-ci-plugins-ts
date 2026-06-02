import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from '@mergifyio/playwright';

// Same deterministic flake as `tests-unhealthy/sample.spec.ts`, wrapped in a
// `test.describe` block. The buildTestKey output is
// `sample.spec.ts > Outer > flaky-test` — exercises the describe-segment
// branch of `extractNamespace` and the file-suite stripping in
// `stripFileSuite` across the `--test-list` round-trip.
test.describe('Outer', () => {
  test('passes', () => {
    expect(1).toBe(1);
  });

  test('flaky-test', ({}, testInfo) => {
    const base = process.env.FLAKY_COUNTER_PATH;
    if (!base) throw new Error('FLAKY_COUNTER_PATH not set');
    const path = `${base}-${testInfo.project.name || 'default'}`;
    const count = existsSync(path) ? Number(readFileSync(path, 'utf8')) : 0;
    writeFileSync(path, String(count + 1));
    if (count === 0) {
      expect.fail('first call always fails');
    }
  });
});
