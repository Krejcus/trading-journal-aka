import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createTradovateBroker } from '../../services/tradovateBroker';
import {
  openTradovatePilotLease,
  type TradovatePilotLeaseEnvelope,
} from '../../server/tradovatePilotLease';

const [leaseArg, ...accountArgs] = process.argv.slice(2);
if (!leaseArg || accountArgs.length === 0) {
  throw new Error('Použití: inspectOrders.ts <pilot-lease.json> <accountId> [accountId...]');
}

const accountIds = accountArgs.map(value => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`Neplatné accountId: ${value}`);
  return parsed;
});

const envelope = JSON.parse(await readFile(resolve(leaseArg), 'utf8')) as TradovatePilotLeaseEnvelope;
const privateKey = await readFile(resolve('.copier-pilot/pilot-private.pem'), 'utf8');
const payload = openTradovatePilotLease(envelope, privateKey);
const broker = createTradovateBroker({
  environment: 'demo',
  accountSpec: payload.accountSpec,
  getAccessToken: async () => payload.accessToken,
});

for (const accountId of accountIds) {
  const [orders, positions] = await Promise.all([
    broker.listOrders(accountId),
    broker.listPositions(accountId),
  ]);
  console.log(JSON.stringify({
    accountId,
    positions: positions.filter(position => position.netQuantity !== 0),
    workingOrders: orders.filter(order => order.status === 'working'),
    latestOrders: orders
      .toSorted((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, 5),
  }, null, 2));
}
