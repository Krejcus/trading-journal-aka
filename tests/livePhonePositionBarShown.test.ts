import { describe, expect, it } from 'vitest';
import { livePhonePositionBarShown } from '../components/day/LivePhoneLiveActions';

const base = { position: { pending: null, bareEntryOperationId: null }, replay: false, manage: true, closeSupported: true, bareCloseEnabled: false };

describe('lišta pozice nad grafem telefonu', () => {
  it('v běžném provozu se nekreslí: × je na čáře', () => {
    expect(livePhonePositionBarShown(base)).toBe(false);
    expect(livePhonePositionBarShown({ ...base, position: { pending: { type: 'Limit' } } })).toBe(false);
    expect(livePhonePositionBarShown({ ...base, position: { bareEntryOperationId: 'entry:1' }, bareCloseEnabled: true })).toBe(false);
  });
  it('zůstává, když čára zavřít neumí: bez ní by v grafu nebyla cesta ven', () => {
    expect(livePhonePositionBarShown({ ...base, closeSupported: false })).toBe(true);
    expect(livePhonePositionBarShown({ ...base, manage: false })).toBe(true);
    expect(livePhonePositionBarShown({ ...base, replay: true })).toBe(true);
    expect(livePhonePositionBarShown({ ...base, position: { pending: { type: 'Limit' } }, manage: false })).toBe(true);
    expect(livePhonePositionBarShown({ ...base, position: { bareEntryOperationId: 'entry:1' } })).toBe(true);
  });
  it('bez pozice nic', () => {
    expect(livePhonePositionBarShown({ ...base, position: null })).toBe(false);
  });
});
