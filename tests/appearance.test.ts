import { describe, expect, it } from 'vitest';
import { customPaletteColors, DEFAULT_APPEARANCE, normalizeAppearance, paletteColors } from '../lib/appearance';

describe('vzhled Aurora', () => {
  it('chybějící nebo poškozené nastavení → výchozí hodnoty', () => {
    expect(normalizeAppearance(undefined)).toEqual(DEFAULT_APPEARANCE);
    expect(normalizeAppearance('nesmysl')).toEqual(DEFAULT_APPEARANCE);
    expect(normalizeAppearance({ background: 'aurora', palette: 'neon', customColor: 'red', strength: 'x' })).toEqual(DEFAULT_APPEARANCE);
  });

  it('průhlednost karet a síla se drží v povoleném rozsahu', () => {
    expect(normalizeAppearance({ cardTransparency: 99, strength: 140 })).toMatchObject({ cardTransparency: 90, strength: 100 });
    expect(normalizeAppearance({ cardTransparency: 2, strength: -5 })).toMatchObject({ cardTransparency: 10, strength: 0 });
  });

  it('platné nastavení zůstane beze změny', () => {
    const value = { background: 'field', palette: 'ocean', customColor: '#10b981', strength: 35, cardTransparency: 70 } as const;
    expect(normalizeAppearance(value)).toEqual(value);
  });

  it('každá paleta dává pět barev pro světlé i tmavé téma', () => {
    for (const palette of ['default', 'polar', 'ocean', 'sunset', 'forest', 'graphite', 'custom'] as const) {
      for (const dark of [false, true]) {
        const colors = paletteColors({ ...DEFAULT_APPEARANCE, palette }, dark);
        expect(colors).toHaveLength(5);
        colors.forEach(color => expect(color).toMatch(/^#[0-9a-f]{6}$/i));
      }
    }
  });

  it('vlastní barva: tmavé téma má tmavší odstíny než světlé', () => {
    const lum = (hex: string) => [1, 3, 5].reduce((sum, i) => sum + parseInt(hex.slice(i, i + 2), 16), 0);
    const light = customPaletteColors('#6366f1', false), dark = customPaletteColors('#6366f1', true);
    light.forEach((color, i) => expect(lum(dark[i])).toBeLessThan(lum(color)));
  });
});
