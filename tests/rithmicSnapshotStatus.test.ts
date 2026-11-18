import { describe, expect, it } from 'vitest';
import { rithmicSnapshotStatus } from '../services/rithmic/rithmicBrokerMapping';
import type { RithmicOrderUpdate } from '../services/rithmic/rithmicClient';

// Řádek změřený 18. 11. 2026 na Rithmic Test (scripts/rithmic/dumpOrders.ts): Market ze zavření pozice v době, kdy
// testovací burza nebyla připojená. Služba kvůli němu po restartu nenastartovala („stav … ve snímku nejde určit").
const row = (extra: Partial<RithmicOrderUpdate> = {}): RithmicOrderUpdate => ({
  status: 'complete', completionReason: '', reportType: 'failure', notifyType: 'GENERIC', totalFillSize: 0, totalUnfilledSize: 1, ...extra,
} as RithmicOrderUpdate);

describe('stav příkazu ze snímku: příkaz, který k burze nedošel', () => {
  it('complete + failure + nic vyplněno + vše nevyplněno = odmítnutý', () => {
    expect(rithmicSnapshotStatus(row(), 1, 0)).toBe('rejected');
  });

  it('bez výslovného dokladu, že se nevyplnilo nic, stav dál určit nejde (adaptér nenastartuje)', () => {
    expect(rithmicSnapshotStatus(row({ totalFillSize: null }), 1, 0)).toBeNull();
    expect(rithmicSnapshotStatus(row({ totalUnfilledSize: null }), 1, 0)).toBeNull();
    expect(rithmicSnapshotStatus(row({ totalUnfilledSize: 0 }), 1, 0)).toBeNull();
    expect(rithmicSnapshotStatus(row({ totalFillSize: 1, totalUnfilledSize: 1 }), 2, 1)).toBeNull();
    expect(rithmicSnapshotStatus(row({ reportType: '' }), 1, 0)).toBeNull();
  });

  it('plně vyplněný příkaz zůstává vyplněný, i kdyby poslední hlášení bylo failure', () => {
    expect(rithmicSnapshotStatus(row({ totalFillSize: 1, totalUnfilledSize: 0 }), 1, 1)).toBe('filled');
  });
});
