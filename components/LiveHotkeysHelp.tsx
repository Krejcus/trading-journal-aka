import React, { useEffect, useRef } from 'react';
import { Keyboard } from 'lucide-react';
import {
  LIVE_HOTKEY_DIALOG_SELECTOR,
  LIVE_HOTKEY_HELP,
  LIVE_HOTKEY_HELP_NOTE,
  type LiveHotkeyIntent,
  type LiveHotkeyOutcome,
} from '../lib/liveHotkeys';
import type { TicketSide } from '../lib/liveOrderTicket';
import type { BacktestChartOrderLine } from '../services/backtestOrderLines';

/**
 * Klávesové zkratky LIVE → Graf na PC (U1, 11/2026): přepínač, nápověda a napojení
 * výsledku `resolveLiveHotkey` na funkce obrazovky. Jen UI — nic odsud neodesílá:
 *
 * - zkratky jsou opt-in (výchozí VYPNUTO, volba jen na tomto zařízení);
 * - Shift+B/S jen předvyplní panel (jako ⚡), vstup odešle jen tlačítko panelu;
 * - BE / zavřít / zrušit čekající vedou na TUTÉŽ funkci jako tlačítko nebo × na čáře
 *   (`onOrderLineAction` / `onOrderLineCancel` v `LiveTradingScreen`), až po dvoukroku;
 * - Shift+F jen požádá nouzovou lištu o otevření dialogu Flatten All (INV-UI-02).
 */

/** Volba zkratek na zařízení (`'1'` = zapnuto; cokoli jiného = vypnuto). */
export const LIVE_HOTKEYS_STORAGE_KEY = 'at:live:hotkeys';

type HotkeysStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** localStorage, nebo null (SSR, soukromé okno, zákaz) — pak platí výchozí VYPNUTO. */
export const liveHotkeysStorage = (): HotkeysStorage | null => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage ?? null;
  } catch {
    return null;
  }
};

/** Zkratky jsou zapnuté jen výslovnou volbou; chyba úložiště = vypnuto. */
export function readLiveHotkeysEnabled(storage: Pick<Storage, 'getItem'> | null | undefined): boolean {
  try {
    return storage?.getItem(LIVE_HOTKEYS_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeLiveHotkeysEnabled(storage: HotkeysStorage | null | undefined, enabled: boolean): void {
  try {
    if (enabled) storage?.setItem(LIVE_HOTKEYS_STORAGE_KEY, '1');
    else storage?.removeItem(LIVE_HOTKEYS_STORAGE_KEY);
  } catch { /* volba jen v paměti */ }
}

/** Dialog nebo menu na obrazovce — klávesy (i Esc) patří jemu. */
export const LIVE_HOTKEY_OVERLAY_SELECTOR = `${LIVE_HOTKEY_DIALOG_SELECTOR}, [role="menu"], [role="listbox"]`;

/**
 * Je vidět dialog nebo menu? Skrytý prvek (bez rozměrů) se nepočítá. Neznámý stav
 * (chybí dokument, výjimka) = otevřeno → zkratky mlčí.
 */
export function liveHotkeyOverlayOpen(root: { querySelectorAll: (selector: string) => ArrayLike<unknown> } | null | undefined): boolean {
  if (!root) return true;
  try {
    return Array.from(root.querySelectorAll(LIVE_HOTKEY_OVERLAY_SELECTOR)).some(element => {
      const rects = (element as { getClientRects?: () => ArrayLike<unknown> }).getClientRects;
      return typeof rects !== 'function' || rects.call(element).length > 0;
    });
  } catch {
    return true;
  }
}

/** Panel Objednávka na PC (`LiveTradingScreen`: `<aside className="live-chart-ticket">`). */
export const LIVE_TICKET_SELECTOR = '.live-chart-ticket';

/**
 * Zkratka (Shift+B/S) mění návrh v panelu: fokus nesmí zůstat na prvku panelu —
 * hlavně na tlačítku Odeslat po kliku, který nic neodeslal (armovací klik holého
 * Marketu, blokace). Enter / mezerník by jinak nový návrh odeslal a vznikla by čistě
 * klávesová cesta k příkazu (pravidlo Filipa 29. 10., oponentura vlny B). Neznámý
 * stav (výjimka `closest`) = fokus zrušit taky. true = fokus zrušen.
 */
export function liveReleaseTicketFocus(root: { activeElement: unknown } | null | undefined): boolean {
  const active = root?.activeElement as { closest?: (selector: string) => unknown; blur?: () => void } | null | undefined;
  if (!active || typeof active.blur !== 'function') return false;
  let inside = true;
  try {
    inside = typeof active.closest !== 'function' || active.closest(LIVE_TICKET_SELECTOR) != null;
  } catch {
    inside = true;
  }
  if (!inside) return false;
  active.blur();
  return true;
}

/** Text pojistky U3-PC: zkratka během přehrávání v grafu. */
export const LIVE_HOTKEY_REPLAY_TEXT = 'Přehrávání v grafu — obchoduj v živém grafu. Nic se neodeslalo.';

/**
 * Pojistka U3-PC: během přehrávání v grafu (graf ukazuje historii) žádný návrh ani
 * akce na pozici. Zůstává jen otevření dialogu Flatten, nápověda a zahození návrhu.
 */
export function liveHotkeyReplayBlocked(intent: LiveHotkeyIntent, replayActive: boolean): string | null {
  // Jen výslovné „nepřehrává se“ pustí vše; neznámý stav = jako přehrávání.
  if (replayActive === false) return null;
  return intent.kind === 'flatten-dialog' || intent.kind === 'help' || intent.kind === 'discard-draft' ? null : LIVE_HOTKEY_REPLAY_TEXT;
}

export interface LiveHotkeyHandlers {
  /** Shift+B/S: jen návrh do panelu (nikdy příkaz). */
  prefill: (side: TicketSide) => void;
  /** Esc: zahodit návrh panelu. */
  discard: () => void;
  /** BE — TÁŽ funkce jako tlačítko BE na čáře (`onOrderLineAction(line, 'break-even')`). */
  breakEven: (line: BacktestChartOrderLine) => void;
  /** Zavřít pozici / zrušit čekající — TÁŽ funkce jako × na čáře (`onOrderLineCancel(line)`). */
  cancelLine: (line: BacktestChartOrderLine) => void;
  notice: (notice: { tone: 'warn' | 'bad'; text: string; until?: number }) => void;
  /** Shift+F: jen požádat nouzovou lištu o dialog Flatten All; false = lišta neposlouchá. */
  openFlatten: () => boolean;
  toggleHelp: () => void;
}

/** Hláška, když nouzová lišta požadavek nepřevzala (nic se nestalo). */
export const LIVE_HOTKEY_FLATTEN_UNAVAILABLE = 'Nouzová lišta teď neposlouchá — použij Flatten All na liště dole.';

/**
 * Výsledek `resolveLiveHotkey` → funkce obrazovky. Příkaz může vzniknout jen z `run`
 * (druhý stisk dvoukroku) a jen přes funkci čáry; tvar čáry se ještě jednou ověří
 * (zavřít = × zavírající pozici, zrušit = × rušící příkaz), jinak nic.
 */
export function dispatchLiveHotkeyOutcome(outcome: LiveHotkeyOutcome, handlers: LiveHotkeyHandlers): void {
  switch (outcome.kind) {
    case 'prefill-draft':
      handlers.prefill(outcome.side);
      return;
    case 'discard-draft':
      handlers.discard();
      return;
    case 'run': {
      const line = outcome.line;
      if (outcome.command === 'break-even') {
        if (line.actions?.some(action => action.id === 'break-even' && !action.disabled)) handlers.breakEven(line);
        else handlers.notice({ tone: 'bad', text: 'BE teď na čáře nejde — nic se neodeslalo.' });
        return;
      }
      const expected = outcome.command === 'close-position' ? 'close-position' : 'cancel-order';
      if (line.cancellable === true && line.cancelAction === expected) handlers.cancelLine(line);
      else handlers.notice({ tone: 'bad', text: 'Čára mezitím změnila význam — nic se neodeslalo.' });
      return;
    }
    case 'prompt':
      handlers.notice({ tone: 'warn', text: outcome.text, until: outcome.until });
      return;
    case 'blocked':
      handlers.notice({ tone: 'bad', text: outcome.text });
      return;
    case 'open-flatten':
      if (!handlers.openFlatten()) handlers.notice({ tone: 'bad', text: LIVE_HOTKEY_FLATTEN_UNAVAILABLE });
      return;
    case 'toggle-help':
      handlers.toggleHelp();
      return;
    default:
      return;
  }
}

/**
 * Tlačítko ⌨ v liště grafu: nápověda zkratek a přepínač (výchozí vypnuto).
 * Rozbalení není dialog ani menu — zkratky v něm dál fungují a Esc ho zavře.
 */
const LiveHotkeysHelp: React.FC<{
  isDark: boolean;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}> = ({ isDark, enabled, onEnabledChange, open, onOpenChange }) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;

  useEffect(() => {
    if (!open) return undefined;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) onOpenChangeRef.current(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') onOpenChangeRef.current(false); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', escape);
    };
  }, [open]);

  const title = `Klávesové zkratky: ${enabled ? 'zapnuté' : 'vypnuté'}`;
  const muted = isDark ? 'text-slate-500' : 'text-slate-400';
  return <div ref={rootRef} className="relative z-[80] shrink-0">
    <button
      type="button"
      onClick={() => onOpenChange(!open)}
      title={title}
      aria-label={title}
      aria-expanded={open}
      className={`relative grid h-8 w-8 place-items-center rounded-md ${isDark ? 'text-slate-300 hover:bg-white/5 hover:text-white' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-950'}`}
    >
      <Keyboard size={15} />
      {enabled && <i className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-blue-500" aria-hidden="true" />}
    </button>
    {open && <div
      role="group"
      aria-label="Klávesové zkratky LIVE"
      data-live-hotkeys-help
      className={`absolute right-0 top-9 w-[330px] overflow-hidden rounded-xl border py-1 shadow-2xl ${isDark ? 'bg-[#111821] border-white/10' : 'bg-white border-slate-200'}`}
    >
      <div className="flex items-center justify-between gap-2 px-3 pb-1.5 pt-1.5">
        <span className={`text-[9px] font-black uppercase tracking-wider ${muted}`}>Klávesové zkratky</span>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          onClick={() => onEnabledChange(!enabled)}
          className={`flex h-6 items-center gap-1.5 rounded-full border px-2 text-[10.5px] font-extrabold ${enabled
            ? 'border-blue-500/50 bg-blue-500/15 text-blue-500'
            : isDark ? 'border-white/15 text-slate-300' : 'border-slate-300 text-slate-600'}`}
        >
          <i className={`h-2 w-2 rounded-full ${enabled ? 'bg-blue-500' : isDark ? 'bg-slate-600' : 'bg-slate-300'}`} aria-hidden="true" />
          {enabled ? 'Zapnuté' : 'Vypnuté'}
        </button>
      </div>
      <ul className={`m-0 grid list-none gap-0.5 px-3 pb-1.5 ${enabled ? '' : 'opacity-50'}`}>
        {LIVE_HOTKEY_HELP.map(item => <li key={item.keys} className="flex items-baseline gap-2 text-[11px] leading-snug">
          <kbd className={`min-w-[74px] shrink-0 rounded border px-1 py-px text-center font-mono text-[10px] font-bold ${isDark ? 'border-white/15 bg-white/[0.04] text-slate-200' : 'border-slate-300 bg-slate-50 text-slate-700'}`}>{item.keys}</kbd>
          <span className={isDark ? 'text-slate-300' : 'text-slate-700'}>{item.text}</span>
        </li>)}
      </ul>
      <div className={`border-t px-3 py-2 text-[9.5px] font-semibold leading-snug ${isDark ? 'border-white/10 text-slate-500' : 'border-slate-100 text-slate-400'}`}>
        {LIVE_HOTKEY_HELP_NOTE} Výchozí stav je vypnuto; volba platí jen na tomto zařízení.
      </div>
    </div>}
  </div>;
};

export default LiveHotkeysHelp;
