import { expect, test } from '../../../src/fixtures.js';

test.describe('math', () => {
  test('fails intentionally', () => {
    expect(1 + 1).toBe(3);
  });
});
