import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRICE_ALERT, PRICE_ALERTS_STORAGE_KEY, PRICE_ALERT_DEFAULTS_KEY, alertConditionFor, alertLineCss, alertTitle,
  createLocalPriceAlertStore, movedAlert, newPriceAlert, readPriceAlertState,
} from '../lib/priceAlerts';
import { liveFillHistory, liveFillKey, type LiveFillMarker } from '../lib/liveFillMarkers';
import { TRADE_TOAST_MAX, keepStickyToasts } from '../lib/liveTradeToasts';

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
    expect(phone).toMatch(/if \(!manage\) return;/);
    // Chybějící „co jsem viděl“ (rozjeté SL pozice z přikoupení) = hláška, nikdy tiché nic ani odeslání (3. 11.).
    expect(phone).toMatch(/if \(expect == null\) \{ onNotice\(/);
  });
});

describe('oponentura 2. 11. — vrstvy, okna, ×, plusko, karty', () => {
  it('sticky karta (odpojený follower) se nevytlačí běžnými ani lokálními kartami', () => {
    const card = (id: string, sticky = false) => ({ id, sticky });
    const out = keepStickyToasts([card('risk', true), card('a'), card('b'), card('c'), card('d')]);
    expect(out.map(item => item.id)).toEqual(['risk', 'c', 'd']);
    expect(out).toHaveLength(TRADE_TOAST_MAX);
    expect(keepStickyToasts([card('a'), card('b'), card('c'), card('d')]).map(item => item.id)).toEqual(['b', 'c', 'd']);
    expect(keepStickyToasts([card('r1', true), card('r2', true), card('r3', true), card('x')]).map(item => item.id)).toEqual(['r1', 'r2', 'r3']);
  });

  it('vrstva LIVE v grafu leží pod listy a menu LIVE ▾ (cesta k vypnutí, INV-UI-02)', () => {
    const chart = readFileSync('components/day/DayFullscreenChart.tsx', 'utf8');
    expect(chart).toMatch(/data-live-chart-layer style=\{\{ position: 'absolute', inset: 0, zIndex: 20, isolation: 'isolate', pointerEvents: 'none' \}\}/);
    // Listy a menu v kořeni dialogu mají z-index 40+.
    expect(readFileSync('components/LivePhoneChrome.tsx', 'utf8')).toMatch(/position: 'absolute', inset: 0, zIndex: 45/);
    expect(readFileSync('components/day/LivePhoneAlerts.tsx', 'utf8')).toMatch(/position: 'absolute', inset: 0, zIndex: 46/);
  });

  it('dvě okna (U3, 3. 11.): štítky a upozornění v každém okně podle jeho API, plusko jen v aktivním, za přehrávání nic', () => {
    const chart = readFileSync('components/day/DayFullscreenChart.tsx', 'utf8');
    expect(chart).toMatch(/fullPane: !split \|\| \(maximized && activePane === 0\)/);
    // Vrstva v buňce okna se souřadnicemi a měřítkem toho okna; skryté (roztažené jiné) okno ji nemá.
    expect(chart).toMatch(/\{live\?\.paneLayer && visible && \(/);
    expect(chart).toMatch(/live\.paneLayer\(\{ \.\.\.liveInfo, api: paneApi\(index\), candles: list, intervalSeconds: timeframeMinutes\(paneTf\) \* 60, paneIndex: index, active: !split \|\| isActive \}\)/);
    const phone = readFileSync('components/day/LivePhoneChart.tsx', 'utf8');
    expect(phone).toMatch(/paneLayer: \(\{ api, replay, active, lastPrice \}\) => \(api && !replay \? <>/);
    expect(phone).toMatch(/\{active && <LivePhoneCrosshairPlus api=\{api\} onPlus=\{setPlus\} \/>\}/);
    // Cenové čáry pozice (náhrada štítků ve dvou oknech) už nejsou potřeba — štítky by byly dvakrát.
    expect(phone).not.toMatch(/PositionPriceLines|createLivePriceLinesFeed/);
  });

  it('× na telefonu vždy na dvě klepnutí; zámek a „odesílám“ v rodiči (přežijí odpojení vrstvy)', () => {
    const lines = readFileSync('components/day/LivePhoneOrderLines.tsx', 'utf8');
    expect(lines).toMatch(/\.map\(line => \(\{ \.\.\.line, confirmCancel: true \}\)\)/);
    expect(lines).toMatch(/const \{ pendingMove, setPendingMove, busyRef \} = state;/);
    // Zámek drží rodič; s deskem je to tentýž ref (`trade.commandLockRef`, C7/C8 kolo 1).
    expect(readFileSync('components/day/LivePhoneChart.tsx', 'utf8')).toMatch(/const ownLineState = useLivePhoneLineState\(\);\s*const lineState = trade\?\.commandLockRef \? \{ \.\.\.ownLineState, busyRef: trade\.commandLockRef \} : ownLineState;/);
  });

  it('plusko a odeslání listu: typ i kontrola proti trhu z čerstvé kotace, ne z close svíčky', () => {
    expect(readFileSync('components/day/LivePhoneAlerts.tsx', 'utf8')).toMatch(/clickedOrderType\('buy', price, quote, TICK\)/);
    const phone = readFileSync('components/day/LivePhoneChart.tsx', 'utf8');
    expect(phone).toMatch(/limitIsMarketable\(draft, now\)/);
    expect(phone).toMatch(/stopIsTriggered\(draft, now\)/);
    expect(phone).toMatch(/quote=\{freshQuote\(\) \?\? quoteOf\(lastPrice\)\}/);
  });

  it('šipky jen se známým stavem obchodu (neznámý = schované)', () => {
    expect(readFileSync('components/day/LivePhoneChart.tsx', 'utf8')).toMatch(/enabled=\{!replay && slots\.fillsOpen != null && shownFills\.length > 0\}/);
  });
});

describe('oponentura 2. 11., 2. kolo', () => {
  it('plusko leží nad štítky čar (klepnutí na + nikdy netrefí × u pozice)', () => {
    expect(readFileSync('components/day/LivePhoneAlerts.tsx', 'utf8')).toMatch(/zIndex: 130, pointerEvents: 'auto', width: 16, height: 16/);
    expect(readFileSync('components/BacktestOrderLinesOverlay.tsx', 'utf8')).toMatch(/z-\[115\]/);
  });
  it('lokální karty (upozornění) nejsou sticky; position box bere čerstvou kotaci', () => {
    const phone = readFileSync('components/day/LivePhoneChart.tsx', 'utf8');
    expect(phone).toMatch(/sticky: false, ms \}/);
    expect(phone).toMatch(/draftFromPositionBox\(drawing, LIVE_PHONE_INSTRUMENT, freshQuote\(\) \?\? quoteOf\(lastPrice\)\)/);
  });
});
