// LIVE jen přes Rithmic (od 23. 11. 2026, Tradovate odstraněn). Desk drží záložky Graf a Kopírka;
// graf jde do místní služby Rithmicu (PC: RithmicLiveChart, telefon a nativní appka: RithmicPhoneChart),
// kopírka zatím jen ukazuje účet služby. Žádný stav Tradovate kopírky sem nevstupuje.
import React, { useCallback, useEffect, useState } from 'react';
import { CandlestickChart, Network } from 'lucide-react';
import { ErrorBoundary } from './ErrorBoundary';
import RithmicLiveChart from './RithmicLiveChart';
import RithmicPhoneChart from './RithmicPhoneChart';
import RithmicCopierTab from './copier/RithmicCopierTab';
import { LivePhoneHeader, LivePhoneMenu } from './LivePhoneChrome';
import { rememberLiveChartCrash } from './LiveTradingScreenSlot';
import type { LiveTradingTab } from './LiveTradingScreen';
import type { LivePhoneChartSlots } from './day/LivePhoneChart';
import { useLiveLayout } from '../hooks/useLiveLayout';
import { isNativeShell } from '../utils/nativeShell';
import { rithmicLocalAvailable, rithmicPairingOffered } from '../lib/rithmicLocalLink';
import { NO_LIVE_COPIER, NO_PHONE_COPIER_CHIP } from '../lib/liveNoCopier';

export type LiveDeskPhoneChartSlots = LivePhoneChartSlots & { onLeave: () => void };

interface LiveDeskProps {
  userId: string;
  theme: string;
  /** Telefonní graf dneška z deníku; Rithmic do něj posílá vlastní trh, pozici a příkazy. */
  phoneChart?: (slots: LiveDeskPhoneChartSlots) => React.ReactNode;
}

type DeskTab = 'chart' | 'copier';

const LiveSlotFailure = ({ label }: { label: string }) => (
  <section role="alert" className="grid min-h-36 place-items-center rounded-xl border border-rose-500/30 bg-rose-500/10 p-5 text-center text-xs font-bold text-rose-500">
    {label} se nepodařilo zobrazit. Stav pozice ověř u brokera, pak obnov stránku.
  </section>
);

const initialTab = (): DeskTab => {
  if (typeof window === 'undefined') return 'chart';
  return new URLSearchParams(window.location.search).get('liveTab') === 'copier' ? 'copier' : 'chart';
};

const LiveDesk: React.FC<LiveDeskProps> = ({ userId, theme, phoneChart }) => {
  const isDark = theme !== 'light';
  const { narrow } = useLiveLayout();
  const phoneLayout = narrow || isNativeShell();
  const [configured] = useState(rithmicLocalAvailable);
  const [pairingHere] = useState(rithmicPairingOffered);
  const [tab, setTab] = useState<DeskTab>(initialTab);
  const [phoneMenuOpen, setPhoneMenuOpen] = useState(false);
  const [chartCrashed, setChartCrashed] = useState(false);
  // Telefon: graf existuje i před spárováním (nabídne „Spárovat s Macem"), PC jen se službou.
  const phoneChartAvailable = phoneLayout && (configured || pairingHere) && Boolean(phoneChart);
  const pcChartAvailable = !phoneLayout && configured;
  const chartAvailable = phoneChartAvailable || pcChartAvailable;

  const tabs: LiveTradingTab[] = [
    ...(chartAvailable ? [{ id: 'chart' as const, label: 'Graf', icon: CandlestickChart }] : []),
    ...(configured ? [{ id: 'copier' as const, label: 'Kopírka', icon: Network }] : []),
  ];

  const navigateToTab = useCallback((next: LiveTradingTab['id']) => {
    if (next !== 'chart' && next !== 'copier') return;
    setTab(next);
    const url = new URL(window.location.href);
    if (next === 'chart') url.searchParams.delete('liveTab'); else url.searchParams.set('liveTab', next);
    const href = `${url.pathname}${url.search}${url.hash}`;
    if (href !== `${window.location.pathname}${window.location.search}${window.location.hash}`) window.history.replaceState(null, '', href);
  }, []);

  useEffect(() => {
    if (tab === 'chart' && !chartAvailable && configured) setTab('copier');
    if (tab === 'copier' && !configured && chartAvailable) setTab('chart');
    if (tab !== 'chart') setPhoneMenuOpen(false);
  }, [chartAvailable, configured, tab]);

  const noteChartCrash = useCallback(() => setChartCrashed(true), []);

  if (!chartAvailable && !configured) {
    return (
      <section className="mx-auto mt-6 max-w-xl rounded-xl border border-[var(--border-subtle,rgba(148,163,184,.3))] p-6 text-center text-sm">
        <p className="font-bold">LIVE běží přes místní službu Rithmicu na Macu.</p>
        <p className="mt-2 text-[var(--text-muted,#94a3b8)]">Na tomto zařízení služba není připojená. Na Macu spusť Rithmic službu a otevři LIVE z jejího odkazu, na telefonu ji spáruj z LIVE grafu.</p>
      </section>
    );
  }

  return (
    <div className="mx-auto max-w-[1500px] space-y-4">
      {tab === 'chart' && pcChartAvailable ? (
        chartCrashed ? <LiveSlotFailure label="Rithmic graf" /> : (
          <ErrorBoundary name="RithmicLiveChart" onError={noteChartCrash} fallback={<LiveSlotFailure label="Rithmic graf" />}>
            <RithmicLiveChart
              open
              onCrash={noteChartCrash}
              isDark={isDark}
              tabs={tabs}
              onNavigate={navigateToTab}
              copier={NO_LIVE_COPIER}
              disarm={null}
            />
          </ErrorBoundary>
        )
      ) : tab === 'chart' && phoneChartAvailable && phoneChart ? (
        <ErrorBoundary name="RithmicPhoneChart" onError={() => { rememberLiveChartCrash(); noteChartCrash(); }} fallback={<LiveSlotFailure label="Rithmic graf" />}>
          <RithmicPhoneChart
            open
            isDark={isDark}
            onLeave={() => navigateToTab('copier')}
            phoneChart={phoneChart}
            userId={userId}
            header={({ group, account }) => <LivePhoneHeader
              groupName={null}
              group={group}
              account={account}
              hideCopier
              copier={NO_PHONE_COPIER_CHIP}
              onMenu={() => setPhoneMenuOpen(true)}
            />}
            overlay={phoneMenuOpen ? <LivePhoneMenu
              tabs={tabs.filter(item => item.id !== 'chart')}
              onPick={id => { setPhoneMenuOpen(false); navigateToTab(id); }}
              onClose={() => setPhoneMenuOpen(false)}
            /> : null}
          />
        </ErrorBoundary>
      ) : null}
      {tab === 'copier' && configured && (
        <>
          {!phoneLayout && (
            <nav className="flex items-center gap-1" aria-label="LIVE navigace">
              {tabs.map(item => <button key={item.id} type="button" onClick={() => navigateToTab(item.id)}
                className={`rounded-lg px-3 py-1.5 text-[12px] font-bold ${item.id === tab ? 'text-indigo-400' : ''}`}>{item.label}</button>)}
            </nav>
          )}
          <ErrorBoundary name="RithmicCopierTab" fallback={<LiveSlotFailure label="Kopírka" />}>
            <RithmicCopierTab open narrow={phoneLayout} isDark={isDark} />
          </ErrorBoundary>
        </>
      )}
      {phoneChartAvailable && tab !== 'chart' && (
        <button type="button" onClick={() => navigateToTab('chart')} className="native-fixed-above-tab-bar fixed right-4 z-[360] flex h-11 items-center gap-2 rounded-full bg-gradient-to-b from-blue-500 to-blue-600 px-4 text-sm font-black text-white shadow-[0_10px_24px_-10px_#2563eb]" style={{ bottom: 'calc(var(--live-bottom-clear, 0px) + 6px)' }}>
          <CandlestickChart size={16} /> Graf
        </button>
      )}
    </div>
  );
};

export default LiveDesk;
