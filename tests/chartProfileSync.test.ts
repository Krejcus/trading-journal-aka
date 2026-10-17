import { describe, expect, it } from 'vitest';
import { decideChartProfileSync, EMPTY_CHART_PROFILE_SYNC_STATE, type ChartProfileSyncState } from '../services/chartProfile';

const state = (patch: Partial<ChartProfileSyncState>): ChartProfileSyncState => ({ ...EMPTY_CHART_PROFILE_SYNC_STATE, ...patch });

describe('decideChartProfileSync — novější změna vyhraje', () => {
  it('bez profilu na serveru nahraje místní', () => {
    expect(decideChartProfileSync({ state: state({}), localHash: 'a', serverHash: null, serverAt: null })).toBe('push-local');
  });

  it('první běh nové verze převezme server', () => {
    expect(decideChartProfileSync({ state: state({}), localHash: 'a', serverHash: 'b', serverAt: 1_000 })).toBe('apply-server');
  });

  it('shodný profil nedělá nic', () => {
    expect(decideChartProfileSync({ state: state({}), localHash: 'a', serverHash: 'a', serverAt: 1_000 })).toBe('none');
  });

  it('jiné zařízení změnilo profil a tady se nic nezměnilo → převzít', () => {
    const synced = state({ syncedHash: 'a', localHash: 'a', seenServerAt: 1_000, localAt: 500 });
    expect(decideChartProfileSync({ state: synced, localHash: 'a', serverHash: 'b', serverAt: 2_000 })).toBe('apply-server');
  });

  it('místní změna, kterou server ještě nemá → nahrát', () => {
    const synced = state({ syncedHash: 'a', localHash: 'c', seenServerAt: 1_000, localAt: 1_500 });
    expect(decideChartProfileSync({ state: synced, localHash: 'c', serverHash: 'a', serverAt: 1_000 })).toBe('push-local');
  });

  it('změna na obou stranách: novější vyhraje', () => {
    const dirty = state({ syncedHash: 'a', localHash: 'c', seenServerAt: 1_000, localAt: 1_500 });
    expect(decideChartProfileSync({ state: dirty, localHash: 'c', serverHash: 'b', serverAt: 2_000 })).toBe('apply-server');
    expect(decideChartProfileSync({ state: { ...dirty, localAt: 3_000 }, localHash: 'c', serverHash: 'b', serverAt: 2_000 })).toBe('push-local');
  });

  it('starou verzi serveru, kterou zařízení už vidělo, znovu nepřebírá', () => {
    const synced = state({ syncedHash: 'a', localHash: 'a', seenServerAt: 2_000 });
    expect(decideChartProfileSync({ state: synced, localHash: 'a', serverHash: 'b', serverAt: 2_000 })).toBe('none');
  });
});
