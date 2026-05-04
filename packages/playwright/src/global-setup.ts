import { join } from 'node:path';
import {
  detectResources,
  envToBool,
  type FlakyDetectionContext,
  fetchFlakyDetectionContext,
  fetchQuarantineList,
  generateTestRunId,
  getRepoName,
  isInCI,
} from '@mergifyio/ci-core';
import type { FullConfig } from '@playwright/test';
import { type SharedState, stateFilePath, writeStateFile } from './state-file.js';

const DEFAULT_API_URL = 'https://api.mergify.com';

export interface RunGlobalSetupDeps {
  cacheRoot: string;
  now: () => Date;
}

export async function runGlobalSetup(config: FullConfig, deps: RunGlobalSetupDeps): Promise<void> {
  const enabled = isInCI() || envToBool(process.env.PLAYWRIGHT_MERGIFY_ENABLE, false);
  if (!enabled) return;

  const token = process.env.MERGIFY_TOKEN;
  const apiUrl = process.env.MERGIFY_API_URL ?? DEFAULT_API_URL;
  const repoName = getRepoName();

  const testRunId = generateTestRunId();
  process.env.MERGIFY_TEST_RUN_ID = testRunId;

  // Resolve the branch name the same way the reporter would — by building the
  // OTel resource attributes once and looking up `vcs.ref.base.name` (PR base,
  // preferred) then `vcs.ref.head.name` (push branch / PR head). Mode for
  // flaky detection is derived from the same attribute split: a present base
  // ref means PR-like context → "new" mode.
  const attrs = detectResources({}, testRunId).attributes;
  const baseRef = attrs['vcs.ref.base.name'] as string | undefined;
  const headRef = attrs['vcs.ref.head.name'] as string | undefined;
  const branch = baseRef ?? headRef;

  if (!token || !repoName || !branch) {
    return;
  }

  const log = (msg: string) => process.stderr.write(`[@mergifyio/playwright] ${msg}\n`);
  // `fetchQuarantineList` is soft — on any error it logs via `log` and returns
  // an empty set. We just persist whatever it returns; a fetch failure and a
  // genuinely-empty list are indistinguishable downstream, and the logger has
  // already surfaced the failure to the user.
  const list = await fetchQuarantineList({ apiUrl, token, repoName, branch }, log);

  // Flaky detection — gated by the feature-flag env var. Same soft-fail
  // shape as quarantine: any null return means feature dormant, not error.
  let flakyContext: FlakyDetectionContext | undefined;
  let flakyMode: 'new' | 'unhealthy' | undefined;
  if (envToBool(process.env._MERGIFY_TEST_NEW_FLAKY_DETECTION, false)) {
    const ctx = await fetchFlakyDetectionContext({ apiUrl, token, repoName }, log);
    if (ctx) {
      flakyContext = ctx;
      flakyMode = baseRef ? 'new' : 'unhealthy';
    }
  }

  const state: SharedState = {
    version: 1,
    testRunId,
    createdAt: deps.now().toISOString(),
    rootDir: config.rootDir,
    quarantinedTests: [...list],
    ...(flakyContext && { flakyContext }),
    ...(flakyMode && { flakyMode }),
  };

  const path = stateFilePath(deps.cacheRoot, testRunId);
  try {
    writeStateFile(path, state);
    process.env.MERGIFY_STATE_FILE = path;
  } catch (err) {
    process.stderr.write(`[@mergifyio/playwright] failed to write state file: ${String(err)}\n`);
  }
}

export default async function playwrightGlobalSetup(config: FullConfig): Promise<void> {
  const cacheRoot = join(config.rootDir, 'node_modules', '.cache');
  await runGlobalSetup(config, {
    cacheRoot,
    now: () => new Date(),
  });
}
