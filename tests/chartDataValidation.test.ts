import { describe, expect, it } from 'vitest';
import { inspectCandleSnapshot } from '../lib/candleSnapshotValidation';
const now = Date.parse('2026-10-30T19:00:30Z');
const minute = Math.floor(now / 60000) * 60;
const bar = [minute, 28000, 28001, 27999, 28000.5, 10];
const file = (extra = {}) => JSON.stringify({ at: now, root: 'MNQ', source: 'CME_MINI:MNQ1!', bars: [bar], ...extra });
describe('candle file trust boundary', () => {
  it.each(['null', '[]', 'false', '1', '"text"', '{'])('rejects malformed object %s without throwing', text => {
    expect(inspectCandleSnapshot(text, 'MNQ', now).ok).toBe(false);
  });
  it.each([null, '', '1793386830000', 0, -1, Infinity, now + 3600000])('rejects invalid capture time %s', at => {
    expect(inspectCandleSnapshot(file({ at }), 'MNQ', now)).toMatchObject({ ok: false, problem: 'invalid-capture-time' });
  });
  it('rejects conflicting declared root, source, and contract, including roll', () => {
    for (const extra of [{ root: 'MES' }, { source: 'CME_MINI:MES1!' }, { contract: 'MESZ2026' }]) {
      expect(inspectCandleSnapshot(file(extra), 'MNQ', now)).toMatchObject({ ok: false, problem: 'market-mismatch' });
    }
    expect(inspectCandleSnapshot(file({ contract: 'MNQH2027' }), 'MNQZ6', now)).toMatchObject({ ok: false, problem: 'market-mismatch' });
    expect(inspectCandleSnapshot(file({ source: 'IBKR:MNQZ2026', contract: 'MNQH2027' }), 'MNQ', now)).toMatchObject({ ok: false, problem: 'market-mismatch' });
  });
  it('allows micro/full price family and IBKR four-digit year without changing its provenance', () => {
    const parsed = inspectCandleSnapshot(file({ root: 'NQ', source: 'IBKR:MNQZ2026', contract: 'MNQZ2026' }), 'MNQ', now);
    expect(parsed).toMatchObject({ ok: true, source: 'IBKR:MNQZ2026', validation: { sourceVerified: true, contract: 'MNQZ2026' } });
    expect(inspectCandleSnapshot(file({ source: 'CME_MINI:NQ1!' }), 'MNQ', now)).toMatchObject({ ok: true, validation: { priceFamilyProxy: true } });
  });
  it('keeps legacy files but labels unknown source; reports dropped rows and unknown volume', () => {
    const parsed = inspectCandleSnapshot(file({ root: undefined, source: undefined, bars: [[minute, 28000, 28001, 27999, 28000.5], bar, [minute + 60, 28000, 27000, 27999, 28000]] }), 'MNQ', now);
    expect(parsed).toMatchObject({ ok: true, validation: { sourceVerified: false, discardedRows: 2, unknownVolume: true } });
  });
});
