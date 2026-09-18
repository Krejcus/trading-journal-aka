import { describe, expect, it } from 'vitest';
import { buildTradovateConnectionUsageRows } from '../lib/tradovateConnectionUsageRows';

describe('řádky využití Tradovate API po připojení', () => {
  const now = Date.parse('2026-09-18T18:55:00.000Z');
  it('sečte web a worker proti limitu, doplní stav session a seřadí podle zátěže', () => {
    const rows = buildTradovateConnectionUsageRows({
      now,
      connections: [
        { id: 'tradeify-1', organizationName: 'Tradeify' },
        { id: 'lucid-1', organizationName: null, tradovateEmail: 'lucid@example.com' },
      ],
      brokerCalls: { 'tradeify-1': { minute: 60, hour: 900 }, 'lucid-1': { minute: 20, hour: 300 } },
      workerUsage: [{
        connectionId: 'tradeify-1', rest: { minute: 25, hour: 200 }, ws: { minute: 2, hour: 10 },
        streamConnected: false, phase: 'syncing', lastClose: { at: now - 60_000, code: 1006, reason: '', clean: false, initiatedBy: 'remote' },
        penaltyUntil: now + 90_000, consecutiveSyncTimeouts: 2,
      }],
    });
    expect(rows.map(row => row.label)).toEqual(['Tradeify', 'lucid@example.com']);
    expect(rows[0].total).toEqual({ minute: 87, hour: 1110 });
    expect(rows[0].level).toBe('over');
    expect(rows[0].session).toMatchObject({ known: true, streamConnected: false, phase: 'syncing', penaltyRemainingMs: 90_000, consecutiveSyncTimeouts: 2 });
    expect(rows[0].session.lastClose?.code).toBe(1006);
    expect(rows[1].worker).toBeNull();
    expect(rows[1].session).toMatchObject({ known: false, phase: 'unknown', penaltyRemainingMs: null });
    expect(rows[1].level).toBe('ok');
  });
  it('ukáže i připojení, o kterém ví jen worker, a vypršelou penalizaci nehlásí', () => {
    const rows = buildTradovateConnectionUsageRows({
      now, connections: [], brokerCalls: {},
      workerUsage: [{ connectionId: 'abcdef12-rest', rest: { minute: 1, hour: 5 }, ws: { minute: 0, hour: 1 }, streamConnected: true, phase: 'connected', lastClose: null, penaltyUntil: now - 1, consecutiveSyncTimeouts: 0 }],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe('conn:abcdef12');
    expect(rows[0].session.penaltyRemainingMs).toBeNull();
    expect(rows[0].total).toEqual({ minute: 1, hour: 6 });
  });
});
