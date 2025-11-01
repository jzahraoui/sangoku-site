import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  root: './src', // Set the root to the src directory
  build: {
    outDir: '../dist', // Output directory relative to root
    emptyOutDir: true, // Clean output dir before build
    rollupOptions: {
      input: resolve(__dirname, 'src/index.html'), // Entry HTML file
      output: {
        manualChunks: {
          vendor: [
            'mathjs',
            // add other big libs here
          ],
        },
      },
    },
  },
  publicDir: '../public', // Public directory for static assets
  server: {
    open: false, // Open browser on dev
  },
});
