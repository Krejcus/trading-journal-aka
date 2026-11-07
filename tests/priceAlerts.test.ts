import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRICE_ALERT, PRICE_ALERTS_STORAGE_KEY, PRICE_ALERT_DEFAULTS_KEY, alertTagInk, alertConditionFor, alertLineCss, alertTitle,
  createLocalPriceAlertStore, movedAlert, newPriceAlert, freshPriceAlertEvents, pcAlertFiredActions, priceAlertEventTitle, quickAlertCardStatus, readPriceAlertState,
} from '../lib/priceAlerts';
import { ALERT_SOUNDS_BASE, ALERT_SOUND_VOLUME_DEFAULT, ALERT_TONE_GROUPS, CUSTOM_SOUND_MAX_BYTES, CUSTOM_SOUND_MAX_COUNT, DEFAULT_ALERT_TONE, alertToneApnsSound, alertToneNotes, alertToneUrl, clampAlertSoundVolume, customSoundProblem, isAlertTone } from '../lib/priceAlertTones';
import { ALERT_FIRE_MS, alertFirePoint, alertFireRgb, alertWaveFront, drawAlertFire } from '../lib/alertFireEffect';
import { LIVE_FILL_CUE_PATTERNS } from '../services/liveFillAudio';
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
    expect(phone).toMatch(/sticky: false, ms, \.\.\.extra \}/);
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
    const tones = ALERT_TONE_GROUPS.flatMap(group => group.tones);
    expect(tones.length).toBeGreaterThanOrEqual(40);
    expect(new Set(tones.map(tone => tone.id)).size).toBe(tones.length);
    const fills = Object.values(LIVE_FILL_CUE_PATTERNS).map(pattern => JSON.stringify(pattern));
    for (const tone of tones) {
      expect(Boolean(tone.file) !== Boolean(tone.notes), tone.id).toBe(true);
      // Nahrávka musí být v public a balík nese svou licenci.
      if (tone.file) expect(existsSync(`public/sounds/alerts/${tone.file}`), tone.file).toBe(true);
      if (tone.notes) {
        expect(tone.notes.reduce((sum, note) => sum + note.ms, 0), tone.id).toBeLessThanOrEqual(1_500);
        expect(fills, tone.id).not.toContain(JSON.stringify(tone.notes.map(({ hz, ms }) => ({ hz, ms }))));
        expect(tone.volume, tone.id).toBeLessThanOrEqual(0.35);
      }
    }
    expect(read('public/sounds/alerts/License.txt')).toContain('Creative Commons Zero');
    expect(read('components/LivePcPriceAlerts.tsx')).toMatch(/if \(actions\.sound\) void playAlertTone\(alert\?\.channels\.tone\)/);
  });

  it('neznámý nebo chybějící zvuk spadne na výchozí; vlastní soubor se ověří', () => {
    expect(alertToneUrl('neznamy')).toBe(`${ALERT_SOUNDS_BASE}${DEFAULT_ALERT_TONE}.wav`);
    expect(alertToneUrl(null)).toBe(`${ALERT_SOUNDS_BASE}${DEFAULT_ALERT_TONE}.wav`);
    expect(alertToneUrl('panic')).toBeNull();
    expect(alertToneUrl('custom:abc-1')).toBeNull();
    expect(alertToneNotes('custom:abc-1').length).toBeGreaterThan(0);
    expect(alertToneNotes('confirmation_001').length).toBeGreaterThan(0);
    expect(clampAlertSoundVolume('140')).toBe(100);
    expect(clampAlertSoundVolume('x')).toBe(ALERT_SOUND_VOLUME_DEFAULT);
    expect(isAlertTone('custom:abc-1')).toBe(true);
    expect(isAlertTone('custom:../x')).toBe(false);
    expect(isAlertTone('panic')).toBe(true);
    const file = { name: 'a.mp3', type: 'audio/mpeg', size: 1000 };
    expect(customSoundProblem(file, 0)).toBeNull();
    expect(customSoundProblem({ ...file, name: 'a.pdf', type: 'application/pdf' }, 0)).toMatch(/zvukový/);
    expect(customSoundProblem({ ...file, size: CUSTOM_SOUND_MAX_BYTES + 1 }, 0)).toMatch(/1 MB/);
    expect(customSoundProblem(file, CUSTOM_SOUND_MAX_COUNT)).toMatch(/Nejvýš/);
    // Soubory jsou jen v zařízení: žádný upload na server.
    expect(read('services/priceAlertSounds.ts')).not.toMatch(/supabase|fetch\(/);
  });

  it('barva z palety a tón přežijí čištění; nesmysl spadne na výchozí', () => {
    const storage = memory({
      [PRICE_ALERTS_STORAGE_KEY]: JSON.stringify([
        { id: 'a', price: 100, condition: 'up', line: { color: '#E91E63' }, channels: { tone: 'panic' } },
        { id: 'b', price: 100, condition: 'up', line: { color: 'red; x' }, channels: { tone: 'hlasite' } },
      ]),
    });
    const [good, bad] = readPriceAlertState(storage).alerts;
    expect(good.line.color).toBe('#e91e63');
    expect(good.channels.tone).toBe('panic');
    expect(bad.line.color).toBe(DEFAULT_PRICE_ALERT.line.color);
    expect(bad.channels.tone).toBeUndefined();
  });

  it('štítek na ose má čitelný text na světlé i tmavé barvě', () => {
    expect(alertTagInk('#ffffff')).toBe('#0f172a');
    expect(alertTagInk('#f5b53d')).toBe('#0f172a');
    expect(alertTagInk('#2962ff')).toBe('#ffffff');
    expect(alertTagInk('#000000')).toBe('#ffffff');
  });

  it('Vyzkoušet jen ukáže spuštění v zařízení: žádná událost ani hlídač; vypnutá animace má klid', () => {
    const source = read('components/LivePcPriceAlerts.tsx');
    const preview = source.slice(source.indexOf('const preview = useCallback'), source.indexOf('// Trvale odmítnuté uložení'));
    expect(preview).toMatch(/presentRef\.current\(alert, alert\.price\)/);
    expect(preview).not.toMatch(/rpc|trigger|store\./);
  });

  it('spuštění v grafu: vlna doběhne doleva, prsten jen na svíčce ve výřezu; chyba barvy nic neshodí', () => {
    const fronts = [0, 0.25, 0.5, 0.75, 1].map(t => alertWaveFront(t, 500));
    expect(fronts[0]).toBeGreaterThan(500);
    for (let i = 1; i < fronts.length; i += 1) expect(fronts[i]).toBeLessThan(fronts[i - 1]);
    expect(fronts.at(-1)).toBeLessThan(0);
    expect(alertFirePoint(300, 600)).toBe(300);
    expect(alertFirePoint(700, 600)).toBeNull();
    expect(alertFirePoint(-1, 600)).toBeNull();
    expect(alertFirePoint(null, 600)).toBeNull();
    expect(alertFireRgb('#e91e63')).toBe('233,30,99');
    expect(alertFireRgb('nesmysl')).toBe('245,181,61');
    const calls: string[] = [];
    const gradient = { addColorStop: () => undefined };
    const ctx = new Proxy({}, {
      get: (_target, key) => (key === 'createLinearGradient' || key === 'createRadialGradient' ? () => gradient : () => { calls.push(String(key)); }),
      set: () => true,
    }) as never;
    // Svíčka mimo výřez: vlna ano, prsten (arc) ne. Ve výřezu i prsten. Po konci nic.
    drawAlertFire(ctx, { width: 600, y: 100, pointX: 900, ms: 500, color: '#f5b53d' });
    expect(calls).not.toContain('arc');
    expect(calls).toContain('stroke');
    calls.length = 0;
    drawAlertFire(ctx, { width: 600, y: 100, pointX: 500, ms: 500, color: '#f5b53d' });
    expect(calls).toContain('arc');
    calls.length = 0;
    drawAlertFire(ctx, { width: 600, y: 100, pointX: 500, ms: ALERT_FIRE_MS, color: '#f5b53d' });
    expect(calls).toEqual([]);
    // Omezené animace: jen klidný prsten.
    drawAlertFire(ctx, { width: 600, y: 100, pointX: 500, ms: 500, color: '#f5b53d', reduced: true });
    expect(calls.filter(call => call === 'arc')).toHaveLength(2);
  });

  it('zvuk v notifikaci iPhonu: soubor z balíčku, vlastní soubor z PC hraje výchozí', () => {
    expect(alertToneApnsSound('panic')).toBe('alert_panic.wav');
    expect(alertToneApnsSound('neznamy')).toBe(`alert_${DEFAULT_ALERT_TONE}.wav`);
    expect(alertToneApnsSound(null)).toBe(`alert_${DEFAULT_ALERT_TONE}.wav`);
    expect(alertToneApnsSound('custom:abc-1')).toBe('default');
    for (const tone of ALERT_TONE_GROUPS.flatMap(group => group.tones)) {
      expect(existsSync(`capacitor-ios/App/App/AlertSounds/alert_${tone.id}.wav`), tone.id).toBe(true);
      expect(read('capacitor-ios/App/App.xcodeproj/project.pbxproj')).toContain(`alert_${tone.id}.wav in Resources */,`);
    }
    expect(read('capacitor-ios/App/App/App.entitlements')).toContain('usernotifications.time-sensitive');
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
    expect(workspace.indexOf('priceAlerts.renderLines(chartApi, context.isDark)')).toBeLessThan(workspace.indexOf('<BacktestOrderLinesOverlay'));
    expect(read('components/day/LivePhoneAlerts.tsx')).toMatch(/overflow: 'hidden', zIndex: 14/);
    expect(read('components/BacktestOrderLinesOverlay.tsx')).toMatch(/absolute inset-0 z-\[115\]/);
    // Kód upozornění se netáhne do backtestu a detailu obchodu.
    expect(workspace).toMatch(/import type \{ LivePcAlertBridge \}/);
  });

  it('dialog leží pod hlavičkou LIVE, OFF zůstává klikatelné', () => {
    const alerts = read('components/LivePcPriceAlerts.tsx');
    expect(alerts).toMatch(/fixed inset-x-0 bottom-0 top-11 z-\[700\]/);
    // Okno bez portálu, jen nabídka zvuků jde přes body (okno by ji ořízlo).
    expect(alerts).toMatch(/return \(\n    <div className="fixed inset-x-0 bottom-0 top-11/);
    expect(alerts.match(/createPortal\(/g)).toHaveLength(1);
    expect(read('components/LiveTradingScreen.tsx')).toMatch(/live-chart-header relative z-\[800\] flex h-11/);
  });

  it('dialog ztiší klávesové zkratky; dvojklik na čáru neotevře nastavení vybrané kresby', () => {
    expect(read('components/LivePcPriceAlerts.tsx')).toMatch(/role="dialog"\s+aria-modal="true"/);
    expect(read('components/AlphaTradeChartWorkspace.tsx')).toMatch(/closest\?\.\('\[data-alert-line\]'\)\) return;/);
  });
});
