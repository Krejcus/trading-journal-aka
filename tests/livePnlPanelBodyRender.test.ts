import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  beginTradovateApiRequest,
  finishTradovateApiRequest,
  recordTradovateBrokerCalls,
  resetTradovateApiTelemetryForTests,
} from '../lib/tradovateApiTelemetry';
import type { CopierConnectionUsage } from '../lib/localCopierAgentProtocol';

vi.mock('../utils/useCompactViewport', () => ({ useCompactViewport: () => false }));

const { LivePnlPanelBody } = await import('../components/LiveCopyTradeOverview');

afterEach(() => resetTradovateApiTelemetryForTests());

describe('panel API (fáze 1a): telemetrii a čerpání limitu si počítá sám', () => {
  it('ukazuje požadavky webu z telemetrie a řádek spojení s voláními webu i workeru', () => {
    resetTradovateApiTelemetryForTests();
    const now = Date.now();
    finishTradovateApiRequest(beginTradovateApiRequest(now), 200, null, now);
    finishTradovateApiRequest(beginTradovateApiRequest(now), 429, 5_000, now);
    recordTradovateBrokerCalls('c1', 5, now);
    const workerUsage = [{
      connectionId: 'c1',
      rest: { minute: 2, hour: 30 },
      ws: { minute: 1, hour: 10 },
    } as unknown as CopierConnectionUsage];
    const html = renderToStaticMarkup(React.createElement(LivePnlPanelBody, {
      dataActive: true,
      apiReady: true,
      connections: [{ id: 'c1', connected: true, organizationName: 'Lucid', tradovateEmail: null }],
      workerUsage,
    }));
    expect(html).toContain('2 požadavků');
    expect(html).toContain('1× rate limit');
    expect(html).toContain('data-testid="tradovate-usage-c1"');
    expect(html).toContain('web (tato aplikace) 5/min');
    expect(html).toContain('worker 2/min REST + 1/min WS');
  });
});
