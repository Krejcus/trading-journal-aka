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
    const value = { background: 'equity', palette: 'ocean', customColor: '#10b981', strength: 35, cardTransparency: 70, speed: 40, mouseEffect: 'smoke', mouseStrength: 65 } as const;
    expect(normalizeAppearance(value)).toEqual(value);
  });

  it('starší uložené nastavení bez rychlosti vypadá jako dřív: Hlubiny stojí, Skvrny se přelévají, myš nic', () => {
    expect(normalizeAppearance({ background: 'depths' })).toMatchObject({ speed: 0, mouseEffect: 'none' });
    expect(normalizeAppearance({ background: 'field' })).toMatchObject({ speed: 50, mouseEffect: 'none' });
  });

  it('rychlost a síla reakce na myš se drží v rozsahu, neznámá reakce → žádná', () => {
    expect(normalizeAppearance({ speed: 300, mouseStrength: -4, mouseEffect: 'laser' })).toMatchObject({ speed: 100, mouseStrength: 0, mouseEffect: 'none' });
    expect(normalizeAppearance({ background: 'candles' })).toMatchObject({ background: 'candles', speed: 50 });
  });

  it('každá paleta dává pět barev pro světlé i tmavé téma', () => {
    for (const palette of ['default', 'polar', 'ocean', 'sunset', 'forest', 'graphite', 'custom'] as const) {
      for (const dark of [false, true]) for (const background of ['depths', 'field', 'candles', 'equity', 'none'] as const) {
        const colors = paletteColors({ ...DEFAULT_APPEARANCE, background, palette }, dark);
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
