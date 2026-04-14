import { test as base, expect } from '@playwright/test';
import { MERGIFY_STATE_PATH } from './global-setup.js';
import type { MergifyState } from './state.js';
import { readState } from './state.js';

// Each Playwright worker gets its own module instance, so this cache is per-worker.
let cachedState: MergifyState | null | undefined;

function getState(): MergifyState | null {
  if (cachedState === undefined) {
    cachedState = readState(MERGIFY_STATE_PATH);
  }
  return cachedState;
}

function getTestTitle(testInfo: { titlePath: string[] }): string {
  return testInfo.titlePath.slice(1).join(' > ');
}

export function getMergifyRetries(): number {
  const state = getState();
  return state?.maxRetries ?? 0;
}

export const test = base.extend<{
  _mergifyQuarantine: void;
  _mergifyFlakyDetection: void;
}>({
  _mergifyQuarantine: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use, testInfo) => {
      const state = getState();
      if (state) {
        const title = getTestTitle(testInfo);
        if (state.quarantineList.includes(title)) {
          testInfo.annotations.push({
            type: 'mergify-quarantine',
            description: 'This test is quarantined by Mergify',
          });
        }
      }
      await use();
    },
    { auto: true },
  ],

  _mergifyFlakyDetection: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use, testInfo) => {
      if (testInfo.retry > 0) {
        const state = getState();
        if (state && state.flakyMode) {
          const title = getTestTitle(testInfo);
          const perTestMax = state.retryCounts[title];

          if (perTestMax !== undefined) {
            // Unhealthy mode: per-test budget computed in global setup
            if (testInfo.retry > perTestMax) {
              test.skip();
            }
          } else if (state.flakyMode === 'new') {
            // New mode: candidate if not in existing test names
            const isNewTest = !state.existingTestNames?.includes(title);
            if (!isNewTest || testInfo.retry > state.maxRetries) {
              test.skip();
            }
          } else {
            // Not a candidate — skip retries
            test.skip();
          }
        }
      }
      await use();
    },
    { auto: true },
  ],
});

export { expect };
