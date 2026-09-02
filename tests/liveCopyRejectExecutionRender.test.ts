import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RejectedExecutionStatus } from '../components/LiveCopyTradeOverview';
import type { CopierAccountEligibility } from '../services/copierRuntimeController';

type RejectedExecution = NonNullable<CopierAccountEligibility['lastExecution']>;

const reason = 'Please check the order price. The current price is outside the price limits set for this product.';
const execution: RejectedExecution = {
  kind: 'rejected',
  reason,
  symbol: 'MNQU6',
  brokerOrderId: 'follower-stop-1',
  orderType: 'Stop',
  side: 'Buy',
  stopPrice: 29_189.75,
  at: Date.UTC(2026, 8, 2, 15, 36, 2),
};

const render = (value: RejectedExecution, accountAuthoritativelyFlat = false) => (
  renderToStaticMarkup(React.createElement(RejectedExecutionStatus, {
    execution: value,
    accountAuthoritativelyFlat,
  }))
);

describe('RejectedExecutionStatus', () => {
  it('nevyřešený reject nad účtem bez potvrzeného flat stavu zůstane rose', () => {
    const markup = render(execution);
    expect(markup).toContain('text-rose-500/90');
    expect(markup).toContain('SL Buy @ 29189.75 odmítnut: cena už byla za zadanou úrovní');
    expect(markup).toContain(`title="Původní broker důvod: ${reason}"`);
  });

  it('guardem vyřešený reject je muted a ukazuje výsledek', () => {
    const markup = render({
      ...execution,
      resolution: {
        kind: 'guard-flattened',
        at: Date.UTC(2026, 8, 2, 15, 36, 6),
        detail: 'leader-flat guard potvrdil flat',
      },
    });
    expect(markup).toContain('text-[var(--text-muted)]');
    expect(markup).not.toContain('text-rose-500/90');
    expect(markup).toContain('kopie zavřena guardem');
    expect(markup).toContain(`title="Původní broker důvod: ${reason}"`);
  });

  it('starý snapshot bez resolution je muted, když aktuální účet autoritativně flat', () => {
    const markup = render(execution, true);
    expect(markup).toContain('text-[var(--text-muted)]');
    expect(markup).toContain('follower je nyní flat');
  });
});
