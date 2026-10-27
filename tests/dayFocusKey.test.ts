import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { reviewFocusKey } from '../components/day/reviewFocusKey';

describe('záběr grafu dne se mění jen akcí uživatele', () => {
  it('klíč přesunu záběru nezávisí na čase, jen na režimu a výběru obchodu', () => {
    expect(reviewFocusKey('day:london:day')).toBe('day:london:day');
    expect(reviewFocusKey('day:london:day', 42)).toBe('trade:42');
    expect(reviewFocusKey('day:london:day', null)).toBe('day:london:day');
  });

  it('graf dne (počítač, telefon, celá obrazovka) bere klíč jen z reviewFocusKey — bez času', () => {
    for (const file of ['components/day/DayDesktop.tsx', 'components/day/DayCompactChart.tsx', 'components/day/DayFullscreenChart.tsx']) {
      const text = readFileSync(join(__dirname, '..', file), 'utf8');
      const line = text.split('\n').find(row => /const focusKey = /.test(row)) ?? '';
      expect(line, file).toMatch(/reviewFocusKey\(/);
      expect(line, file).not.toMatch(/entryMs|exitMs|now/);
    }
  });
});
