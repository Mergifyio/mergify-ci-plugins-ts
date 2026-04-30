import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FlakyDetectionContext } from '@mergifyio/ci-core';

export interface SharedState {
  version: 1;
  testRunId: string;
  createdAt: string;
  rootDir: string;
  quarantinedTests: string[];

  flakyContext?: FlakyDetectionContext;
  flakyMode?: 'new' | 'unhealthy';
  flakyCandidates?: string[];
  flakyPerTestDeadlineMs?: number;
}

/** @deprecated Use SharedState instead. Kept as an alias for compatibility. */
export type QuarantineState = SharedState;

const CURRENT_VERSION = 1;

export function stateFilePath(cacheRoot: string, testRunId: string): string {
  return join(cacheRoot, '@mergifyio', 'playwright', `state-${testRunId}.json`);
}

export function writeStateFile(path: string, state: SharedState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

export function readStateFile(path: string): SharedState | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT') {
      return null;
    }
    process.stderr.write(`[@mergifyio/playwright] failed to read state file ${path}: ${err}\n`);
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`[@mergifyio/playwright] state file ${path} is not valid JSON: ${err}\n`);
    return null;
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as { version?: unknown }).version !== CURRENT_VERSION
  ) {
    process.stderr.write(
      `[@mergifyio/playwright] state file ${path} has unknown version; treating as absent\n`
    );
    return null;
  }

  if (!isWellFormedState(parsed)) {
    process.stderr.write(
      `[@mergifyio/playwright] state file ${path} has malformed shape; treating as absent\n`
    );
    return null;
  }

  return parsed;
}

/**
 * Validate the load-bearing fields after the version gate. Guards against a
 * partially-written or hand-edited file that still has `version: 1` but is
 * missing / malformed elsewhere — downstream code would otherwise crash on
 * `state.quarantinedTests.length` or `new Set(state.quarantinedTests)`.
 * `testRunId` and `createdAt` are informational and deliberately not
 * validated.
 */
function isWellFormedState(value: object): value is SharedState {
  const v = value as Record<string, unknown>;
  if (
    typeof v.rootDir !== 'string' ||
    !Array.isArray(v.quarantinedTests) ||
    !v.quarantinedTests.every((t): t is string => typeof t === 'string')
  ) {
    return false;
  }

  // Optional flaky-detection fields. Strip any that fail validation; do
  // not reject the whole state. This lets quarantine + tracing keep
  // working even if the flaky block is malformed.
  if (v.flakyContext !== undefined && !isWellFormedFlakyContext(v.flakyContext)) {
    delete v.flakyContext;
  }
  if (v.flakyMode !== undefined && v.flakyMode !== 'new' && v.flakyMode !== 'unhealthy') {
    delete v.flakyMode;
  }
  if (
    v.flakyCandidates !== undefined &&
    !(
      Array.isArray(v.flakyCandidates) &&
      v.flakyCandidates.every((n: unknown) => typeof n === 'string')
    )
  ) {
    delete v.flakyCandidates;
  }
  if (v.flakyPerTestDeadlineMs !== undefined && typeof v.flakyPerTestDeadlineMs !== 'number') {
    delete v.flakyPerTestDeadlineMs;
  }
  return true;
}

function isWellFormedFlakyContext(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.budget_ratio_for_new_tests === 'number' &&
    typeof v.budget_ratio_for_unhealthy_tests === 'number' &&
    Array.isArray(v.existing_test_names) &&
    v.existing_test_names.every((n: unknown) => typeof n === 'string') &&
    typeof v.existing_tests_mean_duration_ms === 'number' &&
    Array.isArray(v.unhealthy_test_names) &&
    v.unhealthy_test_names.every((n: unknown) => typeof n === 'string') &&
    typeof v.max_test_execution_count === 'number' &&
    typeof v.max_test_name_length === 'number' &&
    typeof v.min_budget_duration_ms === 'number' &&
    typeof v.min_test_execution_count === 'number'
  );
}
