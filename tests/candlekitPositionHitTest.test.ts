import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Záplata knihovny (patches/@getcandlekit+charts): vstupní čára position boxu
// reaguje na myš jen v šířce boxu, ne přes celý graf na úrovni vstupní ceny.
describe('CandleKit position box hit test', () => {
  const dist = 'node_modules/@getcandlekit/charts/dist';
  const sources = readdirSync(dist).filter(name => /\.(c?js)$/.test(name)).map(name => readFileSync(`${dist}/${name}`, 'utf8'));
  const withPosition = sources.filter(source => source.includes('pointInRect(p, a, c)'));

  it('omezuje zásah vstupní čáry na šířku boxu', () => {
    expect(withPosition.length).toBeGreaterThan(0);
    for (const source of withPosition) {
      expect(source).not.toContain('pointInRect(p, a, c) || Math.abs(p.y - a.y) <= t)');
      expect(source).toContain('Math.abs(p.y - a.y) <= t && p.x >= Math.min(a.x, b.x) - t && p.x <= Math.max(a.x, b.x) + t');
    }
  });

  it('výplň position boxu kreslí pod svíčkami a úchyty jako v TradingView', () => {
    for (const source of withPosition) {
      expect(source).toContain('this.bottomView = new PaneView(this, "bottom")');
      expect(source).toContain('return [this.bottomView, this.view];');
      expect(source).toContain('if (this.layer === "bottom") {');
      expect(source).toContain('const base = s.selected ? 5 : 4;');
    }
  });
});
