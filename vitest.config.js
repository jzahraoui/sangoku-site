import { defineConfig } from 'vitest/config';

// Dedicated Vitest config so tests live at the repo root (./test/**),
// independent of vite.config.js which scopes its `root` to ./src for the app build.
export default defineConfig({
  test: {
    root: '.',
    include: ['test/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
    environment: 'node',
  },
});
