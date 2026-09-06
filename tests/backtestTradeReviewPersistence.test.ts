import { describe, expect, it, vi } from 'vitest';
import {
  mergeTradeSnapshotUrls,
  persistBacktestTradeReview,
  type BacktestTradeReviewStorage,
} from '../services/backtestTradeReview';

describe('mergeTradeSnapshotUrls', () => {
  it('keeps the primary image and appends a unique gallery image', () => {
    expect(mergeTradeSnapshotUrls({
      screenshot: 'https://cdn/first.jpg',
      screenshots: ['https://cdn/first.jpg', 'https://cdn/second.jpg'],
    }, 'https://cdn/third.jpg')).toEqual({
      screenshot: 'https://cdn/first.jpg',
      screenshots: ['https://cdn/first.jpg', 'https://cdn/second.jpg', 'https://cdn/third.jpg'],
    });
  });
});

describe('persistBacktestTradeReview', () => {
  const snapshot = { ownerId: 'user-a', authVersion: 1, data: { notes: 'original', screenshot: 'https://cdn/first.jpg', screenshots: ['https://cdn/first.jpg'] } };
  const storage = (): BacktestTradeReviewStorage => ({
    prepareBacktestTradeReview: vi.fn(async () => snapshot),
    uploadScreenshot: vi.fn(async () => 'https://cdn/new.jpg'),
    updateBacktestTradeReview: vi.fn(async () => ({ notes: 'review', screenshots: ['https://cdn/first.jpg', 'https://cdn/concurrent.jpg', 'https://cdn/new.jpg'] })),
  });
  it('passes an append operation and returns the confirmed current gallery', async () => {
    const api = storage();
    const expected = { notes: 'original' };
    const result = await persistBacktestTradeReview(api, 'trade-1', { notes: 'review' }, 'data:image/png;base64,preview', expected);
    expect(api.prepareBacktestTradeReview).toHaveBeenCalledWith('trade-1', { notes: 'review' });
    expect(api.uploadScreenshot).toHaveBeenCalledWith('data:image/png;base64,preview', 'trade-1', 'user-a');
    expect(api.updateBacktestTradeReview).toHaveBeenCalledWith('trade-1', { notes: 'review' }, snapshot, 'https://cdn/new.jpg', expected);
    expect(result.screenshots).toContain('https://cdn/concurrent.jpg');
  });
  it('stops before upload/write when the read or activation prerequisite fails', async () => {
    const api = storage();
    vi.mocked(api.prepareBacktestTradeReview).mockRejectedValue(new Error('gallery unavailable'));
    await expect(persistBacktestTradeReview(api, 'trade-1', { notes: 'draft' }, 'data:image/png;base64,preview')).rejects.toThrow('gallery unavailable');
    expect(api.uploadScreenshot).not.toHaveBeenCalled();
    expect(api.updateBacktestTradeReview).not.toHaveBeenCalled();
  });
  it('does not upload when review has no new snapshot', async () => {
    const api = storage();
    await persistBacktestTradeReview(api, 'trade-1', { notes: 'text only' });
    expect(api.uploadScreenshot).not.toHaveBeenCalled();
    expect(api.updateBacktestTradeReview).toHaveBeenCalledWith('trade-1', { notes: 'text only' }, snapshot, undefined, undefined);
  });
  it('propagates commit conflicts and does not return an optimistic payload', async () => {
    const api = storage();
    vi.mocked(api.updateBacktestTradeReview).mockRejectedValue(new Error('conflict'));
    await expect(persistBacktestTradeReview(api, 'trade-1', { notes: 'draft' })).rejects.toThrow('conflict');
  });
});
