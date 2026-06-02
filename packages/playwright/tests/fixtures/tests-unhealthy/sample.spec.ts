import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from '@mergifyio/playwright';

test('passes', () => {
  expect(1).toBe(1);
});

test('flaky-test', ({}, testInfo) => {
  // Counter persisted via FLAKY_COUNTER_PATH env var. First call (per project)
  // fails, every subsequent call passes. The path is suffixed by project name
  // so multi-project suites get one fresh counter per project — the
  // integration runner sets a single base path per `spawnSync` invocation.
  const base = process.env.FLAKY_COUNTER_PATH;
  if (!base) throw new Error('FLAKY_COUNTER_PATH not set');
  const path = `${base}-${testInfo.project.name || 'default'}`;
  const count = existsSync(path) ? Number(readFileSync(path, 'utf8')) : 0;
  writeFileSync(path, String(count + 1));
  if (count === 0) {
    expect.fail('first call always fails');
  }
});
