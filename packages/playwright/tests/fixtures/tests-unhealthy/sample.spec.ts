import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from '@mergifyio/playwright';

test('passes', () => {
  expect(1).toBe(1);
});

test('flaky-test', ({}, testInfo) => {
  // Counter persisted via FLAKY_COUNTER_PATH env var. First call fails,
  // every subsequent call passes. The integration runner sets a fresh
  // path per `spawnSync` invocation.
  //
  // The project name is appended to the path so multi-project configs (two
  // projects sharing the same spec) each get their own counter — otherwise
  // project A would consume the lone failure and project B would see only
  // passes, masking the per-project flakiness we want to assert.
  const base = process.env.FLAKY_COUNTER_PATH;
  if (!base) throw new Error('FLAKY_COUNTER_PATH not set');
  const path = testInfo.project.name ? `${base}-${testInfo.project.name}` : base;
  const count = existsSync(path) ? Number(readFileSync(path, 'utf8')) : 0;
  writeFileSync(path, String(count + 1));
  if (count === 0) {
    expect.fail('first call always fails');
  }
});
