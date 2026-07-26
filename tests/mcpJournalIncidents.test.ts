import { describe, expect, it } from 'vitest';
import { incidentForMcp, incidentJournalLine } from '../supabase/functions/mcp-server/journalIncidents';

describe('MCP journal incidenty bez tradů', () => {
  const incident = {
    id: 'incident-1',
    timestamp: Date.parse('2026-07-23T19:00:00+02:00'),
    type: 'gambling',
    title: 'Večerní gamble',
    whatHappened: 'Vstupy bez plánu.',
    trigger: 'Nuda.',
    lesson: 'Po session zavřít graf.',
    allocations: [
      { label: 'Lucid Funded', lossAmount: 500, currency: 'USD' },
      { label: 'Tradeify', lossAmount: 600, currency: 'USD' },
    ],
  };

  it('vrací kompletní strukturovaný incident a drží ho mimo trade statistiky', () => {
    expect(incidentForMcp(incident)).toMatchObject({
      type: 'gambling',
      loss_usd: 1100,
      excluded_from_trade_stats: true,
      allocations: [
        { label: 'Lucid Funded', loss_amount: 500 },
        { label: 'Tradeify', loss_amount: 600 },
      ],
    });
  });

  it('v textovém snapshotu výslovně odděluje incident od obchodů', () => {
    const line = incidentJournalLine(incident);
    expect(line).toContain('INCIDENT BEZ TRADŮ [GAMBLING]');
    expect(line).toContain('ztráta -$1,100');
    expect(line).toContain('Lucid Funded -$500');
    expect(line).toContain('NEZAHRNOVAT do počtu obchodů, WR, RR, PF ani trade P&L');
  });
});
