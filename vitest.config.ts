import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    maxWorkers: 4,
    include: [
      'src/**/*.test.{ts,tsx}',
      'tests/web/**/*.test.ts',
      'tests/tools/**/*.test.ts',
      'tests/packages/**/*.test.ts',
    ],
    exclude: ['tests/e2e/**', 'node_modules/**', 'packages/go/upstream/**'],
  },
});
