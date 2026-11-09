import type { BrokerPort } from './brokerPort';

/**
 * Stavová čtení pozic a příkazů pro už přijatou expozici (9. 11. 2026, INV-TRAD-09).
 *
 * Řadič čte brokera na desítkách míst i mimo explicitní třídu (události ze streamu,
 * časovače, úklid po vypnutí). Taková čtení šla zobrazovacím pruhem `background`, který
 * weby a telefony plní po strop už při otevřeném LIVE — odmítnuté čtení pak znamenalo
 * follower bez ochranného příkazu, vypnutí kopírky nebo tiše vynechaný úklid.
 *
 * Fasáda proto čtení pozic/příkazů (a adresáře účtů při obnově) bez explicitní třídy pustí třídou „accepted“ s
 * vyhasínajícím scope, ale JEN když kopírka nese nebo může nést expozici (`active`).
 * V klidu (vypnuto, flat, nic nepracuje) zůstává vše v běžném rozpočtu. Explicitní
 * třídy (accepted, risk, recovery) se nemění — o tom rozhoduje `runWithLifecycleReads`.
 * Zápisy, risk čtení ani nic jiného fasáda neobaluje.
 */
export const LIFECYCLE_READS_PER_MINUTE = 120;
export const LIFECYCLE_READS_PER_HOUR = 1_200;

export function withLifecycleReads<T extends BrokerPort>(broker: T, active: () => boolean, clock: () => number = Date.now): T {
  const promote = broker.runWithLifecycleReads?.bind(broker);
  if (!promote) return broker;
  // Lokální strop povýšených čtení: nad něj se čtení vrací do původní třídy s rozpočtem,
  // takže chyba ve smyčce nebo záplava událostí nezíská neomezené čtení mimo rozpočet.
  const taken: number[] = [];
  const take = (): boolean => {
    const now = clock();
    while (taken.length && now - taken[0] >= 3_600_000) taken.shift();
    if (taken.length >= LIFECYCLE_READS_PER_HOUR) return false;
    let lastMinute = 0;
    for (let index = taken.length - 1; index >= 0 && now - taken[index] < 60_000; index -= 1) lastMinute += 1;
    if (lastMinute >= LIFECYCLE_READS_PER_MINUTE) return false;
    taken.push(now);
    return true;
  };
  const lifecycle = <R>(read: () => Promise<R>): Promise<R> => {
    let on = false;
    try { on = active(); } catch { on = false; }
    return on && take() ? promote(read) : read();
  };
  // Ostatní metody se přeposílají s hledáním až při volání: úprava metody na původním
  // objektu po sestavení (směrovač, testy) se tak projeví stejně jako dřív.
  const facade: Record<string, unknown> = { ...(broker as unknown as Record<string, unknown>) };
  for (const [key, value] of Object.entries(broker)) {
    if (typeof value !== 'function') continue;
    facade[key] = (...args: unknown[]) => (broker as unknown as Record<string, (...input: unknown[]) => unknown>)[key](...args);
  }
  const reads: Pick<BrokerPort, 'listPositions' | 'listOrders' | 'findOrderById' | 'findOrdersByTag' | 'listAccountCapabilities'> = {
    listAccountCapabilities: accountIds => lifecycle(() => broker.listAccountCapabilities(accountIds)),
    listPositions: accountId => lifecycle(() => broker.listPositions(accountId)),
    listOrders: (accountId, options) => lifecycle(() => broker.listOrders(accountId, options)),
    findOrderById: (accountId, brokerOrderId) => lifecycle(() => broker.findOrderById(accountId, brokerOrderId)),
    findOrdersByTag: (accountId, tag) => lifecycle(() => broker.findOrdersByTag(accountId, tag)),
  };
  return Object.assign(facade, reads) as unknown as T;
}
