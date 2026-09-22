import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Trade } from '../types';
import { __resetCopierThumbCacheForTests } from '../services/copierSnapshotThumbs';
import { advanceTradeHistoryIndex, navigationWarmOffsets, warmJournalTradeDetail, warmTradeHistory } from '../services/tradeHistoryWarmup';

const journalTrade = (index: number): Trade => ({
  id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  accountId: `account-${index}`,
  instrument: 'MNQ',
  direction: 'Long',
  pnl: index,
  date: '2026-09-20',
  timestamp: index,
  copierTradeId: `journal:${index}`,
  copierSnapshots: [{ kind: 'exit', at: index, path: `episode/${index}.jpg` }],
} as Trade);

describe('trade history warmup', () => {
  beforeEach(() => __resetCopierThumbCacheForTests());

  it('moves a bounded eight-trade runway in the chosen navigation direction', () => {
    expect(navigationWarmOffsets(null)).toEqual([-1, 1, -2, 2, -3, 3, -4, 4]);
    expect(navigationWarmOffsets(1)).toEqual([1, -1, 2, 3, 4, 5, 6, 7, 8, -2]);
    expect(navigationWarmOffsets(-1)).toEqual([-1, 1, -2, -3, -4, -5, -6, -7, -8, 2]);
  });

  it('accumulates every rapid navigation intent before React renders again', () => {
    let cursor = 2;
    for (let press = 0; press < 10; press += 1) {
      cursor = advanceTradeHistoryIndex(cursor, 1, 20) ?? cursor;
    }
    expect(cursor).toBe(12);

    for (let press = 0; press < 20; press += 1) {
      cursor = advanceTradeHistoryIndex(cursor, -1, 20) ?? cursor;
    }
    expect(cursor).toBe(0);
    expect(advanceTradeHistoryIndex(0, -1, 20)).toBeNull();
    expect(advanceTradeHistoryIndex(19, 1, 20)).toBeNull();
  });

  it('warms only a bounded first screen and batches its signed thumbnails', async () => {
    const trades = Array.from({ length: 20 }, (_, index) => journalTrade(index + 1));
    const signSnapshots = vi.fn(async (snapshots: NonNullable<Trade['copierSnapshots']>) => snapshots.map(snapshot => ({
      ...snapshot, url: `signed:${snapshot.path}`,
    })));
    const decodeImage = vi.fn(async (_url: string) => undefined);
    const markImageLoaded = vi.fn();
    const loadJournalDetails = vi.fn(async (ids: readonly string[]) => ids.map(id => trades.find(trade => trade.id === id)!));

    const result = await warmTradeHistory(trades, 'owner-a', {
      signSnapshots, decodeImage, markImageLoaded, loadJournalDetails,
    });

    expect(result).toEqual({ thumbCandidates: 4, decodedThumbs: 4, detailSelections: 12 });
    expect(signSnapshots).toHaveBeenCalledTimes(1);
    expect(signSnapshots.mock.calls[0][0]).toHaveLength(4);
    expect(decodeImage).toHaveBeenCalledTimes(4);
    expect(markImageLoaded).toHaveBeenCalledTimes(4);
    expect(loadJournalDetails).toHaveBeenCalledTimes(12);
  });

  it('can verify the bounded detail selections in one owner-consistent batch', async () => {
    const trades = Array.from({ length: 6 }, (_, index) => journalTrade(index + 1));
    const loadJournalDetails = vi.fn(async () => [] as Trade[]);
    const loadJournalDetailSelections = vi.fn(async (selections: readonly (readonly string[])[]) => new Map(
      selections.map(ids => [JSON.stringify(ids), ids.map(id => trades.find(trade => trade.id === id)!)]),
    ));

    const result = await warmTradeHistory(trades, 'owner-a', {
      signSnapshots: async snapshots => snapshots.map(snapshot => ({ ...snapshot, url: `signed:${snapshot.path}` })),
      decodeImage: async () => undefined,
      markImageLoaded: () => undefined,
      loadJournalDetails,
      loadJournalDetailSelections,
    });

    expect(result.detailSelections).toBe(6);
    expect(loadJournalDetailSelections).toHaveBeenCalledTimes(1);
    expect(loadJournalDetailSelections.mock.calls[0][0]).toHaveLength(6);
    expect(loadJournalDetails).not.toHaveBeenCalled();
  });

  it('does not warm manual screenshots and does not mark a decoded image after cancellation', async () => {
    const controller = new AbortController();
    const automatic = journalTrade(1);
    const manual = { ...journalTrade(2), screenshot: 'manual.jpg' };
    const markImageLoaded = vi.fn();
    const decodeImage = vi.fn(async () => { controller.abort(); });

    const result = await warmTradeHistory([automatic, manual], 'owner-a', {
      signSnapshots: async snapshots => snapshots.map(snapshot => ({ ...snapshot, url: `signed:${snapshot.path}` })),
      decodeImage,
      markImageLoaded,
      loadJournalDetails: async () => [],
      signal: controller.signal,
    });

    expect(result.thumbCandidates).toBe(1);
    expect(markImageLoaded).not.toHaveBeenCalled();
  });

  it('warms the first detail snapshot after prioritizing the card thumbnail', async () => {
    const selected = {
      ...journalTrade(1),
      copierSnapshots: [
        { kind: 'entry', at: 1, path: 'episode/entry.jpg' },
        { kind: 'exit', at: 2, path: 'episode/exit.jpg' },
      ],
    } as Trade;
    const signSnapshots = vi.fn(async (snapshots: NonNullable<Trade['copierSnapshots']>) => snapshots.map(snapshot => ({
      ...snapshot, url: `signed:${snapshot.path}`,
    })));
    const decodeImage = vi.fn(async (_url: string) => undefined);

    const result = await warmTradeHistory([selected], 'owner-a', {
      signSnapshots,
      decodeImage,
      markImageLoaded: vi.fn(),
      loadJournalDetails: async () => [selected],
    });

    expect(result).toEqual({ thumbCandidates: 1, decodedThumbs: 1, detailSelections: 1 });
    expect(signSnapshots.mock.calls.map(([snapshots]) => snapshots.map(snapshot => snapshot.path))).toEqual([
      ['episode/exit.jpg'],
      ['episode/entry.jpg'],
    ]);
    expect(decodeImage.mock.calls.map(([url]) => url)).toEqual([
      'signed:episode/exit.jpg',
      'signed:episode/entry.jpg',
    ]);
  });

  it('prepares the verified master media before navigating to a combined neighbor', async () => {
    const master = {
      ...journalTrade(1),
      isMaster: true,
      groupId: 'group-a',
      screenshot: 'manual-master.jpg',
      copierSnapshots: [
        { kind: 'entry', at: 1, path: 'episode/entry.jpg' },
        { kind: 'exit', at: 2, path: 'episode/exit.jpg' },
      ],
    } as Trade;
    const follower = { ...journalTrade(2), groupId: 'group-a', masterTradeId: master.id } as Trade;
    const selected = {
      ...master,
      id: 'combined_group-a',
      combinedTradeIds: [master.id, follower.id],
    } as Trade;
    const loadJournalDetails = vi.fn(async () => [follower, master]);
    const signSnapshots = vi.fn(async (snapshots: NonNullable<Trade['copierSnapshots']>) => snapshots.map(snapshot => ({
      ...snapshot, url: `signed:${snapshot.path}`,
    })));
    const decodeArguments: unknown[][] = [];
    const decodeImage = vi.fn(async (...args: unknown[]) => { decodeArguments.push(args); });

    const prepared = await warmJournalTradeDetail(selected, { loadJournalDetails, signSnapshots, decodeImage });

    expect(loadJournalDetails).toHaveBeenCalledWith([String(master.id), String(follower.id)], undefined);
    expect(signSnapshots).toHaveBeenCalledWith(master.copierSnapshots);
    expect(decodeImage.mock.calls.map(([url]) => url)).toEqual([
      'manual-master.jpg',
      'signed:episode/entry.jpg',
      'signed:episode/exit.jpg',
    ]);
    expect(decodeArguments.every(args => args.length === 1)).toBe(true);
    expect(prepared).toEqual({
      tradeId: 'combined_group-a',
      rows: [follower, master],
      signedCopierSnapshots: [
        { kind: 'entry', at: 1, path: 'episode/entry.jpg', url: 'signed:episode/entry.jpg' },
        { kind: 'exit', at: 2, path: 'episode/exit.jpg', url: 'signed:episode/exit.jpg' },
      ],
    });
  });

  it('does not block trade navigation on a secondary screenshot decode', async () => {
    const selected = {
      ...journalTrade(3),
      copierSnapshots: [
        { kind: 'entry', at: 1, path: 'episode/entry.jpg' },
        { kind: 'exit', at: 2, path: 'episode/exit.jpg' },
      ],
    } as Trade;
    let finishSecondary = () => {};
    const decodeImage = vi.fn((url: string) => url.endsWith('entry.jpg')
      ? Promise.resolve()
      : new Promise<void>(resolve => { finishSecondary = resolve; }));
    const warm = warmJournalTradeDetail(selected, {
      loadJournalDetails: async () => [selected],
      signSnapshots: async snapshots => snapshots.map(snapshot => ({ ...snapshot, url: `signed:${snapshot.path}` })),
      decodeImage,
    });

    const result = await Promise.race([
      warm.then(value => ({ state: 'ready' as const, value })),
      new Promise<{ state: 'blocked'; value: null }>(resolve => setTimeout(() => resolve({ state: 'blocked', value: null }), 25)),
    ]);
    finishSecondary();

    expect(result.state).toBe('ready');
    expect(result.value?.tradeId).toBe(String(selected.id));
    expect(decodeImage).toHaveBeenCalledTimes(2);
  });
});
