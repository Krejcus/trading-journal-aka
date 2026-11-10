import type { TradovateAccountDataResult } from './tradovateAccountDataTypes';

/**
 * Pořadí REST čtení vůči stavu workeru v LIVE grafu (10. 11. 2026, review Codexu).
 *
 * Čas příchodu odpovědi ani hodiny serveru pořadí neurčují: požadavek odeslaný před
 * fillem může dorazit až po posledním stavu workeru a hodiny Vercelu, workeru a prohlížeče
 * se liší. Proto monotónní SEKVENCE ZAHÁJENÍ požadavku v tomto prohlížeči: čtení s vyšším
 * číslem bylo zahájeno později, takže u brokera četlo stav nejméně tak nový jako vše, co
 * graf do okamžiku přidělení čísla viděl. Jen zobrazení — nikdy autorizace.
 */
let sequence = 0;

/** Nové číslo pro právě zahajované REST čtení pozic/příkazů. */
export function nextTradovateClientReadSeq(): number {
  sequence += 1;
  return sequence;
}

/** Nejvyšší dosud přidělené číslo — čtení s vyšším číslem začalo až po tomto okamžiku. */
export function currentTradovateClientReadSeq(): number {
  return sequence;
}

/**
 * Pro každý účet: sekvence REST požadavků v okamžiku, kdy graf naposledy kreslil jeho stav ze
 * workeru. Žije v MODULU se stejnou životností jako čítač (ne v komponentě): po remountu grafu
 * (přepnutí záložky, telefon ↔ PC rozložení) tak pozdní starší REST odpověď znovu nevyrobí flat.
 * Hodnota jen roste.
 */
const workerShownSeq = new Map<number, number>();

/** Graf právě (po renderu) kreslí stav workeru těchto účtů. */
export function noteTradovateWorkerShown(accountIds: Iterable<number>, seq = sequence): void {
  for (const id of accountIds) workerShownSeq.set(id, Math.max(workerShownSeq.get(id) ?? 0, seq));
}

export function tradovateWorkerShownSeq(): ReadonlyMap<number, number> {
  return workerShownSeq;
}

/** Jen pro testy. */
export function resetTradovateClientReadSeqForTests(value = 0): void {
  sequence = value;
  workerShownSeq.clear();
}

/**
 * Označí účty, kterým tohle čtení skutečně změnilo pozice / příkazy (`positionsAsOf` /
 * `ordersAsOf`), sekvencí zahájení požadavku; ostatním nechá předchozí označení (merge
 * starší odpovědi novější čtení nepřepíše, takže ani jeho číslo). `requestSeq` null =
 * začátek neznámý (předstartované čtení) → 0, tedy „starší než cokoli“.
 */
export function stampTradovateClientReads<T extends TradovateAccountDataResult>(
  previous: TradovateAccountDataResult | null | undefined,
  next: T,
  requestSeq: number | null,
): T {
  const before = new Map((previous?.accounts ?? []).map(account => [account.id, account.readState]));
  let changed = false;
  const accounts = next.accounts.map(account => {
    const read = account.readState;
    if (!read) return account;
    const prior = before.get(account.id);
    const positionsSeq = prior && prior.positionsAsOf === read.positionsAsOf ? prior.clientPositionsReadSeq ?? 0 : requestSeq ?? 0;
    const ordersSeq = prior && prior.ordersAsOf === read.ordersAsOf ? prior.clientOrdersReadSeq ?? 0 : requestSeq ?? 0;
    if (read.clientPositionsReadSeq === positionsSeq && read.clientOrdersReadSeq === ordersSeq) return account;
    changed = true;
    return { ...account, readState: { ...read, clientPositionsReadSeq: positionsSeq, clientOrdersReadSeq: ordersSeq } };
  });
  return changed ? { ...next, accounts } : next;
}
