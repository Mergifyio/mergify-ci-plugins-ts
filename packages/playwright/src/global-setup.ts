import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FlakyDetector,
  fetchFlakyDetectionContext,
  fetchQuarantineList,
  getRepoName,
  git,
} from '@mergifyio/ci-core';
import type { MergifyState } from './state.js';
import { writeState } from './state.js';

export const MERGIFY_STATE_PATH =
  process.env.MERGIFY_STATE_PATH ?? join(tmpdir(), 'mergify-playwright-state.json');

const DEFAULT_API_URL = 'https://api.mergify.com';

function getBranch(): string | undefined {
  if (process.env.GITHUB_HEAD_REF) return process.env.GITHUB_HEAD_REF;
  if (process.env.GITHUB_REF_NAME) return process.env.GITHUB_REF_NAME;

  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  return branch ?? undefined;
}

export async function mergifyGlobalSetup(): Promise<void> {
  // eslint-disable-next-line no-console
  const log = (msg: string) => console.log(`[@mergifyio/playwright] ${msg}`);

  const token = process.env.MERGIFY_TOKEN;
  const apiUrl = process.env.MERGIFY_API_URL ?? DEFAULT_API_URL;
  const repoName = getRepoName();
  const branch = getBranch();

  const state: MergifyState = {
    quarantineList: [],
    retryCounts: {},
    maxRetries: 0,
  };

  if (!token || !repoName) {
    log('MERGIFY_TOKEN or repository name not available, writing empty state');
    writeState(MERGIFY_STATE_PATH, state);
    return;
  }

  // Fetch quarantine list
  if (branch) {
    const quarantineSet = await fetchQuarantineList({ apiUrl, token, repoName, branch }, log);
    state.quarantineList = [...quarantineSet];
  }

  // Fetch flaky detection context and pre-compute retry counts
  const flakyModeEnv = process.env._MERGIFY_TEST_NEW_FLAKY_DETECTION;
  if (flakyModeEnv === 'new' || flakyModeEnv === 'unhealthy') {
    const flakyContext = await fetchFlakyDetectionContext({ apiUrl, token, repoName }, log);
    if (flakyContext) {
      // No setTestNames call — test names aren't known in global setup.
      // isCandidate/getMaxRepeats fall back to checking context lists directly.
      const detector = new FlakyDetector(flakyContext, flakyModeEnv);

      state.maxRetries = flakyContext.max_test_execution_count - 1;
      state.flakyMode = flakyModeEnv;

      if (flakyModeEnv === 'new') {
        // In "new" mode, candidates are tests NOT in existing_test_names.
        // Store the list so the fixture can identify them at runtime.
        state.existingTestNames = flakyContext.existing_test_names;
      } else {
        // In "unhealthy" mode, pre-compute retry counts for known candidates
        for (const testName of flakyContext.unhealthy_test_names) {
          if (detector.isCandidate(testName)) {
            const maxRepeats = detector.getMaxRepeats(
              testName,
              flakyContext.existing_tests_mean_duration_ms
            );
            state.retryCounts[testName] = maxRepeats;
          }
        }
      }
    }
  }

  writeState(MERGIFY_STATE_PATH, state);
  log(`State written to ${MERGIFY_STATE_PATH}`);
}

export default mergifyGlobalSetup;
