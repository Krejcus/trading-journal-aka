// LIVE → Graf na telefonu napojený na místní službu Rithmicu (jeden účet mimo kopírku).
// Kreslí STÁVAJÍCÍ telefonní graf (`LivePhoneChart` přes slot desku), jen mu místo deníku dne a IBKR
// dodá svíčky, cenu, pozici a most příkazů ze služby. Obrazovka nic neautorizuje: každý příkaz ověřuje
// služba (LocalExec). Nouzová lišta kopírky sem nepatří — jen „Zavřít pozici" a karty stavů.
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import LiveAccountBar, { liveLimitLinePrices, rithmicAccountBarData, type LiveAccountBarData } from './LiveAccountBar';
import type { BacktestChartOrderLine } from '../services/backtestOrderLines';
import { getLiveChartAutomation, subscribeLiveChartAutomation } from '../services/liveChartAutomation';
import type { LiveDeskPhoneChartSlots } from './LiveDesk';
import { rithmicScreenInstrumentIssue } from './RithmicLiveChart';
import { RITHMIC_SOLO_ACCOUNT } from '../hooks/useRithmicLocalTrading';
import { useRithmicAlertWatch } from '../hooks/useRithmicAlertWatch';
import { useLiveTicketQuote } from '../hooks/useLiveTicketQuote';
import { PhoneSessionContext, usePhoneSession } from './RithmicPhoneSession';
import { rithmicPairingOffered } from '../lib/rithmicLocalLink';
import RithmicPairingPanel from './RithmicPairingPanel';
import { readRithmicDeviceLink } from '../lib/rithmicDeviceLink';
import { perfMarkOnce } from '../lib/perfTrace';
import { cmeSessionCloseWarning } from '../lib/cmeSessionClose';
import {
  rithmicPhoneBridge, rithmicPhoneCards, rithmicPhoneCloseText, rithmicPhoneModeLabel, rithmicPhoneQuote, rithmicPhoneWaiting,
  type RithmicPhoneCard, type RithmicPhoneModeLabel,
} from '../lib/rithmicPhoneBridge';

interface Props {
  open: boolean;
  isDark: boolean;
  /** Escape / systémové zpět: přejde na Live Dashboard. */
  onLeave: () => void;
  /** Telefonní graf desku (`LivePhoneChart` z App) — stejný slot jako u Tradovate. */
  phoneChart: (slots: LiveDeskPhoneChartSlots) => React.ReactNode;
  /** Hlavička desku (LIVE menu, stav kopírky): dostane P&L pozice a čipy účtu Rithmicu. */
  header: (parts: { group?: React.ReactNode; account: React.ReactNode; compact?: boolean }) => React.ReactNode;
  /** Vrstvy desku nad grafem (menu záložek). */
  overlay?: React.ReactNode;
  /** Jen klíč knihovny šablon SL/TP na zařízení (nic neautorizuje). */
  userId?: string | null;
  /** Zkušební stránka: adresa simulace místo skutečné místní služby. */
  simulationUrl?: string;
  /** Výběr účtu / skupiny a P&L dne v hlavičce (jen zobrazení, zatím jen simulace). */
  accountBar?: LiveAccountBarData | null;
}

/** Druhý dotyk „Zavřít pozici" nejdřív po této době (dotyk-duch) a nejpozději do `CLOSE_CONFIRM_MS`. */
const CLOSE_SECOND_TAP_MIN_MS = 350;
const CLOSE_CONFIRM_MS = 5_000;

const MODE_STYLE: Record<RithmicPhoneModeLabel['tone'], React.CSSProperties> = {
  muted: { color: 'var(--dj-muted, #94a3b8)', border: '1px solid var(--dj-line, rgba(148,163,184,.3))' },
  warn: { color: '#fbbf24', border: '1px solid rgba(251,191,36,.55)', background: 'rgba(251,191,36,.12)' },
  danger: { color: '#fff', border: '1px solid #e11d48', background: '#e11d48' },
};
const CARD_STYLE: Record<RithmicPhoneCard['tone'], React.CSSProperties> = {
  red: { border: '1px solid rgba(244,63,94,.6)', background: 'rgba(244,63,94,.14)' },
  amber: { border: '1px solid rgba(245,158,11,.55)', background: 'rgba(245,158,11,.12)' },
  green: { border: '1px solid rgba(52,211,153,.5)', background: 'rgba(52,211,153,.10)' },
};
const chip: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', height: 28, padding: '0 10px', borderRadius: 9, fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap', minWidth: 0 };

/** Karty stavů a tlačítko „Zavřít pozici" — v hlavičce grafu, v prázdném stavu i nad grafem bez hlavičky. */
function RithmicPhoneStatus({ cards, onAction, brake, floating }: {
  cards: readonly RithmicPhoneCard[];
  onAction: (card: RithmicPhoneCard) => void;
  brake: { armed: boolean; busy: boolean; onTap: () => void } | null;
  floating?: boolean;
}) {
  if (!cards.length && !brake) return null;
  return (
    <div data-rithmic-phone-status style={{
      display: 'grid', gap: 6, padding: '6px 10px',
      ...(floating ? { position: 'absolute', left: 0, right: 0, top: 'env(safe-area-inset-top, 0px)', zIndex: 44, pointerEvents: 'none' } : {}),
    }}>
      {brake && (
        <button type="button" data-rithmic-phone-close disabled={brake.busy} onClick={brake.onTap} style={{
          // Vpravo (vedle cenové osy): vlevo nahoře je popisek grafu.
          pointerEvents: 'auto', justifySelf: 'end', marginRight: 64, minHeight: 36, padding: '0 14px', borderRadius: 10, fontSize: 13, fontWeight: 800, cursor: 'pointer',
          // Plné pozadí: brzda leží přes popisek grafu (OHLC) a musí jít přečíst (21. 11.).
          border: '1px solid #e11d48', color: brake.armed ? '#fff' : '#fb7185', background: brake.armed ? '#e11d48' : '#2a0b14', boxShadow: '0 6px 18px -8px rgba(0,0,0,.7)', opacity: brake.busy ? 0.6 : 1,
        }}>{brake.busy ? 'Zavírám…' : brake.armed ? 'Opravdu zavřít? Klepni znovu' : 'Zavřít pozici'}</button>
      )}
      {cards.map(card => (
        <div key={card.id} role="status" data-rithmic-phone-card={card.id.split(':')[0]} style={{ pointerEvents: 'auto', display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 10, backdropFilter: 'blur(6px)', ...CARD_STYLE[card.tone] }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ margin: 0, fontSize: 12.5, fontWeight: 800 }}>{card.title}</p>
            {card.text && <p style={{ margin: '2px 0 0', fontSize: 11.5, lineHeight: 1.35, opacity: 0.9 }}>{card.text}</p>}
          </div>
          {card.action && (
            <button type="button" data-rithmic-phone-action={card.action.kind} disabled={card.action.disabled} onClick={() => onAction(card)} style={{
              flex: 'none', minHeight: 34, padding: '0 12px', borderRadius: 9, border: '1px solid currentColor', background: 'transparent', color: 'inherit', fontSize: 12, fontWeight: 800,
              cursor: 'pointer', opacity: card.action.disabled ? 0.5 : 1,
            }}>{card.action.label}</button>
          )}
        </div>
      ))}
    </div>
  );
}

/** Jak dlouho po rozpadu spojení držet poslední známý obraz, než obrazovka ohlásí výpadek. */
const RECONNECT_GRACE_MS = 4_000;

function StandalonePhoneChart(props: Props) {
  const session = usePhoneSession(props.open, props.simulationUrl);
  return <PhoneChartView {...props} session={session} />;
}

function RithmicPhoneChart(props: Props) {
  const shared = React.useContext(PhoneSessionContext);
  const setChartOpen = shared?.setChartOpen;
  useEffect(() => {
    if (!setChartOpen || props.simulationUrl || !props.open) return;
    setChartOpen(true);
    return () => setChartOpen(false);
  }, [setChartOpen, props.open, props.simulationUrl]);
  return shared && !props.simulationUrl
    ? <PhoneChartView {...props} session={shared} />
    : <StandalonePhoneChart {...props} />;
}

const PhoneChartView: React.FC<Props & { session: ReturnType<typeof usePhoneSession> }> = ({ open, isDark, onLeave, phoneChart, header, overlay, userId, simulationUrl, session, accountBar: accountBarProp = null }) => {
  const { url, deviceAuth, trading, refreshPairing } = session;
  // Upozornění na cenu hlídá služba jen na skutečném trhu (zkušební systém i simulace mají smyšlené ceny).
  const alertWatch = useRithmicAlertWatch(trading, !simulationUrl && trading.system != null && trading.system !== 'Rithmic Test');
  // Lišta účtu: ze zkušební stránky mock účty, jinak skutečný účet služby (jeden, bez skupin; jen zobrazení).
  const realAccountBar = useMemo(() => rithmicAccountBarData({ accountName: trading.accountName, system: trading.system, closedPnl: trading.silent ? null : trading.accountClosedPnl }),
    [trading.accountName, trading.system, trading.accountClosedPnl, trading.silent]);
  const accountBar = accountBarProp ?? realAccountBar;
  // Rozsah tohoto zařízení (určila ho služba při spárování a sama ho vynucuje): obrazovka podle něj jen NENABÍZÍ,
  // co by služba stejně odmítla — aby se o odmítnutí člověk nedozvěděl až po klepnutí v nouzi.
  const deviceScope = useMemo(() => (deviceAuth ? readRithmicDeviceLink()?.scope ?? 'full' : 'full'), [deviceAuth]);
  const viewOnly = trading.readOnly || deviceScope === 'read';
  const closeOnlyHere = trading.closeOnly === true || deviceScope === 'close';
  const { link, state, symbol, marketData } = trading;
  const instrumentIssue = rithmicScreenInstrumentIssue({ symbol, tickSize: trading.tickSize, pointValue: trading.pointValue });
  const blocked = state?.blocked ?? null;

  // Kotace jako panel na PC: poslední cena ze služby na krok, ask o krok výš; `at` = kdy cena přišla.
  // Bez živých cen (služba mlčí, spojení pro ceny stojí) kotace NENÍ — telefon pak nic neodešle.
  const candleClose = marketData?.candles.at(-1)?.close ?? null;
  const tick = useLiveTicketQuote(marketData?.liveFeed ?? null, 'MNQ', candleClose);
  const feedLive = marketData?.liveStatus === 'live';
  const quotePrice = feedLive ? tick?.price ?? trading.price : null;
  const quoteAt = feedLive ? tick?.at ?? (marketData?.liveCapturedAt || null) : null;
  const quote = useMemo(() => rithmicPhoneQuote({ price: quotePrice, at: quoteAt, symbol, tickSize: trading.tickSize }), [quotePrice, quoteAt, symbol, trading.tickSize]);
  const lastLiveQuote = useRef<{ scope: string; price: number; at: number } | null>(null);
  const quoteScope = JSON.stringify([url, trading.system, trading.accountName, symbol]);
  useEffect(() => {
    if (quotePrice != null && quoteAt != null) lastLiveQuote.current = { scope: quoteScope, price: quotePrice, at: quoteAt };
  }, [quoteScope, quotePrice, quoteAt]);
  const lastSeen = !feedLive && lastLiveQuote.current?.scope === quoteScope ? lastLiveQuote.current : null;
  const market = useMemo(() => (marketData ? {
    data: marketData, quote, contract: symbol || null,
    // Rithmic Test je simulovaný trh: starší historie appky (skutečný MNQ) ani obchody deníku k němu nepatří.
    appHistory: trading.system !== null && trading.system !== 'Rithmic Test',
  } : null), [marketData, quote, symbol, trading.system]);

  // Brzda mimo zámek grafu: dvojí klepnutí (telefon), výsledek „neodešlo / neznámý" dostane vlastní kartu.
  const { closeNow, ack, dismissUncertain } = trading;
  const [closeBusy, setCloseBusy] = useState(false);
  const [closeNote, setCloseNote] = useState<{ at: number; text: string } | null>(null);
  const [closeArmedAt, setCloseArmedAt] = useState<number | null>(null);
  const closeRunning = useRef(false);
  const runClose = useCallback(async () => {
    if (closeRunning.current) return { status: 'blocked' as const, text: 'Zavření už běží — počkej na výsledek.' };
    closeRunning.current = true;
    setCloseBusy(true);
    try {
      const result = await closeNow();
      setCloseNote(result.status === 'sent' ? null : { at: Date.now(), text: rithmicPhoneCloseText(result) });
      return result;
    } finally { closeRunning.current = false; setCloseBusy(false); }
  }, [closeNow]);
  useEffect(() => {
    if (closeArmedAt == null) return undefined;
    const timer = window.setTimeout(() => setCloseArmedAt(null), CLOSE_CONFIRM_MS);
    return () => window.clearTimeout(timer);
  }, [closeArmedAt]);
  const tapClose = useCallback(() => {
    const now = Date.now();
    if (closeArmedAt == null) { setCloseArmedAt(now); return; }
    if (now - closeArmedAt < CLOSE_SECOND_TAP_MIN_MS) return; // dvojklep jedním dotykem
    setCloseArmedAt(null);
    void runClose();
  }, [closeArmedAt, runClose]);

  // Výsledek „Potvrdit incident" se nezahazuje: neúspěch dostane vlastní kartu.
  const [ackNote, setAckNote] = useState<{ at: number; text: string } | null>(null);
  const ackRunning = useRef(false);
  const confirmIncident = useCallback(async () => {
    if (ackRunning.current) return;
    // Ze spárovaného zařízení služba potvrzení incidentu nepřijímá (uvolňuje blokaci i nejistotu najednou) —
    // zbytečně se neposílá; zavřít pozici jde z telefonu vždy.
    if (deviceAuth) { setAckNote({ at: Date.now(), text: 'Incident jde potvrdit jen na Macu, kde služba běží. Pozici můžeš zavřít odsud.' }); return; }
    ackRunning.current = true;
    try {
      const reply = await ack();
      setAckNote(reply.ok ? null : { at: Date.now(), text: reply.error ?? 'Potvrzení se nepovedlo.' });
    } finally { ackRunning.current = false; }
  }, [ack, deviceAuth]);

  // Karta jen pro odmítnutí, které přišlo za tohoto spojení — starší z historie služby se neohlašují znovu.
  const rejectionBaseline = useRef<number | null>(null);
  if (!state) rejectionBaseline.current = null;
  else if (rejectionBaseline.current === null) rejectionBaseline.current = state.rejections.at(-1)?.at ?? 0;
  const lastRejection = state?.rejections.at(-1) ?? null;
  const rejection = lastRejection && rejectionBaseline.current !== null && lastRejection.at > rejectionBaseline.current ? lastRejection : null;

  // Konec burzovní seance: denní příkazy (i SL/TP) burza zruší. Upozornění jen když je co ztratit.
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const hasPosition = Boolean(state?.positions.some(item => item.symbol === symbol));
  const hasPendingEntry = Boolean(state?.orders.some(order => order.symbol === symbol && order.role === 'entry' && order.status === 'working'));
  const sessionWarning = link === 'open' ? cmeSessionCloseWarning(clock, { position: hasPosition, pendingEntry: hasPendingEntry }) : null;

  // Krátký výpadek spojení (návrat do appky, přepnutí sítě): pár sekund se drží poslední známý obraz — karta
  // „odpojeno" ani „stav není znám" neprobliknou a graf s hlavičkou neposkočí. Příkazy se po tu dobu NEposílají
  // (spojení není otevřené a služba by je nedostala); po uplynutí lhůty obrazovka řekne pravdu naplno.
  // Jen zobrazení — stejný princip jako lhůta u stavové lišty LIVE (INV-UI-01/03).
  const [grace, setGrace] = useState(false);
  const hadState = useRef(false);
  const stateKnown = state != null;
  useEffect(() => {
    if (stateKnown) { hadState.current = true; setGrace(false); return undefined; }
    if (!hadState.current) return undefined;
    setGrace(true);
    const timer = window.setTimeout(() => { hadState.current = false; setGrace(false); }, RECONNECT_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [stateKnown]);
  const lastPosition = useRef(trading.position);
  if (trading.position && trading.position.issueKind !== 'unknown') lastPosition.current = trading.position;
  const shownPosition = grace && trading.position?.issueKind === 'unknown' && lastPosition.current ? lastPosition.current : trading.position;
  const shownLink = grace ? 'open' as const : link;

  const cards = useMemo(() => rithmicPhoneCards({
    link: shownLink, helloFresh: trading.helloFresh || grace, rithmicConnected: Boolean(state?.connected) || grace, silent: trading.silent && !grace, readOnly: trading.readOnly, blocked,
    uncertain: trading.uncertain, closeNote, ackNote, rejection: rejection ? { at: rejection.at, reason: rejection.reason } : null, sessionWarning, foreignOrders: trading.workingOrders,
  }), [shownLink, grace, trading.helloFresh, state?.connected, trading.silent, trading.readOnly, blocked, trading.uncertain, closeNote, ackNote, rejection?.at, rejection?.reason, sessionWarning, trading.workingOrders]); // eslint-disable-line react-hooks/exhaustive-deps
  const onCardAction = useCallback((card: RithmicPhoneCard) => {
    if (card.action?.kind === 'ack') void confirmIncident();
    else if (card.action?.kind === 'verified') dismissUncertain();
    else if (card.id.startsWith('ack:')) setAckNote(null);
    else if (card.id.startsWith('close:')) setCloseNote(null);
  }, [confirmIncident, dismissUncertain]);

  // Brzda se nabízí při otevřeném spojení se službou — i při incidentu, stojící ceně nebo mlčící službě — a vždy,
  // když je co zavírat NEBO se to neví (visící vstup, neznámý stav, nejistý příkaz). Účet jen pro čtení ji nemá.
  // Během lhůty po výpadku se nabídka zavření řídí posledním známým stavem (neznámý stav by ji jinak na pár
  // sekund ukázal i na účtu bez pozice a zase schoval).
  const exposureShown = grace ? lastPosition.current?.summary != null : trading.mayHaveExposure;
  // S výběrem účtu v hlavičce (21. 11., Filip): v klidu se brzda neukazuje — pozice se zavírá × u pozice v grafu.
  // Sama se vrátí, když běžná cesta nemusí fungovat (nejistý příkaz, neznámý stav, služba mlčí, stop vstupů).
  // Pozice bez známé ceny SL: × v grafu ji nezavře („cena SL/TP není známá — nic se neodeslalo“), brzda tedy zůstává.
  // Nechráněná = bez SL, nebo SL kryje jen část pozice (části smí mít různou ochranu nebo žádnou).
  const unprotected = hasPosition && (shownPosition?.summary?.kind !== 'position' || shownPosition.summary.stop == null
    || (trading.legCoverage != null && trading.legCoverageTotal.stopLoss < shownPosition.summary.quantity));
  // Také když × zrovna nejde: rozběhnutý příkaz (čeká na výsledek), Rithmic odpojený. Přehrávání má telefon pokryté lištou s Flattenem.
  const brakeNeeded = trading.uncertain.length > 0 || (exposureShown && !hasPosition) || unprotected || trading.commandInFlight || !trading.available
    || Boolean(blocked) || trading.silent || !trading.helloFresh;
  const offerBrake = (link === 'open' || grace) && !viewOnly && (exposureShown || trading.uncertain.length > 0) && (!accountBar || brakeNeeded || grace);
  const brake = useMemo(() => (offerBrake ? { armed: closeArmedAt != null, busy: closeBusy, onTap: tapClose } : null), [offerBrake, closeArmedAt, closeBusy, tapClose]);

  // Most příkazů: účet jen pro čtení ho nemá (graf jen zobrazuje). „Zavřít" z lišty grafu = stejná brzda služby.
  const trade = useMemo(() => rithmicPhoneBridge({
    readOnly: trading.readOnly, blocked, entryBlockedReason: trading.entryBlockedReason, maxContracts: trading.maxContracts, symbol,
    averagePrice: trading.averagePrice, scaleIn: trading.scaleIn, position: trading.position, bareLegTrade: trading.bareLegTrade, soloAccountId: RITHMIC_SOLO_ACCOUNT,
    onPlaceEntry: trading.onPlaceEntry, onManageEntry: trading.onManageEntry, onBareLeg: trading.onBareLeg, closeNow: runClose,
    extraOrders: trading.extraOrders, onManageOrder: trading.onManageOrder, legCoverage: trading.legCoverage,
  }), [trading.extraOrders, trading.onManageOrder, trading.legCoverage, trading.readOnly, blocked, trading.entryBlockedReason, trading.maxContracts, symbol, trading.averagePrice, trading.scaleIn, trading.position, trading.bareLegTrade, trading.onPlaceEntry, trading.onManageEntry, trading.onBareLeg, runClose]);

  // P&L pozice a čáry DLL / MLL (jen zobrazení): z průměru, kusů a živé ceny služby.
  const summary = shownPosition?.summary?.kind === 'position' ? shownPosition.summary : null;
  const avg = trading.averagePrice ?? summary?.entry ?? null;
  const pv = trading.pointValue ?? 2;
  const openPnl = summary && avg != null && quotePrice != null ? (quotePrice - avg) * summary.quantity * pv * (summary.side === 'long' ? 1 : -1) : null;
  const limitPrefs = useSyncExternalStore(subscribeLiveChartAutomation, getLiveChartAutomation, getLiveChartAutomation);
  const limitAccount = accountBar?.accounts.find(item => item.id === accountBar.tradedAccountId) ?? null;
  const limitLines = useMemo<BacktestChartOrderLine[] | undefined>(() => {
    if (!limitAccount || !summary || avg == null || !(summary.quantity > 0)) return undefined;
    const prices = liveLimitLinePrices({ side: summary.side, quantity: summary.quantity, averagePrice: avg, pointValue: pv, tickSize: trading.tickSize ?? 0.25,
      realizedToday: limitAccount.realizedToday, ...(limitAccount.dailyLossLimit != null ? { dailyLossLimit: limitAccount.dailyLossLimit } : {}), ...(limitAccount.maxLossLeft != null ? { maxLossLeft: limitAccount.maxLossLeft } : {}) });
    const away = (price: number) => (quotePrice == null ? '' : ` · ${Math.abs(quotePrice - price).toLocaleString('cs-CZ', { maximumFractionDigits: 2 })} b`);
    const line = (id: string, price: number, color: string, label: string): BacktestChartOrderLine => ({ id, ownerId: id, ownerType: 'order', kind: 'stopLoss', price, color, label, draggable: false });
    const out: BacktestChartOrderLine[] = [];
    if (prices.dll && limitPrefs.limitDll) out.push(line('limit-dll', prices.dll.price, '#f59e0b', `DLL −${Math.round(prices.dll.amount).toLocaleString('cs-CZ')} USD${away(prices.dll.price)}`));
    if (prices.mll && limitPrefs.limitMll && !(limitPrefs.limitDll && prices.mll.price === prices.dll?.price)) out.push(line('limit-mll', prices.mll.price, '#e11d48', `MLL −${Math.round(prices.mll.amount).toLocaleString('cs-CZ')} USD${away(prices.mll.price)}`));
    return out.length ? out : undefined;
  }, [limitAccount, summary, avg, pv, trading.tickSize, quotePrice, limitPrefs.limitDll, limitPrefs.limitMll]);

  const mode = rithmicPhoneModeLabel({ system: trading.system, readOnly: viewOnly, closeOnly: closeOnlyHere, liveAccount: trading.liveAccount, simulation: Boolean(simulationUrl) });
  // S výběrem účtu: P&L, výběr a štítek režimu jen když je co hlásit (jen čtení, SKUTEČNÝ ÚČET …), ne „simulace“.
  const account = accountBar ? (
    <>
      <LiveAccountBar compact data={accountBar} openPnl={openPnl} isDark={isDark} />
      {mode && mode.tone !== 'muted' && <span data-rithmic-phone-mode={mode.tone} style={{ ...chip, flex: 'none', fontWeight: 900, letterSpacing: mode.tone === 'danger' ? '.04em' : undefined, ...MODE_STYLE[mode.tone] }}>{mode.text}</span>}
    </>
  ) : (
    <>
      <span data-rithmic-phone-account title={[trading.system, trading.accountName, symbol].filter(Boolean).join(' · ')} style={{ ...chip, border: '1px solid var(--dj-line, rgba(148,163,184,.3))', background: 'var(--dj-chip, transparent)', color: 'var(--dj-text, inherit)', overflow: 'hidden', textOverflow: 'ellipsis', display: 'inline-block', lineHeight: '26px', maxWidth: '60vw' }}>
        {[trading.system ?? 'Rithmic', trading.accountName ?? 'účet neznámý'].join(' · ')}
      </span>
      {mode && <span data-rithmic-phone-mode={mode.tone} style={{ ...chip, flex: 'none', fontWeight: 900, letterSpacing: mode.tone === 'danger' ? '.04em' : undefined, ...MODE_STYLE[mode.tone] }}>{mode.text}</span>}
    </>
  );

  // Hlavička grafu jde schovat (režim bez lišt): karty a brzda se pak kreslí nad grafem, ať nikdy nezmizí.
  const [headerShown, setHeaderShown] = useState(false);
  const headerRef = useCallback((node: HTMLDivElement | null) => setHeaderShown(node != null), []);
  const status = (floating: boolean) => <RithmicPhoneStatus cards={lastSeen ? [...cards, {
    id: 'stale-price', tone: 'amber', title: `Poslední známá cena ${lastSeen.price}`,
    text: `V ${new Date(lastSeen.at).toLocaleTimeString('cs-CZ')} · čekám na živou cenu.`,
  }] : cards} onAction={onCardAction} brake={brake} floating={floating} />;

  const waiting = rithmicPhoneWaiting({ url, instrumentIssue, hasMarket: marketData != null, link });
  const showingLiveChart = open && !waiting && !!market && !!trading.position && feedLive && !trading.authFailed;
  useEffect(() => {
    if (!showingLiveChart) return;
    // Mark when the chart view has mounted with live data; receipt on the socket can precede it.
    const frame = requestAnimationFrame(() => perfMarkOnce('rithmic:phone-chart-live'));
    return () => cancelAnimationFrame(frame);
  }, [showingLiveChart]);

  if (!open) return null;
  // Nespárováno, nebo služba toto zařízení odmítla (odvoláno): nabídnout spárování s Macem.
  if (!simulationUrl && rithmicPairingOffered() && (!url || trading.authFailed)) {
    return (
      <div data-rithmic-phone-pairing className={`grid gap-3 rounded-xl p-3 ${isDark ? 'bg-[#0b0f16]' : 'bg-slate-50'}`}>
        <RithmicPairingPanel isDark={isDark} notice={trading.authFailed ? `Mac toto zařízení odmítl: ${trading.authFailed}. Máš-li otevřenou pozici, zavři ji v platformě propky nebo na Macu.` : null} onChanged={refreshPairing} />
        <button type="button" onClick={onLeave} className={`mx-auto rounded-lg border px-3 py-2 text-[12px] font-bold opacity-80 ${isDark ? 'border-white/20 text-slate-300' : 'border-slate-300 text-slate-700'}`}>Zpět na Live Dashboard</button>
      </div>
    );
  }
  if (waiting || !market || !trading.position) {
    return (
      <div data-rithmic-phone-empty className={`rounded-xl border p-4 ${isDark ? 'border-white/10 bg-[#0b0f16] text-slate-300' : 'border-slate-200 bg-slate-50 text-slate-700'}`}>
        <div className="mb-2 flex flex-wrap items-center gap-2">{account}</div>
        <p className="py-6 text-center text-[14px]">{waiting ?? 'Čekám na data…'}</p>
        {status(false)}
        <button type="button" onClick={onLeave} className="mt-2 rounded-lg border border-current px-3 py-2 text-[12px] font-bold opacity-80">Zpět na Live Dashboard</button>
      </div>
    );
  }
  return (
    <>
      {phoneChart({
        // Stavové karty a brzda PLAVOU pod hlavičkou nad grafem (nulová výška v toku): když se karta objeví nebo zmizí
        // (výpadek spojení po návratu do appky), graf pod ní neposkočí.
        header: group => (
          <div ref={headerRef} data-rithmic-phone-header style={{ position: 'relative' }}>
            {header(accountBar ? { account, compact: true } : { group, account })}
            <div style={{ position: 'absolute', left: 0, right: 0, top: '100%', zIndex: 44, pointerEvents: 'none' }}>
              <div style={{ pointerEvents: 'auto' }}>{status(false)}</div>
            </div>
          </div>
        ),
        overlay: <>{overlay}{!headerShown && status(true)}</>,
        market,
        position: shownPosition,
        onLeave,
        // Účet jen pro čtení: žádný most příkazů — graf a účet jen k nahlédnutí.
        // Zařízení „jen zavírání": most zůstává (ochrana, zavření), ale nový vstup se nenabízí jako možný.
        trade: viewOnly || !trade ? null : deviceScope === 'close' ? { ...trade, blockedReason: trade.blockedReason ?? 'Toto zařízení smí jen zavřít pozici a přidat ochranu.' } : trade,
        copyEvents: trading.events,
        copierArmed: false,
        fills: trading.liveFills.fills,
        fillsPast: trading.liveFills.past,
        fillsOpen: trading.liveFills.open,
        fillsSymbol: trading.liveFills.symbol,
        // Příkazy zadané jinde: jen čáry pro zobrazení, nikdy do mostu příkazů.
        workingOrders: trading.workingView,
        userId: userId ?? null,
        alertWatch: alertWatch.watching,
        ...(limitLines ? { limitLines } : {}),
      })}
    </>
  );
};

export default RithmicPhoneChart;
