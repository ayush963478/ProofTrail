import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // amazon-cognito-identity-js pulls in a `buffer` polyfill that references the
  // Node global `global`, which browsers don't have — map it to `globalThis`
  // for the pre-bundled deps (dev) and the Rollup build alike.
  define: {
    global: 'globalThis',
  },
  optimizeDeps: {
    esbuildOptions: {
      define: {
        global: 'globalThis',
      },
    },
  },
  server: {
    port: 5173,
    strictPort: false,
  },
  preview: {
    port: 5173,
  },
});
