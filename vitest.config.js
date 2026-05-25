import { defineConfig } from 'vitest/config';

// Dedicated Vitest config for the fast unit suite. Other test runners live in
// sibling test directories and are invoked through package scripts.
export default defineConfig({
  test: {
    root: '.',
    include: ['test/unit/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
    environment: 'node',
  },
});
