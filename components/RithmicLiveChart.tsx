// Záložka Graf v LIVE napojená na místní proces Rithmicu (jen systém „Rithmic Test").
// Jeden účet mimo kopírku: příkazy jdou místnímu procesu, který je sám ověřuje (LocalExec).
// `copier`, `disarm` a navigace jsou SKUTEČNÉ ze desku — stav kopírky Tradovate, OFF a cesta na
// Dashboard zůstávají vidět i tady (INV-UI-02). Sdílený zámek příkazů desku se sem nepředává.
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import LiveTradingScreenSlot from './LiveTradingScreenSlot';
import type { LiveTradingCopierState, LiveTradingTab } from './LiveTradingScreen';
import { RITHMIC_SOLO_ACCOUNT, useRithmicLocalTrading } from '../hooks/useRithmicLocalTrading';
import { rithmicLocalUrl } from '../lib/rithmicLocalLink';
import type { TradeToast } from '../lib/liveTradeToasts';
import { buildLiveStatusStrip } from '../services/liveStatusStrip';

/** Obrazovka počítá riziko a velikost napevno pro MNQ — jiný kontrakt by dával špatná čísla. */
export function rithmicScreenInstrumentIssue(info: { symbol: string; tickSize: number | null; pointValue: number | null }): string | null {
  if (!info.symbol) return null;
  if (!/^MNQ[FGHJKMNQUVXZ]\d{1,2}$/.test(info.symbol)) return `Místní proces běží na kontraktu ${info.symbol}. Obrazovka umí jen MNQ — spusť ho s --contract MNQ….`;
  if (info.tickSize !== 0.25 || info.pointValue !== 2) return `Kontrakt ${info.symbol} hlásí jiný krok nebo hodnotu bodu, než obrazovka čeká (0,25 / 2 USD).`;
  return null;
}

interface Props {
  open: boolean;
  isDark: boolean;
  tabs: LiveTradingTab[];
  onNavigate: (tab: LiveTradingTab['id']) => void;
  navigationBlocked?: boolean;
  copier: LiveTradingCopierState;
  disarm: React.ComponentProps<typeof LiveTradingScreenSlot>['disarm'];
  onDisarm?: React.ComponentProps<typeof LiveTradingScreenSlot>['onDisarm'];
  onCrash: () => void;
}

const card = (id: string, tone: TradeToast['tone'], badge: string, title: string, line: string): TradeToast => ({ id, at: Date.now(), tone, badge, title, line, pnl: null, accounts: 0, sticky: true, wrapLine: true });

const RithmicLiveChart: React.FC<Props> = ({ open, isDark, tabs, onNavigate, navigationBlocked, copier, disarm, onDisarm, onCrash }) => {
  const url = useMemo(rithmicLocalUrl, []);
  const trading = useRithmicLocalTrading({ url, enabled: open });
  const { link, state, symbol } = trading;
  const instrumentIssue = rithmicScreenInstrumentIssue({ symbol, tickSize: trading.tickSize, pointValue: trading.pointValue });
  const usable = trading.available && !instrumentIssue;
  const linkNote = link !== 'open' ? 'odpojeno' : !trading.helloFresh ? 'připojuji' : !state?.connected ? 'Rithmic odpojen' : trading.silent ? 'neodpovídá' : trading.readOnly ? 'jen čtení' : null;
  const soloBase = useMemo(() => ({ label: `${trading.system ?? 'Rithmic'} · ${symbol}${linkNote ? ` · ${linkNote}` : ''}`, available: usable, singleLeg: true, historyFromApp: trading.system !== null && trading.system !== 'Rithmic Test' }), [trading.system, symbol, usable, linkNote]);
  // Karta jen pro odmítnutí, které přišlo za tohoto spojení — starší z historie služby se neohlašují znovu.
  const rejectionBaseline = useRef<number | null>(null);
  if (!state) rejectionBaseline.current = null;
  else if (rejectionBaseline.current === null) rejectionBaseline.current = state.rejections.at(-1)?.at ?? 0;
  const lastRejection = state?.rejections.at(-1) ?? null;
  const rejection = lastRejection && rejectionBaseline.current !== null && lastRejection.at > rejectionBaseline.current ? lastRejection : null;
  const blocked = state?.blocked ?? null;
  const uncertainList = trading.uncertain;
  const uncertain = uncertainList.at(-1) ?? null;
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
  const downSince = useRef(0);
  const wasOpen = useRef(false);
  if (link === 'open') wasOpen.current = true;
  else if (wasOpen.current) { wasOpen.current = false; downSince.current = Date.now(); }
  const extraToasts = useMemo<TradeToast[]>(() => [
    // Nejistý výsledek příkazu přežije výpadek spojení i odchod ze záložky (drží ho hook mimo komponentu).
    ...uncertainList.map(item => card(`rithmic-uncertain:${item.id}`, 'amber', 'Pozor', `${item.label}: výsledek NEZNÁMÝ`, `${item.reason} — ověř pozici a příkazy u brokera, nic neopakuj.`)),
    ...(closeNote ? [card(`rithmic-close-now:${closeNote.at}`, 'red', 'Brzda', 'Zavření pozice neodešlo', closeNote.text)] : []),
    // Výpadek hlásí karta jen krátce (po obnově by lhala); trvalý stav nese štítek účtu v hlavičce.
    ...(link !== 'open' ? [{ ...card(`rithmic-link-down:${downSince.current}`, 'red', 'Spojení', 'Místní proces Rithmicu je odpojený', 'Stav v grafu není znám. Příkazy nejdou, dokud se spojení neobnoví.'), sticky: false, ms: 8_000 }] : []),
    // Krátká karta (stav se mění s každým posunem; trvalá by ukazovala staré ceny).
    // Jen pro čtení: příkazy z jiné platformy graf neumí věrně ukázat (role jen odhaduje) → říct to nahlas.
    ...(trading.readOnly && trading.workingOrders > 0 ? [{ ...card(`rithmic-foreign:${trading.workingOrders}`, 'amber', 'Info', `Na účtu pracuje ${trading.workingOrders} příkazů`, 'Zadané jinde než v této appce — čáry v grafu je nemusí ukazovat správně (SL/TP se mohou jevit jako vstup, nebo chybět).'), sticky: false, ms: 12_000 }] : []),
    ...(trading.legsNote ? [{ ...card(`rithmic-legs:${trading.legsNote}`, 'amber', 'SL/TP', 'Dvě ochrany na různých cenách', `${trading.legsNote}. Čára ukazuje tu bližší trhu; posunem srovnáš obě.`), sticky: false, ms: 9_000 }] : []),
    ...(blocked ? [trading.readOnly
      ? card(`rithmic-blocked:${blocked}`, 'amber', 'Info', 'Služba hlásí stav účtu', `${blocked} Účet je připojený jen pro čtení — nic se neposílá.`)
      : card(`rithmic-blocked:${blocked}`, 'red', 'Stop', 'Nové vstupy stojí', `${blocked} Zkontroluj účet a potvrď tlačítkem „Potvrdit incident“.`)] : []),
    ...(ackNote ? [card(`rithmic-ack:${ackNote.at}`, 'red', 'Chyba', 'Incident se nepotvrdil', ackNote.text)] : []),
    ...(rejection ? [card(`rithmic-rejected:${rejection.at}`, 'amber', 'Odmít.', 'Rithmic příkaz odmítl', rejection.reason)] : []),
  ], [uncertainList, closeNote, link, blocked, ackNote, rejection?.at, rejection?.reason, trading.legsNote, trading.readOnly, trading.workingOrders]); // eslint-disable-line react-hooks/exhaustive-deps

  // Brzda se nabízí při otevřeném spojení s procesem — i když ceny stojí nebo proces chvíli mlčí — a vždy,
  // když je co zavírat NEBO se to neví (visící vstup, neznámý stav, nejistý příkaz). Při flat služba vrátí „bez pozice".
  const offerBrake = trading.mayHaveExposure || uncertainList.length > 0;
  const solo = useMemo(() => ({ ...soloBase, ...(link === 'open' && offerBrake && !trading.readOnly ? { emergencyClose: { run: emergencyClose, busy: closeBusy } } : {}) }), [soloBase, link, offerBrake, emergencyClose, closeBusy]);

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
          {uncertain && <button type="button" onClick={dismissUncertain} title="Zavřít varování" className="flex h-[30px] items-center whitespace-nowrap rounded-lg border border-amber-500/60 bg-amber-500/10 px-2.5 text-[11px] font-extrabold text-amber-500">{uncertain.label}: výsledek NEZNÁMÝ — ověř u brokera ×</button>}
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
        entryBareSupported entryBarePendingSupported manageMoveLimitSupported manageMoveBareEntrySupported
        entryScaleIn={trading.scaleIn}
        entryMaxContracts={2} entryFrontContract={symbol} manageLeaderAccountId={RITHMIC_SOLO_ACCOUNT} workingOrders={null}
        entryBlockedReason={blocked ? `Nové vstupy stojí: ${blocked}` : trading.entryBlockedReason}
      />
      {/* Nejistý příkaz: karta se vrací, dokud uživatel nepotvrdí, že stav u brokera ověřil. */}
      {uncertain && !crashed && createPortal(<button type="button" data-rithmic-verified onClick={dismissUncertain} title={uncertainList.map(item => `${item.label}: výsledek neznámý — ${item.reason}`).join('; ')}
        className={`fixed left-[76px] z-[310] rounded-lg border border-amber-500/60 bg-amber-500/15 px-3 py-1.5 text-[12px] font-extrabold text-amber-500 hover:bg-amber-500/25 ${blocked ? 'bottom-14' : 'bottom-4'}`}>Stav u brokera ověřen</button>, document.body)}
      {/* Pod nouzovou lištou a jejími dialogy (z-350/600); po pádu grafu se nekreslí. */}
      {blocked && !crashed && !trading.readOnly && createPortal(<button type="button" data-rithmic-ack onClick={() => void confirmIncident()}
        className="fixed bottom-4 left-[76px] z-[310] rounded-lg border border-rose-500/60 bg-rose-500/15 px-3 py-1.5 text-[12px] font-extrabold text-rose-400 hover:bg-rose-500/25">Potvrdit incident</button>, document.body)}
    </>
  );
};

export default RithmicLiveChart;
