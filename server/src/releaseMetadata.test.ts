import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('release metadata', () => {
  it('keeps the README version badge equal to package.json', async () => {
    const root = resolve(process.cwd());
    const [readme, packageRaw] = await Promise.all([
      readFile(resolve(root, 'README.md'), 'utf8'),
      readFile(resolve(root, 'package.json'), 'utf8'),
    ]);
    const packageJson = JSON.parse(packageRaw) as { version: string };
    expect(readme).toContain(`img.shields.io/badge/version-${packageJson.version}-7c5cff`);
    expect(readme).toContain('https://github.com/ninjin0802/twedel/releases/latest');
  });
});
