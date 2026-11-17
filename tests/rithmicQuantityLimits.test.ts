import { expect, it } from 'vitest';
import { quantityLimits } from '../services/rithmic/rithmicQuantityLimits';
import { RithmicPendingJournal } from '../lib/rithmicPendingJournal';

const account = { account_id: 'A', presence_bits: 511, buy_limit: 20, sell_limit: 20, max_order_quantity: 40 };
const product = { account_id: 'A', product_code: 'MNQ', presence_bits: 11, buy_limit: 6, sell_limit: 3, max_order_quantity: 10 };
it('combines present account and product bounds, including explicit zero and asymmetric limits', () => {
  expect(quantityLimits('A', 'MNQ', [account], [product])).toEqual({ buy: 6, sell: 3, order: 10 });
  expect(quantityLimits('A', 'MNQ', [account], [{ ...product, presence_bits: 1, buy_limit: 0 }])).toEqual({ buy: 0, sell: 20, order: 40 });
  expect(quantityLimits('A', 'MNQ', [account], [{ ...product, product_code: 'NQ' }])).toBeNull();
});
it('fails closed for incomplete, ambiguous or malformed bounds', () => {
  expect(quantityLimits('A', 'MNQ', [account], [{ ...product, fcm_id: 'wrong' }], { fcmId: 'FCM', ibId: 'IB' })).toBeNull();
  expect(quantityLimits('A', 'MNQ', [account], [{ ...product, product_code: '' }])).toBeNull();
  expect(quantityLimits('B', 'MNQ', [account], [product])).toBeNull();
  expect(quantityLimits('A', 'MNQ', [account], [product, product])).toBeNull();
  expect(quantityLimits('A', 'MNQ', [{ ...account, presence_bits: 1 }], [])).toBeNull();
  expect(quantityLimits('A', 'MNQ', [account], [{ ...product, sell_limit: -1 }])).toBeNull();
});
it('reload restores separate commands for the exact system, account and symbol', () => {
  const values = new Map<string, string>();
  const storage: Storage = { clear: () => values.clear(), get length() { return values.size; }, key: (i: number) => [...values.keys()][i], getItem: (k: string) => values.get(k), setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k) };
  const open = (system = 'sim', account = 'A') => new RithmicPendingJournal(storage, system, account, 'MNQZ6');
  open().put({ id: 'command1', op: 'entry', clientId: 'entry1', at: 1 });
  open().put({ id: 'command2', op: 'flatten', at: 2 });
  expect(open('other').list()).toEqual([]);
  expect(open('sim', 'B').list()).toEqual([]);
  open().remove('command1');
  expect(open().list()).toEqual([{ id: 'command2', op: 'flatten', at: 2 }]);
});
