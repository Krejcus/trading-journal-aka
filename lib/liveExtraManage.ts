import type { BacktestChartOrderLine, BacktestChartOrderLineKind } from '../services/backtestOrderLines';
import type { LeaderOrderManageResult } from './leaderOrderManage';
import { liveExtraLineTarget } from './liveExtraOrderLines';

/**
 * Odeslání akce na DALŠÍM příkazu v grafu (další čekající vstup, noha části pozice) — PC i telefon. Cíl je id
 * příkazu u brokera z čáry; cena, kterou uživatel viděl, je jen kontrola. Jeden příkaz naráz (sdílený zámek čar),
 * právě jedno volání, nic se neopakuje; neznámý výsledek se hlásí jako neznámý (INV-UI-01, INV-OUTBOX-01).
 */
export type LiveManageOrderCallback = (
  target: { type: 'order' | 'leg'; orderId: string }, action: 'move' | 'cancel', kind: BacktestChartOrderLineKind, expectPrice: number, newPrice?: number,
) => Promise<LeaderOrderManageResult>;

export interface LiveExtraManageNotice { tone: 'ok' | 'bad' | 'warn'; text: string; at: number }

export const LIVE_EXTRA_BUSY_TEXT = 'Čeká se na výsledek předchozí změny — nic se neodeslalo.';

export interface LiveExtraManageDeps {
  manage: LiveManageOrderCallback | null | undefined;
  busyRef: { current: boolean };
  report: (notice: LiveExtraManageNotice) => void;
  /** Id čáry, jejíž změna právě běží (štítek „mění se“); null po skončení. */
  setPending?: (lineId: string | null) => void;
  now?: () => number;
}

export async function runLiveExtraManage(deps: LiveExtraManageDeps, input: {
  line: Pick<BacktestChartOrderLine, 'id' | 'ownerId' | 'kind'>; action: 'move' | 'cancel'; expect: number; next?: number;
}): Promise<'not-sent' | LeaderOrderManageResult['status']> {
  const now = deps.now ?? Date.now;
  const target = liveExtraLineTarget(input.line);
  if (!target) return 'not-sent';
  if (!deps.manage) { deps.report({ tone: 'bad', text: 'Správa příkazu z grafu teď nejde — nic se neodeslalo.', at: now() }); return 'not-sent'; }
  if (!Number.isFinite(input.expect) || (input.action === 'move' && (input.next === undefined || !Number.isFinite(input.next)))) {
    deps.report({ tone: 'bad', text: 'Cena příkazu není známá — nic se neodeslalo.', at: now() });
    return 'not-sent';
  }
  if (deps.busyRef.current) { deps.report({ tone: 'warn', text: LIVE_EXTRA_BUSY_TEXT, at: now() }); return 'not-sent'; }
  deps.busyRef.current = true;
  deps.setPending?.(input.line.id);
  try {
    const result = await deps.manage(target, input.action, input.line.kind, input.expect, input.next);
    if (result.status === 'acknowledged') {
      deps.report({ tone: 'ok', at: now(), text: input.action === 'cancel' ? 'Vstup zrušen.' : input.line.kind === 'entry' ? 'Vstup posunut.' : `${input.line.kind === 'stopLoss' ? 'SL' : 'TP'} posunut.` });
    } else if (result.status === 'blocked') {
      deps.report({ tone: 'bad', at: now(), text: `Neodesláno: ${result.blockers.map(issue => issue.text).join(' ')}` });
    } else if (result.status === 'rejected') {
      deps.report({ tone: 'bad', at: now(), text: result.reason ?? 'Broker změnu odmítl.' });
    } else {
      deps.report({ tone: 'warn', at: now(), text: result.reason ?? 'Výsledek není znám — zkontroluj příkazy, nic neopakuj.' });
    }
    return result.status;
  } catch (reason) {
    // Výjimka po zavolání = výsledek neznámý; nic se znovu neposílá.
    deps.report({ tone: 'warn', at: now(), text: `Výsledek není znám (${reason instanceof Error ? reason.message.slice(0, 120) : 'chyba'}) — zkontroluj příkazy, nic neopakuj.` });
    return 'unknown';
  } finally {
    deps.busyRef.current = false;
    deps.setPending?.(null);
  }
}
