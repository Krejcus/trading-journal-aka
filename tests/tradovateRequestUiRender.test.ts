import { tradovateRequestHealthDisplay } from '../lib/tradovateRequestHealthDisplay';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TvPriceFeedView } from '../lib/tvPriceStore';
import type { TradovateRequestHealth } from '../lib/tradovateRequestControl';
import { ibkrPositionFingerprint } from '../lib/ibkrDisplayPnl';

const state = vi.hoisted(() => ({ view: null as TvPriceFeedView | null, receivedAt: 0 }));
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot() };
});
vi.mock('../services/tvPriceChannel', () => ({
  tvPriceChannel: { addPnlInterest: vi.fn(() => () => {}) },
  tvPriceStore: { subscribe: vi.fn(() => () => {}), view: () => state.view!, diagnostics: () => ({ lastReceivedAt: state.receivedAt }) },
}));
const { LiveOpenPnlValue } = await import('../components/LiveOpenPnlValue');
const { default: TradovateRequestHealthNotice } = await import('../components/TradovateRequestHealthNotice');
const NOW = 1_800_000;
const health = (patch: Partial<TradovateRequestHealth> = {}): TradovateRequestHealth => ({ version: 1, brokerUserId: 123,
  state: 'ready', observedAt: NOW, blockedUntil: null, evidence: null, reason: null, controlFreshUntil: NOW + 5_000, cooldownIsLocalEstimate: true,
  counts: { dispatchAttempts: 0, blockedBeforeDispatch: 0, responses: 0, transportUnknown: 0 }, ...patch });
afterEach(() => vi.restoreAllMocks());

describe('request health and exact display PnL rendered without broker calls', () => {
  it('renders distinct 429, terminal captcha and budget explanations with no command controls', () => {
    for (const [row, text] of [[health({ state: 'cooldown', evidence: 'raw-429' }), 'HTTP 429'],
      [health({ state: 'captcha', evidence: 'captcha' }), 'captcha']] as const) {
      const html = renderToStaticMarkup(React.createElement(TradovateRequestHealthNotice, { rows: [row], now: NOW, floating: true }));
      expect(html).toContain(text); expect(html).toContain('role="status"'); expect(html).not.toContain('<button');
    }
    // Lokální rozpočet (DEMO 10. 11., bez spamu): text existuje, ale první snímek ho ještě neukáže
    // — až po souvislém vyčerpání (`stabilizeTradovateHealthNotices`, vlastní test).
    expect(tradovateRequestHealthDisplay([health({ state: 'budget-limited' })], NOW)?.[0].text).toContain('Lokální rozpočet');
    expect(renderToStaticMarkup(React.createElement(TradovateRequestHealthNotice, { rows: [health({ state: 'budget-limited' })], now: NOW, floating: true }))).toBe('');
    expect(renderToStaticMarkup(React.createElement(TradovateRequestHealthNotice, { rows: [health()], now: NOW }))).toBe('');
  });
  it('renders direct signed IBKR position PnL despite missing broker-anchor legs and preserves the anchor object', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    state.receivedAt = NOW;
    state.view = { fresh: true, samples: [], trail: null, latest: { v: 1, seq: 1, runId: 'run', chart: 'IBKR:MNQZ2026', front: 'MNQZ2026',
      interval: '1', pane: 0, switchAt: null, mode: 'streaming', bar: null, last: 26_010, bid: 26_009.75, ask: 26_010, at: NOW } };
    const capturedAt = NOW - 1_000;
    const original = { anchor: 999, accountId: 100, net: 2, entry: 26_000, capturedAt };
    const leg = { accountId: original.accountId, symbol: 'MNQZ6', netPosition: original.net, averagePrice: original.entry, capturedAt,
      fingerprint: ibkrPositionFingerprint(100, 'MNQZ6', 2, 26_000, capturedAt), fees: 4 };
    const render = () => renderToStaticMarkup(React.createElement(LiveOpenPnlValue, { anchor: original.anchor, legs: null, ibkrLegs: [leg],
      children: (value, live) => React.createElement('span', { 'data-live': live }, String(value)) }));
    expect(render()).toBe('<span data-live="true">36</span>');
    expect(original).toEqual({ anchor: 999, accountId: 100, net: 2, entry: 26_000, capturedAt });
    state.view = { ...state.view, fresh: false };
    expect(render()).toBe('<span data-live="false">999</span>');
  });
  it('renders stale cached cooldown or captcha as unverified current access, not an asserted active block', () => {
    for (const row of [health({ state: 'cooldown', evidence: 'raw-429', observedAt: NOW - 8_001 }),
      health({ state: 'captcha', evidence: 'captcha', observedAt: NOW - 8_001 })]) {
      const html = renderToStaticMarkup(React.createElement(TradovateRequestHealthNotice, { rows: [row], now: NOW }));
      expect(html).toContain('Stav přístupu k brokerovi není ověřený.');
      expect(html).toContain('data-tradovate-health="warn"');
      expect(html).not.toContain('HTTP 429'); expect(html).not.toContain('captcha');
      expect(html).not.toContain('jsou blokované');
    }
  });
  it('renders missing request health as neutral unknown with no command controls', () => {
    for (const rows of [undefined, []]) {
      const html = renderToStaticMarkup(React.createElement(TradovateRequestHealthNotice, { rows, now: NOW }));
      expect(html).toContain('Stav přístupu k brokerovi není ověřený.');
      expect(html).toContain('data-tradovate-health="warn"'); expect(html).not.toContain('<button');
    }
  });
});
