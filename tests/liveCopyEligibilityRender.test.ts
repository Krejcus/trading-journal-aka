import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AccountEligibilityPill } from '../components/LiveCopyTradeOverview';
import type { CopierAccountEligibility } from '../services/copierRuntimeController';

const eligibility = (partial: Partial<CopierAccountEligibility>): CopierAccountEligibility => ({
  accountId: 205, state: 'active', at: 1_000, ...partial,
});

const render = (props: {
  eligibility?: CopierAccountEligibility;
  live: boolean;
  onVerify?: () => void;
  verifying?: boolean;
}) =>
  renderToStaticMarkup(React.createElement(AccountEligibilityPill, props));

describe('AccountEligibilityPill', () => {
  it('bez záznamu a živým spojením ukazuje Aktivní', () => {
    expect(render({ live: true })).toContain('Aktivní');
  });

  it('DLL/BREACH eligibility nezmizí ani při odpojeném broker spojení', () => {
    const html = render({ live: false, eligibility: eligibility({ state: 'dll-locked' }) });
    expect(html).toContain('DLL · do konce session');
    expect(html).not.toContain('Odpojeno');
  });

  it('odpojení se ukazuje samostatně, pokud účet nemá závažnější eligibility stav', () => {
    expect(render({ live: false })).toContain('Odpojeno');
  });

  it('dll-locked ukazuje zámek do konce session s důvodem v tooltip', () => {
    const html = render({
      live: true,
      eligibility: eligibility({ state: 'dll-locked', reason: 'Violation: daily loss limit reached' }),
    });
    expect(html).toContain('DLL · do konce session');
    expect(html).toContain('daily loss limit');
  });

  it('breached je červený a trvalý', () => {
    expect(render({ live: true, eligibility: eligibility({ state: 'breached' }) })).toContain('BREACHED');
  });

  it('unverifiable je fail-closed stav, ne šedý odstín aktivního', () => {
    expect(render({ live: true, eligibility: eligibility({ state: 'unverifiable' }) })).toContain('Stav nelze ověřit');
  });

  it('unverifiable účet nabízí explicitní read-only ověření a busy stav', () => {
    const ready = render({
      live: true,
      eligibility: eligibility({ state: 'unverifiable' }),
      onVerify: () => undefined,
    });
    const busy = render({
      live: true,
      eligibility: eligibility({ state: 'unverifiable' }),
      onVerify: () => undefined,
      verifying: true,
    });

    expect(ready).toContain('aria-label="Ověřit stav účtu u brokera"');
    expect(ready).toContain('Ověřit');
    expect(busy).toContain('Ověřuji…');
    expect(busy).toContain('disabled=""');
  });
});
