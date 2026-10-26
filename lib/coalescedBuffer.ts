/**
 * Sbírá položky a předává je po dávkách: první přidání hned (časovač 0 ms),
 * další nejvýš jednou za `delayMs`. `flush()` předá zbytek okamžitě a zruší
 * čekající časovač — volá se na konci běhu, při zrušení i v úklidu efektu.
 * Používá Historie pro podepsané náhledy kopírky: každé předání je jeden
 * render celého seznamu.
 */
export function createCoalescedBuffer<T>(deliver: (items: T[]) => void, delayMs = 400) {
  let pending: T[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let delivered = false;
  const flush = () => {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    if (pending.length === 0) return;
    const items = pending;
    pending = [];
    delivered = true;
    deliver(items);
  };
  return {
    add(items: readonly T[]) {
      if (items.length === 0) return;
      pending.push(...items);
      if (timer === null) timer = setTimeout(flush, delivered ? delayMs : 0);
    },
    flush,
  };
}
