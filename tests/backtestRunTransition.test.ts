import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { transitionTransform } from '../components/BacktestRunTransition';

describe('otevření backtest session z karty', () => {
  it('plocha přes celé okno se zmenší přesně na obdélník karty', () => {
    const viewport = { width: 1200, height: 800 };
    expect(transitionTransform({ left: 152, top: 285.5, width: 600, height: 200 }, viewport))
      .toBe('translate(152px, 285.5px) scale(0.5, 0.25)');
    // Celé okno = beze změny.
    expect(transitionTransform({ left: 0, top: 0, width: 1200, height: 800 }, viewport))
      .toBe('translate(0px, 0px) scale(1, 1)');
  });

  it('animuje jen transform a opacity (kompozitor), ne clip-path ani rozměry', () => {
    const source = readFileSync(join(__dirname, '..', 'components/BacktestRunTransition.tsx'), 'utf8');
    const keyframes = [...source.matchAll(/\{\s*(?:transform|opacity|offset)[^}]*\}/g)].map(match => match[0]);
    expect(keyframes.length).toBeGreaterThan(0);
    for (const frame of keyframes) {
      for (const key of frame.match(/(\w+)\s*:/g) ?? []) {
        expect(['transform:', 'opacity:', 'offset:']).toContain(key.replace(/\s+/g, ''));
      }
    }
    expect(source).not.toMatch(/clipPath\s*:/);
  });
});
