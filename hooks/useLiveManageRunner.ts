import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { LeaderOrderManageAction, LeaderOrderManageResult, LeaderOrderManageStatus } from '../lib/leaderOrderManage';
import type { LiveManageIntent, LiveManageLeg } from '../lib/liveManagePrices';

/**
 * Sdílené odeslání správy obchodu leadera (U10, 3. 11. 2026): posun SL/TP číslem
 * i tažením čáry, BE varianty, × zavřít / zrušit — PC panel, PC čáry grafu,
 * telefonní čáry i telefonní list „Správa“. Nahrazuje `runLiveManage`
 * (`LiveTradingScreen`) a `run` (`LivePhoneOrderLines`) se stejnými texty.
 *
 * Jediná cesta k brokerovi je předaný `manage` = `onManageEntry` desku
 * (`manageLeaderEntry` → relay → brány workeru). Hook nic jiného neodesílá,
 * nic neopakuje (neznámý výsledek ani výjimka se znovu NEPOŠLE) a „co jsem
 * viděl“ (`expectPrice`) nepočítá — volající ho bere z read modelu brokera
 * (INV-UI-01). Jeden příkaz naráz; BE varianty dvoukrokově (druhý klik 350 ms
 * až 4 s po prvním, klíč nese akci i ceny — vzor `BacktestOrderLinesOverlay`).
 */

/** Stejný podpis jako `onManageEntry` desku a telefonní `LivePhoneManage`. */
export type LiveManageCallback = (action: LeaderOrderManageAction, expectPrice: number, newPrice?: number) => Promise<LeaderOrderManageResult>;

/** Odeslaný posun čekající na potvrzení: čára drží novou cenu se štítkem „odesílám“. */
export interface LiveManagePendingMove { kind: LiveManageLeg; price: number; until: number }

/**
 * Zámek „jeden příkaz naráz“ a „odesílám“. Tvarem shodné s `LivePhoneLineState`
 * (telefon ho drží v rodiči, aby přežil odpojení vrstvy čar); PC si ho založí
 * `useLiveManageRunnerState`. Sdílí ho všechny spouštěče jedné obrazovky.
 */
export interface LiveManageRunnerState {
  pendingMove: LiveManagePendingMove | null;
  setPendingMove: Dispatch<SetStateAction<LiveManagePendingMove | null>>;
  busyRef: MutableRefObject<boolean>;
}

export interface LiveManageNotice { tone: 'ok' | 'bad' | 'warn'; text: string; at: number }

/**
 * Výsledek jednoho běhu. `called` = `manage` se zavolal (příkaz mohl odejít);
 * `not-sent` = prokazatelně nic neodešlo (předkontrola, zámek, „nic se neodeslalo“
 * z desku); výjimka po odeslání = `unknown` (nikdy úspěch, nic se neopakuje).
 */
export interface LiveManageOutcome {
  called: boolean;
  status: LeaderOrderManageStatus | 'not-sent';
  notice: LiveManageNotice;
}

export interface LiveManageConfirm { key: string; since: number; until: number }

/** Okno druhého kliku dvoukrokového potvrzení (jako × / BE na čarách grafu). */
export const LIVE_MANAGE_CONFIRM_MS = 4_000;
/** Dvojklik se nepočítá jako potvrzení: druhý klik nejdřív po 350 ms. */
export const LIVE_MANAGE_CONFIRM_MIN_MS = 350;
/**
 * Sdílený zámek jednoho příkazu drží jiný příkaz. Zámek kryje i vstup (až ~35 s relaye) a sekvenci
 * „Zrušit čekající“, takže na zařízení mezitím neodejde ani × / posun SL / BE — Flatten jím neprochází
 * (INV-UI-02), proto ho text nabízí (oponentura UI C7/C8 kolo 2).
 */
export const LIVE_MANAGE_BUSY_TEXT = 'Čeká se na výsledek předchozí změny — nic se neodeslalo. Zavřít jde hned Flattenem.';
/** Po potvrzeném posunu drží čára „odesílám“ ještě chvíli na dosednutí ceny. */
export const LIVE_MANAGE_PENDING_HOLD_MS = 5_000;

const NOT_SENT_PATTERN = /entry-busy|entry-superseded|entry-not-admitted|manage-daily-cap|entry-daily-cap|Chybí cesta|není čerstvě ověřený|nic se neodeslalo/;
const ACK_WARNING_PATTERN = /zastavila|spustil|vyplnil|skončil|ne tímto|Flatten/;

/** Text výsledku z workeru (stejné texty jako dosavadní PC `runLiveManage`). */
export function liveManageResultNotice(action: LeaderOrderManageAction, result: LeaderOrderManageResult, at: number): LiveManageNotice {
  if (result.status === 'acknowledged') {
    if (result.reason && ACK_WARNING_PATTERN.test(result.reason)) return { tone: 'warn', text: result.reason, at };
    return {
      tone: 'ok', at,
      text: action === 'cancel-entry' ? 'Vstup zrušen; kopírka zruší kopie.'
        : action === 'close-position' ? 'Leader zavřen; kopírka zavírá kopie.'
          : action === 'attach-brackets' ? 'SL a TP doplněny u leadera; kopírka je doplní kopiím.'
            : 'Posunuto u leadera; kopírka posune kopie.',
    };
  }
  if (result.status === 'blocked') return { tone: 'bad', text: `Neodesláno: ${result.blockers.map(issue => issue.text).join(' ')}`, at };
  if (result.status === 'rejected') return { tone: 'bad', text: result.reason ?? 'Broker změnu odmítl.', at };
  return { tone: 'warn', text: result.reason ?? 'Výsledek neznámý — zkontroluj leadera v Tradovate.', at };
}

/**
 * Výjimka z `manage`: prokazatelně neodeslané (strop, rozestup, chybějící cesta,
 * neověřený stav) = „Neodesláno“, všechno ostatní = výsledek neznámý (nikdy úspěch).
 */
export function liveManageErrorNotice(reason: unknown, at: number): LiveManageNotice {
  const message = reason instanceof Error ? reason.message : 'chyba';
  if (!NOT_SENT_PATTERN.test(message)) {
    return { tone: 'warn', text: `Výsledek neznámý (${message.slice(0, 120)}) — zkontroluj leadera v Tradovate.`, at };
  }
  return {
    tone: 'bad', at,
    text: `Neodesláno: ${/entry-busy/.test(message) ? 'jiná změna se právě zpracovává'
      : /entry-superseded/.test(message) ? 'mezitím přišlo vypnutí kopírky (brzda)'
        : /entry-not-admitted/.test(message) ? 'server změnu nepřijal' : message.slice(0, 120)}`,
  };
}

/** Rozhodla `manage` výjimkou, že se prokazatelně nic neodeslalo? */
const errorNotSent = (reason: unknown) => NOT_SENT_PATTERN.test(reason instanceof Error ? reason.message : '');

export interface LiveManageRunDeps {
  /** Aktuální `onManageEntry` (čte se při každém běhu); null = správa teď nejde. */
  manage: () => LiveManageCallback | null | undefined;
  busyRef: { current: boolean };
  setPendingMove: (update: SetStateAction<LiveManagePendingMove | null>) => void;
  setBusy?: (busy: boolean) => void;
  report: (notice: LiveManageNotice) => void;
  now?: () => number;
  /** Jiné texty výsledku (C8 holá pozice); výchozí `liveManageResultNotice`. Stav běhu se nemění. */
  resultNotice?: (action: LeaderOrderManageAction, result: LeaderOrderManageResult, at: number) => LiveManageNotice;
  /** Jiné texty výjimky (C8); výchozí `liveManageErrorNotice`. „Neodesláno“ vs. neznámé rozhoduje dál vzor. */
  errorNotice?: (reason: unknown, at: number) => LiveManageNotice;
}

/**
 * Jádro běhu bez Reactu (testovatelné). Pořadí: chybějící „co jsem viděl“ → nic;
 * běžící příkaz → nic; jinak právě JEDNO volání `manage` — bez opakování.
 */
export function createLiveManageRun(deps: LiveManageRunDeps) {
  const now = deps.now ?? Date.now;
  const finish = (notice: LiveManageNotice, called: boolean, status: LiveManageOutcome['status']): LiveManageOutcome => {
    deps.report(notice);
    return { called, status, notice };
  };
  return async (
    action: LeaderOrderManageAction, expectPrice: number | null | undefined, newPrice?: number, move?: LiveManageLeg,
  ): Promise<LiveManageOutcome> => {
    const manage = deps.manage();
    if (!manage) return finish({ tone: 'bad', text: 'Správa obchodu z appky teď nejde — nic se neodeslalo.', at: now() }, false, 'not-sent');
    // „Co jsem viděl“ chybí (např. rozjeté SL nohy pozice z přikoupení) — nikdy tiché nic.
    if (expectPrice == null || !Number.isFinite(expectPrice)) {
      return finish({ tone: 'bad', text: 'Cena SL/TP pozice není jedna nebo není známá — nic se neodeslalo. Sjednoť ji v Tradovate, nebo zavři Flattenem.', at: now() }, false, 'not-sent');
    }
    if (deps.busyRef.current) return finish({ tone: 'warn', text: LIVE_MANAGE_BUSY_TEXT, at: now() }, false, 'not-sent');
    deps.busyRef.current = true;
    deps.setBusy?.(true);
    // „Odesílám“ drží, dokud příkaz neskončí (relay čeká až ~35 s), pak ještě chvíli na dosednutí ceny.
    if (move && newPrice != null) deps.setPendingMove({ kind: move, price: newPrice, until: Number.POSITIVE_INFINITY });
    try {
      const result = await manage(action, expectPrice, newPrice);
      if (result.status !== 'acknowledged') deps.setPendingMove(null);
      else deps.setPendingMove(current => (current ? { ...current, until: now() + LIVE_MANAGE_PENDING_HOLD_MS } : current));
      return finish((deps.resultNotice ?? liveManageResultNotice)(action, result, now()), true, result.status);
    } catch (reason) {
      deps.setPendingMove(null);
      // Výjimka po odeslání = výsledek neznámý; nic se znovu neposílá (žádné slepé opakování).
      return finish((deps.errorNotice ?? liveManageErrorNotice)(reason, now()), true, errorNotSent(reason) ? 'not-sent' : 'unknown');
    } finally {
      deps.busyRef.current = false;
      deps.setBusy?.(false);
    }
  };
}

/**
 * Krok dvoukrokového potvrzení. První klik (nebo jiný klíč, nebo po 4 s) = „Opravdu?“;
 * druhý klik se stejným klíčem 350 ms až 4 s po prvním = odeslat. Rychlejší
 * druhý klik (dvojklik) se nepočítá a okno se jím neprodlužuje.
 */
export function liveManageConfirmStep(current: LiveManageConfirm | null, key: string, now: number): { next: LiveManageConfirm | null; fire: boolean; tooSoon?: true } {
  if (current && current.key === key && current.until > now) {
    if (now - current.since >= LIVE_MANAGE_CONFIRM_MIN_MS) return { next: null, fire: true };
    // Příliš rychlý klik posune kotvu na sebe: trojklik nic nepotvrdí.
    return { next: { key, since: now, until: now + LIVE_MANAGE_CONFIRM_MS }, fire: false, tooSoon: true };
  }
  return { next: { key, since: now, until: now + LIVE_MANAGE_CONFIRM_MS }, fire: false };
}

/** Stav zámku a „odesílám“ pro PC (telefon ho má v `useLivePhoneLineState`). */
export function useLiveManageRunnerState(): LiveManageRunnerState {
  const [pendingMove, setPendingMove] = useState<LiveManagePendingMove | null>(null);
  const busyRef = useRef(false);
  return { pendingMove, setPendingMove, busyRef };
}

export interface UseLiveManageRunnerOptions {
  /** `onManageEntry` desku; null/undefined = správa nejde (nic se neodešle, jen text). */
  manage: LiveManageCallback | null | undefined;
  /** Sdílený zámek a „odesílám“ (telefon: z rodiče). Bez něj vlastní. */
  state?: LiveManageRunnerState;
  /** Každý výsledek (PC lineNotice, telefon onNotice). */
  onNotice?: (notice: LiveManageNotice) => void;
  /**
   * Současné SL / TP z read modelu brokera: „odesílám“ zmizí, jakmile cena dosedne
   * (nebo po `LIVE_MANAGE_PENDING_HOLD_MS` od potvrzení). Bez něj to hlídá volající.
   */
  landed?: { stopLoss: number | null | undefined; takeProfit: number | null | undefined };
}

export type LiveManageRequest =
  | { step: 'asking' }
  | { step: 'waiting' }
  | { step: 'sent'; outcome: Promise<LiveManageOutcome> };

export interface LiveManageRunner {
  /** Příkaz právě běží (tato instance); sdílený zámek hlídá i ostatní spouštěče. */
  busy: boolean;
  /** Poslední výsledek (nebo důvod, proč se nic neposlalo). */
  result: LiveManageNotice | null;
  clearResult: () => void;
  pendingMove: LiveManagePendingMove | null;
  /** Přímý běh se stejným podpisem jako dosavadní `runLiveManage` / telefonní `run`. */
  run: (action: LeaderOrderManageAction, expectPrice: number | null | undefined, newPrice?: number, move?: LiveManageLeg) => Promise<LiveManageOutcome>;
  /** Záměr z `lib/liveManagePrices` — dvoukrokově, když `intent.confirm`. Záměr počítej při každém kliku znovu. */
  request: (intent: LiveManageIntent) => LiveManageRequest;
  /** Klíč čekající na druhý klik („Opravdu?“). */
  confirming: LiveManageConfirm | null;
  asking: (key: string) => boolean;
  cancelConfirm: () => void;
}

export function useLiveManageRunner(options: UseLiveManageRunnerOptions): LiveManageRunner {
  const own = useLiveManageRunnerState();
  const state = options.state ?? own;
  const { pendingMove, setPendingMove, busyRef } = state;
  const manageRef = useRef(options.manage);
  manageRef.current = options.manage;
  const onNoticeRef = useRef(options.onNotice);
  onNoticeRef.current = options.onNotice;
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<LiveManageNotice | null>(null);
  const [confirming, setConfirming] = useState<LiveManageConfirm | null>(null);
  // Ref kvůli dvěma klikům v jednom snímku (stav by ještě nebyl překreslený).
  const confirmingRef = useRef<LiveManageConfirm | null>(null);
  const setConfirm = useCallback((next: LiveManageConfirm | null) => {
    confirmingRef.current = next;
    setConfirming(next);
  }, []);

  useEffect(() => {
    if (!confirming) return undefined;
    const timer = window.setTimeout(() => setConfirm(null), Math.max(0, confirming.until - Date.now()));
    return () => window.clearTimeout(timer);
  }, [confirming, setConfirm]);

  const landedStop = options.landed?.stopLoss;
  const landedTarget = options.landed?.takeProfit;
  const watchLanding = options.landed != null;
  useEffect(() => {
    if (!watchLanding || !pendingMove) return undefined;
    const landed = pendingMove.kind === 'stopLoss' ? landedStop : landedTarget;
    if (landed === pendingMove.price) { setPendingMove(null); return undefined; }
    if (!Number.isFinite(pendingMove.until)) return undefined;
    const timer = window.setTimeout(() => setPendingMove(null), Math.max(0, pendingMove.until - Date.now()));
    return () => window.clearTimeout(timer);
  }, [watchLanding, pendingMove, landedStop, landedTarget, setPendingMove]);

  const run = useMemo(() => createLiveManageRun({
    manage: () => manageRef.current,
    busyRef,
    setPendingMove,
    setBusy,
    report: notice => {
      setResult(notice);
      onNoticeRef.current?.(notice);
    },
  }), [busyRef, setPendingMove]);

  const request = useCallback((intent: LiveManageIntent): LiveManageRequest => {
    const send = () => run(intent.action, intent.expectPrice, intent.newPrice, intent.leg);
    if (!intent.confirm) {
      setConfirm(null);
      return { step: 'sent', outcome: send() };
    }
    const now = Date.now();
    const current = confirmingRef.current;
    const step = liveManageConfirmStep(current, intent.confirmKey, now);
    if (step.fire) {
      setConfirm(null);
      return { step: 'sent', outcome: send() };
    }
    // Dvojklik/trojklik (klik do 350 ms od předchozího): nic se neodešle, pauza běží znovu.
    if (step.tooSoon) { setConfirm(step.next); return { step: 'waiting' }; }
    setConfirm(step.next);
    return { step: 'asking' };
  }, [run, setConfirm]);

  const asking = useCallback((key: string) => confirming?.key === key, [confirming]);
  const cancelConfirm = useCallback(() => setConfirm(null), [setConfirm]);
  const clearResult = useCallback(() => setResult(null), []);

  return { busy, result, clearResult, pendingMove, run, request, confirming, asking, cancelConfirm };
}
