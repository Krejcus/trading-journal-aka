import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Bell } from 'lucide-react';
import type { ChartViewApi } from '@getcandlekit/charts/react';
import './day/dayJournal.css';
import { LivePhoneAlertLines, LivePhoneAlertList, LivePhoneAlertSheet } from './day/LivePhoneAlerts';
import {
  alertTitle, movedAlert, newPriceAlert, pcAlertFiredActions, priceAlertEventTitle, quickAlertCardStatus,
  type PriceAlert, type PriceAlertStore,
} from '../lib/priceAlerts';
import type { TradeToast } from '../lib/liveTradeToasts';
import { alertVoiceText, speakAlertText } from '../services/alertVoice';
import { liveFillAudio } from '../services/liveFillAudio';
import { useFreshPriceAlertEvents, usePriceAlertStore } from '../services/priceAlertStoreHook';

/**
 * Upozornění na cenu v LIVE grafu PC (Filip 6. 11. 2026): pravý klik do grafu = rychlý alert
 * podle posledního nastavení, tah čáry = posun, dvojklik = nastavení. Stejná data jako telefon
 * (`priceAlertStoreHook`), hlídá Mac worker z IBKR. Upozornění jen hlásí: žádný kód tady
 * nesahá na příkazy ani kopírku (INV-UI-01).
 */

const FLASH_MS = 2_400;

/** Stabilní most do panelu grafu: změna upozornění nepřekresluje graf, čáry si stav čtou samy. */
export interface LivePcAlertBridge {
  store: PriceAlertStore;
  flash: { subscribe: (listener: () => void) => () => void; get: () => ReadonlySet<string> };
  quickAdd: (price: number) => void;
  openEdit: (id: string) => void;
  move: (id: string, price: number) => void;
  remove: (id: string) => void;
  /** Vrstva čar pro panel; přes most, ať se kód upozornění netáhne do backtestu a detailu obchodu. */
  renderLines: (api: ChartViewApi) => React.ReactNode;
}

function createFlashStore() {
  let ids: ReadonlySet<string> = new Set();
  const listeners = new Set<() => void>();
  const set = (next: ReadonlySet<string>) => { ids = next; listeners.forEach(listener => listener()); };
  return {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    get: () => ids,
    fire: (id: string) => {
      set(new Set(ids).add(id));
      window.setTimeout(() => { const next = new Set(ids); next.delete(id); set(next); }, FLASH_MS);
    },
  };
}

const toast = (tone: TradeToast['tone'], badge: string, title: string, line: string, ms?: number): TradeToast => {
  const at = Date.now();
  return { id: `alert-${at}-${Math.random().toString(36).slice(2, 6)}`, at, tone, badge, title, line, pnl: null, accounts: 0, sticky: false, ms };
};

/**
 * `conditionMarket` = close svíčky jako na telefonu: jde do uloženého směru, a ten nesmí stát na
 * rychlém kanálu ceny (INV-UI-04). Hlídač si automatický směr stejně přepočítá z IBKR.
 */
export function useLivePcPriceAlerts({ conditionMarket, watching }: { conditionMarket: number | null; watching: string | null }) {
  const store = usePriceAlertStore();
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const [editId, setEditId] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [cards, setCards] = useState<readonly TradeToast[]>([]);
  const flashRef = useRef<ReturnType<typeof createFlashStore> | null>(null);
  const flash = (flashRef.current ??= createFlashStore());
  const marketRef = useRef(conditionMarket);
  marketRef.current = conditionMarket;
  const watchingRef = useRef(watching);
  watchingRef.current = watching;
  // Karty už předané do `LiveTradeToasts` (ten si je drží sám); krátký seznam stačí.
  const card = useCallback((next: TradeToast) => setCards(current => [...current.slice(-5), next]), []);

  const events = useMemo(() => (state.events ?? []).filter(event => !event.suppressed)
    .map(event => ({ id: event.id, alertId: event.alertId, at: event.at, price: event.level })), [state.events]);
  useFreshPriceAlertEvents(store, events, (event, alert) => {
    if (alert) flash.fire(alert.id);
    const title = priceAlertEventTitle(alert, event.price);
    const actions = pcAlertFiredActions(alert);
    if (actions.card) card(toast('amber', 'Upoz.', title, alert?.note ? alert.note : 'Upozornění na cenu', 8_000));
    if (actions.sound) liveFillAudio.playCue('alert');
    if (actions.voice) speakAlertText(alertVoiceText(title, alert?.note));
  });
  // Trvale odmítnuté uložení (např. strop 50): čára zmizí, takže to musí být vidět hned, ne až v seznamu.
  const lastErrorRef = useRef(state.error ?? null);
  useEffect(() => {
    const error = state.error ?? null;
    if (error && error !== lastErrorRef.current) card(toast('red', 'Upoz.', 'Upozornění se NEULOŽILO', error, 12_000));
    lastErrorRef.current = error;
  }, [card, state.error]);
  // Výpadek serveru po „Ukládám“: změny čekají ve frontě, karta to řekne hned.
  const lastSyncRef = useRef(state.sync);
  useEffect(() => {
    if (state.sync === 'offline' && lastSyncRef.current !== 'offline') card(toast('red', 'Upoz.', 'Upozornění zatím NEULOŽENO', 'Server nedostupný, odešle se později', 8_000));
    lastSyncRef.current = state.sync;
  }, [card, state.sync]);
  // Prohlížeč pustí zvuk až po gestu uživatele (stejné odemčení jako hlášení plnění).
  useEffect(() => liveFillAudio.installUnlock(), []);

  const bridge = useMemo<LivePcAlertBridge>(() => {
    const value: LivePcAlertBridge = {
    store,
    flash,
    quickAdd: price => {
      const alert = newPriceAlert(price, marketRef.current, store.getState().defaults);
      store.add(alert);
      const status = quickAlertCardStatus(store.getState().sync, watchingRef.current);
      card(toast(status.warn ? 'red' : 'amber', 'Upoz.', alertTitle(alert), status.line, status.warn ? 8_000 : 4_000));
    },
    openEdit: setEditId,
    move: (id, price) => {
      const alert = store.getState().alerts.find(item => item.id === id);
      if (!alert) return;
      const next = movedAlert(alert, price, marketRef.current);
      store.update(next);
      card(toast('blue', 'Posun', 'Upozornění posunuto', `${alert.price.toFixed(2)} → ${next.price.toFixed(2)}`));
    },
    remove: id => {
      store.remove(id);
      card(toast('muted', 'Zrušeno', 'Upozornění zrušeno', ''));
    },
    renderLines: api => <LivePcAlertLines api={api} bridge={value} />,
    };
    return value;
  }, [card, flash, store]);

  const editing = editId ? state.alerts.find(alert => alert.id === editId) ?? null : null;
  const activeCount = state.alerts.filter(alert => alert.status !== 'triggered').length;
  const closeEdit = useCallback(() => setEditId(null), []);
  const closeList = useCallback(() => setListOpen(false), []);
  return { bridge, cards, state, editing, activeCount, listOpen, setListOpen, closeEdit, closeList, setEditId };
}

export type LivePcPriceAlerts = ReturnType<typeof useLivePcPriceAlerts>;

/** Čáry v panelu grafu exekučního instrumentu. Leží POD čarami příkazů, ty mají přednost. */
function LivePcAlertLines({ api, bridge }: { api: ChartViewApi; bridge: LivePcAlertBridge }) {
  const state = useSyncExternalStore(bridge.store.subscribe, bridge.store.getState, bridge.store.getState);
  const flashIds = useSyncExternalStore(bridge.flash.subscribe, bridge.flash.get, bridge.flash.get);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  return (
    <LivePhoneAlertLines
      api={api}
      alerts={state.alerts}
      selectedId={selectedId}
      flashIds={flashIds}
      mouse
      onSelect={setSelectedId}
      onEdit={bridge.openEdit}
      onMove={bridge.move}
      onRemove={id => { setSelectedId(null); bridge.remove(id); }}
    />
  );
}

/** Zvonek v liště grafu: počet a seznam (i pro alerty mimo výřez a stav hlídání). */
export function LivePcAlertsButton({ alerts, isDark }: { alerts: LivePcPriceAlerts; isDark: boolean }) {
  return (
    <button
      type="button"
      aria-label={`Upozornění na cenu (${alerts.activeCount})`}
      title="Upozornění na cenu"
      onClick={() => alerts.setListOpen(true)}
      className={`relative flex h-7 w-7 items-center justify-center rounded-md transition-colors ${isDark ? 'text-slate-400 hover:bg-white/10 hover:text-slate-100' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-900'}`}
    >
      <Bell size={15} />
      {alerts.activeCount > 0 && <span className="absolute -right-0.5 -top-0.5 min-w-[13px] rounded-full bg-amber-400 px-[3px] text-center text-[8.5px] font-extrabold leading-[13px] text-amber-950">{alerts.activeCount}</span>}
    </button>
  );
}

/** Dialog nastavení a seznam; patří k celé obrazovce, ne k panelu grafu. */
export function LivePcAlertDialogs({ alerts, lastPrice, conditionMarket, watching, isDark }: {
  alerts: LivePcPriceAlerts;
  /** Jen text „X b nad trhem“. */
  lastPrice: number | null;
  conditionMarket: number | null;
  watching: string | null;
  isDark: boolean;
}) {
  const { bridge, editing, closeEdit, closeList, setEditId } = alerts;
  const pc = useMemo(() => ({ isDark }), [isDark]);
  return <>
    {alerts.listOpen && (
      <LivePhoneAlertList
        pc={pc}
        alerts={alerts.state.alerts}
        watching={watching}
        error={alerts.state.error ?? null}
        onClose={closeList}
        onEdit={id => { closeList(); setEditId(id); }}
        onRemove={bridge.remove}
      />
    )}
    {editing && (
      <LivePhoneAlertSheet
        key={editing.id}
        pc={pc}
        alert={editing}
        market={lastPrice}
        onClose={closeEdit}
        onDelete={id => { closeEdit(); bridge.remove(id); }}
        onSave={(next: PriceAlert) => {
          // Ruční přepsání ceny: automaticky odvozený směr se přepočítá jako při tahu čáry.
          const moved = next.conditionAuto && next.price !== editing.price ? movedAlert(next, next.price, conditionMarket) : next;
          bridge.store.update({ ...moved, updatedAt: Date.now() });
          // Co uložíš, dostanou i další nová upozornění (stejně jako na telefonu).
          bridge.store.setDefaults({ frequency: next.frequency, expiry: next.expiry, line: next.line, channels: next.channels });
          closeEdit();
        }}
      />
    )}
  </>;
}
