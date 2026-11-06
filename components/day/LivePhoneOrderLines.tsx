import { LIVE_ACTION_CHANGED_TEXT } from '../../lib/liveClickGate';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChartViewApi } from '@getcandlekit/charts/react';
import BacktestOrderLinesOverlay from '../BacktestOrderLinesOverlay';
import type { BacktestChartOrderLine, BacktestChartOrderLineKind } from '../../services/backtestOrderLines';
import { LIVE_ATTACH_SEND_ACTION, LIVE_PENDING_ADD_LINE_ID, LIVE_POSITION_OWNER, liveBreakEven, liveLineMoveBlockReason, livePositionChartLines } from '../../lib/liveChartOrderLines';
import type { LiveChartPositionSummary } from '../../lib/liveChartPosition';
import type { LeaderOrderManageAction, LeaderOrderManageResult } from '../../lib/leaderOrderManage';
import { LIVE_ATTACH_OWNER, LIVE_DRAFT_ID, liveAttachChartLines, liveDraftChartLines, snapToTick, type LiveAttachLegs, withBracket, withEntryPrice, type TicketDraft, type TicketInstrument, type TicketQuote } from '../../lib/liveOrderTicket';
import type { LiveTicketScaleIn } from '../../lib/liveScaleIn';
import { LIVE_MANAGE_BUSY_TEXT } from '../../hooks/useLiveManageRunner';
import { isLiveDisplayOnlyLine, type LiveWorkingOrderBadge, type LiveWorkingOrdersView } from '../../lib/liveWorkingOrderLines';

const TICK = 0.25;
const POINT_VALUE = 2;

/** Správa obchodu leadera z telefonu — stejná cesta jako PC (`onManageEntry`); dodá ji datová vrstva. */
export type LivePhoneManage = (action: LeaderOrderManageAction, expectPrice: number, newPrice?: number) => Promise<LeaderOrderManageResult>;

type PendingMove = { kind: 'stopLoss' | 'takeProfit'; price: number; until: number };
/**
 * Zámek „jeden příkaz naráz“ a „odesílám“ žijí v rodiči (LivePhoneChart): vrstva
 * čar se při přehrávání nebo výměně grafu odpojí a stav letícího příkazu nesmí
 * zmizet (jinak by čára ukázala starý SL jako aktuální a pustila druhý tah).
 */
export interface LivePhoneLineState {
  pendingMove: PendingMove | null;
  setPendingMove: React.Dispatch<React.SetStateAction<PendingMove | null>>;
  busyRef: React.MutableRefObject<boolean>;
}
export function useLivePhoneLineState(): LivePhoneLineState {
  const [pendingMove, setPendingMove] = useState<PendingMove | null>(null);
  const busyRef = useRef(false);
  return { pendingMove, setPendingMove, busyRef };
}

/** ✎ na čáře SL/TP (U10): jen otevře list správy s touto nohou — nic neodešle. */
export const LIVE_PHONE_MANAGE_ACTION = { id: 'manage', label: '✎', title: 'Správa SL/TP: číslo, BE, BE + n ticků' } as const;

/**
 * Přikoupení do pozice drží SL/TP pozice (`livePhoneScaleInDraft`): závorky návrhu se
 * v grafu netáhnou (worker jiné nepustí, PC je má v panelu zamčené) — kreslí je čáry pozice.
 */
export function livePhoneDraftScaleLocked(draft: Pick<TicketDraft, 'side'>, scaleIn: LiveTicketScaleIn | null | undefined): boolean {
  return scaleIn != null && draft.side === scaleIn.side && scaleIn.stopLoss != null && scaleIn.targetPrice != null;
}

/**
 * Čáry návrhu v grafu telefonu (U2, 3. 11. 2026) — stejné jako PC (`liveDraftChartLines`):
 * vstup Limit/Stop jde táhnout, u Marketu jen SL/TP (vstup jede s cenou). Návrh, ne příkaz:
 * tah mění jen návrh v rodiči, odchází až tlačítkem lišty návrhu nebo listu (INV-UI-01).
 */
export function livePhoneDraftLines(
  draft: TicketDraft,
  instrument: TicketInstrument,
  quote: TicketQuote,
  scaleIn: LiveTicketScaleIn | null | undefined,
): BacktestChartOrderLine[] {
  try {
    const lines = liveDraftChartLines(draft, instrument, quote);
    return livePhoneDraftScaleLocked(draft, scaleIn) ? lines.filter(line => line.kind === 'entry').map(line => ({ ...line, addableBrackets: undefined })) : lines;
  } catch {
    return [];
  }
}

/** Tah čáry návrhu → nový návrh (vstup Limit/Stop, SL, TP; ceny na tick). Market vstup se nemění. */
export function livePhoneDraftAfterDrag(draft: TicketDraft, kind: BacktestChartOrderLineKind, price: number, instrument: TicketInstrument): TicketDraft {
  if (!Number.isFinite(price)) return draft;
  if (kind === 'entry') return draft.type === 'market' ? draft : withEntryPrice(draft, price, instrument);
  const snapped = snapToTick(price, instrument.tickSize);
  return kind === 'stopLoss' ? { ...draft, stopLoss: snapped } : { ...draft, takeProfit: snapped };
}

/** × na čáře návrhu: vstup = zahodit celý návrh (null), SL/TP = jen tu nohu. */
export function livePhoneDraftAfterRemove(draft: TicketDraft, kind: BacktestChartOrderLineKind): TicketDraft | null {
  if (kind === 'entry') return null;
  return kind === 'stopLoss' ? { ...draft, stopLoss: null } : { ...draft, takeProfit: null };
}

/** „+ SL“ / „+ TP“ na vstupu návrhu (na taženou cenu, jinak výchozí vzdálenost jako PC). */
export function livePhoneDraftAfterAddBracket(draft: TicketDraft, kind: 'stopLoss' | 'takeProfit', instrument: TicketInstrument, quote: TicketQuote, price?: number): TicketDraft {
  return withBracket(draft, kind === 'stopLoss' ? 'sl' : 'tp', instrument, quote, price);
}

/**
 * Market návrh v grafu: SL a TP jedou s cenou (drží vzdálenost od vstupu) — jako PC
 * (`LiveTradingScreen`). Přikoupení drží SL/TP pozice. `previousEntry` null = první cena.
 */
export function livePhoneMarketDraftFollow(
  draft: TicketDraft,
  previousEntry: number | null,
  entry: number,
  scaleIn: LiveTicketScaleIn | null | undefined,
  tickSize: number,
): TicketDraft {
  if (draft.type !== 'market' || previousEntry == null || previousEntry === entry || !Number.isFinite(entry)) return draft;
  if (livePhoneDraftScaleLocked(draft, scaleIn)) return draft;
  const delta = entry - previousEntry;
  return {
    ...draft,
    stopLoss: draft.stopLoss == null ? null : snapToTick(draft.stopLoss + delta, tickSize),
    takeProfit: draft.takeProfit == null ? null : snapToTick(draft.takeProfit + delta, tickSize),
  };
}

/**
 * Pracující příkazy (U5) pro graf telefonu: jen když kontrakt čar sedí s kontraktem grafu.
 * IBKR zdroj nese konkrétní měsíc (`chartContract`); jiný měsíc (týden rollu) = nic. Souvislá
 * řada (bez měsíce) kreslí čáry kontraktu pozice / frontu podle brokera. Jen zobrazení.
 */
export function livePhoneWorkingView(
  working: (LiveWorkingOrdersView & { contract: string | null }) | null | undefined,
  chartContract: string | null,
): { lines: readonly BacktestChartOrderLine[]; badges: readonly LiveWorkingOrderBadge[] } {
  if (!working || working.contract == null || (chartContract != null && chartContract !== working.contract)) return { lines: [], badges: [] };
  return { lines: working.lines.filter(line => isLiveDisplayOnlyLine(line)), badges: working.badges };
}

/**
 * Čáry obchodu v LIVE grafu telefonu stejně jako na PC: tenké Aurora štítky
 * (`BacktestOrderLinesOverlay` + `livePositionChartLines`). Na telefonu se SL/TP
 * nejdřív klepnutím vybere a pak táhne (jen v ploše grafu). Bez `manage` jsou
 * čáry jen zobrazení (nejde táhnout, žádné × ani BE). Ošetření posunu, BE,
 * zavření a zrušení je stejné jako `LiveTradingScreen` (INV-UI-01..04): „co
 * jsem viděl“ ze začátku tahu, předkontroly jen blokují, rozhoduje worker.
 *
 * 3. 11. 2026 ve stejném overlayi (jeden výběr, dotyky se nepřou): čáry návrhu (U2,
 * tah mění jen návrh v rodiči), pracující příkazy jen pro zobrazení (U5, `live-working`
 * nikdy nic nepošle) a ✎ na SL/TP, které jen otevře list správy (U10).
 */
export function LivePhoneOrderLines({
  api, state, summary, guardAt, displayOpenPnl = null, manage, pendingLegs = false, attach = null, canClose, entryAvg, pendingAdd = null, closeExpect = null, isDark, onNotice,
  extraLines, draftLines, onDraftChange, onDraftRemove, onDraftAddBracket, onManage,
}: {
  api: ChartViewApi;
  state: LivePhoneLineState;
  summary: LiveChartPositionSummary | null;
  /**
   * Souhrn pro pojistky utažení SL a BE jako na PC (`withIbkrTightenMark`): bez ceny z P&L
   * brokera čerstvá kotace IBKR téhož kontraktu. Jen předkontrola v UI (může blok i uvolnit,
   * INV-UI-04); rozhoduje worker. Při akci se vyhodnotí znovu s aktuálním časem.
   */
  guardAt?: (at: number) => LiveChartPositionSummary | null;
  /** Živé P&L jen do štítku vstupu (`liveDisplayOpenPnl`); null = číslo brokera. */
  displayOpenPnl?: number | null;
  manage: LivePhoneManage | null;
  /** Worker umí SL/TP nevyplněného vstupu a TP blíž k trhu. */
  pendingLegs?: boolean;
  /** Holá pozice: nohy vytažené ze štítků „+ SL“ / „+ TP“; tah mění jen návrh, odchází až tlačítkem na čáře. */
  attach?: {
    legs: LiveAttachLegs | null;
    side: 'long' | 'short';
    quantity: number;
    reference: number | null;
    onLeg: (kind: 'stopLoss' | 'takeProfit', price: number | null | undefined) => void;
    onSend: () => void;
  } | null;
  /** × u pozice jen za čerstvě zapnuté kopírky (ne shadow) — jako PC. */
  canClose: boolean;
  /** Průměrný vstup leadera od workeru (BE). */
  entryAvg: number | null;
  /** Čekající přikoupení do pozice (čára s × = zrušit jen přikoupení). */
  pendingAdd?: { price: number | null; quantity: number; orderType: string } | null;
  /** Pozice z přikoupení: nejochrannější SL od workeru — „co jsem viděl“ pro × při rozjetých SL. */
  closeExpect?: number | null;
  isDark: boolean;
  onNotice: (text: string) => void;
  /** U5: pracující příkazy jen pro zobrazení (`livePhoneWorkingView`) — netáhnou se, nemají ×. */
  extraLines?: readonly BacktestChartOrderLine[];
  /** U2: čáry návrhu (`livePhoneDraftLines`); tah / × / + SL jen volají `onDraft*`. */
  draftLines?: readonly BacktestChartOrderLine[];
  onDraftChange?: (kind: BacktestChartOrderLineKind, price: number) => void;
  onDraftRemove?: (kind: BacktestChartOrderLineKind) => void;
  onDraftAddBracket?: (kind: 'stopLoss' | 'takeProfit', price?: number) => void;
  /** U10: ✎ na čáře SL/TP otevře list správy s touto nohou; chybí = ✎ se nekreslí. */
  onManage?: (leg: 'stopLoss' | 'takeProfit') => void;
}) {
  const { pendingMove, setPendingMove, busyRef } = state;
  useEffect(() => {
    if (!pendingMove) return undefined;
    const landed = pendingMove.kind === 'stopLoss' ? summary?.stop : summary?.target;
    if (landed === pendingMove.price) { setPendingMove(null); return undefined; }
    if (!Number.isFinite(pendingMove.until)) return undefined;
    const timer = window.setTimeout(() => setPendingMove(null), Math.max(0, pendingMove.until - Date.now()));
    return () => window.clearTimeout(timer);
  }, [pendingMove, setPendingMove, summary?.stop, summary?.target]);

  // Telefon: × (zavřít pozici i zrušit vstup) jedním klepnutím (Filip 5. 11.), jako na PC.
  const guardSummary = useMemo(() => (summary ? guardAt?.(Date.now()) ?? summary : null), [guardAt, summary]);
  // Most z rodiče je každý render nový objekt: čáry se přepočítají jen při změně nohou (tah nesmí poskočit).
  const attachOn = attach != null;
  const attachLegs = attach?.legs ?? null;
  const attachSide = attach?.side;
  const attachQuantity = attach?.quantity;
  const attachReference = attach?.reference;
  const positionLines = useMemo(() => (guardSummary ? livePositionChartLines(guardSummary, {
    manageable: manage != null,
    pendingLegs: pendingLegs === true,
    attachChips: attachOn && guardSummary.kind === 'position' ? {
      missing: ([['stopLoss', attachLegs?.stopLoss], ['takeProfit', attachLegs?.takeProfit]] as const).filter(([, value]) => value == null).map(([kind]) => kind),
      canSend: attachLegs?.stopLoss != null && attachLegs.takeProfit != null,
    } : null,
    canClose,
    entryAvg,
    pointValue: POINT_VALUE,
    displayOpenPnl,
    ...(pendingMove ? { pending: { [pendingMove.kind]: pendingMove.price } } : {}),
    pendingAdd,
  }) : []), [attachOn, attachLegs, canClose, displayOpenPnl, entryAvg, manage, pendingLegs, pendingMove, guardSummary, pendingAdd]);
  const lines = useMemo(() => [
    // ✎ jen u táhnutelné SL/TP (správa jde a nic se právě neodesílá); jen otevře list.
    ...(onManage ? positionLines.map(line => (line.ownerId === LIVE_POSITION_OWNER && line.kind !== 'entry' && line.draggable && guardSummary?.kind === 'position'
      ? { ...line, actions: [...(line.actions ?? []), { ...LIVE_PHONE_MANAGE_ACTION }] } : line)) : positionLines),
    ...(attachLegs && attachSide && attachQuantity != null ? liveAttachChartLines(attachLegs, { side: attachSide, quantity: attachQuantity }, attachReference ?? null, { tickSize: TICK, pointValue: POINT_VALUE } as TicketInstrument) : []),
    // Pracující příkazy: jen zobrazení — vynucené bez tahu, × a tlačítek, ať je pustí jen tato vrstva.
    ...(extraLines ?? []).map(line => ({ ...line, draggable: false, cancellable: false, actions: undefined, addableBrackets: undefined })),
    // Návrh nahoře (poslední v DOM). × návrhu jedním klepnutím: jen zahodí návrh (u brokera nic).
    ...(draftLines ?? []).map(line => ({ ...line, confirmCancel: false })),
  ], [attachLegs, attachReference, attachSide, attachQuantity, draftLines, extraLines, onManage, positionLines]);

  const run = useCallback(async (action: LeaderOrderManageAction, expect: number | null | undefined, newPrice?: number, move?: 'stopLoss' | 'takeProfit') => {
    if (!manage) return;
    if (expect == null) { onNotice('Cena SL/TP pozice není jedna nebo není známá — nic se neodeslalo. Sjednoť ji v Tradovate, nebo zavři Flattenem.'); return; }
    if (busyRef.current) { onNotice(LIVE_MANAGE_BUSY_TEXT); return; }
    busyRef.current = true;
    if (move && newPrice != null) setPendingMove({ kind: move, price: newPrice, until: Number.POSITIVE_INFINITY });
    try {
      const result = await manage(action, expect, newPrice);
      if (result.status !== 'acknowledged') setPendingMove(null);
      else setPendingMove(current => (current ? { ...current, until: Date.now() + 5_000 } : current));
      onNotice(result.status === 'acknowledged'
        ? (result.reason && /zastavila|spustil|vyplnil|skončil|ne tímto|Flatten/.test(result.reason) ? result.reason
          : action === 'cancel-entry' ? 'Vstup zrušen; kopírka zruší kopie.'
            : action === 'close-position' ? 'Leader zavřen; kopírka zavírá kopie.' : 'Posunuto u leadera; kopírka posune kopie.')
        : result.status === 'blocked' ? `Neodesláno: ${result.blockers.map(issue => issue.text).join(' ')}`
          : result.status === 'rejected' ? result.reason ?? 'Broker změnu odmítl.'
            : result.reason ?? 'Výsledek neznámý — zkontroluj leadera v Tradovate.');
    } catch (reason) {
      setPendingMove(null);
      const message = reason instanceof Error ? reason.message : 'chyba';
      onNotice(/entry-busy|entry-superseded|entry-not-admitted|entry-daily-cap|manage-daily-cap|Chybí cesta|není čerstvě ověřený|nic se neodeslalo/.test(message)
        ? `Neodesláno: ${message.slice(0, 120)}` : `Výsledek neznámý (${message.slice(0, 120)}) — zkontroluj leadera v Tradovate.`);
    } finally {
      busyRef.current = false;
    }
  }, [busyRef, manage, onNotice, setPendingMove]);

  // Připojený i bez čar: pojistka změny nabídky musí přežít stav bez čáry (čekající → nic → pozice).
  return (
    <BacktestOrderLinesOverlay
      api={api}
      lines={lines}
      isDark={isDark}
      selectToDrag
      onClickSwallowed={() => onNotice(LIVE_ACTION_CHANGED_TEXT)}
      onChange={(line, kind, price, startLine) => {
        // Pracující příkazy jsou jen zobrazení: žádný posun, žádný návrh (pojistka nad overlayem).
        if (isLiveDisplayOnlyLine(line)) return;
        // Návrh: tah jen změní návrh v rodiči — k brokerovi nic (odeslání jen tlačítkem).
        if (line.ownerId === LIVE_DRAFT_ID) { onDraftChange?.(kind, snapToTick(price, TICK)); return; }
        if (line.ownerId === LIVE_ATTACH_OWNER) { if (kind !== 'entry') attach?.onLeg(kind, snapToTick(price, TICK)); return; }
        if (line.ownerId !== LIVE_POSITION_OWNER || !summary || kind === 'entry') return;
        const snapped = snapToTick(price, TICK);
        const current = kind === 'stopLoss' ? summary.stop : summary.target;
        if (startLine && startLine.price !== current) { onNotice(`${kind === 'stopLoss' ? 'SL' : 'TP'} se během tažení změnil — nic se neodeslalo.`); return; }
        if (snapped === current) return;
        const blocked = liveLineMoveBlockReason(guardAt?.(Date.now()) ?? summary, kind, snapped, { pendingLegs: pendingLegs === true });
        if (blocked) { onNotice(blocked); return; }
        void run(kind === 'stopLoss' ? 'move-stop' : 'move-target', current, snapped, kind);
      }}
      onCancel={line => {
        if (isLiveDisplayOnlyLine(line)) return;
        if (line.ownerId === LIVE_DRAFT_ID) { onDraftRemove?.(line.kind); return; }
        if (line.ownerId === LIVE_ATTACH_OWNER) { if (line.kind !== 'entry') attach?.onLeg(line.kind, null); return; }
        if (line.id === LIVE_PENDING_ADD_LINE_ID) {
          if (pendingAdd?.price != null) void run('cancel-entry', pendingAdd.price);
          return;
        }
        if (line.ownerId !== LIVE_POSITION_OWNER || line.kind !== 'entry' || !summary) return;
        if (summary.kind === 'pending') void run('cancel-entry', summary.leader?.entry);
        else void run('close-position', summary.stop ?? closeExpect);
      }}
      onAction={(line, actionId) => {
        if (isLiveDisplayOnlyLine(line) || line.ownerId !== LIVE_POSITION_OWNER || !summary) return;
        if (actionId === LIVE_ATTACH_SEND_ACTION) { attach?.onSend(); return; }
        // ✎ jen otevře list správy; příkaz odejde až tlačítkem v listu.
        if (actionId === LIVE_PHONE_MANAGE_ACTION.id) { if (line.kind !== 'entry') onManage?.(line.kind); return; }
        if (actionId !== 'break-even') return;
        const be = liveBreakEven(guardAt?.(Date.now()) ?? summary, entryAvg);
        if (be.blocked || be.price == null) { onNotice(be.blocked ?? 'BE teď nejde.'); return; }
        void run('move-stop', summary.stop, be.price, 'stopLoss');
      }}
      onAddBracket={(line, kind, price) => {
        if (line.ownerId === LIVE_POSITION_OWNER) { attach?.onLeg(kind, price); return; }
        // Jinak jen na vstupu návrhu.
        if (line.ownerId !== LIVE_DRAFT_ID || isLiveDisplayOnlyLine(line)) return;
        onDraftAddBracket?.(kind, price);
      }}
    />
  );
}

/**
 * Štítky pracujících příkazů bez čáry (U5): nepodporovaný typ, neznámá strana, „+N dalších“.
 * Jen zobrazení; kde jinde spravovat, říká text (Tradovate / × / Flatten).
 */
export function LivePhoneWorkingBadges({ badges, top = 8 }: { badges: readonly LiveWorkingOrderBadge[]; top?: number }) {
  if (!badges.length) return null;
  return (
    <div aria-label="Další pracující příkazy" style={{ position: 'absolute', zIndex: 22, top, left: 8, display: 'grid', gap: 4, justifyItems: 'start', maxWidth: 'calc(100% - 90px)', pointerEvents: 'none' }}>
      {badges.map(badge => (
        <span
          key={badge.id}
          role="note"
          title={badge.title}
          className="dj-mono"
          style={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', padding: '2px 7px', borderRadius: 6, border: `1px dashed ${badge.color}`, background: 'var(--dj-glass, rgba(13,18,27,.9))', color: 'var(--dj-text-2)', fontSize: 10.5, fontWeight: 600 }}
        >{badge.text}</span>
      ))}
    </div>
  );
}
