import { describe, expect, it, vi } from 'vitest';
import { createPriceSourceNotifier, priceSourceAlertText, priceSourceNotifyWindowOpen } from '../server/priceSourceNotifier';

// 28. 10. 2026 je středa; Praha je od 25. 10. v SEČ (UTC+1).
const prague = (hour: number, day = 28) => Date.UTC(2026, 9, day, hour - 1, 30);

const setup = (start: number) => {
  let clock = start;
  let tick: (() => void) | null = null;
  const notify = vi.fn();
  const notifier = createPriceSourceNotifier({
    notify,
    now: () => clock,
    setIntervalImpl: callback => { tick = callback; return 1; },
    clearIntervalImpl: () => {},
  });
  return { notifier, notify, setClock: (value: number) => { clock = value; tick?.(); } };
};

describe('oznámení výpadku IBKR na Macu', () => {
  it('jen v pracovní dny 8–22 h pražského času', () => {
    expect(priceSourceNotifyWindowOpen(prague(8))).toBe(true);
    expect(priceSourceNotifyWindowOpen(prague(21))).toBe(true);
    expect(priceSourceNotifyWindowOpen(prague(22))).toBe(false);
    expect(priceSourceNotifyWindowOpen(prague(7))).toBe(false);
    expect(priceSourceNotifyWindowOpen(prague(12, 31))).toBe(false); // sobota
  });

  it('důvod podle kódu a stavu Gateway, nikdy text chyby', () => {
    expect(priceSourceAlertText({ state: 'down', ibkr: 'paused', code: 10197 }).body).toContain('přihlášené jinde');
    expect(priceSourceAlertText({ state: 'down', ibkr: 'connecting', code: null }).body).toContain('neběží');
    expect(priceSourceAlertText({ state: 'down', ibkr: 'live', code: 1100 }).body).toContain('ztratila spojení');
    expect(priceSourceAlertText({ state: 'down', ibkr: 'crash', code: null }).body).toContain('spadlo');
    expect(priceSourceAlertText({ state: 'down', ibkr: 'live', code: null }).body).toContain('neposílá obchody');
    expect(priceSourceAlertText({ state: 'up', ibkr: null, code: null }).title).toBe('IBKR zpět');
  });

  it('jeden výpadek = jedno oznámení; návrat se hlásí jen po ohlášeném výpadku', () => {
    const t = setup(prague(15));
    t.notifier.onAlert({ state: 'down', ibkr: 'connecting', code: null });
    t.notifier.onAlert({ state: 'down', ibkr: 'crash', code: null });
    t.setClock(prague(15) + 120_000);
    expect(t.notify).toHaveBeenCalledTimes(1);
    expect(t.notify.mock.calls[0][0]).toContain('IBKR nedostupné');
    t.notifier.onAlert({ state: 'up', ibkr: null, code: null });
    expect(t.notify).toHaveBeenCalledTimes(2);
    expect(t.notify.mock.calls[1][0]).toBe('IBKR zpět');
  });

  it('výpadek mimo hodiny se ohlásí až po jejich začátku; v noci vyřešený se nehlásí vůbec', () => {
    const t = setup(prague(6));
    t.notifier.onAlert({ state: 'down', ibkr: 'connecting', code: null });
    expect(t.notify).not.toHaveBeenCalled();
    t.setClock(prague(8));
    expect(t.notify).toHaveBeenCalledTimes(1);
    const night = setup(prague(23));
    night.notifier.onAlert({ state: 'down', ibkr: 'live', code: null });
    night.notifier.onAlert({ state: 'up', ibkr: null, code: null });
    night.setClock(prague(9, 29));
    expect(night.notify).not.toHaveBeenCalled();
  });
});
