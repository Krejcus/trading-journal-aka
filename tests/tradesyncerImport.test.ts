import { describe, it, expect } from 'vitest';
import { parseTradesyncerOrders } from '../services/tradesyncerImport';

// Minimální Tradesyncer orders export (jeden účet, jeden round-trip).
const header = 'account,status,side,fillSize,fillPrice,fillTime,symbol,id,leaderOrderId,connectionName,accountName';
const csv = (rows: string[]) => [header, ...rows].join('\n');

describe('parseTradesyncerOrders — směr fillu', () => {
  // REGRESE: dřív se brala JEN doslovná hodnota 'long' jako +1; 'Buy'/'Sell'/'B'/'S' tiše
  // spadly na short → rozbitý netting, špatný směr i znaménko P&L.
  it('Buy → Long s kladným P&L (long nahoru)', () => {
    const accs = parseTradesyncerOrders(csv([
      'ACC1,Filled,Buy,1,20000,2026-06-29 15:30:00,MNQ,1,L1,Conn,Acc1',
      'ACC1,Filled,Sell,1,20010,2026-06-29 15:35:00,MNQ,2,L1,Conn,Acc1',
    ]));
    expect(accs.length).toBe(1);
    expect(accs[0].trades.length).toBe(1);
    const t = accs[0].trades[0];
    expect(t.dir).toBe('Long');
    expect(t.pnl).toBeGreaterThan(0); // entry 20000 → exit 20010, MNQ $2/bod = +$20
  });

  it('Sell (entry) → Short s kladným P&L (short dolů)', () => {
    const accs = parseTradesyncerOrders(csv([
      'ACC2,Filled,Sell,1,20010,2026-06-29 16:00:00,MNQ,3,L2,Conn,Acc2',
      'ACC2,Filled,Buy,1,20000,2026-06-29 16:05:00,MNQ,4,L2,Conn,Acc2',
    ]));
    expect(accs.length).toBe(1);
    const t = accs[0].trades[0];
    expect(t.dir).toBe('Short');
    expect(t.pnl).toBeGreaterThan(0); // short z 20010 → 20000 = +$20
  });
});
