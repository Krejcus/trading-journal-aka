// Záložka Graf v LIVE napojená na místní proces Rithmicu (jen systém „Rithmic Test").
// Jeden účet mimo kopírku: příkazy jdou místnímu procesu, který je sám ověřuje (LocalExec).
// `copier`, `disarm` a navigace jsou SKUTEČNÉ ze desku — stav kopírky Tradovate, OFF a cesta na
// Dashboard zůstávají vidět i tady (INV-UI-02). Sdílený zámek příkazů desku se sem nepředává.
import React, { useCallback, useMemo, useState } from 'react';
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
  const linkNote = link !== 'open' ? 'odpojeno' : !state?.connected ? 'Rithmic odpojen' : trading.silent ? 'neodpovídá' : null;
  const solo = useMemo(() => ({ label: `${trading.system ?? 'Rithmic'} · ${symbol}${linkNote ? ` · ${linkNote}` : ''}`, available: usable }), [trading.system, symbol, usable, linkNote]);
  const rejection = state?.rejections.at(-1) ?? null;
  const blocked = state?.blocked ?? null;
  const uncertain = trading.uncertain;
  // Výsledek „Potvrdit incident" se nezahazuje: neúspěch dostane vlastní kartu.
  const [ackNote, setAckNote] = useState<{ at: number; text: string } | null>(null);
  const [crashed, setCrashed] = useState(false);
  const crash = useCallback(() => { setCrashed(true); onCrash(); }, [onCrash]);
  const { ack, dismissUncertain } = trading;
  const confirmIncident = useCallback(async () => {
    const reply = await ack();
    setAckNote(reply.ok ? null : { at: Date.now(), text: reply.error ?? 'Potvrzení se nepovedlo.' });
  }, [ack]);
  const extraToasts = useMemo<TradeToast[]>(() => [
    // Nejistý výsledek příkazu přežije výpadek spojení i odchod ze záložky (drží ho hook mimo komponentu).
    ...(uncertain ? [card(`rithmic-uncertain:${uncertain.id}`, 'amber', 'Pozor', `${uncertain.label}: výsledek NEZNÁMÝ`, `${uncertain.reason} — ověř pozici a příkazy u brokera, nic neopakuj.`)] : []),
    ...(link !== 'open' ? [card('rithmic-link-down', 'red', 'Spojení', 'Místní proces Rithmicu je odpojený', 'Stav v grafu není znám. Příkazy nejdou, dokud se spojení neobnoví.')] : []),
    ...(blocked ? [card(`rithmic-blocked:${blocked}`, 'red', 'Stop', 'Nové vstupy stojí', `${blocked} Zkontroluj účet a potvrď tlačítkem „Potvrdit incident“.`)] : []),
    ...(ackNote ? [card(`rithmic-ack:${ackNote.at}`, 'red', 'Chyba', 'Incident se nepotvrdil', ackNote.text)] : []),
    ...(rejection ? [card(`rithmic-rejected:${rejection.at}`, 'amber', 'Odmít.', 'Rithmic příkaz odmítl', rejection.reason)] : []),
  ], [uncertain, link, blocked, ackNote, rejection?.at, rejection?.reason]); // eslint-disable-line react-hooks/exhaustive-deps

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
        manageEntryAvgPrice={trading.averagePrice} manageCloseSupported entryMarketSupported
        entryMaxContracts={2} entryFrontContract={symbol} manageLeaderAccountId={RITHMIC_SOLO_ACCOUNT} workingOrders={null}
        entryBlockedReason={blocked ? `Nové vstupy stojí: ${blocked}` : trading.entryBlockedReason}
      />
      {/* Nejistý příkaz: karta se vrací, dokud uživatel nepotvrdí, že stav u brokera ověřil. */}
      {uncertain && !crashed && createPortal(<button type="button" data-rithmic-verified onClick={dismissUncertain} title={`${uncertain.label}: výsledek neznámý — ${uncertain.reason}`}
        className={`fixed left-[76px] z-[310] rounded-lg border border-amber-500/60 bg-amber-500/15 px-3 py-1.5 text-[12px] font-extrabold text-amber-500 hover:bg-amber-500/25 ${blocked ? 'bottom-14' : 'bottom-4'}`}>Stav u brokera ověřen</button>, document.body)}
      {/* Pod nouzovou lištou a jejími dialogy (z-350/600); po pádu grafu se nekreslí. */}
      {blocked && !crashed && createPortal(<button type="button" data-rithmic-ack onClick={() => void confirmIncident()}
        className="fixed bottom-4 left-[76px] z-[310] rounded-lg border border-rose-500/60 bg-rose-500/15 px-3 py-1.5 text-[12px] font-extrabold text-rose-400 hover:bg-rose-500/25">Potvrdit incident</button>, document.body)}
    </>
  );
};

export default RithmicLiveChart;
