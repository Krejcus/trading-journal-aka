import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createTradovateBroker } from '../../services/tradovateBroker';
import { createBrokerRouter } from '../../services/brokerRouter';
import {
  openTradovatePilotLease,
  type TradovatePilotLeaseEnvelope,
} from '../../server/tradovatePilotLease';
import { loadMacCopierConnectionManifest } from '../../server/macCopierConnectionManifest';
import {
  createMacCopierDeviceTokenProvider,
  loadMacCopierDevice,
} from '../../server/macCopierDevice';

const [leaseArg, ...accountArgs] = process.argv.slice(2);
if (!leaseArg || accountArgs.length === 0) {
  throw new Error('Použití: inspectOrders.ts <pilot-lease.json|connections.json> <accountId> [accountId...]');
}

const accountIds = accountArgs.map(value => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`Neplatné accountId: ${value}`);
  return parsed;
});

const inputPath = resolve(leaseArg);
const input = JSON.parse(await readFile(inputPath, 'utf8')) as { version?: number; connections?: unknown[] };
const broker = Array.isArray(input.connections)
  ? await brokerFromManifest(inputPath)
  : await brokerFromLease(inputPath);

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

async function brokerFromLease(path: string) {
  const envelope = JSON.parse(await readFile(path, 'utf8')) as TradovatePilotLeaseEnvelope;
  const privateKey = await readFile(resolve('.copier-pilot/pilot-private.pem'), 'utf8');
  const payload = openTradovatePilotLease(envelope, privateKey);
  return createTradovateBroker({
    environment: 'demo',
    accountSpec: payload.accountSpec,
    getAccessToken: async () => payload.accessToken,
  });
}

async function brokerFromManifest(path: string) {
  const manifest = await loadMacCopierConnectionManifest(path);
  const routes = await Promise.all(manifest.connections.map(async entry => {
    const config = await loadMacCopierDevice(entry.deviceConfigPath);
    const provider = createMacCopierDeviceTokenProvider({ config });
    const payload = await provider.refresh();
    return {
      accountIds: entry.accountIds,
      broker: createTradovateBroker({
        environment: 'demo',
        accountSpec: payload.accountSpec,
        getAccessToken: provider.getAccessToken,
      }),
    };
  }));
  return createBrokerRouter(routes);
}
