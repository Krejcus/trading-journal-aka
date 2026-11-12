import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TradovateRequestHealthNotice from '../components/TradovateRequestHealthNotice';
import type { TradovateRequestHealth } from '../lib/tradovateRequestControl';
import { BUDGET_NOTICE_INITIAL, CONTROL_REFRESH_NOTICE_GRACE_MS, stabilizeTradovateHealthNotices, tradovateRequestHealthDisplay } from '../lib/tradovateRequestHealthDisplay';

const NOW = 1_800_000;
const ready = (patch: Partial<TradovateRequestHealth> = {}): TradovateRequestHealth => ({
  version: 1, brokerUserId: 123, state: 'ready', observedAt: NOW - 2_000,
  controlFreshUntil: NOW - 100, blockedUntil: null, reason: null, evidence: null,
  cooldownIsLocalEstimate: true, counts: { responses: 0, dispatchAttempts: 0, blockedBeforeDispatch: 0, transportUnknown: 0 }, ...patch,
});
const shown = (rows: TradovateRequestHealth[] | undefined, now = NOW) => stabilizeTradovateHealthNotices(
  tradovateRequestHealthDisplay(rows, now), BUDGET_NOTICE_INITIAL, now,
).notices;

describe('brief expiry of a previously ready request-control certificate', () => {
  it('avoids a yellow flash while preserving the raw unknown state and the original expiry', () => {
    const row = ready();
    const before = structuredClone(row);
    expect(tradovateRequestHealthDisplay([row], NOW)?.[0].text).toContain('není ověřený');
    expect(shown([row])).toEqual([]);
    expect(row).toEqual(before);
    expect(shown([ready({ observedAt: NOW + 400, controlFreshUntil: NOW + 3_000 })], NOW + 400)).toEqual([]);
  });
  it('shows a persistent gap at a fixed source deadline, even on the first render of a new client', () => {
    const row = ready();
    const due = row.controlFreshUntil! + CONTROL_REFRESH_NOTICE_GRACE_MS;
    expect(shown([row], due - 1)).toEqual([]);
    expect(shown([row], due)).toHaveLength(1);
    expect(shown([row], due + 500)).toHaveLength(1);
    // A newer heartbeat carrying the same expired certificate cannot reset the grace.
    expect(shown([ready({ observedAt: due + 500 })], due + 500)).toHaveLength(1);
  });
  it.each([
    ready({ state: 'unavailable', reason: 'Request control is not durably ready' }),
    ready({ state: 'captcha', evidence: 'captcha' }),
    ready({ state: 'cooldown', evidence: 'raw-429' }),
    ready({ observedAt: NOW - 8_001 }),
    ready({ observedAt: NOW + 1_001 }),
    ready({ controlFreshUntil: null }),
    ready({ controlFreshUntil: NaN }),
    ready({ evidence: 'raw-429' }),
  ])('does not defer a real failure, penalty or missing/untrustworthy evidence: %j', row => {
    expect(shown([row])).toHaveLength(1);
  });
  it('keeps missing worker health immediate and treats the two logins independently', () => {
    expect(shown(undefined)).toHaveLength(1);
    expect(shown([])).toHaveLength(1);
    expect(shown([ready(), ready({ brokerUserId: 456, state: 'unavailable' })]).map(notice => notice.key)).toEqual(['456']);
  });
  it('renders no transient banner, then renders the persistent unknown with no healthy claim or command control', () => {
    const render = (now: number) => renderToStaticMarkup(React.createElement(TradovateRequestHealthNotice, { rows: [ready()], now }));
    expect(render(NOW)).toBe('');
    const html = render(NOW + CONTROL_REFRESH_NOTICE_GRACE_MS);
    expect(html).toContain('není ověřený');
    expect(html).not.toContain('Connected');
    expect(html).not.toContain('<button');
  });
});
