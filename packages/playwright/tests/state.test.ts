import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readState, writeState } from '../src/state.js';
import type { MergifyState } from '../src/state.js';

const TEST_STATE_PATH = join(tmpdir(), 'mergify-playwright-state-test.json');

afterEach(() => {
  if (existsSync(TEST_STATE_PATH)) {
    unlinkSync(TEST_STATE_PATH);
  }
});

describe('state', () => {
  it('round-trips state through write and read', () => {
    const state: MergifyState = {
      quarantineList: ['suite > test1', 'suite > test2'],
      retryCounts: { 'suite > test1': 3 },
      maxRetries: 5,
    };

    writeState(TEST_STATE_PATH, state);
    const result = readState(TEST_STATE_PATH);

    expect(result).toEqual(state);
  });

  it('returns null for missing file', () => {
    const result = readState('/tmp/nonexistent-mergify-state-12345.json');
    expect(result).toBeNull();
  });
});
