import { execSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MergifyState } from '../../src/state.js';

const fixturesDir = resolve(import.meta.dirname, 'fixtures');
const configPath = resolve(fixturesDir, 'playwright.config.ts');
const playwrightBin = resolve(import.meta.dirname, '../../node_modules/.bin/playwright');

// Write state to a fixed path relative to the project to avoid tmpdir differences
const statePath = resolve(import.meta.dirname, '../../.mergify-test-state.json');

function writeTestState(state: MergifyState): void {
  writeFileSync(statePath, JSON.stringify(state), 'utf-8');
}

function cleanState(): void {
  if (existsSync(statePath)) rmSync(statePath);
}

function runPlaywright(testFile: string): { exitCode: number; output: string } {
  try {
    const output = execSync(`${playwrightBin} test --config ${configPath} ${testFile}`, {
      cwd: fixturesDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CI: '', MERGIFY_STATE_PATH: statePath },
    });
    return { exitCode: 0, output };
  } catch (err: any) {
    return {
      exitCode: err.status ?? 1,
      output: (err.stdout ?? '') + (err.stderr ?? ''),
    };
  }
}

describe('Quarantine integration', () => {
  beforeEach(() => {
    cleanState();
  });

  afterEach(() => {
    cleanState();
  });

  it('quarantined failing test does not fail the run', () => {
    writeTestState({
      quarantineList: ['math > fails intentionally'],
      retryCounts: {},
      maxRetries: 0,
    });

    const { exitCode } = runPlaywright('failing.spec.ts');
    expect(exitCode).toBe(0);
  });

  it('non-quarantined failing test still fails the run', () => {
    writeTestState({
      quarantineList: ['some > other test'],
      retryCounts: {},
      maxRetries: 0,
    });

    const { exitCode } = runPlaywright('failing.spec.ts');
    expect(exitCode).not.toBe(0);
  });

  it('passing test passes without quarantine', () => {
    writeTestState({
      quarantineList: [],
      retryCounts: {},
      maxRetries: 0,
    });

    const { exitCode } = runPlaywright('passing.spec.ts');
    expect(exitCode).toBe(0);
  });
});
