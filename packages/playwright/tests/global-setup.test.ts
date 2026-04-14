import { existsSync, unlinkSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MERGIFY_STATE_PATH, mergifyGlobalSetup } from '../src/global-setup.js';
import { readState } from '../src/state.js';

describe('mergifyGlobalSetup', () => {
  beforeEach(() => {
    vi.stubEnv('MERGIFY_TOKEN', '');
    vi.stubEnv('GITHUB_REPOSITORY', '');
    vi.stubEnv('MERGIFY_API_URL', '');
    vi.stubEnv('_MERGIFY_TEST_NEW_FLAKY_DETECTION', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (existsSync(MERGIFY_STATE_PATH)) {
      unlinkSync(MERGIFY_STATE_PATH);
    }
  });

  it('writes state with empty quarantine list when no token', async () => {
    await mergifyGlobalSetup();

    const state = readState(MERGIFY_STATE_PATH);
    expect(state).toBeDefined();
    expect(state!.quarantineList).toEqual([]);
    expect(state!.retryCounts).toEqual({});
    expect(state!.maxRetries).toBe(0);
  });

  it('writes state with quarantine list from API', async () => {
    vi.stubEnv('MERGIFY_TOKEN', 'test-token');
    vi.stubEnv('GITHUB_REPOSITORY', 'owner/repo');
    vi.stubEnv('GITHUB_REF_NAME', 'main');

    const mockResponse = {
      quarantined_tests: [{ test_name: 'suite > test1' }, { test_name: 'suite > test2' }],
    };

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockResponse),
      })
    );

    await mergifyGlobalSetup();

    const state = readState(MERGIFY_STATE_PATH);
    expect(state).toBeDefined();
    expect(state!.quarantineList).toEqual(['suite > test1', 'suite > test2']);

    vi.unstubAllGlobals();
  });

  it('writes existing test names in new flaky detection mode', async () => {
    vi.stubEnv('MERGIFY_TOKEN', 'test-token');
    vi.stubEnv('GITHUB_REPOSITORY', 'owner/repo');
    vi.stubEnv('_MERGIFY_TEST_NEW_FLAKY_DETECTION', 'new');

    const quarantineResponse = { quarantined_tests: [] };
    const flakyResponse = {
      budget_ratio_for_new_tests: 0.2,
      budget_ratio_for_unhealthy_tests: 0.1,
      existing_test_names: ['suite > existing test'],
      existing_tests_mean_duration_ms: 100,
      unhealthy_test_names: [],
      max_test_execution_count: 10,
      max_test_name_length: 255,
      min_budget_duration_ms: 1000,
      min_test_execution_count: 3,
    };

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (url.includes('flaky-detection-context')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve(flakyResponse),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(quarantineResponse),
        });
      })
    );

    await mergifyGlobalSetup();

    const state = readState(MERGIFY_STATE_PATH);
    expect(state).toBeDefined();
    expect(state!.flakyMode).toBe('new');
    expect(state!.existingTestNames).toEqual(['suite > existing test']);
    expect(state!.maxRetries).toBe(9);
    expect(state!.retryCounts).toEqual({});

    vi.unstubAllGlobals();
  });

  it('writes retry counts in unhealthy flaky detection mode', async () => {
    vi.stubEnv('MERGIFY_TOKEN', 'test-token');
    vi.stubEnv('GITHUB_REPOSITORY', 'owner/repo');
    vi.stubEnv('_MERGIFY_TEST_NEW_FLAKY_DETECTION', 'unhealthy');

    const quarantineResponse = { quarantined_tests: [] };
    const flakyResponse = {
      budget_ratio_for_new_tests: 0.2,
      budget_ratio_for_unhealthy_tests: 0.1,
      existing_test_names: ['suite > test A'],
      existing_tests_mean_duration_ms: 100,
      unhealthy_test_names: ['suite > test A'],
      max_test_execution_count: 10,
      max_test_name_length: 255,
      min_budget_duration_ms: 1000,
      min_test_execution_count: 3,
    };

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (url.includes('flaky-detection-context')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve(flakyResponse),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(quarantineResponse),
        });
      })
    );

    await mergifyGlobalSetup();

    const state = readState(MERGIFY_STATE_PATH);
    expect(state).toBeDefined();
    expect(state!.flakyMode).toBe('unhealthy');
    expect(state!.existingTestNames).toBeUndefined();
    expect(state!.maxRetries).toBe(9);
    expect(state!.retryCounts).toHaveProperty('suite > test A');

    vi.unstubAllGlobals();
  });
});
