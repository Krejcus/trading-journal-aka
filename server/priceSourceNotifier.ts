import type { PriceSourceAlert } from './tvPriceStreamSupervisor';

/**
 * Oznámení na Macu, když živá cena přestane jít z IBKR (a tiše jede ze zálohy
 * TradingView) a když se vrátí. Jen zobrazení (INV-UI-04): nic odsud
 * nerozhoduje o kopírce. Hlásí se jen v pracovní dny 8–22 h pražského času —
 * noční pauza CME, víkend ani denní restart Gateway nemají budit.
 *
 * Výpadek, který začal mimo tyto hodiny a trvá dál, se ohlásí po jejich začátku.
 * Návrat se hlásí jen po ohlášeném výpadku.
 */

export const PRICE_SOURCE_NOTIFY_TIME_ZONE = 'Europe/Prague';
export const PRICE_SOURCE_NOTIFY_FROM_HOUR = 8;
export const PRICE_SOURCE_NOTIFY_TO_HOUR = 22;
const CHECK_MS = 60_000;
/**
 * Opakovaný výpadek do hodiny od posledního oznámeného (pád vlákna dokola, cukání
 * Gateway) se už neoznamuje — ani jeho návrat. Stačí vědět jednou.
 */
export const PRICE_SOURCE_FLAP_MS = 60 * 60_000;

const COMPETING_SESSION = 10197;
const CONNECTIVITY_LOST = new Set([1100, 2110]);
const DATA_FARM_BROKEN = 2103;
const CONNECTIVITY_RESTORED_DATA_LOST = 1101;

/** Pracovní den a hodina v Praze (víkend = nehlásit). */
export function priceSourceNotifyWindowOpen(at: number): boolean {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: PRICE_SOURCE_NOTIFY_TIME_ZONE, weekday: 'short', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(at));
  const weekday = parts.find(part => part.type === 'weekday')?.value ?? '';
  const hour = Number(parts.find(part => part.type === 'hour')?.value);
  if (weekday === 'Sat' || weekday === 'Sun' || !Number.isFinite(hour)) return false;
  return hour >= PRICE_SOURCE_NOTIFY_FROM_HOUR && hour < PRICE_SOURCE_NOTIFY_TO_HOUR;
}

/** Text oznámení podle stavu a kódu Gateway (nikdy text chyb Gateway). */
export function priceSourceAlertText(alert: PriceSourceAlert): { title: string; body: string } {
  if (alert.state === 'up') return { title: 'IBKR zpět', body: 'Živá cena znovu jde z IBKR.' };
  // Pořadí: aktuální stav spojení má přednost před (možná starším) kódem.
  const reason = alert.ibkr === 'crash' ? 'vlákno ceny s IBKR spadlo, 30 min jen TradingView'
    : alert.code === COMPETING_SESSION ? 'IBKR je přihlášené jinde (mobil nebo web) — Gateway odpojena'
      : alert.ibkr === 'connecting' || alert.ibkr === 'off' || alert.ibkr === 'stopped' ? 'IB Gateway neběží nebo není přihlášená'
        : alert.code !== null && CONNECTIVITY_LOST.has(alert.code) ? 'IB Gateway ztratila spojení s IBKR'
          : alert.code === DATA_FARM_BROKEN ? 'výpadek datové farmy IBKR'
            : alert.code === CONNECTIVITY_RESTORED_DATA_LOST ? 'spojení obnoveno, čeká se na nový odběr dat'
              : alert.ibkr === 'paused' ? `IBKR odmítlo odběr dat${alert.code !== null ? ` (kód ${alert.code})` : ''}`
                : 'IBKR neposílá obchody, TradingView ano';
  return { title: 'IBKR nedostupné — cena z TradingView', body: `Důvod: ${reason}.` };
}

export interface PriceSourceNotifier {
  onAlert(alert: PriceSourceAlert): void;
  stop(): void;
}

export function createPriceSourceNotifier(deps: {
  notify: (title: string, body: string) => void;
  now?: () => number;
  setIntervalImpl?: (callback: () => void, ms: number) => unknown;
  clearIntervalImpl?: (timer: unknown) => void;
}): PriceSourceNotifier {
  const now = deps.now ?? Date.now;
  let down: PriceSourceAlert | null = null;
  let downNotified = false;
  let lastDownNotifiedAt = -Infinity;
  /** Pád vlákna se oznamuje jen jednou za den (pražský den) — smyčka pádů jinak cinká každou hodinu. */
  let crashNotifiedDay: string | null = null;
  const pragueDay = (at: number) => new Intl.DateTimeFormat('en-CA', { timeZone: PRICE_SOURCE_NOTIFY_TIME_ZONE }).format(new Date(at));
  /** Výpadek odškrtnutý bez oznámení (cukání) — jeho návrat se taky neoznamuje. */
  let silent = false;
  const send = (alert: PriceSourceAlert) => {
    const { title, body } = priceSourceAlertText(alert);
    try { deps.notify(title, body); } catch { /* oznámení je best effort */ }
  };
  const check = () => {
    if (down && !downNotified && priceSourceNotifyWindowOpen(now())) {
      downNotified = true;
      // Cukání: výpadek brzy po minulém oznámeném jen tiše odškrtnout (a jeho návrat taky).
      const crashAgain = down.ibkr === 'crash' && crashNotifiedDay === pragueDay(now());
      if (crashAgain || now() - lastDownNotifiedAt < PRICE_SOURCE_FLAP_MS) { silent = true; return; }
      if (down.ibkr === 'crash') crashNotifiedDay = pragueDay(now());
      silent = false;
      lastDownNotifiedAt = now();
      send(down);
    }
  };
  const every = deps.setIntervalImpl ?? ((callback: () => void, ms: number) => {
    const timer = setInterval(callback, ms);
    (timer as { unref?: () => void }).unref?.();
    return timer;
  });
  const cancel = deps.clearIntervalImpl ?? (timer => clearInterval(timer as ReturnType<typeof setInterval>));
  const timer = every(() => { try { check(); } catch { /* nikdy nevyhodí */ } }, CHECK_MS);
  return {
    onAlert(alert) {
      try {
        if (alert.state === 'down') {
          // Opakované hlášení téhož výpadku (pád vlákna během výpadku) neposílá další oznámení.
          if (!down) { down = alert; downNotified = false; }
          check();
          return;
        }
        const wasNotified = downNotified && !silent;
        down = null;
        downNotified = false;
        silent = false;
        if (wasNotified && priceSourceNotifyWindowOpen(now())) send(alert);
      } catch {
        // nikdy nevyhodí
      }
    },
    stop() {
      cancel(timer);
    },
  };
}
