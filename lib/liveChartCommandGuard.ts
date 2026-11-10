import { liveManageRiskAction, liveUnverifiedActionBlock, type LiveChartRiskAction } from './liveChartRiskPolicy';
import { LiveCommandNotSentError } from './liveCommandErrors';
import {
  attachIntentDraft, bareLegIntentDraft, closeBareIntentDraft, entryIntentDraft, liveChartPositionBaseline, manageIntentDraft, trackLiveChartIntent,
  type LiveChartIntentStore,
} from './liveChartIntent';
import type { LiveChartPosition } from './liveChartPosition';

/**
 * Vstup odeslání z LIVE grafu (10. 11. 2026, review Codexu) jako čistá továrna bez Reactu —
 * `TradovateLiveDesk` dodá jen pozici grafu, úložiště záměrů a samotná odeslání.
 *
 * Každý obal:
 * 1. brána: z neověřené pozice grafu projde jen akce snižující riziko (zavřít, zrušit vstup,
 *    utáhnout SL / BE, přidat SL/TP — `lib/liveChartRiskPolicy.ts`); ostatní dostane
 *    `LiveCommandNotSentError` (kód `not-sent`) a odeslání se nezavolá (INV-UI-01/03).
 * 2. `operationId` vznikne PŘED odesláním a jde do příkazu i do záměru (čekající čára),
 *    takže výsledek, timeout i pozdní odpověď se párují jen přes něj.
 * 3. záměr vznikne synchronně (před prvním `await`); odeslání ho při odchodu relay požadavku
 *    označí `markSent` (desk v relay obalu) — výjimka pak = neznámý výsledek, nikdy návrat.
 * Nic se neopakuje; výsledek ani výjimku obaly nemění.
 */
export interface LiveChartGuardDeps {
  /** Pozice grafu (poslední render desku). */
  position: () => LiveChartPosition;
  store: LiveChartIntentStore;
  newOperationId: () => string;
}

type Result = { status: string; operationId?: string };

export function createLiveChartCommandGuard(deps: LiveChartGuardDeps) {
  /** Politika neověřené pozice (`lib/liveChartRiskPolicy.ts`): riziko snižující akce projdou. */
  const gateFor = (action: LiveChartRiskAction): LiveCommandNotSentError | null => {
    const blocked = liveUnverifiedActionBlock(deps.position().summary, action);
    return blocked ? new LiveCommandNotSentError(blocked) : null;
  };
  const guarded = <R extends Result>(action: LiveChartRiskAction, run: (operationId: string) => Promise<R> | null): Promise<R> => {
    const blocked = gateFor(action);
    if (blocked) return Promise.reject(blocked);
    const operationId = deps.newOperationId();
    return run(operationId) ?? Promise.reject(new LiveCommandNotSentError('Nic se neodeslalo.'));
  };
  return {
    gateFor,
    /** Správa leadera (posun SL/TP/limitu, BE, × pozice, zrušení vstupu). */
    manage<R extends Result>(input: { action: string; symbol: string | null | undefined; expectPrice: number; newPrice?: number },
      send: (operationId: string) => Promise<R>): Promise<R> {
      // Utažení SL se posuzuje proti ceně, kterou worker ověří u brokera (`expect.price`),
      // ne proti případně zastaralému souhrnu grafu.
      return guarded(liveManageRiskAction(input.action, input.newPrice, input.action === 'move-stop' ? input.expectPrice : undefined), operationId => {
        const position = deps.position();
        const draft = manageIntentDraft(input.action, {
          symbol: input.symbol ?? position.symbol, side: position.summary?.side, expectPrice: input.expectPrice, newPrice: input.newPrice,
          entry: position.summary?.entry, quantity: position.summary?.quantity, operationId,
        });
        return trackLiveChartIntent(deps.store, draft, () => send(operationId));
      });
    },
    /** Doplnění SL i TP holé pozice (snižuje riziko — jde i z neověřené pozice). */
    attach<R extends Result>(input: { symbol: string; quantity: number; stopLoss: number; takeProfit: number }, send: (operationId: string) => Promise<R>): Promise<R> {
      return guarded({ kind: 'add-protection' }, operationId => trackLiveChartIntent(deps.store,
        attachIntentDraft({ ...input, side: deps.position().summary?.side }, operationId), () => send(operationId)));
    },
    /** × holé pozice (zavření — jde i z neověřené pozice). */
    closeBare<R extends Result>(seen: Parameters<typeof closeBareIntentDraft>[0], send: (operationId: string) => Promise<R>): Promise<R> {
      return guarded({ kind: 'close' }, operationId => trackLiveChartIntent(deps.store,
        closeBareIntentDraft(seen, deps.position().summary?.entry, operationId), () => send(operationId)));
    },
    /** SL a TP po jedné: přidat (vždy), posunout (SL jen utáhnout, když neověřeno), odebrat (ne, když neověřeno). */
    bareLeg<R extends Result>(seen: Parameters<typeof bareLegIntentDraft>[0], intent: Parameters<typeof bareLegIntentDraft>[1],
      send: (operationId: string) => Promise<R>): Promise<R> {
      const stop = intent.leg === 'stopLoss';
      const action: LiveChartRiskAction = intent.kind === 'add' ? { kind: 'add-protection' }
        : intent.kind === 'remove' ? { kind: stop ? 'remove-stop' : 'remove-target' }
        : stop ? { kind: 'move-stop', newPrice: intent.price, currentStop: intent.current ?? null } : { kind: 'move-target' };
      return guarded(action, operationId => trackLiveChartIntent(deps.store, bareLegIntentDraft(seen, intent, operationId), () => send(operationId)));
    },
    /**
     * Ruční vstup: `operationId` dává volající (PC ho má už z potvrzovacího kliku). Přikoupení i nový
     * vstup na kontraktu NEOVĚŘENÉ pozice riziko zvyšují → odmítnuto; bez neověřené pozice beze změny.
     */
    entry<R extends Result>(draft: Parameters<typeof entryIntentDraft>[0], operationId: string, scaleIn: boolean, send: () => Promise<R>): Promise<R> {
      const position = deps.position();
      const blocked = scaleIn ? gateFor({ kind: 'scale-in' })
        : position.symbol === draft.symbol ? gateFor({ kind: 'entry' }) : null;
      if (blocked) return Promise.reject(blocked);
      return trackLiveChartIntent(deps.store, entryIntentDraft(draft, operationId, liveChartPositionBaseline(position)), send);
    },
  };
}

export type LiveChartCommandGuard = ReturnType<typeof createLiveChartCommandGuard>;
