import { describe, expect, it } from 'vitest';
import {
  BUDGET_NOTICE_INITIAL, BUDGET_NOTICE_REPEAT_AFTER_MS, BUDGET_NOTICE_SHOW_AFTER_MS, stabilizeTradovateHealthNotices, tradovateHumanErrorMessage,
} from '../lib/tradovateRequestHealthDisplay';

const budget = [{ key: '77', tone: 'warn' as const, text: 'Lokální rozpočet požadavků je dočasně vyčerpaný.', title: 't' }];
const captcha = [{ key: '77', tone: 'danger' as const, text: 'Tradovate vyžaduje ruční ověření captcha. Požadavky k brokerovi jsou blokované.', title: 't' }];

describe('DEMO 10. 11. bod 8: rozpočet požadavků lidsky a bez spamu', () => {
  it('neoznačuje chybějící broker identitu za omezení dotazů, které se samo opraví', () => {
    const message = tradovateHumanErrorMessage('tradovate-request-identity-unavailable');
    expect(message).toMatch(/identitu Tradovate/);
    expect(message).not.toMatch(/omezen|rozpočet|limit|za chvilku samy/);
  });
  it('surový kód se nikdy neukáže', () => {
    expect(tradovateHumanErrorMessage('tradovate-request-budget')).toMatch(/šetří dotazy/);
    expect(tradovateHumanErrorMessage('tradovate-request-budget')).not.toMatch(/tradovate-request/);
    expect(tradovateHumanErrorMessage('Něco jiného')).toBe('Něco jiného');
  });

  it('hláška o rozpočtu až po souvislém vyčerpání a po zmizení nejdřív za minutu; captcha hned', () => {
    let memory = BUDGET_NOTICE_INITIAL;
    let at = 0;
    const step = (notices: typeof budget | null, ms: number) => { at += ms; const out = stabilizeTradovateHealthNotices(notices, memory, at); memory = out.memory; return out.notices; };
    expect(step(budget, 0)).toEqual([]);
    expect(step(budget, BUDGET_NOTICE_SHOW_AFTER_MS)).toEqual(budget);
    expect(step(null, 1_000)).toEqual([]);
    // Kolísání rozpočtu do minuty: žádné opakované vyskakování.
    expect(step(budget, 1_000)).toEqual([]);
    expect(step(budget, BUDGET_NOTICE_SHOW_AFTER_MS)).toEqual([]);
    expect(step(budget, BUDGET_NOTICE_REPEAT_AFTER_MS)).toEqual(budget);
    expect(stabilizeTradovateHealthNotices(captcha, BUDGET_NOTICE_INITIAL, 0).notices).toEqual(captcha);
  });
});
