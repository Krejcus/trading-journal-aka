/**
 * Náhled skutečného menu ⋮ u řádku skupiny mimo přihlášenou appku.
 * Mountuje tutéž komponentu, kterou vidí uživatel — jen s mock akcemi.
 */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { GroupActionMenu } from '../components/LiveCopyTradeOverview';
import '../index.css';

const Harness = () => {
  const [log, setLog] = useState<string[]>([]);
  const note = (what: string) => setLog(current => [what, ...current].slice(0, 5));
  return (
    <div style={{ padding: 40, minHeight: '100vh', background: 'var(--bg-page)' }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', width: 420 }}>
        <GroupActionMenu
          active
          onToggleEnabled={() => note('vypnout/zapnout')}
          onEdit={() => note('upravit')}
          onDelete={() => note('smazat')}
          templates={[]}
          tightenOnly={false}
          onApplyTemplate={() => note('šablona')}
        />
      </div>
      <pre id="log" style={{ marginTop: 24, fontSize: 12, color: 'var(--text-secondary)' }}>{log.join('\n')}</pre>
    </div>
  );
};

const container = document.getElementById('root')! as HTMLElement & { _root?: ReturnType<typeof createRoot> };
container._root ??= createRoot(container);
container._root.render(<Harness />);
