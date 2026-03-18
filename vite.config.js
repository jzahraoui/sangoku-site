import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: './src', // Set the root to the src directory
  build: {
    outDir: '../dist', // Output directory relative to root
    emptyOutDir: true, // Clean output dir before build
    rollupOptions: {
      input: resolve(__dirname, 'src/index.html'), // Entry HTML file
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/three')) {
            return 'vendor-three';
          }
          if (
            id.includes('node_modules/mathjs') ||
            id.includes('node_modules/decimal.js')
          ) {
            return 'vendor-math';
          }
          if (id.includes('node_modules/knockout') || id.includes('node_modules/jszip')) {
            return 'vendor-misc';
          }
          return undefined;
        },
      },
    },
  },
  publicDir: '../public', // Public directory for static assets
  server: {
    port: 5173,
    open: false, // Open browser on dev
  },
});
