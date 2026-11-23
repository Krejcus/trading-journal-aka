import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('typy stavu kopírky pro sdílený LIVE kód', () => {
  it('soubor zůstává jen typový: žádná hodnota, žádný běhový import', () => {
    const code = readFileSync(new URL('../lib/liveCopierTypes.ts', import.meta.url), 'utf8');
    const imports = [...code.matchAll(/^import\s+(type\s+)?/gm)];
    expect(imports.length).toBeGreaterThan(0);
    for (const match of imports) expect(match[1]).toBeTruthy();
    expect(code).not.toMatch(/^export\s+(const|let|var|function|class|default)\b/m);
    expect(code).not.toMatch(/^(const|let|var|function|class)\s/m);
  });
});
