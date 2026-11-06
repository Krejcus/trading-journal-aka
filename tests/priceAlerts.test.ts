import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRICE_ALERT, PRICE_ALERTS_STORAGE_KEY, PRICE_ALERT_DEFAULTS_KEY, PRICE_ALERT_TONES, alertTagInk, alertConditionFor, alertLineCss, alertTitle,
  createLocalPriceAlertStore, movedAlert, newPriceAlert, freshPriceAlertEvents, pcAlertFiredActions, priceAlertEventTitle, quickAlertCardStatus, readPriceAlertState,
} from '../lib/priceAlerts';
import { liveFillHistory, liveFillKey, type LiveFillMarker } from '../lib/liveFillMarkers';
import { EXTRA_TOAST_MAX, TRADE_TOAST_MAX, capExtraToasts, keepStickyToasts } from '../lib/liveTradeToasts';

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
      [PRICE_ALERTS_STORAGE_KEY]: JSON.stringify([{ id: 'x', price: -5 }, { id: 'ok', price: 21480.1, line: { color: 'ne-barva', width: 'huge' } }, 'junk']),
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

  it('× na telefonu jedním klepnutím; zámek a „odesílám“ v rodiči (přežijí odpojení vrstvy)', () => {
    const lines = readFileSync('components/day/LivePhoneOrderLines.tsx', 'utf8');
    expect(lines).not.toMatch(/confirmCancel: true/);
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

describe('upozornění na cenu na PC', () => {
  const read = (file: string) => readFileSync(file, 'utf8');

  it('text spuštění: automatický směr tvrdí jen překročení, bez upozornění zůstane úroveň', () => {
    const alert = newPriceAlert(21480, 21400, DEFAULT_PRICE_ALERT);
    expect(priceAlertEventTitle(alert, 21480)).toBe(`MNQ překročí ${(21480).toLocaleString('cs-CZ', { minimumFractionDigits: 2 })}`);
    expect(priceAlertEventTitle({ ...alert, conditionAuto: false }, 21480)).toContain('nahoru přes');
    expect(priceAlertEventTitle(null, 21480)).toBe('MNQ překročí 21480.00');
  });

  it('karta rychlého alertu tvrdí „hlídá“ jen když je uložený a Mac hlídá', () => {
    expect(quickAlertCardStatus(undefined, 'Hlídá')).toMatchObject({ warn: true, line: expect.stringContaining('nepřihlášeno') });
    expect(quickAlertCardStatus('offline', 'Hlídá')).toMatchObject({ warn: true, line: expect.stringContaining('NEULOŽENO') });
    expect(quickAlertCardStatus('syncing', 'Hlídá')).toEqual({ warn: false, line: 'Ukládám · Mac hlídá' });
    expect(quickAlertCardStatus('syncing', null)).toMatchObject({ warn: true, line: expect.stringContaining('NEHLÍDÁ') });
    expect(quickAlertCardStatus('synced', 'Hlídá')).toMatchObject({ warn: false, line: expect.stringContaining('Hlídá Mac') });
    expect(quickAlertCardStatus('synced', null)).toMatchObject({ warn: true, line: expect.stringContaining('NEHLÍDÁ') });
    // Řádek karty se ořezává kolem 42 znaků: stav se musí vejít celý.
    for (const sync of [undefined, 'offline', 'syncing', 'synced'] as const) {
      for (const watching of ['Hlídá', null]) expect(quickAlertCardStatus(sync, watching).line.length).toBeLessThanOrEqual(36);
    }
  });

  it('kanály na PC jdou každý zvlášť', () => {
    for (const pc of [true, false]) for (const voice of [true, false]) for (const sound of [true, false]) {
      expect(pcAlertFiredActions({ channels: { phone: true, pc, voice, sound } })).toEqual({ card: pc, voice, sound });
    }
    expect(pcAlertFiredActions(null)).toEqual({ card: true, voice: false, sound: false });
  });

  it('nové události: první načtení mlčí, stará ani opakovaná se nehlásí', () => {
    const now = 1_000_000;
    const old = { id: 'old', at: now - 60_000 };
    const first = freshPriceAlertEvents(null, [old], now);
    expect(first.fresh).toEqual([]);
    const fresh = { id: 'new', at: now - 1_000 };
    const late = { id: 'late', at: now - 31_000 };
    const second = freshPriceAlertEvents(first.seen, [old, late, fresh], now);
    expect(second.fresh).toEqual([fresh]);
    expect(freshPriceAlertEvents(second.seen, [old, late, fresh], now).fresh).toEqual([]);
    // Výměna úložiště (přihlášení): volající předá null, staré se znovu nehlásí.
    expect(freshPriceAlertEvents(null, [fresh], now).fresh).toEqual([]);
  });

  it('karty upozornění nevytlačí kartu plnění', () => {
    const fill = { id: 'fill', sticky: false };
    const extras = Array.from({ length: 5 }, (_, i) => ({ id: `x${i}`, sticky: false }));
    expect(read('components/LiveTradingScreen.tsx')).toMatch(/extra=\{priceAlerts\.cards\} capExtra/);
    expect(read('components/day/LivePhoneChart.tsx')).toMatch(/extra=\{cards\} capExtra/);
    expect(read('components/BacktestWorkspace.tsx')).not.toMatch(/capExtra/);
    const capped = capExtraToasts([fill, ...extras], toast => toast.id.startsWith('x'));
    expect(capped.filter(toast => toast.id.startsWith('x'))).toHaveLength(EXTRA_TOAST_MAX);
    expect(capped.at(-1)?.id).toBe('x4');
    expect(keepStickyToasts(capped).map(toast => toast.id)).toContain('fill');
  });

  it('tón upozornění je vlastní, nepůjčuje si tón z pozice', () => {
    for (const [tone] of PRICE_ALERT_TONES) expect(read('services/liveFillAudio.ts')).toContain(`'alert-${tone}': [`);
    expect(read('components/LivePcPriceAlerts.tsx')).toMatch(/playCue\(`alert-\$\{alert\?\.channels\.tone \?\? 'double'\}`\)/);
  });

  it('barva z palety a tón přežijí čištění; nesmysl spadne na výchozí', () => {
    const storage = memory({
      [PRICE_ALERTS_STORAGE_KEY]: JSON.stringify([
        { id: 'a', price: 100, condition: 'up', line: { color: '#E91E63' }, channels: { tone: 'urgent' } },
        { id: 'b', price: 100, condition: 'up', line: { color: 'red; x' }, channels: { tone: 'hlasite' } },
      ]),
    });
    const [good, bad] = readPriceAlertState(storage).alerts;
    expect(good.line.color).toBe('#e91e63');
    expect(good.channels.tone).toBe('urgent');
    expect(bad.line.color).toBe(DEFAULT_PRICE_ALERT.line.color);
    expect(bad.channels.tone).toBeUndefined();
  });

  it('štítek na ose má čitelný text na světlé i tmavé barvě', () => {
    expect(alertTagInk('#ffffff')).toBe('#0f172a');
    expect(alertTagInk('#f5b53d')).toBe('#0f172a');
    expect(alertTagInk('#2962ff')).toBe('#ffffff');
    expect(alertTagInk('#000000')).toBe('#ffffff');
  });

  it('nic neobchoduje a nesahá na kopírku ani příkazy', () => {
    const source = read('components/LivePcPriceAlerts.tsx');
    expect(source).not.toMatch(/from ['"][^'"]*(tradovate|copier|relay|broker|leaderOrderManage|livePhoneOrders)[^'"]*['"]/i);
    expect(source).not.toMatch(/fetch\(|supabase|invoke\(/);
  });

  it('jen živý panel exekuce, za přehrávání nic; čáry leží pod čarami příkazů', () => {
    const workspace = read('components/AlphaTradeChartWorkspace.tsx');
    expect(workspace).toMatch(/onQuickPriceAlert=\{liveReplayLocked \? undefined : liveOrderEntry\?\.priceAlerts\?\.quickAdd\}/);
    expect(workspace).toMatch(/liveOrderEntry\?\.priceAlerts && !liveReplayLocked/);
    expect(workspace.indexOf('priceAlerts.renderLines(chartApi)')).toBeLessThan(workspace.indexOf('<BacktestOrderLinesOverlay'));
    expect(read('components/day/LivePhoneAlerts.tsx')).toMatch(/overflow: 'hidden', zIndex: 14/);
    expect(read('components/BacktestOrderLinesOverlay.tsx')).toMatch(/absolute inset-0 z-\[115\]/);
    // Kód upozornění se netáhne do backtestu a detailu obchodu.
    expect(workspace).toMatch(/import type \{ LivePcAlertBridge \}/);
  });

  it('dialog leží pod hlavičkou LIVE, OFF zůstává klikatelné', () => {
    const alerts = read('components/LivePcPriceAlerts.tsx');
    expect(alerts).toMatch(/fixed inset-x-0 bottom-0 top-11 z-\[700\]/);
    expect(alerts).not.toMatch(/createPortal/);
    expect(read('components/LiveTradingScreen.tsx')).toMatch(/live-chart-header relative z-\[800\] flex h-11/);
  });

  it('dialog ztiší klávesové zkratky; dvojklik na čáru neotevře nastavení vybrané kresby', () => {
    expect(read('components/LivePcPriceAlerts.tsx')).toMatch(/role="dialog"\s+aria-modal="true"/);
    expect(read('components/AlphaTradeChartWorkspace.tsx')).toMatch(/closest\?\.\('\[data-alert-line\]'\)\) return;/);
  });
});
