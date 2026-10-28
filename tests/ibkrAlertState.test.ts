import { describe, expect, it } from 'vitest';
import { IBKR_ALERT_AFTER_MS, ibkrAlertNeedsTvCheck, ibkrConnectionProblem, initialIbkrAlertState, nextIbkrAlert } from '../services/ibkrAlertState';

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
