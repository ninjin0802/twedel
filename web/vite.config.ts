import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const webDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(webDir, '..');

export default defineConfig({
  root: webDir,
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve(repoRoot, 'shared'),
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:5174',
        changeOrigin: false,
      },
    },
  },
});
