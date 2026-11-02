import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChartViewApi } from '@getcandlekit/charts/react';
import BacktestOrderLinesOverlay from '../BacktestOrderLinesOverlay';
import { LIVE_POSITION_OWNER, liveBreakEven, liveLineMoveBlockReason, livePositionChartLines } from '../../lib/liveChartOrderLines';
import type { LiveChartPositionSummary } from '../../lib/liveChartPosition';
import type { LeaderOrderManageAction, LeaderOrderManageResult } from '../../lib/leaderOrderManage';
import { snapToTick } from '../../lib/liveOrderTicket';

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

/**
 * Čáry obchodu v LIVE grafu telefonu stejně jako na PC: tenké Aurora štítky
 * (`BacktestOrderLinesOverlay` + `livePositionChartLines`). Na telefonu se SL/TP
 * nejdřív klepnutím vybere a pak táhne (jen v ploše grafu). Bez `manage` jsou
 * čáry jen zobrazení (nejde táhnout, žádné × ani BE). Ošetření posunu, BE,
 * zavření a zrušení je stejné jako `LiveTradingScreen` (INV-UI-01..04): „co
 * jsem viděl“ ze začátku tahu, předkontroly jen blokují, rozhoduje worker.
 */
export function LivePhoneOrderLines({ api, state, summary, manage, canClose, entryAvg, isDark, onNotice }: {
  api: ChartViewApi;
  state: LivePhoneLineState;
  summary: LiveChartPositionSummary | null;
  manage: LivePhoneManage | null;
  /** × u pozice jen za čerstvě zapnuté kopírky (ne shadow) — jako PC. */
  canClose: boolean;
  /** Průměrný vstup leadera od workeru (BE). */
  entryAvg: number | null;
  isDark: boolean;
  onNotice: (text: string) => void;
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

  // Telefon: × (zavřít pozici i zrušit vstup) vždy na dvě klepnutí — leží u osy hned
  // vedle plusu crosshairu a jedno klepnutí by mohlo zavřít leadera omylem.
  const lines = useMemo(() => (summary ? livePositionChartLines(summary, {
    manageable: manage != null,
    canClose,
    entryAvg,
    pointValue: POINT_VALUE,
    ...(pendingMove ? { pending: { [pendingMove.kind]: pendingMove.price } } : {}),
  }).map(line => ({ ...line, confirmCancel: true })) : []), [canClose, entryAvg, manage, pendingMove, summary]);

  const run = useCallback(async (action: LeaderOrderManageAction, expect: number | null | undefined, newPrice?: number, move?: 'stopLoss' | 'takeProfit') => {
    if (!manage || expect == null) return;
    if (busyRef.current) { onNotice('Čeká se na výsledek předchozí změny — nic se neodeslalo.'); return; }
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
      onNotice(/entry-busy|entry-superseded|entry-not-admitted|manage-daily-cap|Chybí cesta|není čerstvě ověřený|nic se neodeslalo/.test(message)
        ? `Neodesláno: ${message.slice(0, 120)}` : `Výsledek neznámý (${message.slice(0, 120)}) — zkontroluj leadera v Tradovate.`);
    } finally {
      busyRef.current = false;
    }
  }, [busyRef, manage, onNotice, setPendingMove]);

  if (!lines.length) return null;
  return (
    <BacktestOrderLinesOverlay
      api={api}
      lines={lines}
      isDark={isDark}
      selectToDrag
      onChange={(line, kind, price, startLine) => {
        if (line.ownerId !== LIVE_POSITION_OWNER || !summary || kind === 'entry') return;
        const snapped = snapToTick(price, TICK);
        const current = kind === 'stopLoss' ? summary.stop : summary.target;
        if (startLine && startLine.price !== current) { onNotice(`${kind === 'stopLoss' ? 'SL' : 'TP'} se během tažení změnil — nic se neodeslalo.`); return; }
        if (snapped === current) return;
        const blocked = liveLineMoveBlockReason(summary, kind, snapped);
        if (blocked) { onNotice(blocked); return; }
        void run(kind === 'stopLoss' ? 'move-stop' : 'move-target', current, snapped, kind);
      }}
      onCancel={line => {
        if (line.ownerId !== LIVE_POSITION_OWNER || line.kind !== 'entry' || !summary) return;
        if (summary.kind === 'pending') void run('cancel-entry', summary.leader?.entry);
        else void run('close-position', summary.stop);
      }}
      onAction={(line, actionId) => {
        if (line.ownerId !== LIVE_POSITION_OWNER || actionId !== 'break-even' || !summary) return;
        const be = liveBreakEven(summary, entryAvg);
        if (be.blocked || be.price == null) { onNotice(be.blocked ?? 'BE teď nejde.'); return; }
        void run('move-stop', summary.stop, be.price, 'stopLoss');
      }}
    />
  );
}
