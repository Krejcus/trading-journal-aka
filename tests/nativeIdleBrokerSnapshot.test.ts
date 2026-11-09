import { describe, expect, it } from 'vitest';
import { skipIdleBrokerSnapshot, workerRuntimeReportsIdle } from '../server/nativeIdleBrokerSnapshot';

const NOW = Date.parse('2026-11-10T00:02:20.000Z'); // minuta 2 → není pátá
const runtime = (controller: Record<string, unknown> | null, seenAgoMs = 2_000) => ({
  last_seen_at: new Date(NOW - seenAgoMs).toISOString(),
  status: controller ? { controller } : {},
});
const idle = (patch: Record<string, unknown> = {}, exposure: Record<string, unknown> = {}) => runtime({
  connected: true, groupFlat: true, reconciliationRequired: false, lastError: null,
  exposure: { verifiedAt: NOW - 10 * 60_000, positions: [], orders: [], ...exposure }, ...patch,
});

describe('cron broker snapshot is slowed down only when the worker reports a settled flat state', () => {
  it('idle worker: four of five minutes skip the display read', () => {
    expect(workerRuntimeReportsIdle(idle(), NOW)).toBe(true);
    expect(skipIdleBrokerSnapshot(idle(), NOW)).toBe(true);
    expect(skipIdleBrokerSnapshot(idle(), Date.parse('2026-11-10T00:05:20.000Z'))).toBe(false);
    expect(skipIdleBrokerSnapshot(idle({}, { verifiedAt: Date.parse('2026-11-10T00:00:00.000Z') }), Date.parse('2026-11-10T00:10:20.000Z'))).toBe(false);
  });

  it.each([
    ['open position', idle({}, { positions: [{ accountId: 1, symbol: 'MNQZ6', netQuantity: 1 }] })],
    ['working order', idle({}, { orders: [{ brokerOrderId: '1' }] })],
    ['not flat', idle({ groupFlat: false })],
    ['disconnected', idle({ connected: false })],
    ['needs reconciliation', idle({ reconciliationRequired: true })],
    ['incident', idle({ lastError: 'x' })],
    ['exposure changed under three minutes ago', idle({}, { verifiedAt: NOW - 60_000 })],
    ['exposure never verified', idle({}, { verifiedAt: undefined })],
    ['exposure missing', runtime({ connected: true, groupFlat: true, exposure: null })],
    ['verified in the future', idle({}, { verifiedAt: NOW + 60_000 })],
    ['stale heartbeat', (() => { const row = idle(); return { ...row, last_seen_at: new Date(NOW - 120_000).toISOString() }; })()],
    ['no controller', runtime(null)],
  ])('%s is never idle: the broker is read every minute as before', (_label, row) => {
    expect(workerRuntimeReportsIdle(row, NOW)).toBe(false);
    expect(skipIdleBrokerSnapshot(row, NOW)).toBe(false);
  });
});
