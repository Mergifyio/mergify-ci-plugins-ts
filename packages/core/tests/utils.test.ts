import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isDraftPullRequest, resolveBranchFromAttributes, strtobool } from '../src/utils.js';

describe('strtobool', () => {
  it.each([
    'y',
    'Y',
    'yes',
    'YES',
    'Yes',
    't',
    'T',
    'true',
    'TRUE',
    'True',
    'on',
    'ON',
    '1',
  ])('returns true for "%s"', (value) => {
    expect(strtobool(value)).toBe(true);
  });

  it.each([
    'n',
    'N',
    'no',
    'NO',
    'No',
    'f',
    'F',
    'false',
    'FALSE',
    'False',
    'off',
    'OFF',
    '0',
  ])('returns false for "%s"', (value) => {
    expect(strtobool(value)).toBe(false);
  });

  it.each(['', 'anything', '42', 'yesno'])('throws for unrecognized value "%s"', (value) => {
    expect(() => strtobool(value)).toThrow(`Could not convert '${value}' to boolean`);
  });
});

describe('resolveBranchFromAttributes', () => {
  it('returns vcs.ref.base.name when set', () => {
    expect(
      resolveBranchFromAttributes({
        'vcs.ref.base.name': 'main',
        'vcs.ref.head.name': 'feature',
      })
    ).toBe('main');
  });

  it('falls through to vcs.ref.head.name when base is empty', () => {
    expect(
      resolveBranchFromAttributes({
        'vcs.ref.base.name': '',
        'vcs.ref.head.name': 'feature',
      })
    ).toBe('feature');
  });

  it('falls through to vcs.ref.head.name when base is missing', () => {
    expect(resolveBranchFromAttributes({ 'vcs.ref.head.name': 'feature' })).toBe('feature');
  });

  it('returns undefined when both are missing', () => {
    expect(resolveBranchFromAttributes({})).toBeUndefined();
  });

  it('returns undefined when both are empty strings', () => {
    expect(
      resolveBranchFromAttributes({
        'vcs.ref.base.name': '',
        'vcs.ref.head.name': '',
      })
    ).toBeUndefined();
  });
});

describe('isDraftPullRequest', () => {
  let eventDir: string | undefined;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (eventDir) {
      rmSync(eventDir, { recursive: true, force: true });
      eventDir = undefined;
    }
  });

  function writeEvent(payload: unknown): string {
    eventDir = mkdtempSync(join(tmpdir(), 'mergify-event-'));
    const eventPath = join(eventDir, 'event.json');
    writeFileSync(eventPath, JSON.stringify(payload));
    return eventPath;
  }

  it('returns true for a draft pull request', () => {
    vi.stubEnv('GITHUB_EVENT_NAME', 'pull_request');
    vi.stubEnv('GITHUB_EVENT_PATH', writeEvent({ pull_request: { draft: true } }));
    expect(isDraftPullRequest()).toBe(true);
  });

  it('returns true for a draft pull_request_target event', () => {
    vi.stubEnv('GITHUB_EVENT_NAME', 'pull_request_target');
    vi.stubEnv('GITHUB_EVENT_PATH', writeEvent({ pull_request: { draft: true } }));
    expect(isDraftPullRequest()).toBe(true);
  });

  it('returns false for a non-draft pull request', () => {
    vi.stubEnv('GITHUB_EVENT_NAME', 'pull_request');
    vi.stubEnv('GITHUB_EVENT_PATH', writeEvent({ pull_request: { draft: false } }));
    expect(isDraftPullRequest()).toBe(false);
  });

  it('returns false when the event is not a pull request', () => {
    vi.stubEnv('GITHUB_EVENT_NAME', 'push');
    expect(isDraftPullRequest()).toBe(false);
  });

  it('returns false when GITHUB_EVENT_PATH is unset', () => {
    vi.stubEnv('GITHUB_EVENT_NAME', 'pull_request');
    vi.stubEnv('GITHUB_EVENT_PATH', '');
    expect(isDraftPullRequest()).toBe(false);
  });

  it('returns false when the event file is missing', () => {
    vi.stubEnv('GITHUB_EVENT_NAME', 'pull_request');
    vi.stubEnv('GITHUB_EVENT_PATH', join(tmpdir(), 'mergify-missing-event.json'));
    expect(isDraftPullRequest()).toBe(false);
  });

  it('returns false when the event payload is malformed', () => {
    eventDir = mkdtempSync(join(tmpdir(), 'mergify-event-'));
    const eventPath = join(eventDir, 'event.json');
    writeFileSync(eventPath, '{ not valid json');
    vi.stubEnv('GITHUB_EVENT_NAME', 'pull_request');
    vi.stubEnv('GITHUB_EVENT_PATH', eventPath);
    expect(isDraftPullRequest()).toBe(false);
  });

  it('returns false when the payload has an unexpected shape', () => {
    vi.stubEnv('GITHUB_EVENT_NAME', 'pull_request');
    vi.stubEnv('GITHUB_EVENT_PATH', writeEvent(['not', 'an', 'object']));
    expect(isDraftPullRequest()).toBe(false);
  });
});
