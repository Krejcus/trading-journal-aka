import { describe, expect, it } from 'vitest';
import { barCountdownAxisBox, barCountdownText, barCountdownTextColor, BAR_COUNTDOWN_GRACE_SECONDS } from '../services/barCountdownPrimitive';

describe('odpočet do uzavření svíčky na cenové ose', () => {
  const barTime = 1_793_000_000; // začátek svíčky (s)

  it('ukazuje zbývající čas jako TradingView a po uzavření chvíli 0:00', () => {
    expect(barCountdownText({ barTime, timeframeMinutes: 5, nowSeconds: barTime + 55 })).toBe('4:05');
    expect(barCountdownText({ barTime, timeframeMinutes: 1, nowSeconds: barTime + 59.4 })).toBe('0:00');
    expect(barCountdownText({ barTime, timeframeMinutes: 240, nowSeconds: barTime + 100 })).toBe('3:58:20');
    expect(barCountdownText({ barTime, timeframeMinutes: 1, nowSeconds: barTime + 60 + BAR_COUNTDOWN_GRACE_SECONDS })).toBe('0:00');
  });

  it('stará data nebo zavřený trh = žádný odpočet (ne věčné 0:00)', () => {
    expect(barCountdownText({ barTime, timeframeMinutes: 1, nowSeconds: barTime + 60 + BAR_COUNTDOWN_GRACE_SECONDS + 1 })).toBeNull();
    expect(barCountdownText({ barTime, timeframeMinutes: 0, nowSeconds: barTime })).toBeNull();
    expect(barCountdownText({ barTime: Number.NaN, timeframeMinutes: 1, nowSeconds: barTime })).toBeNull();
  });

  it('box navazuje na spodní hranu štítku ceny ve stejné výšce (lightweight-charts: 17/12 písma)', () => {
    // 12 px písmo: štítek ceny 17 px se středem na ceně → box od +8,5 px, výška 17.
    expect(barCountdownAxisBox(100, 12, true)).toEqual({ top: 109, height: 17 });
    expect(barCountdownAxisBox(100, 11, true)).toEqual({ top: 108, height: 16 });
    // Bez štítku ceny box sedí přímo na cenové čáře.
    expect(barCountdownAxisBox(100, 12, false)).toEqual({ top: 92, height: 17 });
  });

  it('text čitelný na barvě štítku', () => {
    expect(barCountdownTextColor('#2962ff')).toBe('#ffffff');
    expect(barCountdownTextColor('#26a69a')).toBe('#ffffff');
    expect(barCountdownTextColor('#ffeb3b')).toBe('#000000');
    expect(barCountdownTextColor('#fff')).toBe('#000000');
    expect(barCountdownTextColor('rgba(1,2,3,1)')).toBe('#ffffff');
  });
});
