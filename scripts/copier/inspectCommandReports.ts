import { resolve } from 'node:path';
import { loadMacCopierConnectionManifest } from '../../server/macCopierConnectionManifest';
import {
  createMacCopierDeviceTokenProvider,
  loadMacCopierDevice,
} from '../../server/macCopierDevice';

const [manifestArg, ...pairArgs] = process.argv.slice(2);
if (!manifestArg || pairArgs.length === 0) {
  throw new Error('Použití: inspectCommandReports.ts <connections.json> <accountId:orderId> [...]');
}

const pairs = pairArgs.map(value => {
  const [accountIdRaw, orderIdRaw] = value.split(':');
  const accountId = Number(accountIdRaw);
  const orderId = Number(orderIdRaw);
  if (!Number.isSafeInteger(accountId) || !Number.isSafeInteger(orderId)) {
    throw new Error(`Neplatná dvojice accountId:orderId: ${value}`);
  }
  return { accountId, orderId };
});

const manifest = await loadMacCopierConnectionManifest(resolve(manifestArg));
for (const connection of manifest.connections) {
  const selected = pairs.filter(pair => connection.accountIds.includes(pair.accountId));
  if (selected.length === 0) continue;

  const config = await loadMacCopierDevice(connection.deviceConfigPath);
  const provider = createMacCopierDeviceTokenProvider({ config });
  const lease = await provider.refresh();
  const restOrigin = lease.environment === 'live'
    ? 'https://live.tradovateapi.com/v1'
    : 'https://demo.tradovateapi.com/v1';

  const get = async <T>(path: string): Promise<T> => {
    const response = await fetch(`${restOrigin}${path}`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${await provider.getAccessToken()}`,
      },
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${path} failed (${response.status}): ${text.slice(0, 500)}`);
    return JSON.parse(text) as T;
  };

  const allCommands = await get<Array<Record<string, unknown>>>('/command/list');
  const selectedOrderIds = new Set(selected.map(pair => pair.orderId));
  const recentModifyCommands = allCommands
    .filter(command => command.commandType === 'Modify')
    .filter(command => selectedOrderIds.has(Number(command.orderId)))
    .sort((left, right) => Number(right.id) - Number(left.id));
  console.log(JSON.stringify({
    connectionId: connection.connectionId,
    matchingModifyCommandsFromList: await Promise.all(recentModifyCommands.map(async command => {
      const commandId = Number(command.id);
      return {
        command,
        commandReports: Number.isSafeInteger(commandId)
          ? await get<Array<Record<string, unknown>>>(`/commandReport/deps?masterid=${commandId}`)
          : [],
        executionReports: Number.isSafeInteger(commandId)
          ? await get<Array<Record<string, unknown>>>(`/executionReport/deps?masterid=${commandId}`)
          : [],
      };
    })),
  }, null, 2));

  for (const pair of selected) {
    const commands = await get<Array<Record<string, unknown>>>(`/command/deps?masterid=${pair.orderId}`);
    const reports = (await Promise.all(commands.map(async command => {
      const commandId = Number(command.id);
      if (!Number.isSafeInteger(commandId)) return { command, commandReports: [], executionReports: [] };
      const [commandReports, executionReports] = await Promise.all([
        get<Array<Record<string, unknown>>>(`/commandReport/deps?masterid=${commandId}`),
        get<Array<Record<string, unknown>>>(`/executionReport/deps?masterid=${commandId}`),
      ]);
      return { command, commandReports, executionReports };
    }))).filter(item => item.command.commandType === 'Modify');

    console.log(JSON.stringify({
      connectionId: connection.connectionId,
      accountId: pair.accountId,
      orderId: pair.orderId,
      modifyCommands: reports,
    }, null, 2));
  }
}
