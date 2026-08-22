import { beforeEach, describe, expect, it } from 'vitest';
import {
  persistAccountSnapshots,
  resetAccountSnapshotThrottleCacheForTests,
} from '../server/copierAccountSnapshotStore';

interface StoredRow {
  external_account_id: string;
  captured_at: string;
  auto_liq_level?: number | null;
}

const account = {
  accountId: 42,
  accountName: 'Funded 42',
  balance: 50_125,
  realizedPnl: 125,
  openPnl: 0,
  totalPnl: 125,
  canTrade: true,
  changesLocked: false,
  autoLiqLevel: 48_750,
};

function mockDb() {
  const rows: StoredRow[] = [];
  let cutoff = '';
  let ids: string[] = [];
  return {
    rows,
    db: {
      from() {
        return {
          select() {
            const chain = {
              eq() { return chain; },
              gt(_column: string, value: string) { cutoff = value; return chain; },
              async in(_column: string, value: string[]) {
                ids = value;
                return {
                  data: rows.filter(row => row.captured_at > cutoff && ids.includes(row.external_account_id)),
                  error: null,
                };
              },
            };
            return chain;
          },
          async insert(payload: StoredRow[]) {
            rows.push(...payload);
            return { error: null };
          },
        };
      },
    },
  };
}

describe('account snapshot 15min throttle', () => {
  beforeEach(() => resetAccountSnapshotThrottleCacheForTests());

  it('writes at most once inside 15 minutes and allows the exact next interval', async () => {
    const { db, rows } = mockDb();
    const start = Date.parse('2026-08-22T10:00:00.000Z');
    const write = (capturedAt: number) => persistAccountSnapshots({
      db: db as never,
      userId: 'user-1',
      connectionId: 'connection-1',
      accounts: [account],
      capturedAt,
    });

    expect(await write(start)).toBe(1);
    expect(await write(start + 14 * 60_000)).toBe(0);
    expect(await write(start + 15 * 60_000)).toBe(1);
    expect(rows).toHaveLength(2);
    expect(rows.map(row => row.captured_at)).toEqual([
      '2026-08-22T10:00:00.000Z',
      '2026-08-22T10:15:00.000Z',
    ]);
    expect(rows.map(row => row.auto_liq_level)).toEqual([48_750, 48_750]);
  });
});
