// Záložka Graf v LIVE napojená na místní proces Rithmicu (jen systém „Rithmic Test").
// Jeden účet mimo kopírku: příkazy jdou místnímu procesu, který je sám ověřuje (LocalExec).
// `copier`, `disarm` a navigace jsou SKUTEČNÉ ze desku — stav kopírky Tradovate, OFF a cesta na
// Dashboard zůstávají vidět i tady (INV-UI-02). Sdílený zámek příkazů desku se sem nepředává.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import LiveTradingScreenSlot from './LiveTradingScreenSlot';
import type { LiveTradingCopierState, LiveTradingTab } from './LiveTradingScreen';
import { RITHMIC_SOLO_ACCOUNT, useRithmicLocalTrading } from '../hooks/useRithmicLocalTrading';
import { useRithmicAlertWatch } from '../hooks/useRithmicAlertWatch';
import { rithmicLocalUrl } from '../lib/rithmicLocalLink';
import { cmeSessionCloseWarning } from '../lib/cmeSessionClose';
import type { TradeToast } from '../lib/liveTradeToasts';
import { rithmicAccountBarData, type LiveAccountBarData } from './LiveAccountBar';
import { buildLiveStatusStrip } from '../services/liveStatusStrip';

/** Obrazovka počítá riziko a velikost napevno pro MNQ — jiný kontrakt by dával špatná čísla. */
export function rithmicScreenInstrumentIssue(info: { symbol: string; tickSize: number | null; pointValue: number | null }): string | null {
  if (!info.symbol) return null;
  if (!/^MNQ[FGHJKMNQUVXZ]\d{1,2}$/.test(info.symbol)) return `Místní proces běží na kontraktu ${info.symbol}. Obrazovka umí jen MNQ — spusť ho s --contract MNQ….`;
  if (info.tickSize !== 0.25 || info.pointValue !== 2) return `Kontrakt ${info.symbol} hlásí jiný krok nebo hodnotu bodu, než obrazovka čeká (0,25 / 2 USD).`;
  return null;
}

interface Props {
  simulationUrl?: string;
  open: boolean;
  isDark: boolean;
  tabs: LiveTradingTab[];
  onNavigate: (tab: LiveTradingTab['id']) => void;
  navigationBlocked?: boolean;
  copier: LiveTradingCopierState;
  disarm: React.ComponentProps<typeof LiveTradingScreenSlot>['disarm'];
  onDisarm?: React.ComponentProps<typeof LiveTradingScreenSlot>['onDisarm'];
  onCrash: () => void;
  /** Výběr účtu / skupiny a P&L dne v horní liště (jen zobrazení, zatím jen lokální simulace). */
  accountBar?: LiveAccountBarData | null;
}

const card = (id: string, tone: TradeToast['tone'], badge: string, title: string, line: string): TradeToast => ({ id, at: Date.now(), tone, badge, title, line, pnl: null, accounts: 0, sticky: true, wrapLine: true });

const RithmicLiveChart: React.FC<Props> = ({ open, isDark, tabs, onNavigate, navigationBlocked, copier, disarm, onDisarm, onCrash, simulationUrl, accountBar: accountBarProp = null }) => {
  const url = useMemo(() => simulationUrl ?? rithmicLocalUrl(), [simulationUrl]);
  const trading = useRithmicLocalTrading({ url, enabled: open });
  // Upozornění na cenu hlídá služba jen na skutečném trhu (zkušební systém i simulace mají smyšlené ceny).
  const alertsReal = !simulationUrl && trading.system != null && trading.system !== 'Rithmic Test';
  const alertWatch = useRithmicAlertWatch(trading, alertsReal);
  // Lišta účtu: ze zkušební stránky mock účty, jinak skutečný účet služby (jeden, bez skupin; jen zobrazení).
  const realAccountBar = useMemo(() => rithmicAccountBarData({ accountName: trading.accountName, system: trading.system, closedPnl: trading.silent ? null : trading.accountClosedPnl }),
    [trading.accountName, trading.system, trading.accountClosedPnl, trading.silent]);
  const accountBar = accountBarProp ?? realAccountBar;
  const [replaying, setReplaying] = useState(false);
  const { link, state, symbol } = trading;
  const instrumentIssue = rithmicScreenInstrumentIssue({ symbol, tickSize: trading.tickSize, pointValue: trading.pointValue });
  const usable = trading.available && !instrumentIssue;
  const linkNote = link !== 'open' ? 'odpojeno' : !trading.helloFresh ? 'připojuji' : !state?.connected ? 'Rithmic odpojen' : trading.silent ? 'neodpovídá' : trading.readOnly ? 'jen čtení' : trading.closeOnly ? 'jen zavírání' : trading.liveAccount ? 'SKUTEČNÝ ÚČET' : null;
  const systemLabel = simulationUrl && !trading.liveAccount ? 'Lokální simulace · LOCAL-SIM' : [trading.system ?? 'Rithmic', trading.accountName].filter(Boolean).join(' · ');
  const limitsLabel = trading.limits && trading.helloFresh ? `Max. kontraktů · long ${trading.limits.buy} · short ${trading.limits.sell} · příkaz ${trading.limits.order}` : 'Čekám na limity účtu a produktu';
  const lastClose = state?.closes?.filter(item => item.symbol === symbol).at(-1);
  const lastCloseLabel = lastClose && trading.pointValue ? `Poslední zavření · ${new Date(lastClose.at).toLocaleString('cs-CZ')} · ${lastClose.quantity} ks · ${(lastClose.pointsTotal * trading.pointValue).toLocaleString('cs-CZ', { maximumFractionDigits: 2 })} USD před poplatky` : undefined;
  const soloBase = useMemo(() => ({ limitsLabel, quantityLimits: trading.limits ?? undefined, lastCloseLabel, label: `${systemLabel} · ${symbol}${linkNote ? ` · ${linkNote}` : ''}`, statusNote: linkNote, available: usable, singleLeg: true, legsRemovable: trading.legsRemovable, historyFromApp: trading.system !== null && trading.system !== 'Rithmic Test' }), [limitsLabel, trading.limits, lastCloseLabel, systemLabel, trading.system, symbol, usable, linkNote, trading.legsRemovable]);
  // Karta jen pro odmítnutí, které přišlo za tohoto spojení — starší z historie služby se neohlašují znovu.
  const rejectionBaseline = useRef<number | null>(null);
  if (!state) rejectionBaseline.current = null;
  else if (rejectionBaseline.current === null) rejectionBaseline.current = state.rejections.at(-1)?.at ?? 0;
  const lastRejection = state?.rejections.at(-1) ?? null;
  const rejection = lastRejection && rejectionBaseline.current !== null && lastRejection.at > rejectionBaseline.current ? lastRejection : null;
  const blocked = state?.blocked ?? null;
  const uncertainList = trading.uncertain;
  const uncertain = uncertainList.find(item => !item.confirmed) ?? uncertainList.at(-1) ?? null;
  // Výsledek „Potvrdit incident" se nezahazuje: neúspěch dostane vlastní kartu.
  const [ackNote, setAckNote] = useState<{ at: number; text: string } | null>(null);
  const [crashed, setCrashed] = useState(false);
  const crash = useCallback(() => { setCrashed(true); onCrash(); }, [onCrash]);
  const { ack, dismissUncertain } = trading;
  const confirmIncident = useCallback(async () => {
    const reply = await ack();
    setAckNote(reply.ok ? null : { at: Date.now(), text: reply.error ?? 'Potvrzení se nepovedlo.' });
  }, [ack]);
  // Brzda mimo zámek obrazovky: nejistý výsledek hlásí hook (seznam nejistých), neodeslání vlastní karta.
  const [closeBusy, setCloseBusy] = useState(false);
  const [closeNote, setCloseNote] = useState<{ at: number; text: string } | null>(null);
  const { closeNow } = trading;
  const closeRunning = useRef(false);
  const emergencyClose = useCallback(() => {
    if (closeRunning.current) return; // dvojklik před překreslením
    closeRunning.current = true;
    setCloseBusy(true);
    void closeNow().then(result => setCloseNote(result.status === 'blocked' ? { at: Date.now(), text: result.text ?? 'Neodesláno.' } : null)).finally(() => { closeRunning.current = false; setCloseBusy(false); });
  }, [closeNow]);
  const [reduceBusy, setReduceBusy] = useState(false);
  const [reduceNote, setReduceNote] = useState<{ at: number; text: string } | null>(null);
  const { reduceOne } = trading;
  const reduceRunning = useRef(false);
  const reducePart = useCallback(() => {
    if (reduceRunning.current) return; // dvojklik před překreslením
    reduceRunning.current = true;
    setReduceBusy(true);
    // Nejistý výsledek zapisuje spojení mezi nejisté příkazy; tady jen důvod, proč nic neodešlo.
    void reduceOne().then(result => setReduceNote(result.status === 'blocked' ? { at: Date.now(), text: result.text ?? 'Neodesláno.' } : null)).finally(() => { reduceRunning.current = false; setReduceBusy(false); });
  }, [reduceOne]);
  const downSince = useRef(0);
  const wasOpen = useRef(false);
  if (link === 'open') wasOpen.current = true;
  else if (wasOpen.current) { wasOpen.current = false; downSince.current = Date.now(); }
  // Konec burzovní seance: denní příkazy (i SL/TP) burza zruší. Upozornění s předstihem, jen když je co ztratit.
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const hasPosition = Boolean(trading.state?.positions.some(item => item.symbol === symbol));
  const hasPendingEntry = Boolean(trading.state?.orders.some(order => order.symbol === symbol && order.role === 'entry' && order.status === 'working'));
  const sessionWarning = link === 'open' ? cmeSessionCloseWarning(clock, { position: hasPosition, pendingEntry: hasPendingEntry }) : null;
  const extraToasts = useMemo<TradeToast[]>(() => [
    ...(sessionWarning ? [card('rithmic-session-close', 'amber', 'Pozor', 'Blíží se konec seance', sessionWarning)] : []),
    // Nejistý výsledek příkazu přežije výpadek spojení i odchod ze záložky (drží ho hook mimo komponentu).
    ...uncertainList.map(item => item.confirmed ? card(`rithmic-verified:${item.id}`, 'green', 'Rithmic', 'Broker potvrdil stav příkazu', item.reason) : card(`rithmic-uncertain:${item.id}`, 'amber', 'Pozor', `${item.label}: výsledek NEZNÁMÝ`, `${item.reason} — ověř pozici a příkazy u brokera, nic neopakuj.`)),
    ...(closeNote ? [card(`rithmic-close-now:${closeNote.at}`, 'red', 'Brzda', 'Zavření pozice neodešlo', closeNote.text)] : []),
    ...(reduceNote ? [card(`rithmic-reduce:${reduceNote.at}`, 'amber', 'Pozor', 'Částečné zavření neodešlo', reduceNote.text)] : []),
    // Výpadek hlásí karta jen krátce (po obnově by lhala); trvalý stav nese štítek účtu v hlavičce.
    ...(link !== 'open' ? [{ ...card(`rithmic-link-down:${downSince.current}`, 'red', 'Spojení', 'Místní proces Rithmicu je odpojený', 'Stav v grafu není znám. Příkazy nejdou, dokud se spojení neobnoví.'), sticky: false, ms: 8_000 }] : []),
    // Krátká karta (stav se mění s každým posunem; trvalá by ukazovala staré ceny).
    // Jen pro čtení: příkazy z jiné platformy graf neumí věrně ukázat (role jen odhaduje) → říct to nahlas.
    ...(trading.workingOrders > 0 ? [{ ...card(`rithmic-foreign:${trading.workingOrders}`, 'amber', 'Info', `Na účtu pracuje ${trading.workingOrders} ${trading.workingOrders === 1 ? 'příkaz zadaný' : 'příkazů zadaných'} jinde`, 'Graf je ukazuje tlumenou čarou jen pro zobrazení — z této appky je nejde posunout ani zrušit.'), sticky: false, ms: 10_000 }] : []),
    ...(trading.legsNote ? [{ ...card(`rithmic-legs:${trading.legsNote}`, 'amber', 'SL/TP', 'Části pozice mají ochranu na různých cenách', `${trading.legsNote}. Čára ukazuje tu bližší trhu; posunem srovnáš všechny.`), sticky: false, ms: 9_000 }] : []),
    ...(blocked ? [trading.readOnly
      ? card(`rithmic-blocked:${blocked}`, 'amber', 'Info', 'Služba hlásí stav účtu', `${blocked} Účet je připojený jen pro čtení — nic se neposílá.`)
      : card(`rithmic-blocked:${blocked}`, 'red', 'Stop', 'Nové vstupy stojí', `${blocked} Zkontroluj účet a potvrď tlačítkem „Potvrdit incident“.`)] : []),
    ...(ackNote ? [card(`rithmic-ack:${ackNote.at}`, 'red', 'Chyba', 'Incident se nepotvrdil', ackNote.text)] : []),
    ...(rejection ? [card(`rithmic-rejected:${rejection.at}`, 'amber', 'Odmít.', 'Rithmic příkaz odmítl', rejection.reason)] : []),
  ], [sessionWarning, uncertainList, closeNote, reduceNote, link, blocked, ackNote, rejection?.at, rejection?.reason, trading.legsNote, trading.readOnly, trading.workingOrders]); // eslint-disable-line react-hooks/exhaustive-deps

  // Brzda se nabízí při otevřeném spojení s procesem — i když ceny stojí nebo proces chvíli mlčí — a vždy,
  // když je co zavírat NEBO se to neví (visící vstup, neznámý stav, nejistý příkaz). Při flat služba vrátí „bez pozice".
  // S výběrem účtu v liště (21. 11., Filip): v klidu se brzda neukazuje — pozice se zavírá × v grafu nebo Shift+X.
  // Sama se vrátí, když běžná cesta nemusí fungovat: nejistý příkaz, neznámý stav / visící vstup bez pozice,
  // služba mlčí nebo nejsou čerstvá data, stop nových vstupů.
  // Pozice bez známé ceny SL: × v grafu ji nezavře („cena SL/TP není známá — nic se neodeslalo“), brzda tedy zůstává.
  // Nechráněná = bez SL, nebo SL kryje jen část pozice (části smí mít různou ochranu nebo žádnou).
  const unprotected = hasPosition && (trading.position?.summary?.kind !== 'position' || trading.position.summary.stop == null
    || (trading.legCoverage != null && trading.legCoverageTotal.stopLoss < trading.position.summary.quantity));
  // Také když × a Shift+X zrovna nejdou: rozběhnutý příkaz (čekají na výsledek), přehrávání grafu, Rithmic odpojený.
  const brakeNeeded = uncertainList.length > 0 || (trading.mayHaveExposure && !hasPosition) || unprotected || trading.commandInFlight || replaying || !trading.available
    || Boolean(blocked) || trading.silent || !trading.helloFresh;
  const offerBrake = (trading.mayHaveExposure || uncertainList.length > 0) && (!accountBar || brakeNeeded);
  const solo = useMemo(() => ({ ...soloBase, alerts: alertsReal, extraOrders: trading.extraOrders, legCoverage: trading.legCoverage, ...(trading.readOnly ? {} : { manageOrder: trading.onManageOrder }), ...(link === 'open' && offerBrake && !trading.readOnly ? { emergencyClose: { run: emergencyClose, busy: closeBusy } } : {}),
    ...(usable && trading.reducible ? { reduce: { run: reducePart, busy: reduceBusy, quantity: trading.reducible.quantity } } : {}) }), [soloBase, alertsReal, link, offerBrake, emergencyClose, closeBusy, usable, trading.reducible, reducePart, reduceBusy, trading.extraOrders, trading.onManageOrder, trading.readOnly, trading.legCoverage]);

  // Skutečný incident kopírky musí být vidět i v prázdném stavu (INV-UI-02 duchem).
  const strip = buildLiveStatusStrip({ status: copier.status, available: copier.available, pending: copier.pending, transport: copier.transport, journalHealth: copier.journalHealth });

  // Prázdný stav jen dokud graf nemá co kreslit; pozdější výpadek obrazovku NEodmontuje (karta + štítek).
  const waiting = !url ? 'Chybí přístupový token místního procesu.'
    : instrumentIssue ?? (trading.marketData ? null
      : link !== 'open' ? 'Místní proces Rithmicu není dostupný — běží scripts/rithmic/devTradeServer.ts?' : 'Čekám na první cenu z Rithmicu…');

  if (!open) return null;
  if (waiting || !trading.marketData) {
    // Záložky zůstávají, aby šlo vždy zpět na Dashboard; vrstva nezakrývá nouzovou lištu.
    return createPortal(
      <div className={`fixed inset-x-0 top-0 z-[300] flex flex-col ${isDark ? 'bg-[#0b0f16] text-slate-300' : 'bg-slate-50 text-slate-700'}`} style={{ bottom: 'var(--live-safety-height, 0px)' }} data-rithmic-empty>
        <nav className="flex h-11 shrink-0 items-center gap-1 border-b border-white/10 px-3" aria-label="LIVE navigace">
          {tabs.map(item => <button key={item.id} type="button" onClick={() => onNavigate(item.id)} className={`rounded-lg px-3 py-1.5 text-[12px] font-bold ${item.id === 'chart' ? 'text-indigo-400' : ''}`}>{item.label}</button>)}
          <span className="flex-1" />
          {strip.notice && <button type="button" onClick={() => onNavigate('overview')} title={strip.notice} className="flex h-[30px] items-center whitespace-nowrap rounded-lg border border-rose-500/60 bg-rose-500/10 px-2.5 text-[11px] font-extrabold text-rose-500">Incident kopírky →</button>}
          {uncertain && <button type="button" disabled={!trading.helloFresh || link !== 'open'} onClick={dismissUncertain} title="Zavřít varování" className="flex h-[30px] items-center whitespace-nowrap rounded-lg border border-amber-500/60 bg-amber-500/10 px-2.5 text-[11px] font-extrabold text-amber-500">{uncertain.confirmed ? 'Zavřít potvrzení' : `${uncertain.label} · výsledek neznámý — ověř u brokera`} ×</button>}
        </nav>
        <div className="grid flex-1 place-items-center px-6 text-center text-[14px]">{waiting ?? 'Čekám na data…'}</div>
      </div>,
      document.body,
    );
  }
  return (
    <>
      <LiveTradingScreenSlot
        open onCrash={crash} isDark={isDark} tabs={tabs} onNavigate={onNavigate} navigationBlocked={navigationBlocked}
        copier={copier} disarm={disarm} {...(onDisarm ? { onDisarm } : {})} group={null}
        position={trading.position} marketData={trading.marketData} solo={solo} copyEvents={trading.events} extraToasts={extraToasts}
        onPlaceEntry={trading.onPlaceEntry} onManageEntry={trading.onManageEntry}
        {...(trading.bareLegTrade && !trading.readOnly ? { bareLegTrade: trading.bareLegTrade, onBareLeg: trading.onBareLeg } : {})}
        manageEntryAvgPrice={trading.averagePrice} manageCloseSupported entryMarketSupported
        entryBareSupported entryBarePendingSupported manageMoveLimitSupported manageMoveBareEntrySupported managePendingLegsSupported
        entryScaleIn={trading.scaleIn}
        entryMaxContracts={trading.maxContracts} entryFrontContract={symbol} manageLeaderAccountId={RITHMIC_SOLO_ACCOUNT} workingOrders={trading.workingView} liveFills={trading.liveFills}
        entryBlockedReason={blocked ? `Nové vstupy stojí: ${blocked}` : trading.entryBlockedReason}
        accountBar={accountBar} onReplayChange={setReplaying} alertWatch={alertWatch.watching}
      />
      {/* Nejistý příkaz: karta se vrací, dokud uživatel nepotvrdí, že stav u brokera ověřil. */}
      {uncertain && !crashed && createPortal(<button type="button" data-rithmic-verified disabled={!trading.helloFresh || link !== 'open'} onClick={dismissUncertain} title={uncertainList.map(item => `${item.label} · ${item.reason}`).join('; ')}
        className={`fixed left-[76px] z-[310] rounded-lg border border-amber-500/60 bg-amber-500/15 px-3 py-1.5 text-[12px] font-extrabold text-amber-500 hover:bg-amber-500/25 ${blocked ? 'bottom-14' : 'bottom-4'}`}>{uncertain?.confirmed ? 'Zavřít potvrzení' : 'Stav u brokera ověřen'}</button>, document.body)}
      {/* Pod nouzovou lištou a jejími dialogy (z-350/600); po pádu grafu se nekreslí. */}
      {blocked && !crashed && !trading.readOnly && createPortal(<button type="button" data-rithmic-ack onClick={() => void confirmIncident()}
        className="fixed bottom-4 left-[76px] z-[310] rounded-lg border border-rose-500/60 bg-rose-500/15 px-3 py-1.5 text-[12px] font-extrabold text-rose-400 hover:bg-rose-500/25">Potvrdit incident</button>, document.body)}
    </>
  );
};

export default RithmicLiveChart;
