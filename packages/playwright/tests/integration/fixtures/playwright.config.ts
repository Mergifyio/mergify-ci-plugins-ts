import { resolve } from 'node:path';
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  reporter: [['list'], [resolve(import.meta.dirname, '../../../src/reporter.ts')]],
});
