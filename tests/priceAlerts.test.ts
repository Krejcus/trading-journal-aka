import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRICE_ALERT, PRICE_ALERTS_STORAGE_KEY, PRICE_ALERT_DEFAULTS_KEY, alertConditionFor, alertLineCss, alertTitle,
  createLocalPriceAlertStore, movedAlert, newPriceAlert, readPriceAlertState,
} from '../lib/priceAlerts';
import { liveFillHistory, liveFillKey, type LiveFillMarker } from '../lib/liveFillMarkers';

const memory = (initial: Record<string, string> = {}) => {
  const data = { ...initial };
  return { data, getItem: (key: string) => data[key] ?? null, setItem: (key: string, value: string) => { data[key] = value; } };
};

describe('upozornění na cenu (telefon, 2. 11.)', () => {
  it('nové upozornění: cena na tick, podmínka podle strany trhu, výchozí nastavení', () => {
    const above = newPriceAlert(21480.13, 21467.5, DEFAULT_PRICE_ALERT, 1000);
    expect(above.price).toBe(21480.25);
    expect(above.condition).toBe('up');
    expect(above.line).toEqual(DEFAULT_PRICE_ALERT.line);
    expect(newPriceAlert(21440, 21467.5, DEFAULT_PRICE_ALERT).condition).toBe('down');
    expect(alertConditionFor(21440, null)).toBe('cross');
    expect(alertTitle(above).replace(/\s/g, ' ')).toBe('MNQ nahoru přes 21 480,25');
  });

  it('posun: „nahoru/dolů přes“ se přepne podle nové strany trhu, „překročí“ zůstane', () => {
    const alert = newPriceAlert(21480, 21467.5, DEFAULT_PRICE_ALERT, 1000);
    expect(movedAlert(alert, 21450, 21467.5, 2000)).toMatchObject({ price: 21450, condition: 'down', updatedAt: 2000 });
    expect(movedAlert({ ...alert, condition: 'cross' }, 21450, 21467.5).condition).toBe('cross');
  });

  it('úložiště v zařízení: přidat, posunout, smazat, výchozí nastavení přežije reload; nesmysly se zahodí', () => {
    const storage = memory();
    const store = createLocalPriceAlertStore(storage);
    const alert = newPriceAlert(21480, 21467.5, store.getState().defaults);
    store.add(alert);
    store.update({ ...alert, note: 'retest dHigh' });
    store.setDefaults({ ...DEFAULT_PRICE_ALERT, line: { width: 'thick', style: 'dotted', color: '#60a5fa' } });
    const reloaded = readPriceAlertState(storage);
    expect(reloaded.alerts).toHaveLength(1);
    expect(reloaded.alerts[0].note).toBe('retest dHigh');
    expect(reloaded.defaults.line).toEqual({ width: 'thick', style: 'dotted', color: '#60a5fa' });
    store.remove(alert.id);
    expect(readPriceAlertState(storage).alerts).toHaveLength(0);

    const broken = readPriceAlertState(memory({
      [PRICE_ALERTS_STORAGE_KEY]: JSON.stringify([{ id: 'x', price: -5 }, { id: 'ok', price: 21480.1, line: { color: '#ff0000', width: 'huge' } }, 'junk']),
      [PRICE_ALERT_DEFAULTS_KEY]: '{',
    }));
    expect(broken.alerts.map(item => item.id)).toEqual(['ok']);
    expect(broken.alerts[0].price).toBe(21480);
    expect(broken.alerts[0].line).toEqual(DEFAULT_PRICE_ALERT.line);
    expect(broken.defaults).toEqual(DEFAULT_PRICE_ALERT);
  });

  it('čára: výběr jen jemně zesílí a styl (tečkovaná/čárkovaná) zůstane', () => {
    expect(alertLineCss({ width: 'thin', style: 'dashed', color: '#f5b53d' }, false)).toEqual({ width: 1, style: 'dashed' });
    expect(alertLineCss({ width: 'thin', style: 'dashed', color: '#f5b53d' }, true)).toEqual({ width: 1.5, style: 'dashed' });
    expect(alertLineCss({ width: 'thin', style: 'dotted', color: '#f5b53d' }, true).style).toBe('dotted');
  });

  it('upozornění jen hlásí: žádná cesta k brokerovi, kopírce ani relay', () => {
    for (const file of ['lib/priceAlerts.ts', 'components/day/LivePhoneAlerts.tsx']) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/from ['"][^'"]*(tradovate|copier|relay|broker|leaderOrderManage|livePhoneOrders)[^'"]*['"]/i);
      expect(source, file).not.toMatch(/fetch\(|supabase|invoke\(/);
    }
  });
});

describe('šipky plnění hned po vyplnění', () => {
  const fill = (over: Partial<LiveFillMarker>): LiveFillMarker => ({ id: 'f1', orderId: 'o1', at: 2000, price: 21452.25, side: 'Buy', role: 'entry', quantity: 2, ...over });

  it('syntetická historie pro primitivu deníku: seřazená plnění, otevřený/uzavřený obchod, vadná plnění pryč', () => {
    const history = liveFillHistory([fill({ id: 'f2', orderId: 'o2', at: 5000, side: 'Sell', role: 'exit', price: 21470 }), fill({}), fill({ id: 'bad', price: Number.NaN })], false)!;
    expect(history.fills.map(item => item.id)).toEqual(['f1', 'f2']);
    expect(history.fills[0]).toMatchObject({ role: 'entry', side: 'Buy', allocatedQuantity: 2, timeSource: 'broker' });
    expect(history.position).toMatchObject({ status: 'closed', openedAt: 2000, closedAt: 5000, peakQuantity: 2 });
    expect(liveFillHistory([fill({})], true)!.position).toMatchObject({ status: 'open', closedAt: null });
    expect(liveFillHistory([], true)).toBeNull();
  });

  it('klíč překreslení se mění jen s novým plněním', () => {
    expect(liveFillKey([fill({})])).toBe(liveFillKey([fill({})]));
    expect(liveFillKey([fill({})])).not.toBe(liveFillKey([fill({}), fill({ id: 'f2' })]));
  });

  it('šipky kreslí stejná primitiva jako deník (klepnutí = hoverAt), PC graf se nemění', () => {
    expect(readFileSync('components/day/useLiveFillArrows.ts', 'utf8')).toMatch(/createJournalChartPrimitive\([\s\S]*hoverAt\(point\)/);
    expect(readFileSync('services/journalChartPrimitive.ts', 'utf8')).toMatch(/hoverAt: point => onCrosshair\(\{ point: point \?\? undefined \}\)/);
  });
});

describe('čáry obchodu na telefonu jako na PC', () => {
  it('stejný model a předkontroly jako PC; tažení až po výběru jen na telefonu', () => {
    const phone = readFileSync('components/day/LivePhoneOrderLines.tsx', 'utf8');
    expect(phone).toMatch(/livePositionChartLines\(/);
    expect(phone).toMatch(/liveLineMoveBlockReason\(/);
    expect(phone).toMatch(/liveBreakEven\(/);
    expect(phone).toMatch(/startLine\.price !== current/);
    expect(phone).toMatch(/selectToDrag/);
    // PC LIVE graf zůstává s tažením bez výběru.
    for (const file of ['components/LiveTradingScreen.tsx', 'components/AlphaTradeChartWorkspace.tsx']) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/selectToDrag/);
    }
  });

  it('bez napojené správy jsou čáry jen zobrazení (manage chybí = nic se neodešle)', () => {
    const phone = readFileSync('components/day/LivePhoneOrderLines.tsx', 'utf8');
    expect(phone).toMatch(/manageable: manage != null/);
    expect(phone).toMatch(/if \(!manage \|\| expect == null\) return;/);
  });
});
