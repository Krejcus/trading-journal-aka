import { describe, expect, it } from 'vitest';
import { IBKR_QUIET_DOWN_MS, initialIbkrQuiet, nextIbkrQuiet, IBKR_ALERT_AFTER_MS, ibkrAlertNeedsTvCheck, ibkrConnectionProblem, initialIbkrAlertState, nextIbkrAlert } from '../services/ibkrAlertState';

const step = (state = initialIbkrAlertState(), input: Partial<Parameters<typeof nextIbkrAlert>[1]> = {}) =>
  nextIbkrAlert(state, { available: false, connectionProblem: false, tvLive: null, at: 0, ...input });

describe('hlášení výpadku IBKR z vlákna ceny', () => {
  it('nové vlákno při prvním platném čtení pošle „zpět“ (oznamovač zapomene starý výpadek), pak už ne', () => {
    const first = step(undefined, { available: true });
    expect(first.emit).toBe('up');
    expect(step(first.state, { available: true }).emit).toBeNull();
  });

  it('problém spojení: výpadek až po 60 s, jednou', () => {
    let state = step(undefined, { connectionProblem: true, at: 0 }).state;
    expect(step(state, { connectionProblem: true, at: IBKR_ALERT_AFTER_MS - 1 }).emit).toBeNull();
    const down = step(state, { connectionProblem: true, at: IBKR_ALERT_AFTER_MS });
    expect(down.emit).toBe('down');
    state = down.state;
    expect(step(state, { connectionProblem: true, at: IBKR_ALERT_AFTER_MS * 5 }).emit).toBeNull();
    expect(step(state, { available: true, at: IBKR_ALERT_AFTER_MS * 6 }).emit).toBe('up');
  });

  it('IBKR mlčí bez problému spojení: výpadek jen když TV má živou cenu (zavřený trh / svátek nic)', () => {
    const state = step(undefined, { at: 0 }).state;
    expect(ibkrAlertNeedsTvCheck(state, false, false, IBKR_ALERT_AFTER_MS)).toBe(true);
    expect(step(state, { tvLive: false, at: IBKR_ALERT_AFTER_MS }).emit).toBeNull();
    expect(step(state, { tvLive: null, at: IBKR_ALERT_AFTER_MS }).emit).toBeNull();
    expect(step(state, { tvLive: true, at: IBKR_ALERT_AFTER_MS }).emit).toBe('down');
  });

  it('problém spojení podle stavu a kódu; čekání na první obchod (víkend) problém není', () => {
    expect(ibkrConnectionProblem('connecting', null)).toBe(true);
    expect(ibkrConnectionProblem('paused', 10197)).toBe(true);
    expect(ibkrConnectionProblem('live', 1100)).toBe(true);
    expect(ibkrConnectionProblem('subscribing', null)).toBe(false);
    expect(ibkrConnectionProblem('live', null)).toBe(false);
  });
});

describe('tichý výpadek IBKR bez TradingView', () => {
  const run = (steps: Array<{ at: number; sessionOpen?: boolean; connectionProblem?: boolean; available?: boolean }>) => {
    let quiet = initialIbkrQuiet();
    let state = initialIbkrAlertState();
    const emits: Array<'up' | 'down'> = [];
    for (const step of steps) {
      const available = step.available ?? false;
      const connectionProblem = step.connectionProblem ?? false;
      const next = nextIbkrQuiet(quiet, { available, connectionProblem, sessionOpen: step.sessionOpen ?? true, at: step.at });
      quiet = next.quiet;
      const alert = nextIbkrAlert(state, { available, connectionProblem, tvLive: next.quietDown, at: step.at });
      state = alert.state;
      if (alert.emit) emits.push(alert.emit);
    }
    return emits;
  };
  const every5s = (from: number, to: number, extra: object = {}) => Array.from({ length: Math.floor((to - from) / 5_000) + 1 }, (_, index) => ({ at: from + index * 5_000, ...extra }));

  it('v otevřené seanci hlásí až po dvou minutách ticha', () => {
    expect(run(every5s(0, IBKR_QUIET_DOWN_MS - 5_000))).toEqual([]);
    expect(run(every5s(0, IBKR_QUIET_DOWN_MS))).toEqual(['down']);
  });

  it('otevření seance se starým výpadkem nic nehlásí, počítá se od otevření', () => {
    const closed = every5s(0, 3_600_000, { sessionOpen: false });
    const open = every5s(3_605_000, 3_605_000 + IBKR_QUIET_DOWN_MS - 5_000);
    expect(run([...closed, ...open])).toEqual([]);
  });

  it('spánek Macu počítání ticha začne znovu', () => {
    expect(run([...every5s(0, 60_000), ...every5s(600_000, 600_000 + IBKR_QUIET_DOWN_MS - 5_000)])).toEqual([]);
  });

  it('konec problému spojení nezačne hned hlásit výpadek', () => {
    const problem = every5s(0, 30_000, { connectionProblem: true });
    const quietNow = every5s(35_000, 35_000 + IBKR_QUIET_DOWN_MS - 5_000);
    expect(run([...problem, ...quietNow])).toEqual([]);
  });

  it('návrat dat hlásí up', () => {
    expect(run([...every5s(0, IBKR_QUIET_DOWN_MS), { at: IBKR_QUIET_DOWN_MS + 5_000, available: true }])).toEqual(['down', 'up']);
  });
});
