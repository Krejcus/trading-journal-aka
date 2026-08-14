import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/runtimeConfig', () => ({ isNativeBuild: true }));

const plugin = vi.hoisted(() => ({
  presentCalendarEvent: vi.fn(),
}));

vi.mock('../services/alphaTradeNativePlugin', () => ({ alphaTradeNativePlugin: plugin }));

import {
  presentNativeCalendarEvent,
  type NativeCalendarEventPayload,
} from '../services/nativeCapabilities';

const payload: NativeCalendarEventPayload = {
  title: 'AlphaTrade · LIVE seance',
  startTimestampMs: 1_786_694_400_000,
  durationMinutes: 90,
  location: 'AlphaTrade',
  notes: 'Uložení potvrzuje uživatel.',
};

describe('native Calendar editor bridge', () => {
  beforeEach(() => vi.clearAllMocks());

  it('passes only the explicit event draft to the system editor', async () => {
    plugin.presentCalendarEvent.mockResolvedValueOnce({ action: 'saved' });
    await expect(presentNativeCalendarEvent(payload)).resolves.toEqual({ action: 'saved' });
    expect(plugin.presentCalendarEvent).toHaveBeenCalledWith(payload);
  });

  it('reports cancellation without pretending that an event was saved', async () => {
    plugin.presentCalendarEvent.mockResolvedValueOnce({ action: 'cancelled' });
    await expect(presentNativeCalendarEvent(payload)).resolves.toEqual({ action: 'cancelled' });
  });
});
