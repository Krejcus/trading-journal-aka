// Záložka Graf v LIVE napojená na místní proces Rithmicu (jen systém „Rithmic Test").
// Jeden účet mimo kopírku: příkazy jdou místnímu procesu, který je sám ověřuje (LocalExec).
// `copier`, `disarm` a navigace jsou SKUTEČNÉ ze desku — stav kopírky Tradovate, OFF a cesta na
// Dashboard zůstávají vidět i tady (INV-UI-02). Sdílený zámek příkazů desku se sem nepředává.
import React, { useMemo } from 'react';
import LiveTradingScreenSlot from './LiveTradingScreenSlot';
import type { LiveTradingCopierState, LiveTradingTab } from './LiveTradingScreen';
import { RITHMIC_SOLO_ACCOUNT, useRithmicLocalTrading } from '../hooks/useRithmicLocalTrading';
import { rithmicLocalUrl } from '../lib/rithmicLocalLink';
import type { TradeToast } from '../lib/liveTradeToasts';

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

const card = (id: string, tone: TradeToast['tone'], badge: string, title: string, line: string): TradeToast => ({ id, at: 0, tone, badge, title, line, pnl: null, accounts: 0, sticky: true, wrapLine: true });

const RithmicLiveChart: React.FC<Props> = ({ open, isDark, tabs, onNavigate, navigationBlocked, copier, disarm, onDisarm, onCrash }) => {
  const url = useMemo(rithmicLocalUrl, []);
  const trading = useRithmicLocalTrading({ url, enabled: open });
  const { link, state, symbol } = trading;
  const instrumentIssue = rithmicScreenInstrumentIssue({ symbol, tickSize: trading.tickSize, pointValue: trading.pointValue });
  const solo = useMemo(() => ({ label: `${trading.system ?? 'Rithmic'} · ${symbol}`, available: trading.available && !instrumentIssue }), [trading.system, symbol, trading.available, instrumentIssue]);
  const rejection = state?.rejections.at(-1) ?? null;
  const blocked = state?.blocked ?? null;
  const extraToasts = useMemo<TradeToast[]>(() => [
    ...(blocked ? [card(`rithmic-blocked:${blocked}`, 'red', 'Stop', 'Nové vstupy stojí', `${blocked} Zkontroluj účet a potvrď tlačítkem „Potvrdit incident“.`)] : []),
    ...(rejection ? [card(`rithmic-rejected:${rejection.at}`, 'amber', 'Odmít.', 'Rithmic příkaz odmítl', rejection.reason)] : []),
  ], [blocked, rejection?.at, rejection?.reason]); // eslint-disable-line react-hooks/exhaustive-deps

  const waiting = !url ? 'Chybí přístupový token místního procesu.'
    : instrumentIssue ?? (link !== 'open' ? 'Místní proces Rithmicu není dostupný — běží scripts/rithmic/devTradeServer.ts?'
      : !trading.marketData ? 'Čekám na první cenu z Rithmicu…' : null);

  if (!open) return null;
  if (waiting || !trading.marketData) {
    // Prázdný stav: záložky zůstávají, aby šlo vždy zpět na Dashboard; nezakrývá nouzovou lištu.
    return (
      <div className={`fixed inset-x-0 top-0 z-[300] flex flex-col ${isDark ? 'bg-[#0b0f16] text-slate-300' : 'bg-slate-50 text-slate-700'}`} style={{ bottom: 'var(--live-safety-height, 0px)' }} data-rithmic-empty>
        <nav className="flex h-11 shrink-0 items-center gap-1 border-b border-white/10 px-3" aria-label="LIVE navigace">
          {tabs.map(item => <button key={item.id} type="button" onClick={() => onNavigate(item.id)} className={`rounded-lg px-3 py-1.5 text-[12px] font-bold ${item.id === 'chart' ? 'text-indigo-400' : ''}`}>{item.label}</button>)}
        </nav>
        <div className="grid flex-1 place-items-center px-6 text-center text-[14px]">{waiting ?? 'Čekám na data…'}</div>
      </div>
    );
  }
  return (
    <>
      <LiveTradingScreenSlot
        open onCrash={onCrash} isDark={isDark} tabs={tabs} onNavigate={onNavigate} navigationBlocked={navigationBlocked}
        copier={copier} disarm={disarm} {...(onDisarm ? { onDisarm } : {})} group={null}
        position={trading.position} marketData={trading.marketData} solo={solo} copyEvents={trading.events} extraToasts={extraToasts}
        onPlaceEntry={trading.onPlaceEntry} onManageEntry={trading.onManageEntry}
        manageEntryAvgPrice={trading.averagePrice} manageCloseSupported entryMarketSupported
        entryMaxContracts={2} entryFrontContract={symbol} manageLeaderAccountId={RITHMIC_SOLO_ACCOUNT} workingOrders={null}
        entryBlockedReason={blocked ? `Nové vstupy stojí: ${blocked}` : trading.entryBlockedReason}
      />
      {blocked && <button type="button" data-rithmic-ack onClick={() => void trading.ack()}
        className="fixed bottom-4 left-[76px] z-[900] rounded-lg border border-rose-500/60 bg-rose-500/15 px-3 py-1.5 text-[12px] font-extrabold text-rose-400 hover:bg-rose-500/25">Potvrdit incident</button>}
    </>
  );
};

export default RithmicLiveChart;
