// LIVE → Graf na telefonu napojený na místní službu Rithmicu (jeden účet mimo kopírku).
// Kreslí STÁVAJÍCÍ telefonní graf (`LivePhoneChart` přes slot desku), jen mu místo deníku dne a IBKR
// dodá svíčky, cenu, pozici a most příkazů ze služby. Obrazovka nic neautorizuje: každý příkaz ověřuje
// služba (LocalExec). Nouzová lišta kopírky sem nepatří — jen „Zavřít pozici" a karty stavů.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LiveDeskPhoneChartSlots } from './TradovateLiveDesk';
import { rithmicScreenInstrumentIssue } from './RithmicLiveChart';
import { RITHMIC_SOLO_ACCOUNT, useRithmicLocalTrading } from '../hooks/useRithmicLocalTrading';
import { useLiveTicketQuote } from '../hooks/useLiveTicketQuote';
import { rithmicLocalAuth, rithmicLocalUrl, rithmicPairingOffered } from '../lib/rithmicLocalLink';
import RithmicPairingPanel from './RithmicPairingPanel';
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
  header: (parts: { group?: React.ReactNode; account: React.ReactNode }) => React.ReactNode;
  /** Vrstvy desku nad grafem (menu záložek). */
  overlay?: React.ReactNode;
  /** Jen klíč knihovny šablon SL/TP na zařízení (nic neautorizuje). */
  userId?: string | null;
  /** Zkušební stránka: adresa simulace místo skutečné místní služby. */
  simulationUrl?: string;
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
          pointerEvents: 'auto', justifySelf: 'start', minHeight: 36, padding: '0 14px', borderRadius: 10, fontSize: 13, fontWeight: 800, cursor: 'pointer',
          border: '1px solid #e11d48', color: brake.armed ? '#fff' : '#fb7185', background: brake.armed ? '#e11d48' : 'rgba(244,63,94,.12)', opacity: brake.busy ? 0.6 : 1,
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

const RithmicPhoneChart: React.FC<Props> = ({ open, isDark, onLeave, phoneChart, header, overlay, userId, simulationUrl }) => {
  // Spárování se čte znovu po každé změně (nové spárování, zrušení) — jinak by obrazovka držela starou adresu.
  const [linkVersion, setLinkVersion] = useState(0);
  const url = useMemo(() => simulationUrl ?? rithmicLocalUrl(), [simulationUrl, linkVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  // Spárované zařízení (telefon) se službě prokazuje klíčem z Klíčenky; PC a simulace klíč zařízení nemají.
  const deviceAuth = useMemo(() => (simulationUrl ? null : rithmicLocalAuth()), [simulationUrl, linkVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  const trading = useRithmicLocalTrading({ url, enabled: open, auth: deviceAuth });
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

  const cards = useMemo(() => rithmicPhoneCards({
    link, helloFresh: trading.helloFresh, rithmicConnected: Boolean(state?.connected), silent: trading.silent, readOnly: trading.readOnly, blocked,
    uncertain: trading.uncertain, closeNote, ackNote, rejection: rejection ? { at: rejection.at, reason: rejection.reason } : null, sessionWarning, foreignOrders: trading.workingOrders,
  }), [link, trading.helloFresh, state?.connected, trading.silent, trading.readOnly, blocked, trading.uncertain, closeNote, ackNote, rejection?.at, rejection?.reason, sessionWarning, trading.workingOrders]); // eslint-disable-line react-hooks/exhaustive-deps
  const onCardAction = useCallback((card: RithmicPhoneCard) => {
    if (card.action?.kind === 'ack') void confirmIncident();
    else if (card.action?.kind === 'verified') dismissUncertain();
    else if (card.id.startsWith('ack:')) setAckNote(null);
    else if (card.id.startsWith('close:')) setCloseNote(null);
  }, [confirmIncident, dismissUncertain]);

  // Brzda se nabízí při otevřeném spojení se službou — i při incidentu, stojící ceně nebo mlčící službě — a vždy,
  // když je co zavírat NEBO se to neví (visící vstup, neznámý stav, nejistý příkaz). Účet jen pro čtení ji nemá.
  const offerBrake = link === 'open' && !trading.readOnly && (trading.mayHaveExposure || trading.uncertain.length > 0);
  const brake = useMemo(() => (offerBrake ? { armed: closeArmedAt != null, busy: closeBusy, onTap: tapClose } : null), [offerBrake, closeArmedAt, closeBusy, tapClose]);

  // Most příkazů: účet jen pro čtení ho nemá (graf jen zobrazuje). „Zavřít" z lišty grafu = stejná brzda služby.
  const trade = useMemo(() => rithmicPhoneBridge({
    readOnly: trading.readOnly, blocked, entryBlockedReason: trading.entryBlockedReason, maxContracts: trading.maxContracts, symbol,
    averagePrice: trading.averagePrice, scaleIn: trading.scaleIn, position: trading.position, bareLegTrade: trading.bareLegTrade, soloAccountId: RITHMIC_SOLO_ACCOUNT,
    onPlaceEntry: trading.onPlaceEntry, onManageEntry: trading.onManageEntry, onBareLeg: trading.onBareLeg, closeNow: runClose,
  }), [trading.readOnly, blocked, trading.entryBlockedReason, trading.maxContracts, symbol, trading.averagePrice, trading.scaleIn, trading.position, trading.bareLegTrade, trading.onPlaceEntry, trading.onManageEntry, trading.onBareLeg, runClose]);

  const mode = rithmicPhoneModeLabel({ system: trading.system, readOnly: trading.readOnly, closeOnly: trading.closeOnly === true, liveAccount: trading.liveAccount, simulation: Boolean(simulationUrl) });
  const account = (
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
  const status = (floating: boolean) => <RithmicPhoneStatus cards={cards} onAction={onCardAction} brake={brake} floating={floating} />;

  if (!open) return null;
  // Prázdný stav jen dokud graf nemá co kreslit; pozdější výpadek graf NEodmontuje (karta + štítek).
  const waiting = rithmicPhoneWaiting({ url, instrumentIssue, hasMarket: marketData != null, link });
  // Nespárováno, nebo služba toto zařízení odmítla (odvoláno): nabídnout spárování s Macem.
  if (!simulationUrl && rithmicPairingOffered() && (!url || trading.authFailed)) {
    return (
      <div data-rithmic-phone-pairing className={`grid gap-3 rounded-xl p-3 ${isDark ? 'bg-[#0b0f16]' : 'bg-slate-50'}`}>
        <RithmicPairingPanel isDark={isDark} notice={trading.authFailed ? `Mac toto zařízení odmítl: ${trading.authFailed}` : null} onChanged={() => setLinkVersion((version) => version + 1)} />
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
        header: group => <div ref={headerRef} data-rithmic-phone-header>{header({ group, account })}{status(false)}</div>,
        overlay: <>{overlay}{!headerShown && status(true)}</>,
        market,
        position: trading.position,
        onLeave,
        // Účet jen pro čtení: žádný most příkazů — graf a účet jen k nahlédnutí.
        trade: trading.readOnly ? null : trade,
        copyEvents: trading.events,
        copierArmed: false,
        fills: trading.liveFills.fills,
        fillsOpen: trading.liveFills.open,
        fillsSymbol: trading.liveFills.symbol,
        // Příkazy zadané jinde: jen čáry pro zobrazení, nikdy do mostu příkazů.
        workingOrders: trading.workingView,
        userId: userId ?? null,
      })}
    </>
  );
};

export default RithmicPhoneChart;
