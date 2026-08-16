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
  it('uploads a pending data URL only when save is requested and persists one merged payload', async () => {
    const storage: BacktestTradeReviewStorage = {
      getTradeScreenshots: vi.fn(async () => new Map([['trade-1', {
        screenshot: 'https://cdn/first.jpg',
        screenshots: ['https://cdn/first.jpg'],
      }]])),
      uploadScreenshot: vi.fn(async () => 'https://cdn/new.jpg'),
      updateTrade: vi.fn(async () => undefined),
    };
    const payload = await persistBacktestTradeReview(
      storage,
      'trade-1',
      { notes: 'review', isValid: true },
      'data:image/png;base64,preview',
    );

    expect(storage.getTradeScreenshots).toHaveBeenCalledWith(['trade-1']);
    expect(storage.uploadScreenshot).toHaveBeenCalledWith('data:image/png;base64,preview', 'trade-1');
    expect(storage.updateTrade).toHaveBeenCalledTimes(1);
    expect(payload).toEqual({
      notes: 'review',
      isValid: true,
      screenshot: 'https://cdn/first.jpg',
      screenshots: ['https://cdn/first.jpg', 'https://cdn/new.jpg'],
    });
    expect(storage.updateTrade).toHaveBeenCalledWith('trade-1', payload);
  });

  it('does not touch screenshot storage when review has no new snapshot', async () => {
    const storage: BacktestTradeReviewStorage = {
      getTradeScreenshots: vi.fn(),
      uploadScreenshot: vi.fn(),
      updateTrade: vi.fn(async () => undefined),
    };
    await persistBacktestTradeReview(storage, 'trade-1', { notes: 'text only' });
    expect(storage.getTradeScreenshots).not.toHaveBeenCalled();
    expect(storage.uploadScreenshot).not.toHaveBeenCalled();
    expect(storage.updateTrade).toHaveBeenCalledWith('trade-1', { notes: 'text only' });
  });
});
