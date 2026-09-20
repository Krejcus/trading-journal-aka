/**
 * Náhled skutečného dialogu „Nastavení tabulky“ mimo přihlášenou appku.
 *
 * Mountuje tutéž komponentu, kterou vidí uživatel — ne její kopii — jen jí
 * podstrčí stav v paměti. Slouží k posouzení designu a animace bez přihlášení.
 */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TableSettingsDialog } from '../components/LiveCopyTradeOverview';
import { moveColumn, pinColumnEdges } from '../lib/tableColumnOrder';
import '../index.css';

const ACCOUNTS = ['account', 'broker', 'firm', 'balance', 'positions', 'daily', 'dllRemaining', 'unreal', 'distDd', 'execLimit', 'qtyMult', 'actions'];
const GROUPS = ['status', 'leader', 'firm', 'followers', 'capital', 'daily', 'unreal'];
const ORDERS = ['account', 'broker', 'symbol', 'action', 'type', 'qty', 'limit', 'stop', 'status', 'timestamp', 'orderId'];

const Harness = () => {
  const [order, setOrder] = useState({ accounts: ACCOUNTS, groups: GROUPS, orders: ORDERS } as never);
  const [hiddenAccounts, setHiddenAccounts] = useState(new Set(['execLimit']));
  const [hiddenGroups, setHiddenGroups] = useState(new Set<string>());
  const [hiddenOrders, setHiddenOrders] = useState(new Set(['broker', 'orderId']));
  const [redaction, setRedaction] = useState({ visibleStart: 3, visibleEnd: 4 });
  const [rearm, setRearm] = useState(true);

  const toggle = (setter: (update: (current: Set<string>) => Set<string>) => void) => (key: string) =>
    setter(current => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });

  return (
    <TableSettingsDialog
      hiddenColumns={hiddenAccounts as never}
      hiddenGroupColumns={hiddenGroups as never}
      hiddenOrderColumns={hiddenOrders as never}
      columnOrder={order}
      redaction={redaction}
      confirmRearmAfterFlatten={rearm}
      onMoveColumn={(table, from, to) => setOrder((current: Record<string, string[]>) => {
        const moved = moveColumn(current[table], from, to);
        return {
          ...current,
          [table]: table === 'accounts' ? pinColumnEdges(moved, 'account', 'actions') : moved,
        } as never;
      })}
      onRedaction={setRedaction as never}
      onConfirmRearmAfterFlatten={setRearm}
      onToggleColumn={toggle(setHiddenAccounts as never) as never}
      onToggleGroupColumn={toggle(setHiddenGroups) as never}
      onToggleOrderColumn={toggle(setHiddenOrders as never) as never}
      onReset={() => {
        setOrder({ accounts: ACCOUNTS, groups: GROUPS, orders: ORDERS } as never);
        setHiddenAccounts(new Set());
        setHiddenGroups(new Set());
        setHiddenOrders(new Set());
        setRedaction({ visibleStart: 3, visibleEnd: 3 });
        setRearm(true);
      }}
      onClose={() => { /* náhled se nezavírá */ }}
    />
  );
};

// HMR jinak zavolá createRoot na tomtéž uzlu podruhé a stránka má dva stromy.
const container = document.getElementById('root')! as HTMLElement & { _root?: ReturnType<typeof createRoot> };
container._root ??= createRoot(container);
container._root.render(<Harness />);
