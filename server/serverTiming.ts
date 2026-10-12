/** Server-Timing pro měření z iPhonu: `auth;dur=12.3, resolve;dur=80.1`.
 * Jen názvy fází a milisekundy — žádná data. */
export function createServerTiming(now: () => number = () => performance.now()) {
  const entries: string[] = [];
  let last = now();
  return {
    mark(name: string) {
      const current = now();
      entries.push(`${name};dur=${(current - last).toFixed(1)}`);
      last = current;
    },
    header: () => entries.join(', '),
  };
}
