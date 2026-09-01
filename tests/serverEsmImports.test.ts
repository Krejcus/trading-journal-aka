import { readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const serverRoot = fileURLToPath(new URL('../server/', import.meta.url));

const typescriptFiles = (directory: string): string[] => readdirSync(directory, { withFileTypes: true })
  .flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return typescriptFiles(path);
    return extname(entry.name) === '.ts' ? [path] : [];
  });

describe('server Node ESM imports', () => {
  it('uses explicit file extensions for every relative static import', () => {
    const extensionless: string[] = [];
    const relativeImport = /\bfrom\s+['"](\.\.?\/[^'"]+)['"]/g;

    for (const path of typescriptFiles(serverRoot)) {
      const source = readFileSync(path, 'utf8');
      for (const match of source.matchAll(relativeImport)) {
        const specifier = match[1];
        if (!/\.(?:js|mjs|cjs|json)$/.test(specifier)) {
          extensionless.push(`${path.slice(serverRoot.length)}: ${specifier}`);
        }
      }
    }

    expect(extensionless).toEqual([]);
  });
});
