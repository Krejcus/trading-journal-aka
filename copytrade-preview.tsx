import React, { useState } from 'react';
import ReactDOM from 'react-dom/client';
import LiveCopyTradeOverview from './components/LiveCopyTradeOverview';
import LiveRiskTab from './components/LiveRiskTab';
import LiveStatusStrip from './components/LiveStatusStrip';
import { DEFAULT_COPY_GROUP_SAFETY, type CopyGroupConfig } from './services/liveCopyTrading';
import type { CopierControllerStatus } from './services/copierRuntimeController';
import type { LiveAccount, LiveSnapshot } from './services/tradecopiaLiveService';

const account = (id: number, name: string, firm: string, balance: number): LiveAccount => ({
  id, entityId: null, name, firm, phase: 'Funded', accountSize: 50_000,
  balance, equity: balance, realizedPnl: 0, weekRealizedPnl: 0, unrealizedPnl: 0,
  unrealizedPnlSource: 'broker', peakEquity: 50_000, drawdownFloor: 48_000,
  cushion: balance - 48_000, positions: [], updatedAt: new Date().toISOString(),
  mapRowId: null, mappedAccountId: null, mappedAccountName: null, mappingStatus: null,
});
const accounts = [account(101, 'Tradeify · leader', 'Tradeify', 48_046.18), account(102, 'Lucid · follower', 'Lucid', 49_300)];
const snapshot: LiveSnapshot = {
  run: null, accounts, appAccounts: [], alerts: [],
  connections: accounts.map(a => ({ id: a.firm, firm: a.firm, connected: true, status: 'Connected', accountCount: 1, disconnectedAt: null, disconnectReason: null, updatedAt: new Date().toISOString() })),
  groups: [{ id: 'local-preview', name: 'Hlavní', leaderAccountId: 101, leaderName: accounts[0].name, followers: [{ accountId: 102, accountName: accounts[1].name, scale: 1, replicate: true, synced: true, mismatches: [] }], syncedCount: 1, warningCount: 0 }],
  totalBalance: 97_346.18, totalEquity: 97_346.18, totalRealizedPnl: 0, totalUnrealizedPnl: 0, worstCushion: 46.18,
};
const initialGroup: CopyGroupConfig = {
  id: 'local-preview', name: 'Hlavní', enabled: true, leaderAccountId: 101,
  followers: [{ accountId: 102, mode: 'on-submit', multiplier: 1 }], color: '#84cc16', localOnly: true,
  safety: { ...DEFAULT_COPY_GROUP_SAFETY, dailyMaxLosingTrades: 2, entryCooldownMinutes: 15, dailyLossLimitUsd: 0, dailyMaxTrades: 0, armExpiryFlatten: 'off' },
};
function Preview() {
  const [tab, setTab] = useState<'overview' | 'risk'>('overview');
  const [scenario, setScenario] = useState('off');
  const [group, setGroup] = useState(initialGroup);
  const [notice, setNotice] = useState('');
  const now = Date.now();
  const status: CopierControllerStatus = {
    started: true, armed: scenario === 'copying' || scenario === 'paused', killSwitch: false,
    shadowMode: false, connected: scenario !== 'offline', reconciliationRequired: scenario === 'offline',
    divergentAccounts: [], workingOrderAccounts: [], stuckOutbox: false, stuckOperations: [], lastError: scenario === 'offline' ? 'Tradovate WebSocket transport error' : null,
    revision: 1, lastSequence: 0, groupFlat: true, dayLockUntil: 0, sessionArmedAt: 0,
    pause: scenario === 'paused' ? { until: now + 20 * 60_000, rule: 'daily-loss', at: now } : null,
    dailyStats: { label: 'Leader · jen obchody přes kopírku · bez poplatků', sessionEndAt: now + 3_600_000, realizedPnlUsd: 0, losingTrades: 0, tradesToday: 0, windowState: 'off', warnedRules: [], recentClosedTrades: [], unpricedSymbols: [] },
  };
  const available = scenario !== 'unknown';
  const supported = scenario !== 'legacy';
  return <main className="mx-auto max-w-[1500px] space-y-4 p-4">
    <header className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] p-4">
      <div><h1 className="text-xl font-black">LIVE</h1><p className="text-xs text-[var(--text-secondary)]">Lokální náhled · ukázková data · bez připojení k brokerovi</p></div>
      <label className="text-xs font-bold">Ukázat stav <select aria-label="Ukázat stav" value={scenario} onChange={event => setScenario(event.target.value)} className="ml-2 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-page)] p-2">
        <option value="off">Vypnutá kopírka</option><option value="copying">Zapnutá kopírka</option><option value="paused">Pauza</option><option value="offline">Odpojený stream</option><option value="unknown">Neověřený worker</option><option value="legacy">Starý worker</option>
      </select></label>
    </header>
    <nav aria-label="LIVE navigace" className="flex gap-1 border-b border-[var(--border-subtle)]">{(['overview', 'risk'] as const).map(value => <button key={value} onClick={() => setTab(value)} className={`border-b-2 px-4 py-3 text-xs font-bold ${value === tab ? 'border-indigo-500 text-indigo-500' : 'border-transparent'}`}>{value === 'overview' ? 'Live Dashboard' : 'Risk'}</button>)}</nav>
    <LiveStatusStrip status={status} available={available} pending={false} transport="local" />
    {notice && <p className="text-xs text-indigo-500">{notice}</p>}
    {tab === 'overview' ? <LiveCopyTradeOverview key={scenario} snapshot={snapshot} runtimeGroup={group} executionGroupId={group.id}
      runtimeStatus={status} runtimeAvailable={available} riskConfigSupported={supported} copierArmed={status.armed}
      copierStatusPending={!available} dailyStats={status.dailyStats} pause={status.pause} onOpenRisk={() => setTab('risk')} />
      : <LiveRiskTab snapshot={snapshot} group={group} status={status} runtimeAvailable={available} riskConfigSupported={supported}
        onSaveGroup={async next => { setGroup(next); setNotice('Změna pouze v lokální ukázce. Žádný požadavek nebyl odeslán.'); }} />}
  </main>;
}
ReactDOM.createRoot(document.getElementById('root')!).render(<Preview />);
