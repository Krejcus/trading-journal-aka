import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { SessionConfig, Trade } from '../../types';
import DayFullscreenChart from './DayFullscreenChart';
import { useDayController } from './useDayController';
import { focusRange } from './dayFocus';
import { readStoredDayChartTimeframe, writeStoredDayChartTimeframe } from '../../lib/dayChartTools';
import type { MarketTimeframe } from '../../services/marketData';
import { LIVE_PHONE_INSTRUMENT, draftSummary, readLivePillPrefs, writeLivePillPrefs, type LivePillPrefs } from '../../lib/livePhoneTrade';
import { draftFromPositionBox, type TicketDraft } from '../../lib/liveOrderTicket';
import { LiveChartNotice, LiveQtySheet, LiveTradePill, LiveTradeToggle } from './LivePhoneTrade';
import LivePhoneOrderSheet from './LivePhoneOrderSheet';
import { LivePhoneAttachSheet, LivePhonePositionBar } from './LivePhoneLiveActions';
import { useLiveTicketQuote } from '../../hooks/useLiveTicketQuote';
import { previewSymbolFromChartSource } from '../../lib/leaderEntryPreview';
import { snapToTick } from '../../lib/liveOrderTicket';
import {
  livePhoneBareMarket, livePhoneOperationId, livePhonePlacedText, livePhoneSheetEntry,
  type LivePhoneQuote, type LivePhoneTradeBridge,
} from '../../lib/livePhoneOrders';
import type { LiveEntryPreviewDraft } from '../../lib/leaderEntryPreview';
import { LivePhoneAccountsSheet, LivePhoneGroupPnl } from './LivePhoneAccounts';
import type { LiveChartPosition } from '../../lib/liveChartPosition';
import LiveTradeToasts from '../LiveTradeToasts';
import type { TradeToast } from '../../lib/liveTradeToasts';
import { LivePhoneOrderLines, useLivePhoneLineState } from './LivePhoneOrderLines';
import { createLivePriceLinesFeed, type LivePriceLinesFeed } from '../../lib/livePriceLinesFeed';
import { LivePhoneAlertLines, LivePhoneAlertList, LivePhoneAlertSheet, LivePhoneAlertsButton, LivePhoneCrosshairPlus, LivePhonePlusSheet } from './LivePhoneAlerts';
import { alertTitle, createLocalPriceAlertStore, movedAlert, newPriceAlert, type PriceAlert } from '../../lib/priceAlerts';
import { useLiveFillArrows } from './useLiveFillArrows';
import type { LiveFillMarker } from '../../lib/liveFillMarkers';
import { limitIsMarketable, newTicketDraft, stopIsTriggered, type TicketQuote } from '../../lib/liveOrderTicket';
import type { ChartViewApi } from '@getcandlekit/charts/react';
import type { MarketCandle } from '../../services/marketData';
import './dayJournal.css';

export interface LivePhoneChartSlots {
  /** LIVE hlavička nad grafem (LIVE ▾, skupina, stav kopírky); `group` = P&L skupiny místo názvu. */
  header: (group?: React.ReactNode) => React.ReactNode;
  /** Vrstvy LIVE nad grafem (menu záložek). */
  overlay?: React.ReactNode;
  /** Obchodování z telefonu (2. 11. 2026): stejný relay jako PC; null = jen zobrazení. */
  trade?: LivePhoneTradeBridge | null;
  /** Živá pozice a účty skupiny — stejný read model jako PC graf, jen zobrazení. */
  position: LiveChartPosition;
  /** Události kopírky z workeru → karty vlevo dole jako na PC (`LiveTradeToasts`). */
  copyEvents?: React.ComponentProps<typeof LiveTradeToasts>['events'];
  /** Kopírka čerstvě zapnutá (ne shadow) — tečky kopií na kartách. */
  copierArmed?: boolean;
  /** Plnění živého obchodu → šipky hned po vyplnění (napojí datová vrstva). */
  fills?: readonly LiveFillMarker[];
  /** Obchod plnění je otevřený (šipky bez výstupu). */
  fillsOpen?: boolean;
  /** Kdo hlídá upozornění (text do seznamu); null = zatím nikdo. */
  alertWatch?: string | null;
  /** Spuštěná upozornění od datové vrstvy → bliknutí čáry a karta. */
  alertEvents?: readonly { id: string; alertId: string; at: number; price: number }[];
}

const NO_FILLS: readonly LiveFillMarker[] = [];

/**
 * Dvě okna / roztažené jiné okno: štítky a upozornění by seděly na souřadnicích
 * okna 0 přes okno s jiným měřítkem — pozici pak kreslí cenové čáry do všech oken.
 */
function PositionPriceLines({ feed, position, enabled }: { feed: LivePriceLinesFeed; position: LiveChartPosition; enabled: boolean }) {
  useEffect(() => { feed.publish(enabled ? position.symbol : null, enabled ? position.lines : []); }, [enabled, feed, position.key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => feed.publish(null, []), [feed]);
  return null;
}

/** Šipky plnění (hook uvnitř vrstvy grafu, kde je API panelu). */
function LiveFillArrows(props: { api: ChartViewApi | null; fills: readonly LiveFillMarker[]; open: boolean; candles: readonly MarketCandle[]; intervalSeconds: number; enabled: boolean; isDark: boolean }) {
  useLiveFillArrows(props);
  return null;
}

/** Market jen s cenou kanálu mladší než tohle (worker ji ověří znovu proti IBKR). */
const PHONE_MARKET_QUOTE_MAX_AGE_MS = 3_000;

/**
 * LIVE → Graf na telefonu: graf dneška z deníku (stejné svíčky, kreslení,
 * kolečko intervalů) v LIVE režimu — nativní lišta zůstává a graf se
 * nezavírá. Jen zobrazení; obchodní cesty se napojí zvlášť.
 */
export default function LivePhoneChart({ trades, allTrades, sessions, isDark, onUpdateTrade, slots, onLeave }: {
  trades: readonly Trade[];
  allTrades: readonly Trade[];
  sessions: readonly SessionConfig[];
  isDark: boolean;
  onUpdateTrade: (id: string | number, updates: Partial<Trade>) => unknown;
  slots: LivePhoneChartSlots;
  /** Escape / systémové zpět: přejde na Live Dashboard. */
  onLeave: () => void;
}) {
  const ctl = useDayController({ trades, allTrades, sessions, onUpdateTrade });
  const [timeframe, setTimeframeState] = useState<MarketTimeframe>(() => readStoredDayChartTimeframe(typeof window === 'undefined' ? null : window.localStorage));
  const setTimeframe = (next: MarketTimeframe) => { setTimeframeState(next); writeStoredDayChartTimeframe(window.localStorage, next); };
  const range = focusRange({ mode: 'day', session: 'ny', scope: ctl.scope, windows: ctl.chartWindows, now: ctl.now, isToday: ctl.isToday });
  const [pill, setPill] = useState<LivePillPrefs>(() => readLivePillPrefs(typeof window === 'undefined' ? null : window.localStorage));
  const savePill = (next: LivePillPrefs) => { setPill(next); writeLivePillPrefs(window.localStorage, next); };
  const [qtySheet, setQtySheet] = useState(false);
  const [notice, setNotice] = useState<{ key: number; text: string } | null>(null);
  const clearNotice = useCallback(() => setNotice(null), []);
  const trade = slots.trade ?? null;
  // Živá cena jako panel na PC: kanál ceny grafu, kontrakt jen ze zdroje IBKR (INV-UI-04).
  const candleClose = ctl.chart.candles.at(-1)?.close ?? null;
  const tick = useLiveTicketQuote(ctl.chart.liveFeed, 'MNQ', candleClose);
  const contract = previewSymbolFromChartSource(ctl.chart.liveSource);
  const quote = useMemo<LivePhoneQuote | null>(() => {
    if (!tick || ctl.chart.liveStatus !== 'live') return null;
    const bid = snapToTick(tick.price, LIVE_PHONE_INSTRUMENT.tickSize);
    return { symbol: contract, bid, ask: bid + LIVE_PHONE_INSTRUMENT.tickSize, at: tick.at };
  }, [tick, contract, ctl.chart.liveStatus]);
  // Jeden příkaz naráz (zámek přes ref — dvojklep nepošle druhý; nový operationId jen za nový pokus).
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const say = (text: string) => setNotice({ key: Date.now(), text });
  const send = async (draft: LiveEntryPreviewDraft | { error: string }) => {
    if ('error' in draft) { say(draft.error); return; }
    if (!trade || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const result = await trade.place(draft, livePhoneOperationId());
      say(livePhonePlacedText(result));
    } catch (error) {
      say(`Neodesláno / neznámé: ${error instanceof Error ? error.message.slice(0, 140) : 'chyba'} — nic neopakuj, zkontroluj pozici.`);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const sendBlocked = (market: boolean): string | null => (
    !trade ? 'Odesílání z telefonu tu není dostupné.'
      : trade.blockedReason ?? (market && !trade.marketSupported ? 'Worker zatím neumí Market.'
        : !quote || Date.now() - quote.at > PHONE_MARKET_QUOTE_MAX_AGE_MS ? 'Cena není čerstvá (starší než 3 s) — nic se neodeslalo.'
          : !(quote.symbol ?? (market ? null : trade.frontContract)) ? 'Kontrakt není ověřený (cena není z IBKR) — nic se neodeslalo.' : null)
  );
  const sheetContract = (type: string): string | null => (quote?.symbol ?? (type === 'limit' ? trade?.frontContract ?? null : null)
  );
  // Lišta: Koupit / Prodat = holý Market hned (Filip 1. 11.), SL/TP doplní „Přidat SL/TP“.
  const onSide = (side: 'buy' | 'sell') => {
    const blocked = sendBlocked(true) ?? (!trade!.bareSupported ? 'Worker zatím neumí Market bez SL/TP.'
      : pill.qty > trade!.maxContracts ? `Strop ručního vstupu je ${trade!.maxContracts} kontraktů.` : null);
    if (blocked) { say(blocked); return; }
    void send(livePhoneBareMarket(side, pill.qty, quote!));
  };
  const [attachOpen, setAttachOpen] = useState(false);
  const position = trade?.position ?? null;
  const marketNow = quote ? (position?.side === 'short' ? quote.ask : quote.bid) : null;
  // Objednávka z position toolu: návrh jako ⚡ na PC (draftFromPositionBox), velikost v kontraktech.
  const [order, setOrder] = useState<{ key: number; draft: TicketDraft } | null>(null);
  const quoteOf = (lastPrice: number) => ({ bid: lastPrice, ask: lastPrice });
  // Pozice v grafu: čáry vstupu a SL/TP z read modelu (jen zobrazení, neověřené = žádné čáry).
  // Pozici kreslí štítky jako na PC (LivePhoneOrderLines); ve dvou oknech cenové čáry řady.
  const chartPosition = slots.position;
  const [priceLines] = useState(createLivePriceLinesFeed);
  const lineState = useLivePhoneLineState();
  // Typ příkazu a kontrola proti trhu z čerstvé kotace (≤ 3 s), jako PC — ne z close svíčky.
  const freshQuote = (): TicketQuote | null => (quote && Date.now() - quote.at <= PHONE_MARKET_QUOTE_MAX_AGE_MS ? { bid: quote.bid, ask: quote.ask } : null);
  const [accountsOpen, setAccountsOpen] = useState(false);
  const showGroup = chartPosition.summary != null || chartPosition.issue != null;
  useEffect(() => { if (!chartPosition.summary) setAccountsOpen(false); }, [chartPosition.summary]);
  // Karty vlevo dole, které nevznikly z událostí kopírky (upozornění).
  const [cards, setCards] = useState<TradeToast[]>([]);
  // Lokální karty nikdy nejsou sticky (nesmí se hromadit nad lištou ani vytlačit kartu rizika).
  const card = useCallback((tone: TradeToast['tone'], badge: string, title: string, line: string, ms?: number) => {
    const at = Date.now();
    setCards(current => [...current.slice(-5), { id: `local-${at}-${Math.random().toString(36).slice(2, 6)}`, at, tone, badge, title, line, pnl: null, accounts: 0, sticky: false, ms }]);
  }, []);
  // Upozornění na cenu: zatím jen v tomto zařízení (hlídání a doručení napojí datová vrstva).
  const [alertStore] = useState(() => createLocalPriceAlertStore(typeof window === 'undefined' ? null : window.localStorage));
  const alertState = useSyncExternalStore(alertStore.subscribe, alertStore.getState, alertStore.getState);
  const [selectedAlert, setSelectedAlert] = useState<string | null>(null);
  const [editAlert, setEditAlert] = useState<string | null>(null);
  const [alertList, setAlertList] = useState(false);
  const [plus, setPlus] = useState<number | null>(null);
  const [flashIds, setFlashIds] = useState<ReadonlySet<string>>(() => new Set());
  const seenAlertEvents = useRef<Set<string> | null>(null);
  useEffect(() => {
    const events = slots.alertEvents ?? [];
    // První načtení = staré události, jen si je zapamatovat (jako karty obchodů).
    if (!seenAlertEvents.current) { seenAlertEvents.current = new Set(events.map(event => event.id)); return; }
    const fresh = events.filter(event => !seenAlertEvents.current!.has(event.id));
    for (const event of fresh) {
      seenAlertEvents.current.add(event.id);
      const alert = alertStore.getState().alerts.find(item => item.id === event.alertId);
      if (!alert) continue;
      card('amber', 'Upoz.', alertTitle(alert), alert.note ? `${alert.note} · cena ${event.price.toFixed(2)}` : `cena ${event.price.toFixed(2)}`, 8_000);
      setFlashIds(current => new Set(current).add(alert.id));
      window.setTimeout(() => setFlashIds(current => { const next = new Set(current); next.delete(alert.id); return next; }), 2_400);
    }
  }, [alertStore, card, slots.alertEvents]);
  const market = ctl.chart.candles.at(-1)?.close ?? null;
  const editing = editAlert ? alertState.alerts.find(alert => alert.id === editAlert) ?? null : null;
  const moveAlert = (id: string, price: number) => {
    const alert = alertStore.getState().alerts.find(item => item.id === id);
    if (!alert) return;
    const next = movedAlert(alert, price, market);
    alertStore.update(next);
    card('blue', 'Posun', 'Upozornění posunuto', `${alert.price.toFixed(2)} → ${next.price.toFixed(2)} · ${alertTitle(next).split(' ').slice(1, -1).join(' ')}`);
  };
  const removeAlert = (id: string) => {
    alertStore.remove(id);
    if (selectedAlert === id) setSelectedAlert(null);
    card('muted', 'Zrušeno', 'Upozornění zrušeno', '');
  };
  return (
    <DayFullscreenChart
      ctl={ctl}
      isDark={isDark}
      timeframe={timeframe}
      onTimeframe={setTimeframe}
      range={range}
      focusKeyPrefix={`live:${ctl.scope}`}
      selectedTrade={null}
      onClose={onLeave}
      live={{
        header: slots.header(showGroup ? <LivePhoneGroupPnl position={chartPosition} onOpen={() => setAccountsOpen(true)} /> : undefined),
        priceLines,
        overlay: ({ lastPrice, api, candles }) => <>
          {slots.overlay}
          {accountsOpen && chartPosition.summary && <LivePhoneAccountsSheet position={chartPosition} onClose={() => setAccountsOpen(false)} />}
          {plus != null && (
            <LivePhonePlusSheet
              price={plus}
              market={lastPrice}
              quote={freshQuote()}
              quantity={pill.qty}
              onClose={() => setPlus(null)}
              onOrder={(side, type) => {
                const price = plus;
                setPlus(null);
                if (lastPrice == null) { say('Cena trhu zatím není — objednávku nejde připravit.'); return; }
                // Stejný list a odeslání jako objednávka z position boxu (kontroly beze změny).
                setOrder({ key: Date.now(), draft: newTicketDraft(side, type, price, LIVE_PHONE_INSTRUMENT, freshQuote() ?? quoteOf(lastPrice), { sizing: 'qty', quantity: pill.qty, riskUsd: 200 }) });
              }}
              onAlert={() => {
                const alert = newPriceAlert(plus, lastPrice, alertStore.getState().defaults);
                alertStore.add(alert);
                setPlus(null);
                card('amber', 'Upoz.', 'Upozornění přidáno', `${alertTitle(alert)} · ${slots.alertWatch ? 'zvoneček = výběr, dvojklep = nastavení' : 'zatím jen v tomto zařízení, hlídání se napojí'}`);
              }}
              onLine={() => {
                const engine = api?.drawing?.engine;
                const time = candles.at(-1)?.time;
                setPlus(null);
                if (!engine || time == null) return;
                engine.commit({ id: engine.newDrawingId(), tool: 'HorizontalLine', points: [{ time, price: plus }], style: engine.getDefaultStyle() } as Parameters<typeof engine.commit>[0]);
              }}
            />
          )}
          {editing && (
            <LivePhoneAlertSheet
              key={editing.id}
              alert={editing}
              market={lastPrice}
              onClose={() => setEditAlert(null)}
              onDelete={id => { setEditAlert(null); removeAlert(id); }}
              onSave={(next: PriceAlert) => {
                alertStore.update({ ...next, updatedAt: Date.now() });
                // Co uložíš, dostanou i další nová upozornění.
                alertStore.setDefaults({ frequency: next.frequency, expiry: next.expiry, line: next.line, channels: next.channels });
                setEditAlert(null);
              }}
            />
          )}
          {alertList && (
            <LivePhoneAlertList
              alerts={alertState.alerts}
              watching={slots.alertWatch ?? null}
              onClose={() => setAlertList(false)}
              onEdit={id => { setAlertList(false); setEditAlert(id); }}
              onRemove={removeAlert}
            />
          )}
          {qtySheet && <LiveQtySheet value={pill.qty} onClose={() => setQtySheet(false)} onDone={qty => { savePill({ ...pill, qty }); setQtySheet(false); }} />}
          {order && lastPrice != null && (
            <LivePhoneOrderSheet
              key={order.key}
              initial={order.draft}
              instrument={LIVE_PHONE_INSTRUMENT}
              quote={freshQuote() ?? quoteOf(lastPrice)}
              onClose={() => setOrder(null)}
              onSubmit={draft => {
                setOrder(null);
                const blocked = sendBlocked(draft.type === 'market')
                  ?? (draft.quantity > (trade?.maxContracts ?? 1) ? `Strop ručního vstupu je ${trade?.maxContracts ?? 1} kontraktů.` : null);
                if (blocked) { say(`${draftSummary(draft)} — ${blocked}`); return; }
                // Znovu proti čerstvé kotaci: limit/stop, který by se teď hned vyplnil, neposílat.
                const now = freshQuote();
                const crossed = now && draft.type === 'limit' && limitIsMarketable(draft, now) ? 'limit je už na druhé straně trhu (vyplnil by se hned)'
                  : now && draft.type === 'stop' && stopIsTriggered(draft, now) ? 'stop je už za trhem (spustil by se hned)' : null;
                if (crossed) { say(`${draftSummary(draft)} — ${crossed}, nic se neodeslalo.`); return; }
                // Limit/Stop bez IBKR: kontrakt podle brokera (worker ho ověří znovu); Market jen z IBKR.
                void send(livePhoneSheetEntry(draft, LIVE_PHONE_INSTRUMENT, { ...quote!, symbol: sheetContract(draft.type) }));
              }}
            />
          )}
          {attachOpen && position && marketNow != null && position.bareEntryOperationId && (
            <LivePhoneAttachSheet
              side={position.side}
              market={marketNow}
              tickSize={LIVE_PHONE_INSTRUMENT.tickSize}
              onClose={() => setAttachOpen(false)}
              onSubmit={(stopLoss, takeProfit) => {
                setAttachOpen(false);
                if (!trade || busyRef.current) return;
                busyRef.current = true;
                setBusy(true);
                void trade.attach({ entryOperationId: position.bareEntryOperationId!, symbol: position.symbol, quantity: position.quantity, expectPrice: marketNow, stopLoss, takeProfit })
                  .then(result => say(result.status === 'acknowledged' ? 'SL a TP přijaty brokerem.'
                    : result.status === 'blocked' ? `Neodesláno: ${result.blockers[0]?.text ?? ''}` : result.reason ?? 'Výsledek neznámý — zkontroluj pozici.'))
                  .catch(error => say(`Neodesláno / neznámé: ${error instanceof Error ? error.message.slice(0, 140) : 'chyba'}`))
                  .finally(() => { busyRef.current = false; setBusy(false); });
              }}
            />
          )}
        </>,
        onPositionOrder: (drawing, { lastPrice }) => {
          if (lastPrice == null) { setNotice({ key: Date.now(), text: 'Cena trhu zatím není — objednávku nejde připravit.' }); return; }
          try {
            const { draft, quantity } = draftFromPositionBox(drawing, LIVE_PHONE_INSTRUMENT, freshQuote() ?? quoteOf(lastPrice));
            setOrder({ key: Date.now(), draft: { ...draft, sizing: 'qty', quantity: Math.max(1, quantity) } });
          } catch (error) {
            setNotice({ key: Date.now(), text: error instanceof Error ? error.message : 'Position box nejde převést na objednávku.' });
          }
        },
        // Bid/ask ze streamu přijde s napojením dat; zatím poslední cena svíčky.
        chartLayer: ({ lastPrice, api, candles, intervalSeconds, replay, fullPane }) => <>
          <PositionPriceLines feed={priceLines} position={chartPosition} enabled={!fullPane && !replay} />
          {api && !replay && fullPane && <>
            <LivePhoneOrderLines
              api={api}
              state={lineState}
              summary={chartPosition.summary}
              manage={trade?.manage ?? null}
              canClose={trade?.closeSupported === true}
              entryAvg={trade?.entryAvg ?? null}
              isDark={isDark}
              onNotice={say}
            />
            <LivePhoneAlertLines
              api={api}
              alerts={alertState.alerts}
              selectedId={selectedAlert}
              flashIds={flashIds}
              onSelect={setSelectedAlert}
              onEdit={id => { setSelectedAlert(id); setEditAlert(id); }}
              onMove={moveAlert}
              onRemove={removeAlert}
            />
            <LivePhoneCrosshairPlus api={api} onPlus={setPlus} />
          </>}
          <LiveFillArrows api={api} fills={slots.fills ?? NO_FILLS} open={slots.fillsOpen === true} candles={candles} intervalSeconds={intervalSeconds} enabled={!replay && slots.fillsOpen != null} isDark={isDark} />
          <LiveTradeToasts events={slots.copyEvents} copierArmed={slots.copierArmed ?? false} isDark={isDark} placement={{ left: 8, bottom: 84 }} extra={cards} />
          {position && <LivePhonePositionBar
            side={position.side} quantity={position.quantity} symbol={position.symbol} pending={position.pending}
            unprotected={position.bareEntryOperationId != null} busy={busy}
            onAttach={() => { if (marketNow == null) say('Cena není čerstvá — SL/TP teď nejde připravit.'); else setAttachOpen(true); }}
            onClose={() => { void trade?.flatten().then(say, error => say(`Flatten: ${error instanceof Error ? error.message.slice(0, 140) : 'chyba'}`)); }}
          />}
          <LiveTradePill prefs={pill} onPrefs={savePill} bid={quote?.bid ?? lastPrice} ask={quote?.ask ?? lastPrice} onQty={() => setQtySheet(true)} onSide={onSide} />
          {notice && <LiveChartNotice key={notice.key} text={notice.text} onDone={clearNotice} />}
        </>,
        symbol: LIVE_PHONE_INSTRUMENT.symbol,
        toolbar: <>
          <LivePhoneAlertsButton count={alertState.alerts.length} onClick={() => setAlertList(true)} />
          <LiveTradeToggle on={pill.on} onToggle={() => savePill({ ...pill, on: !pill.on })} />
        </>,
      }}
    />
  );
}
