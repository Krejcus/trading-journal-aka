/**
 * Náhled skutečného dialogu pro založení/úpravu skupiny mimo přihlášenou
 * appku. Mountuje tutéž komponentu, kterou vidí uživatel, jen s mock účty.
 */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { GroupEditorDialog } from '../components/LiveCopyTradeOverview';
import '../index.css';

const account = (id: number, name: string, firm: string, balance: number) => ({
  id, entityId: null, name, firm, phase: 'Funded', accountSize: 50_000,
  balance, equity: balance, realizedPnl: 0, weekRealizedPnl: 0, unrealizedPnl: 0,
  peakEquity: null, drawdownFloor: null, cushion: null, positions: [], status: 'active',
  dailyLossLimit: null, updatedAt: null,
});

const ACCOUNTS = [
  account(1, 'LFF05066846490007', 'Lucid', 51_525),
  account(2, 'TDF-50K-118204', 'Tradeify', 50_310),
  account(3, 'TDF-50K-118205', 'Tradeify', 49_880),
  account(4, 'TDF-100K-90412', 'Tradeify', 101_240),
  account(5, 'APEX-184920', 'Apex', 49_500),
  account(6, 'LFF05066846490011', 'Lucid', 50_000),
];

const Harness = () => {
  const [isNew, setIsNew] = useState(true);
  const [key, setKey] = useState(0);
  const group = isNew
    ? { id: 'g-new', name: '', enabled: false, leaderAccountId: null, followers: [] }
    : {
      id: 'g-1', name: 'Hlavní', enabled: true, color: '#6366f1', leaderAccountId: 1,
      followers: [
        { accountId: 2, mode: 'on-submit', multiplier: 1 },
        { accountId: 3, mode: 'on-submit', multiplier: 2 },
        { accountId: 4, mode: 'on-fill', multiplier: 1, maxContracts: 5 },
      ],
    };
  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-page)' }}>
      <div style={{ position: 'fixed', bottom: 16, left: 16, zIndex: 200, display: 'flex', gap: 8 }}>
        {(['Nová skupina', 'Úprava'] as const).map((label, index) => (
          <button key={label} onClick={() => { setIsNew(index === 0); setKey(value => value + 1); }}
            style={{ fontSize: 11, fontWeight: 800, padding: '6px 12px', borderRadius: 8, cursor: 'pointer',
              border: '1px solid var(--border-subtle)',
              background: (index === 0) === isNew ? '#6366f1' : 'transparent',
              color: (index === 0) === isNew ? '#fff' : 'var(--text-secondary)' }}>{label}</button>
        ))}
      </div>
      <GroupEditorDialog
        key={key}
        group={group as never}
        isNew={isNew}
        tightenOnly={false}
        accounts={ACCOUNTS as never}
        accountLabel={(id: number) => ACCOUNTS.find(a => a.id === id)?.name ?? `Účet ${id}`}
        saving={false}
        libraryState="ready"
        libraryError={null}
        onClose={() => { /* náhled se nezavírá */ }}
        onSave={async () => true}
        onRemoveUnavailableFollowers={() => { /* mock */ }}
        onDelete={isNew ? undefined : () => { /* mock */ }}
      />
    </div>
  );
};

const container = document.getElementById('root')! as HTMLElement & { _root?: ReturnType<typeof createRoot> };
container._root ??= createRoot(container);
container._root.render(<Harness />);
