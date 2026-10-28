import { describe, expect, it } from 'vitest';
import { barCountdownAxisGeometry, barCountdownCornerRect, barCountdownText, barCountdownTextColor, BAR_COUNTDOWN_GRACE_SECONDS } from '../services/barCountdownPrimitive';

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

  it('box pod cenou má geometrii štítku ceny z lightweight-charts a navazuje na jeho spodní hranu', () => {
    // 12 px písmo, DPR 1: výška 17 (lichá jako tick 1 px), šířka = rámeček 1 + 2 × 5 + text 50 + tick 5 = 66.
    const geometry = barCountdownAxisGeometry({
      priceY: 100, fontSize: 12, textWidth: 50, horizontalPixelRatio: 1, verticalPixelRatio: 1,
      bitmapWidth: 80, alignRight: false, lastValueVisible: true,
    });
    expect(geometry).toEqual({ x: 1, width: 66, height: 17, priceTop: 92, top: 109 });
    // Retina (DPR 2): výška 34 (parita s tickem 2 px sedí), střed 199 → štítek ceny 183–217, box od 217.
    const retina = barCountdownAxisGeometry({
      priceY: 100, fontSize: 12, textWidth: 50, horizontalPixelRatio: 2, verticalPixelRatio: 2,
      bitmapWidth: 160, alignRight: false, lastValueVisible: true,
    });
    expect(retina).toMatchObject({ x: 2, width: 132, height: 34, priceTop: 183, top: 217 });
    // Osa vlevo: štítky u pravého okraje osy.
    expect(barCountdownAxisGeometry({
      priceY: 100, fontSize: 12, textWidth: 50, horizontalPixelRatio: 1, verticalPixelRatio: 1,
      bitmapWidth: 80, alignRight: true, lastValueVisible: true,
    }).x).toBe(80 - 1 - 66);
    // Bez štítku ceny box sedí přímo na ceně.
    expect(barCountdownAxisGeometry({
      priceY: 100, fontSize: 12, textWidth: 50, horizontalPixelRatio: 1, verticalPixelRatio: 1,
      bitmapWidth: 80, alignRight: false, lastValueVisible: false,
    }).top).toBe(92);
  });

  it('obdélník v rohu grafu podle zvoleného rohu', () => {
    const base = { paneWidth: 800, paneHeight: 400, boxWidth: 60, boxHeight: 20 };
    expect(barCountdownCornerRect({ ...base, corner: 'bottom-right' })).toEqual({ x: 732, y: 372 });
    expect(barCountdownCornerRect({ ...base, corner: 'bottom-left' })).toEqual({ x: 8, y: 372 });
    expect(barCountdownCornerRect({ ...base, corner: 'top-right' })).toEqual({ x: 732, y: 8 });
    expect(barCountdownCornerRect({ ...base, corner: 'top-left' })).toEqual({ x: 8, y: 8 });
  });

  it('text čitelný na barvě štítku', () => {
    expect(barCountdownTextColor('#2962ff')).toBe('#ffffff');
    expect(barCountdownTextColor('#26a69a')).toBe('#ffffff');
    expect(barCountdownTextColor('#ffeb3b')).toBe('#000000');
    expect(barCountdownTextColor('#fff')).toBe('#000000');
    expect(barCountdownTextColor('rgba(1,2,3,1)')).toBe('#ffffff');
  });
});
