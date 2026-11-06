import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AudioLines, Bell, Monitor, Smartphone, Trash2, X } from 'lucide-react';
import type { ChartViewApi } from '@getcandlekit/charts/react';
import './day/dayJournal.css';
import TradingViewColorPicker from './TradingViewColorPicker';
import { LivePhoneAlertLines } from './day/LivePhoneAlerts';
import {
  PRICE_ALERT_PC_OPACITY, PRICE_ALERT_TONES, alertConditionText, alertTitle, movedAlert, newPriceAlert, pcAlertFiredActions, priceAlertEventTitle, quickAlertCardStatus,
  type PriceAlert, type PriceAlertLineStyle, type PriceAlertLineWidth, type PriceAlertStore, type PriceAlertTone,
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
    if (actions.sound) liveFillAudio.playCue(`alert-${alert?.channels.tone ?? 'double'}`);
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

const TICK = 0.25;
const price2 = (value: number) => value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Skleněné okno Aurory (hranaté `rounded-lg`, skleněná hrana, lesk nahoře, vlastní výplň kvůli
 * Chrome bez blur). Začíná POD hlavičkou LIVE (h-11, z-800), OFF zůstává klikatelné (INV-UI-02).
 * `role="dialog"` + `aria-modal` ztiší klávesové zkratky obchodování, fokus zůstává uvnitř, Esc zavře.
 */
function AlertWindow({ label, isDark, width, onClose, children }: { label: string; isDark: boolean; width: number; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  const sectionRef = useRef<HTMLElement>(null);
  useEffect(() => { sectionRef.current?.focus(); }, []);
  const keepFocus = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Tab') return;
    const section = sectionRef.current;
    const items = section ? [...section.querySelectorAll<HTMLElement>('button:not(:disabled), input')] : [];
    if (!section || items.length === 0) { event.preventDefault(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey ? (active === first || active === section) : active === last) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  };
  return (
    <div className="fixed inset-x-0 bottom-0 top-11 z-[700] flex items-center justify-center p-4" role="presentation">
      <div className={`absolute inset-0 backdrop-blur-[2px] ${isDark ? 'bg-[#03060c]/55' : 'bg-slate-900/25'}`} onClick={onClose} />
      <section
        ref={sectionRef}
        tabIndex={-1}
        onKeyDown={keepFocus}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        data-price-alert-window
        className={`relative flex max-h-full flex-col overflow-hidden rounded-lg border outline-none backdrop-blur-xl backdrop-saturate-150 ${isDark
          ? 'border-white/[0.12] text-slate-100 shadow-[0_28px_60px_-22px_rgba(0,0,0,0.85),inset_0_1px_0_rgba(255,255,255,0.09)]'
          : 'border-white/90 text-slate-900 shadow-[0_28px_60px_-24px_rgba(15,23,42,0.45),0_0_0_1px_rgba(15,23,42,0.07),inset_0_1px_0_rgba(255,255,255,0.95)]'}`}
        style={{
          width: `min(${width}px, 100%)`,
          background: isDark
            ? 'radial-gradient(120% 100% at 0% 0%, rgba(99,102,241,0.16), transparent 55%), radial-gradient(90% 80% at 100% 100%, rgba(20,184,166,0.07), transparent 60%), rgba(14,20,30,0.95)'
            : 'radial-gradient(120% 100% at 0% 0%, rgba(99,102,241,0.09), transparent 55%), rgba(255,255,255,0.96)',
        }}
      >
        {children}
      </section>
    </div>
  );
}

const line = (isDark: boolean) => (isDark ? 'border-white/[0.07]' : 'border-slate-900/[0.08]');
const muted = (isDark: boolean) => (isDark ? 'text-slate-400' : 'text-slate-500');
const pressable = (isDark: boolean, on: boolean) => (on
  ? (isDark ? 'bg-indigo-500/25 text-indigo-100' : 'bg-indigo-500/15 text-indigo-700')
  : (isDark ? 'text-slate-400 hover:bg-white/[0.07] hover:text-slate-100' : 'text-slate-500 hover:bg-slate-900/[0.05] hover:text-slate-900'));

function WindowHeader({ title, meta, isDark, onClose }: { title: string; meta: React.ReactNode; isDark: boolean; onClose: () => void }) {
  return (
    <header className={`flex h-11 shrink-0 items-center gap-2 border-b pl-4 pr-2 ${line(isDark)}`}>
      <Bell size={14} className="text-amber-400" aria-hidden />
      <b className="text-[13px] font-semibold">{title}</b>
      <span className={`text-[11.5px] ${muted(isDark)}`}>{meta}</span>
      <button type="button" aria-label="Zavřít" onClick={onClose} className={`ml-auto grid h-7 w-7 place-items-center rounded-md transition-colors ${pressable(isDark, false)}`}><X size={14} /></button>
    </header>
  );
}

function Row({ label, sub, isDark, children }: { label: string; sub?: React.ReactNode; isDark: boolean; children: React.ReactNode }) {
  return (
    <div className={`flex min-h-[40px] items-center justify-between gap-3 border-b px-4 py-1.5 ${line(isDark)}`}>
      <div className="min-w-0">
        <div className={`text-[12px] font-medium ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>{label}</div>
        {sub != null && <div className={`font-mono text-[10.5px] ${muted(isDark)}`}>{sub}</div>}
      </div>
      {children}
    </div>
  );
}

function Seg<T extends string>({ value, options, isDark, onChange }: { value: T; options: ReadonlyArray<[T, string]>; isDark: boolean; onChange: (value: T) => void }) {
  return (
    <div className={`flex shrink-0 gap-0.5 rounded-md border p-0.5 ${line(isDark)}`}>
      {options.map(([key, text]) => (
        <button key={key} type="button" aria-pressed={value === key} onClick={() => onChange(key)}
          className={`h-6 whitespace-nowrap rounded-[5px] px-2 text-[11.5px] font-semibold transition-colors ${pressable(isDark, value === key)}`}>{text}</button>
      ))}
    </div>
  );
}

/** PC: cena se dá přepsat rukou; platná až po potvrzení, zaokrouhlená na tick. */
function PriceField({ price, isDark, onChange }: { price: number; isDark: boolean; onChange: (price: number) => void }) {
  const [text, setText] = useState<string | null>(null);
  const commit = () => {
    if (text == null) return;
    // „21 480,5“ i „21,480.5“: s tečkou je čárka oddělovač tisíců, jinak desetinná.
    const clean = text.replace(/\s/g, '');
    const value = Number(clean.includes('.') ? clean.replace(/,/g, '') : clean.replace(',', '.'));
    setText(null);
    if (Number.isFinite(value) && value > 0) onChange(Math.round(value / TICK) * TICK);
  };
  const step = `grid h-7 w-7 place-items-center text-[14px] transition-colors ${pressable(isDark, false)}`;
  return (
    <div className={`flex shrink-0 items-center overflow-hidden rounded-md border ${isDark ? 'border-white/[0.12] bg-black/20' : 'border-slate-900/[0.12] bg-white/70'}`}>
      <button type="button" aria-label="O tick níž" className={step} onClick={() => onChange(price - TICK)}>−</button>
      <input
        inputMode="decimal"
        aria-label="Cena upozornění"
        value={text ?? price.toFixed(2)}
        onChange={event => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commit(); } }}
        className="h-7 w-[92px] bg-transparent text-center font-mono text-[13px] font-bold tabular-nums outline-none"
      />
      <button type="button" aria-label="O tick výš" className={step} onClick={() => onChange(price + TICK)}>+</button>
    </div>
  );
}

const WIDTHS: ReadonlyArray<[PriceAlertLineWidth, string]> = [['thin', 'Tenká'], ['thick', 'Tlustá'], ['none', 'Jen štítek na ose']];
const STYLES: ReadonlyArray<[PriceAlertLineStyle, string]> = [['solid', 'Plná'], ['dashed', 'Čárkovaná'], ['dotted', 'Tečkovaná']];
const CHANNELS: ReadonlyArray<{ key: 'phone' | 'pc' | 'voice'; text: string; title: string; Icon: typeof Bell }> = [
  { key: 'phone', text: 'iPhone', title: 'Běžná notifikace, i při zamčeném telefonu', Icon: Smartphone },
  { key: 'pc', text: 'PC', title: 'Karta vlevo dole, s otevřeným LIVE grafem; oznámení prohlížeče', Icon: Monitor },
  { key: 'voice', text: 'Hlas', title: 'Telefon i PC přečtou upozornění nahlas', Icon: AudioLines },
];

/** Nastavení jednoho upozornění: „popisek vlevo, ovládání vpravo“ jako v Nastavení aplikace. */
function AlertSettingsWindow({ alert, market, isDark, onSave, onDelete, onClose }: {
  alert: PriceAlert;
  market: number | null;
  isDark: boolean;
  onSave: (alert: PriceAlert) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<PriceAlert>(alert);
  const set = (patch: Partial<PriceAlert>) => setDraft(current => ({ ...current, ...patch }));
  const distance = market == null ? null : draft.price - market;
  const anyChannel = draft.channels.phone || draft.channels.voice || draft.channels.pc;
  const lineSample = (key: PriceAlertLineStyle, width: number) => <span aria-hidden className="block w-5" style={{ borderTop: `${width}px ${key} ${draft.line.color}` }} />;
  return (
    <AlertWindow label="Upozornění" isDark={isDark} width={430} onClose={onClose}>
      <WindowHeader title="Upozornění" meta={draft.symbol} isDark={isDark} onClose={onClose} />
      <div className="min-h-0 overflow-y-auto">
        <Row label="Cena" isDark={isDark} sub={distance == null ? undefined : Math.abs(distance) < TICK / 2 ? 'na trhu' : `${price2(Math.abs(distance))} b ${distance > 0 ? 'nad' : 'pod'} trhem`}>
          <PriceField price={draft.price} isDark={isDark} onChange={price => set({ price })} />
        </Row>
        <Row label="Podmínka" isDark={isDark}>
          <Seg value={draft.condition} isDark={isDark} onChange={condition => set({ condition, conditionAuto: false })} options={[['cross', 'Překročí'], ['up', 'Nahoru přes'], ['down', 'Dolů přes']]} />
        </Row>
        <Row label="Spustit" isDark={isDark}>
          <Seg value={draft.frequency} isDark={isDark} onChange={frequency => set({ frequency })} options={[['once', 'Jednou'], ['every', 'Pokaždé, max 1×/min']]} />
        </Row>
        <Row label="Platnost" isDark={isDark}>
          <Seg value={draft.expiry} isDark={isDark} onChange={expiry => set({ expiry })} options={[['session', 'Do konce seance'], ['gtc', 'Do zrušení']]} />
        </Row>
        <Row label="Čára" isDark={isDark}>
          <div className="flex shrink-0 items-center gap-1.5">
            <div className={`flex gap-0.5 rounded-md border p-0.5 ${line(isDark)}`}>
              {STYLES.map(([key, text]) => (
                <button key={key} type="button" title={text} aria-label={text} aria-pressed={draft.line.style === key} onClick={() => set({ line: { ...draft.line, style: key } })}
                  className={`grid h-6 w-8 place-items-center rounded-[5px] transition-colors ${pressable(isDark, draft.line.style === key)}`}>{lineSample(key, key === 'dotted' ? 2 : 1.5)}</button>
              ))}
            </div>
            <div className={`flex gap-0.5 rounded-md border p-0.5 ${line(isDark)}`}>
              {WIDTHS.map(([key, text]) => (
                <button key={key} type="button" title={text} aria-label={text} aria-pressed={draft.line.width === key} onClick={() => set({ line: { ...draft.line, width: key } })}
                  className={`grid h-6 w-8 place-items-center rounded-[5px] transition-colors ${pressable(isDark, draft.line.width === key)}`}>
                  {key === 'none' ? <Bell size={12} aria-hidden /> : lineSample('solid', key === 'thick' ? 3 : 1)}
                </button>
              ))}
            </div>
          </div>
        </Row>
        <Row label="Barva" isDark={isDark}>
          <TradingViewColorPicker compact label="Barva čáry" value={draft.line.color} opacity={draft.line.opacity ?? PRICE_ALERT_PC_OPACITY} onChange={(color, opacity) => set({ line: { ...draft.line, color, opacity } })} />
        </Row>
        <Row label="Kam poslat" isDark={isDark}>
          <div className="flex shrink-0 gap-1">
            {CHANNELS.map(({ key, text, title, Icon }) => (
              <button key={key} type="button" title={title} aria-pressed={draft.channels[key]} onClick={() => set({ channels: { ...draft.channels, [key]: !draft.channels[key] } })}
                className={`inline-flex h-7 items-center gap-1 rounded-md border px-1.5 text-[11px] font-semibold transition-colors ${draft.channels[key] ? (isDark ? 'border-indigo-400/40' : 'border-indigo-500/30') : line(isDark)} ${pressable(isDark, draft.channels[key])}`}>
                <Icon size={12} aria-hidden />{text}
              </button>
            ))}
          </div>
        </Row>
        <Row label="Zvuk" isDark={isDark}>
          <Seg<PriceAlertTone | 'off'>
            value={draft.channels.sound ? draft.channels.tone ?? 'double' : 'off'}
            isDark={isDark}
            options={[['off', 'Vyp'], ...PRICE_ALERT_TONES]}
            onChange={choice => {
              // Klik je zároveň ukázka tónu.
              if (choice === 'off') { set({ channels: { ...draft.channels, sound: false } }); return; }
              set({ channels: { ...draft.channels, sound: true, tone: choice } });
              liveFillAudio.unlock();
              liveFillAudio.playCue(`alert-${choice}`);
            }}
          />
        </Row>
        <Row label="Poznámka" isDark={isDark}>
          <input value={draft.note} maxLength={60} placeholder="např. retest dHigh" aria-label="Poznámka" onChange={event => set({ note: event.target.value })}
            className={`h-7 w-[210px] min-w-0 rounded-md border bg-transparent px-2 text-[12px] outline-none transition-colors ${isDark ? 'border-white/[0.12] placeholder:text-slate-600 focus:border-indigo-400/60' : 'border-slate-900/[0.12] placeholder:text-slate-400 focus:border-indigo-500/60'}`} />
        </Row>
      </div>
      {!anyChannel && <p className="m-0 px-4 pt-2 text-[11.5px] text-amber-500">Zapni aspoň iPhone, PC, nebo hlas.</p>}
      <footer className="flex shrink-0 items-center gap-2 px-4 py-2.5">
        <button type="button" onClick={() => onDelete(alert.id)} className={`inline-flex h-[30px] items-center gap-1.5 rounded-md px-2 text-xs font-semibold text-rose-400 transition-colors ${isDark ? 'hover:bg-rose-500/10' : 'hover:bg-rose-500/10'}`}><Trash2 size={13} aria-hidden />Smazat</button>
        <button type="button" onClick={onClose} className={`ml-auto h-[30px] rounded-md px-3 text-xs font-semibold transition-colors ${pressable(isDark, false)}`}>Zrušit</button>
        <button type="button" disabled={!anyChannel} onClick={() => onSave(draft)} className="h-[30px] rounded-md bg-indigo-500 px-4 text-xs font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] transition-colors hover:bg-indigo-400 disabled:opacity-50">Uložit</button>
      </footer>
    </AlertWindow>
  );
}

/** Seznam upozornění pod zvonečkem. */
function AlertListWindow({ alerts, watching, error, isDark, onEdit, onRemove, onClose }: {
  alerts: readonly PriceAlert[];
  watching: string | null;
  error: string | null;
  isDark: boolean;
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
  onClose: () => void;
}) {
  const active = alerts.filter(alert => alert.status !== 'triggered').length;
  return (
    <AlertWindow label="Upozornění" isDark={isDark} width={400} onClose={onClose}>
      <WindowHeader title="Upozornění" meta={`${active} ${active === 1 ? 'aktivní' : 'aktivních'}`} isDark={isDark} onClose={onClose} />
      <div className={`flex shrink-0 items-center gap-2 border-b px-4 py-2 text-[11.5px] font-medium ${line(isDark)} ${watching ? (isDark ? 'text-emerald-300' : 'text-emerald-700') : (isDark ? 'text-amber-300' : 'text-amber-700')}`}>
        <i className={`h-1.5 w-1.5 shrink-0 rounded-full ${watching ? 'bg-emerald-400' : 'bg-amber-400'}`} />
        {watching ?? 'Teď nikdo nehlídá: Mac worker neběží nebo nemá cenu z IBKR. Křížení mezitím se nedoženou.'}
      </div>
      {error && <div role="alert" className={`shrink-0 border-b px-4 py-2 text-[11.5px] ${line(isDark)} ${isDark ? 'text-rose-300' : 'text-rose-700'}`}>{error}</div>}
      <div className="min-h-0 overflow-y-auto">
        {alerts.length === 0 && <p className={`m-0 px-4 py-5 text-center text-[12px] ${muted(isDark)}`}>Žádné upozornění. Klikni pravým do grafu a vyber Rychlý alert.</p>}
        {alerts.map(alert => {
          const channels = [alert.channels.phone && 'iPhone', alert.channels.pc && 'PC', alert.channels.voice && 'hlas'].filter(Boolean).join(' + ');
          const spent = alert.status === 'triggered';
          return (
            <div key={alert.id} className={`group flex items-center gap-1 border-b pr-2 transition-colors ${line(isDark)} ${isDark ? 'hover:bg-white/[0.04]' : 'hover:bg-slate-900/[0.03]'}`}>
              <button type="button" onClick={() => onEdit(alert.id)} className="min-w-0 flex-1 py-2 pl-4 text-left">
                <div className={`flex items-center gap-2 text-[12.5px] font-semibold ${spent ? 'opacity-60' : ''}`}>
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: alert.line.color }} />
                  <span>{alertConditionText(alert.condition)}</span>
                  <span className="font-mono tabular-nums">{price2(alert.price)}</span>
                  {spent && <span className={`text-[10.5px] font-medium ${muted(isDark)}`}>spuštěno</span>}
                </div>
                <div className={`mt-0.5 truncate pl-4 text-[11px] ${muted(isDark)}`}>
                  {alert.frequency === 'once' ? 'jednou' : 'pokaždé'} · {alert.expiry === 'session' ? 'do konce seance' : 'do zrušení'} · {channels || 'bez kanálu'}{alert.note ? ` · ${alert.note}` : ''}
                </div>
              </button>
              <button type="button" aria-label={`Smazat upozornění ${price2(alert.price)}`} onClick={() => onRemove(alert.id)} className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-rose-400 opacity-60 transition hover:bg-rose-500/10 hover:opacity-100 focus-visible:opacity-100"><Trash2 size={13} /></button>
            </div>
          );
        })}
      </div>
      <p className={`m-0 shrink-0 px-4 py-2 text-[10.5px] ${muted(isDark)}`}>Upozornění jen hlásí, nikdy nic neobchoduje.</p>
    </AlertWindow>
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
  return <>
    {alerts.listOpen && (
      <AlertListWindow
        isDark={isDark}
        alerts={alerts.state.alerts}
        watching={watching}
        error={alerts.state.error ?? null}
        onClose={closeList}
        onEdit={id => { closeList(); setEditId(id); }}
        onRemove={bridge.remove}
      />
    )}
    {editing && (
      <AlertSettingsWindow
        key={editing.id}
        isDark={isDark}
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
