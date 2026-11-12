import { describe, expect, it } from 'vitest';
import { idleBrokerSnapshotUsers, workerRuntimeReportsIdle } from '../server/nativeIdleBrokerSnapshot';

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
  it('worker re-verifies exposure on its own: a fresh verifiedAt alone no longer keeps the cron reading every minute', () => {
    expect(workerRuntimeReportsIdle(idle({}, { verifiedAt: NOW - 20_000 }), NOW)).toBe(true);
    expect(workerRuntimeReportsIdle(idle({}, { verifiedAt: NOW - 20_000, changedAt: NOW - 10 * 60_000 }), NOW)).toBe(true);
    expect(workerRuntimeReportsIdle(idle({ manualEntries: [{ updatedAt: NOW - 10 * 60_000 }], recentCopyEvents: [{ at: NOW - 4 * 60_000 }] }, { verifiedAt: NOW - 20_000 }), NOW)).toBe(true);
  });

  it('idle worker: four of five minutes skip the display read', () => {
    expect(workerRuntimeReportsIdle(idle(), NOW)).toBe(true);
    expect([...idleBrokerSnapshotUsers([{ ...idle(), user_id: 'u1' }], NOW, true)]).toEqual(['u1']);
    const fifth = Date.parse('2026-11-10T00:05:20.000Z');
    expect(idleBrokerSnapshotUsers([{ ...idle(), user_id: 'u1', last_seen_at: new Date(fifth - 1_000).toISOString() }], fifth, true).size).toBe(0);
  });

  it.each([
    ['open position', idle({}, { positions: [{ accountId: 1, symbol: 'MNQZ6', netQuantity: 1 }] })],
    ['working order', idle({}, { orders: [{ brokerOrderId: '1' }] })],
    ['not flat', idle({ groupFlat: false })],
    ['disconnected', idle({ connected: false })],
    ['needs reconciliation', idle({ reconciliationRequired: true })],
    ['incident', idle({ lastError: 'x' })],
    ['exposure changed under three minutes ago (worker sends changedAt)', idle({}, { changedAt: NOW - 60_000 })],
    ['changedAt in the future', idle({}, { changedAt: NOW + 60_000 })],
    ['changedAt not a number', idle({}, { changedAt: null })],
    ['manual entry a minute ago (older worker)', idle({ manualEntries: [{ updatedAt: NOW - 60_000 }] })],
    ['order managed a minute ago (older worker)', idle({ manualOrderActions: [{ updatedAt: NOW - 60_000 }] })],
    ['copy event a minute ago (older worker)', idle({ recentCopyEvents: [{ at: NOW - 60_000 }] })],
    ['trade closed a minute ago (older worker)', idle({ dailyStats: { recentClosedTrades: [{ closedAt: NOW - 60_000 }] } })],
    ['exposure never verified', idle({}, { verifiedAt: undefined })],
    ['exposure missing', runtime({ connected: true, groupFlat: true, exposure: null })],
    ['verified in the future', idle({}, { verifiedAt: NOW + 60_000 })],
    ['stale heartbeat', (() => { const row = idle(); return { ...row, last_seen_at: new Date(NOW - 120_000).toISOString() }; })()],
    ['no controller', runtime(null)],
    ['kill switch', idle({ killSwitch: true })],
    ['day lock running', idle({ dayLockUntil: NOW + 60_000 })],
    ['entry cooldown running', idle({ entryCooldownUntil: NOW + 60_000 })],
    ['switched off a minute ago', idle({ lastDisarm: { at: NOW - 60_000 } })],
    ['switched on a minute ago', idle({ armedAt: NOW - 60_000 })],
  ])('%s is never idle: the broker is read every minute as before', (_label, row) => {
    expect(workerRuntimeReportsIdle(row, NOW)).toBe(false);
    expect(idleBrokerSnapshotUsers([{ ...row, user_id: 'u1' }], NOW, true).size).toBe(0);
  });

  it('armed and flat for a while is still idle; an expired day lock does not block it', () => {
    expect(workerRuntimeReportsIdle(idle({ armed: true, armedAt: NOW - 30 * 60_000, dayLockUntil: 0, entryCooldownUntil: NOW - 1 }), NOW)).toBe(true);
  });

  it('one user with two workers: a flat DEMO worker never slows reads while the other worker is busy', () => {
    const demo = { ...idle(), user_id: 'u1' };
    const live = { ...idle({}, { positions: [{ accountId: 2, symbol: 'MNQZ6', netQuantity: 1 }] }), user_id: 'u1' };
    const other = { ...idle(), user_id: 'u2' };
    expect([...idleBrokerSnapshotUsers([demo, live, other], NOW, true)]).toEqual(['u2']);
    expect([...idleBrokerSnapshotUsers([live, demo, other], NOW, true)]).toEqual(['u2']);
    // Dávno mrtvý druhý worker klid živého neruší.
    const dead = { ...live, last_seen_at: new Date(NOW - 10 * 60_000).toISOString() };
    expect([...idleBrokerSnapshotUsers([demo, dead], NOW, true)]).toEqual(['u1']);
  });

  it('is off unless the server opts in', () => {
    expect(idleBrokerSnapshotUsers([{ ...idle(), user_id: 'u1' }], NOW, false).size).toBe(0);
    expect(idleBrokerSnapshotUsers([{ ...idle(), user_id: 'u1' }], NOW).size).toBe(0);
  });
});
