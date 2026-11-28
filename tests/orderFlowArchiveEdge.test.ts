import { describe, expect, it } from 'vitest';
import {
  archiveCanonical,
  archiveObjectPath,
  deriveArchiveKey,
  mayReplaceArchiveDay,
  plausibleNqContracts,
  sha256Hex,
  signArchiveRequest,
  summarizeArchiveDay,
  validateArchiveRequest,
  verifyArchiveRequest,
  type OrderFlowArchiveRequest,
} from '../supabase/functions/orderflow-archive/shared';

const SECRET = 'x'.repeat(48);
const USER = '4ee03dd0-4048-4a48-8354-b8e754b8b7ad';
const NOW = Date.UTC(2026, 10, 28, 9, 0, 0);
const REQ: OrderFlowArchiveRequest = { action: 'prepare', contract: 'NQZ6', tradeDate: '2026-11-25', sha256: 'a'.repeat(64), bytes: 790_000, source: 'backfill' };

describe('archiv order flow — požadavky z Macu', () => {
  it('přijme jen platný den, kontrakt NQ, sha, velikost do 3 MB a známý zdroj', () => {
    expect(validateArchiveRequest(REQ, NOW)).toEqual(REQ);
    expect(validateArchiveRequest({ ...REQ, contract: 'ESZ6' }, NOW)).toEqual({ error: 'invalid-contract' });
    expect(validateArchiveRequest({ ...REQ, tradeDate: '2026-02-30' }, NOW)).toEqual({ error: 'invalid-date' });
    expect(validateArchiveRequest({ ...REQ, tradeDate: '2026-12-25' }, NOW)).toEqual({ error: 'date-out-of-range' });
    expect(validateArchiveRequest({ ...REQ, tradeDate: '2023-01-02' }, NOW)).toEqual({ error: 'date-out-of-range' });
    expect(validateArchiveRequest({ ...REQ, sha256: 'A'.repeat(64) }, NOW)).toEqual({ error: 'invalid-sha256' });
    expect(validateArchiveRequest({ ...REQ, bytes: 4 * 1024 * 1024 }, NOW)).toEqual({ error: 'invalid-bytes' });
    expect(validateArchiveRequest({ ...REQ, source: 'other' }, NOW)).toEqual({ error: 'invalid-source' });
    expect(validateArchiveRequest({ ...REQ, action: 'delete' }, NOW)).toEqual({ error: 'invalid-action' });
    expect(validateArchiveRequest({ ...REQ, contract: 'NQU6' }, NOW)).toEqual({ error: 'contract-not-for-date' });
  });

  it('pro den jdou jen dva nejbližší nevypršelé kontrakty (omezí, co jde nahrát i s uniklým klíčem)', () => {
    expect(plausibleNqContracts('2026-11-25')).toEqual(['NQZ6', 'NQH7']);
    expect(plausibleNqContracts('2026-09-08')).toEqual(['NQU6', 'NQZ6']);
    expect(plausibleNqContracts('2026-12-18')).toEqual(['NQZ6', 'NQH7']);
    expect(plausibleNqContracts('2026-12-21')).toEqual(['NQH7', 'NQM7']);
  });

  it('podpis váže celou operaci a čas; jiný den, sha, zdroj, klíč nebo starý čas neprojde', async () => {
    const key = (await deriveArchiveKey(SECRET, USER))!;
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const header = await signArchiveRequest(key, NOW, REQ);
    expect(await verifyArchiveRequest(header, REQ, SECRET, USER, NOW + 1_000)).toBe(true);
    for (const changed of [{ tradeDate: '2026-11-24' }, { sha256: 'b'.repeat(64) }, { source: 'merged' as const }, { action: 'commit' as const }, { bytes: 790_001 }]) {
      expect(await verifyArchiveRequest(header, { ...REQ, ...changed }, SECRET, USER, NOW)).toBe(false);
    }
    expect(await verifyArchiveRequest(header, REQ, 'y'.repeat(48), USER, NOW)).toBe(false);
    expect(await verifyArchiveRequest(header, REQ, SECRET, USER, NOW + 10 * 60_000)).toBe(false);
    expect(await verifyArchiveRequest(null, REQ, SECRET, USER, NOW)).toBe(false);
    expect(await verifyArchiveRequest('nesmysl', REQ, SECRET, USER, NOW)).toBe(false);
    expect(archiveCanonical(NOW, REQ).split('\n')).toHaveLength(7);
  });

  it('klíč se neodvodí z krátkého tajemství ani z cizího ID', async () => {
    expect(await deriveArchiveKey('short', USER)).toBeNull();
    expect(await deriveArchiveKey(SECRET, 'not-a-uuid')).toBeNull();
    expect(await deriveArchiveKey(SECRET, USER)).not.toBe(await deriveArchiveKey(SECRET, '00000000-0000-4000-8000-000000000000'));
  });

  it('horší zdroj lepší den nepřepíše; cesta obsahuje vlastníka a sha', () => {
    expect(mayReplaceArchiveDay(null, 'backfill')).toBe(true);
    expect(mayReplaceArchiveDay('merged', 'backfill')).toBe(false);
    expect(mayReplaceArchiveDay('live', 'backfill')).toBe(false);
    expect(mayReplaceArchiveDay('backfill', 'merged')).toBe(true);
    expect(mayReplaceArchiveDay('merged', 'merged')).toBe(true);
    expect(archiveObjectPath(USER, REQ)).toBe(`${USER}/NQ/NQZ6/2026-11-25/${'a'.repeat(64)}.json.gz`);
  });

  it('obsah dne musí sedět s požadavkem; souhrn pro tabulku', async () => {
    const day = { v: 1, root: 'NQ', contract: 'NQZ6', tradeDate: '2026-11-25', source: 'merged', minutes: [[1, []], [2, []]], trades: [[]], coverage: [], exactBubbles: [[0, 120_000]], check: { flowVolume: 10, candleVolume: 10 } };
    const merged = { ...REQ, source: 'merged' as const };
    expect(summarizeArchiveDay(day, merged)).toEqual({ minutes: 2, trades: 1, exactMinutes: 2, flowVolume: 10, candleVolume: 10 });
    // zdroj musí sedět s obsahem: „sloučený“ bez přesných bublin ani „historie“ s nimi neprojde
    expect(summarizeArchiveDay({ ...day, exactBubbles: [] }, merged)).toEqual({ error: 'source-mismatch' });
    expect(summarizeArchiveDay({ ...day, source: 'backfill' }, REQ)).toEqual({ error: 'source-mismatch' });
    expect(summarizeArchiveDay({ ...day, tradeDate: '2026-11-24' }, merged)).toEqual({ error: 'day-mismatch' });
    expect(summarizeArchiveDay({ ...day, v: 2 }, merged)).toEqual({ error: 'invalid-version' });
    expect(summarizeArchiveDay({ ...day, check: {} }, merged)).toEqual({ error: 'invalid-check' });
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
