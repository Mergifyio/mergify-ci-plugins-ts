import { describe, expect, it } from 'vitest';
import { detect } from '../../src/resources/playwright.js';

describe('Playwright resource detector', () => {
  it('returns framework name and version', () => {
    const attrs = detect('1.52.0');
    expect(attrs).toEqual({
      'test.framework': 'playwright',
      'test.framework.version': '1.52.0',
    });
  });
});
