import assert from 'node:assert/strict';
import { buildNativeWidgetRemoteSnapshot } from '/Users/filipkrejca/Documents/trading-journal-aka/server/nativeWidgetRemoteSnapshot.ts';
import { loadNativeLiveActivityBrokerSnapshot } from '/Users/filipkrejca/Documents/trading-journal-aka/server/nativeLiveActivityBrokerSnapshot.ts';
import { planNativeLiveActivityUpdate } from '/Users/filipkrejca/Documents/trading-journal-aka/server/nativeLiveActivityUpdater.ts';

async function main() {
  const now = Date.parse('2026-09-05T10:00:00Z');
  const runtime = { device_id: 'fake-device', user_id: 'fake-user', connection_id: 'fake-connection', started_at: '2026-09-05T09:00:00Z', last_seen_at: '2026-09-05T09:55:00Z', status: { controller: { armed: true, connected: true, killSwitch: false, dayLockUntil: 0 }, group: { leaderAccountId: 10, followers: [] } } };
  const mockFetch = async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    if (['/position/list', '/order/list', '/cashBalance/list'].includes(path)) return new Response('[]');
    return new Response('{}', { status: 503 });
  };
  const broker = await loadNativeLiveActivityBrokerSnapshot({ baseUrl: 'https://review.invalid', accessToken: 'fake-token', accountIds: [10], now, fetchImpl: mockFetch as typeof fetch });
  const remote = buildNativeWidgetRemoteSnapshot({ runtime, broker, now, profiles: [], trades: [] });
  assert.equal(remote.live.status, 'WORKER OFFLINE');
  assert.equal(remote.live.armed, true);
  assert.equal(remote.live.connected, true);
  assert.equal(remote.updatedAt, now);
  assert.equal(broker.accountStatusComplete, false);
  assert.equal(broker.accountLockStatusComplete, false);
  assert.equal(broker.accounts[0].balanceAvailable, false);
  assert.equal(remote.live.accounts[0].locked, false);
  assert.equal(remote.live.accounts[0].balance, 0);
  assert.equal('balanceAvailable' in remote.live.accounts[0], false);
  console.log('CONFIRMED offline widget snapshot retains armed=true connected=true with fresh updatedAt');
  console.log('CONFIRMED failed broker account/lock/balance coverage becomes unlocked $0 widget account');

  const trailingFetch = async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    const data: Record<string, unknown> = {
      '/position/list': [{ accountId: 10, contractId: 99, netPos: 1, netPrice: 20000 }],
      '/order/list': [{ id: 20, accountId: 10, contractId: 99, action: 'Sell', ordStatus: 'Working' }],
      '/cashBalance/list': [{ accountId: 10, amount: 50000, realizedPnL: 0 }],
      '/account/list': [{ id: 10, name: 'Mock account', canTrade: true }],
      '/userAccountAutoLiq/list': [],
      '/orderVersion/list': [{ id: 1, orderId: 20, orderQty: 1, orderType: 'Stop', stopPrice: 20010 }],
      '/contract/items': [{ id: 99, name: 'MNQU6' }],
      '/cashBalance/getcashbalancesnapshot': { openPnL: 100, netLiq: 50100 },
    };
    return new Response(JSON.stringify(data[path] ?? {}));
  };
  const trailing = await loadNativeLiveActivityBrokerSnapshot({ baseUrl: 'https://review.invalid', accessToken: 'fake-token', accountIds: [10], now, fetchImpl: trailingFetch as typeof fetch });
  assert.equal(trailing.positions[0].stopPrice, null);
  console.log('CONFIRMED profitable long trailing stop at 20010 above entry 20000 omitted from Live Activity');

  const fresh = { ...runtime, last_seen_at: new Date(now).toISOString() };
  const serverPlan = planNativeLiveActivityUpdate({ runtime: fresh, broker: trailing, now });
  assert.equal(serverPlan.update.state.mode, 'position');
  assert.equal(serverPlan.update.state.pnlText, '+$100.00');
  console.log('Remote state has position mode; inspected local Swift construction sets mode and all detail optionals to nil');
}
void main();
