// Serverová pojistka automatického pokračování po výpadku (10. 10. 2026).
import { describe, expect, it } from 'vitest';
import { admitCopierAutoResume, AUTO_RESUME_BRAKE_MARGIN_MS } from '../server/tradovateCopierCommandRelay';

type Row = { id: string; user_id: string; device_id: string; command_type: string; status: string; created_at: string; expires_at: string };
const fakeDb = (rows: Row[]) => ({
  from: () => {
    let filtered = rows;
    const chain = {
      select: () => chain,
      eq: (column: keyof Row, value: string) => { filtered = filtered.filter(row => row[column] === value); return chain; },
      in: (column: keyof Row, values: string[]) => { filtered = filtered.filter(row => values.includes(row[column])); return chain; },
      gte: (column: keyof Row, value: string) => { filtered = filtered.filter(row => row[column] >= value); return chain; },
      gt: (column: keyof Row, value: string) => { filtered = filtered.filter(row => row[column] > value); return chain; },
      order: () => { filtered = [...filtered].sort((a, b) => b.created_at.localeCompare(a.created_at)); return chain; },
      limit: async () => ({ data: filtered.map(row => ({ id: row.id, created_at: row.created_at })), error: null }),
    };
    return chain;
  },
}) as never;

const NOW = Date.parse('2026-10-10T15:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const row = (patch: Partial<Row>): Row => ({
  id: 'x', user_id: 'user', device_id: 'dev', command_type: 'arm-live', status: 'succeeded',
  created_at: iso(NOW - 10 * 60_000), expires_at: iso(NOW - 9 * 60_000), ...patch,
});
const since = NOW - 5 * 60_000;

describe('admitCopierAutoResume', () => {
  it('čistá historie a prázdná fronta = povoleno', async () => {
    expect(await admitCopierAutoResume({ db: fakeDb([row({})]), userId: 'user', deviceId: 'dev', since, now: NOW }))
      .toEqual({ admitted: true, reason: null });
  });

  it('brzda od zapnutí (v jakémkoli stavu, i v rezervě hodin) = zamítnuto', async () => {
    for (const status of ['pending', 'claimed', 'succeeded', 'expired']) {
      const result = await admitCopierAutoResume({
        db: fakeDb([row({ command_type: 'disarm', status, created_at: iso(since - AUTO_RESUME_BRAKE_MARGIN_MS + 1_000) })]),
        userId: 'user', deviceId: 'dev', since, now: NOW,
      });
      expect(result.admitted).toBe(false);
    }
    // Brzda na jiné zařízení téhož uživatele se počítá; cizí uživatel ne.
    expect((await admitCopierAutoResume({
      db: fakeDb([row({ device_id: 'other', command_type: 'kill-switch', created_at: iso(NOW - 1_000) })]),
      userId: 'user', deviceId: 'dev', since, now: NOW,
    })).admitted).toBe(false);
    expect((await admitCopierAutoResume({
      db: fakeDb([row({ user_id: 'someone', device_id: 'other', command_type: 'kill-switch', created_at: iso(NOW - 1_000) })]),
      userId: 'user', deviceId: 'dev', since, now: NOW,
    })).admitted).toBe(true);
    // Kotva serverovým časem téhož zapnutí: Mac s hodinami napřed brzdu neschová.
    expect((await admitCopierAutoResume({
      db: fakeDb([
        row({ command_type: 'arm-live', created_at: iso(NOW - 3 * 60_000) }),
        row({ id: 'b', command_type: 'disarm', created_at: iso(NOW - 150_000) }),
      ]),
      userId: 'user', deviceId: 'dev', since: NOW - 60_000, now: NOW,
    })).admitted).toBe(false);
    // Starý vzdálený ON (včera) kotvu neposune: dnešní ON byl z lokálního UI.
    expect((await admitCopierAutoResume({
      db: fakeDb([
        row({ command_type: 'arm-live', created_at: iso(NOW - 20 * 3_600_000) }),
        row({ id: 'b', command_type: 'disarm', created_at: iso(NOW - 19 * 3_600_000) }),
      ]),
      userId: 'user', deviceId: 'dev', since: NOW - 10 * 60_000, now: NOW,
    })).admitted).toBe(true);
  });

  it('čekající neexpirovaný příkaz = zamítnuto, prošlý ne', async () => {
    expect((await admitCopierAutoResume({
      db: fakeDb([row({ command_type: 'copy-command', status: 'pending', expires_at: iso(NOW + 10_000) })]),
      userId: 'user', deviceId: 'dev', since, now: NOW,
    })).reason).toBe('ve frontě čeká příkaz');
    expect((await admitCopierAutoResume({
      db: fakeDb([row({ command_type: 'copy-command', status: 'pending', expires_at: iso(NOW - 10_000) })]),
      userId: 'user', deviceId: 'dev', since, now: NOW,
    })).admitted).toBe(true);
  });

  it('neplatný čas posledního zapnutí = zamítnuto', async () => {
    expect((await admitCopierAutoResume({ db: fakeDb([]), userId: 'user', deviceId: 'dev', since: Number.NaN, now: NOW })).admitted).toBe(false);
  });
});
