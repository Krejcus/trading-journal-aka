import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, unknown>();
const failing = { read: false, write: false };
vi.mock('idb-keyval', () => ({
  get: async (key: string) => {
    if (failing.read) throw new Error('blocked');
    return store.get(key);
  },
  set: async (key: string, value: unknown) => {
    if (failing.write) throw new Error('full');
    store.set(key, value);
  },
  getMany: async () => [],
  setMany: async () => undefined,
}));
vi.mock('../services/supabase', () => ({ supabase: {} }));

const { DAY_TAIL_MAX_CAP_GAP_MS, historyReadyForChart, readDayTail, writeDayTail } = await import('../services/dayCandles');

const CAP = Date.UTC(2026, 10, 5, 3, 15);
const candle = { time: CAP / 1_000 - 60, open: 1, high: 2, low: 1, close: 2, volume: 3 };
const tail = { day: '2026-11-06', anchorKey: '', capKey: CAP, symbol: 'MNQ.v.0', candles: [candle] };
const covered = new Date(CAP).toISOString();

describe('historie grafu dne v zařízení', () => {
  beforeEach(() => {
    store.clear();
    failing.read = false;
    failing.write = false;
  });

  it('vrátí uloženou historii jen pro stejný den a kotvu', async () => {
    await writeDayTail(tail, covered);
    expect(await readDayTail('2026-11-06', '', CAP)).toEqual(tail);
    expect(await readDayTail('2026-11-07', '', CAP)).toBeNull();
    expect(await readDayTail('2026-11-06', 'MNQ:1:2', CAP)).toBeNull();
  });

  it('starší hranici vezme jen do limitu, novější nikdy (díra v řadě)', async () => {
    await writeDayTail(tail, covered);
    expect(await readDayTail('2026-11-06', '', CAP + DAY_TAIL_MAX_CAP_GAP_MS)).toEqual(tail);
    expect(await readDayTail('2026-11-06', '', CAP + DAY_TAIL_MAX_CAP_GAP_MS + 1)).toBeNull();
    expect(await readDayTail('2026-11-06', '', CAP - 1)).toBeNull();
  });

  it('historie ze zařízení čeká na živé čtení; ze sítě a po dojetí živého čtení jde dál', () => {
    const device = { fromDevice: true };
    const network = { fromDevice: false };
    expect(historyReadyForChart(device, true, true)).toBeNull();
    expect(historyReadyForChart(device, true, false)).toBe(device);
    expect(historyReadyForChart(device, false, true)).toBe(device);
    expect(historyReadyForChart(network, true, true)).toBe(network);
    expect(historyReadyForChart(null, true, true)).toBeNull();
  });

  it('do zařízení jde jen odpověď Databenta, ne svíčky složené se živými (INV-UI-04)', () => {
    const hook = readFileSync(join(process.cwd(), 'hooks/useDayChartData.ts'), 'utf8');
    expect(hook.match(/writeDayTail\(/g)).toHaveLength(1);
    expect(hook).toContain('writeDayTail({ day, anchorKey, capKey, symbol: response.symbol, candles: response.candles }, response.end)');
  });

  it('neuloží odpověď, která hranici nepokryla, ani prázdnou', async () => {
    await writeDayTail(tail, new Date(CAP - 1).toISOString());
    await writeDayTail(tail, undefined);
    await writeDayTail({ ...tail, candles: [] }, covered);
    await writeDayTail({ ...tail, capKey: 0 }, covered);
    expect(store.size).toBe(0);
  });

  it('poškozený záznam ani nedostupné úložiště graf nerozbijí', async () => {
    store.set('day-candles-tail-v1', { day: '2026-11-06', anchorKey: '', capKey: 'x', candles: 'y' });
    expect(await readDayTail('2026-11-06', '', CAP)).toBeNull();
    failing.read = true;
    expect(await readDayTail('2026-11-06', '', CAP)).toBeNull();
    failing.write = true;
    await expect(writeDayTail(tail, covered)).resolves.toBeUndefined();
  });
});
