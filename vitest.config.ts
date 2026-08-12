import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const repoRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // `@shared` is aliased in web/vite.config.ts and in both tsconfigs; vitest uses
  // neither, so a *value* import from @shared would fail to resolve here without this.
  resolve: {
    alias: {
      '@shared': resolve(repoRoot, 'shared'),
    },
  },
  test: {
    environment: 'node',
    include: [
      'server/**/*.test.ts',
      'shared/**/*.test.ts',
      'web/**/*.test.ts',
      'web/**/*.test.tsx',
    ],
  },
});
