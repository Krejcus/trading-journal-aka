import { liveChartProjectionManageBlock } from './liveChartExposureProjection';
import { LiveCommandNotSentError } from './liveCommandErrors';
import {
  attachIntentDraft, bareLegIntentDraft, closeBareIntentDraft, entryIntentDraft, manageIntentDraft, trackLiveChartIntent,
  type LiveChartIntentStore,
} from './liveChartIntent';
import type { LiveChartPosition } from './liveChartPosition';

/**
 * Vstup odeslání z LIVE grafu (10. 11. 2026, review Codexu) jako čistá továrna bez Reactu —
 * `TradovateLiveDesk` dodá jen pozici grafu, úložiště záměrů a samotná odeslání.
 *
 * Každý obal:
 * 1. brána: z neověřené projekce workeru (bez dokladu) NIC neodejde — `LiveCommandNotSentError`
 *    (kód `not-sent`), odeslání se nezavolá. Ovládání se přitom v UI neschovává;
 *    autorizace stojí jen na platném dokladu / ověřeném čtení (INV-UI-01/03).
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
  const gate = (): LiveCommandNotSentError | null => {
    const blocked = liveChartProjectionManageBlock(deps.position());
    return blocked ? new LiveCommandNotSentError(blocked) : null;
  };
  const guarded = <R extends Result>(run: (operationId: string) => Promise<R> | null): Promise<R> => {
    const blocked = gate();
    if (blocked) return Promise.reject(blocked);
    const operationId = deps.newOperationId();
    return run(operationId) ?? Promise.reject(new LiveCommandNotSentError('Nic se neodeslalo.'));
  };
  return {
    gate,
    /** Správa leadera (posun SL/TP/limitu, BE, × pozice, zrušení vstupu). */
    manage<R extends Result>(input: { action: string; symbol: string | null | undefined; expectPrice: number; newPrice?: number },
      send: (operationId: string) => Promise<R>): Promise<R> {
      return guarded(operationId => {
        const position = deps.position();
        const draft = manageIntentDraft(input.action, {
          symbol: input.symbol ?? position.symbol, side: position.summary?.side, expectPrice: input.expectPrice, newPrice: input.newPrice,
          entry: position.summary?.entry, quantity: position.summary?.quantity, operationId,
        });
        return trackLiveChartIntent(deps.store, draft, () => send(operationId));
      });
    },
    /** Doplnění SL i TP holé pozice. */
    attach<R extends Result>(input: { symbol: string; quantity: number; stopLoss: number; takeProfit: number }, send: (operationId: string) => Promise<R>): Promise<R> {
      return guarded(operationId => trackLiveChartIntent(deps.store,
        attachIntentDraft({ ...input, side: deps.position().summary?.side }, operationId), () => send(operationId)));
    },
    /** × holé pozice. */
    closeBare<R extends Result>(seen: Parameters<typeof closeBareIntentDraft>[0], send: (operationId: string) => Promise<R>): Promise<R> {
      return guarded(operationId => trackLiveChartIntent(deps.store,
        closeBareIntentDraft(seen, deps.position().summary?.entry, operationId), () => send(operationId)));
    },
    /** SL a TP po jedné: přidat, posunout, odebrat. */
    bareLeg<R extends Result>(seen: Parameters<typeof bareLegIntentDraft>[0], intent: Parameters<typeof bareLegIntentDraft>[1],
      send: (operationId: string) => Promise<R>): Promise<R> {
      return guarded(operationId => trackLiveChartIntent(deps.store, bareLegIntentDraft(seen, intent, operationId), () => send(operationId)));
    },
    /**
     * Ruční vstup: `operationId` dává volající (PC ho má už z potvrzovacího kliku). Přikoupení
     * (`scaleIn`) zvyšuje riziko → z neověřené pozice nikdy; obyčejný vstup bránu nepotřebuje.
     */
    entry<R extends Result>(draft: Parameters<typeof entryIntentDraft>[0], operationId: string, scaleIn: boolean, send: () => Promise<R>): Promise<R> {
      const blocked = scaleIn ? gate() : null;
      if (blocked) return Promise.reject(blocked);
      return trackLiveChartIntent(deps.store, entryIntentDraft(draft, operationId, deps.position().key), send);
    },
  };
}

export type LiveChartCommandGuard = ReturnType<typeof createLiveChartCommandGuard>;
