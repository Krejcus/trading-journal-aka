import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { access, chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createMacCopierDevice, loadMacCopierDevice } from '../../server/macCopierDevice';
import {
  loadMacCopierConnectionManifest,
  upsertMacCopierConnectionManifest,
} from '../../server/macCopierConnectionManifest';

const execFileAsync = promisify(execFile);
const LABEL = 'com.alphatrade.copier';
const projectRoot = resolve(new URL('../..', import.meta.url).pathname);
const pilotRoot = resolve(homedir(), 'Library/Application Support/AlphaTrade/copier');
const launchAgents = resolve(homedir(), 'Library/LaunchAgents');
const plistPath = resolve(launchAgents, `${LABEL}.plist`);
const deviceConfigPath = resolve(pilotRoot, 'mac-device.json');
const connectionsManifestPath = resolve(pilotRoot, 'connections.json');

const args = process.argv.slice(2);
const action = args[0] ?? 'help';
const flags = new Map<string, string>();
for (let index = 1; index < args.length; index += 2) {
  const key = args[index];
  const value = args[index + 1];
  if (!key?.startsWith('--') || !value) throw new Error(`Neplatný argument ${key ?? ''}`);
  flags.set(key.slice(2), value);
}
const required = (name: string) => {
  const value = flags.get(name)?.trim();
  if (!value) throw new Error(`Chybí --${name}`);
  return value;
};
const positiveInteger = (name: string) => {
  const value = Number(required(name));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`--${name} musí být kladné celé číslo`);
  return value;
};
const xml = (value: string) => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&apos;');

if (process.platform !== 'darwin') throw new Error('Mac installer lze spustit pouze na macOS');

if (action === 'add-connection') await addConnection();
else if (action === 'install') await install();
else if (action === 'status') await status();
else if (action === 'reconcile') await reconcile();
else if (action === 'resolve-stuck') await resolveStuck();
else {
  console.log(`
AlphaTrade Mac copier service

  npm run copier:mac -- add-connection --connection-id UUID --accounts "ID,ID" --lease /cesta/lease.json [--primary true]
  npm run copier:mac -- install --connection-id UUID --leader ID --follower ID --lease /cesta/lease.json
  npm run copier:mac -- install --connections-manifest /cesta/connections.json --leader ID --followers "ID@MULT,ID@MULT@MAX"
  npm run copier:mac -- status
  npm run copier:mac -- reconcile
  npm run copier:mac -- resolve-stuck --kind cancel-or-modify --key KEY --reason "DŮVOD" --approval POTVRZUJI_RUCNI_RESOLUTION_BEZ_BROKER_PRIKAZU

Instalace vytvoří LaunchAgent, drží Mac vzhůru přes caffeinate a každý start
nechá execution runtime DISARMED. ARM zůstává výhradně ruční akcí v LIVE UI.
`);
}

async function localAgentStatus(): Promise<Record<string, unknown>> {
  const response = await fetch('http://127.0.0.1:3211/v1/status', {
    headers: { Origin: 'https://alphatrade-mentor-15.vercel.app' },
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(`Loopback status selhal (${response.status}): ${JSON.stringify(body)}`);
  return body;
}

async function executeLocalCommand(command: Record<string, unknown>): Promise<Record<string, unknown>> {
  const before = await localAgentStatus();
  const nonce = typeof before.nonce === 'string' ? before.nonce : '';
  if (!nonce) throw new Error('Loopback agent nevrátil nonce');
  const response = await fetch('http://127.0.0.1:3211/v1/command', {
    method: 'POST',
    headers: {
      Origin: 'https://alphatrade-mentor-15.vercel.app',
      'Content-Type': 'application/json',
      'X-AlphaTrade-Agent-Nonce': nonce,
    },
    body: JSON.stringify(command),
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(`Loopback command selhal (${response.status}): ${JSON.stringify(body)}`);
  return body;
}

async function reconcile(): Promise<void> {
  const result = await executeLocalCommand({ type: 'reconcile' });
  console.log(JSON.stringify(result, null, 2));
  console.log('Read-only reconciliation dokončena; žádný broker příkaz nebyl odeslán.');
}

async function resolveStuck(): Promise<void> {
  if (required('approval') !== 'POTVRZUJI_RUCNI_RESOLUTION_BEZ_BROKER_PRIKAZU') {
    throw new Error('Chybí přesné potvrzení ruční resolution');
  }
  const kind = required('kind');
  if (!['place', 'bracket', 'oso', 'cancel-or-modify'].includes(kind)) {
    throw new Error('--kind musí být place, bracket, oso nebo cancel-or-modify');
  }
  const key = required('key');
  const reason = required('reason');
  const before = await localAgentStatus();
  const controller = before.controller && typeof before.controller === 'object'
    ? before.controller as Record<string, unknown>
    : {};
  if (controller.armed === true) throw new Error('Ruční resolution je povolena jen v DISARMED stavu');
  const stuck = Array.isArray(controller.stuckOperations)
    ? controller.stuckOperations.filter(item => item && typeof item === 'object') as Record<string, unknown>[]
    : [];
  if (!stuck.some(item => item.kind === kind && item.key === key)) {
    throw new Error('Požadovaná položka není v aktuálním seznamu stuck operations');
  }
  const result = await executeLocalCommand({ type: 'resolve-stuck-operation', kind, key, reason });
  console.log(JSON.stringify(result, null, 2));
  console.log('Položka byla pouze durable označena jako ručně vyřešená; žádný broker příkaz nebyl odeslán.');
  console.log('Před dalším ARM je povinná nová read-only reconciliation.');
}

async function addConnection(): Promise<void> {
  const connectionId = required('connection-id');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(connectionId)) {
    throw new Error('--connection-id musí být platné UUID');
  }
  const accountIds = required('accounts').split(',').map(value => Number(value.trim()));
  if (accountIds.length === 0 || accountIds.some(value => !Number.isSafeInteger(value) || value <= 0)) {
    throw new Error('--accounts musí obsahovat kladná ID oddělená čárkou');
  }
  const connectionRoot = resolve(pilotRoot, 'connections', connectionId);
  const connectionDevicePath = resolve(connectionRoot, 'device.json');
  const stableLeasePath = resolve(connectionRoot, 'bootstrap-lease.json');
  const stablePrivateKeyPath = resolve(connectionRoot, 'pilot-private.pem');
  const sourceLeasePath = resolve(required('lease'));
  const sourcePrivateKeyPath = resolve(flags.get('private-key')?.trim() || resolve(projectRoot, '.copier-pilot/pilot-private.pem'));
  await Promise.all([access(sourceLeasePath), access(sourcePrivateKeyPath)]);
  await mkdir(connectionRoot, { recursive: true, mode: 0o700 });
  if (sourceLeasePath !== stableLeasePath) await copyFile(sourceLeasePath, stableLeasePath);
  if (sourcePrivateKeyPath !== stablePrivateKeyPath) await copyFile(sourcePrivateKeyPath, stablePrivateKeyPath);
  await Promise.all([chmod(stableLeasePath, 0o600), chmod(stablePrivateKeyPath, 0o600)]);

  let device: Awaited<ReturnType<typeof loadMacCopierDevice>>;
  try {
    device = await loadMacCopierDevice(connectionDevicePath);
    if (device.connectionId !== connectionId) throw new Error('Device konfigurace patří jinému OAuth připojení');
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
    device = await createMacCopierDevice({
      configPath: connectionDevicePath,
      connectionId,
      apiOrigin: flags.get('api-origin')?.trim() || 'https://alphatrade-mentor-15.vercel.app',
      deviceName: flags.get('device-name')?.trim() || undefined,
    });
  }
  const manifest = await upsertMacCopierConnectionManifest({
    path: connectionsManifestPath,
    connection: {
      connectionId,
      accountIds,
      deviceConfigPath: connectionDevicePath,
      leasePath: stableLeasePath,
      privateKeyPath: stablePrivateKeyPath,
    },
    makePrimary: flags.get('primary')?.trim().toLowerCase() === 'true',
  });
  console.log(`OAuth připojení připraveno: ${connectionId} (${accountIds.join(', ')})`);
  console.log(`Device: ${device.deviceName} (${device.paired ? 'spárován' : 'čeká na spárování v LIVE Connections'})`);
  console.log(`Manifest: ${connectionsManifestPath}`);
  console.log(`Celkem OAuth připojení: ${manifest.connections.length}; primární: ${manifest.primaryConnectionId}`);
  console.log('Po přidání všech připojení spusť install s --connections-manifest a úplným seznamem followerů.');
}

async function install(): Promise<void> {
  const leader = positiveInteger('leader');
  const followers = flags.get('followers')?.trim() || '';
  const fallbackFollower = followers.split(',')[0]?.split('@')[0]?.trim() || '';
  const follower = Number(flags.get('follower')?.trim() || fallbackFollower);
  if (!Number.isSafeInteger(follower) || follower <= 0) throw new Error('Chybí platné --follower nebo --followers');
  if (leader === follower) throw new Error('Leader a follower musí být různé účty');
  await mkdir(pilotRoot, { recursive: true, mode: 0o700 });
  await mkdir(launchAgents, { recursive: true, mode: 0o700 });
  const runtimePath = resolve(pilotRoot, 'copier-agent.mjs');
  const sourceManifest = flags.get('connections-manifest')?.trim();
  let device: Awaited<ReturnType<typeof loadMacCopierDevice>> | null = null;
  const connectionArguments: string[] = [];
  if (sourceManifest) {
    const manifest = await loadMacCopierConnectionManifest(sourceManifest);
    await Promise.all(manifest.connections.flatMap(connection => [
      access(connection.deviceConfigPath),
      ...(connection.leasePath ? [access(connection.leasePath)] : []),
      ...(connection.privateKeyPath ? [access(connection.privateKeyPath)] : []),
    ]));
    await writeFile(connectionsManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await chmod(connectionsManifestPath, 0o600);
    connectionArguments.push('--connections-manifest', connectionsManifestPath);
  } else {
    const connectionId = required('connection-id');
    const sourceLease = resolve(required('lease'));
    await access(sourceLease);
    const stableLease = resolve(pilotRoot, 'bootstrap-lease.json');
    const stablePilotPrivateKey = resolve(pilotRoot, 'pilot-private.pem');
    if (sourceLease !== stableLease) await copyFile(sourceLease, stableLease);
    const sourcePrivateKey = resolve(flags.get('private-key')?.trim() || resolve(projectRoot, '.copier-pilot/pilot-private.pem'));
    if (sourcePrivateKey !== stablePilotPrivateKey) await copyFile(sourcePrivateKey, stablePilotPrivateKey);
    await Promise.all([chmod(stableLease, 0o600), chmod(stablePilotPrivateKey, 0o600)]);

    try {
      device = await loadMacCopierDevice(deviceConfigPath);
      if (device.connectionId !== connectionId) {
        throw new Error('Existující Mac device patří jinému Tradovate připojení; nejdřív ho explicitně odvolej');
      }
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
      device = await createMacCopierDevice({
        configPath: deviceConfigPath,
        connectionId,
        apiOrigin: flags.get('api-origin')?.trim() || 'https://alphatrade-mentor-15.vercel.app',
        deviceName: flags.get('device-name')?.trim() || undefined,
      });
    }
    connectionArguments.push(
      '--device-config', deviceConfigPath,
      '--lease', stableLease,
      '--private-key', stablePilotPrivateKey,
    );
  }

  const esbuild = resolve(projectRoot, 'node_modules/.bin/esbuild');
  const pilotSource = resolve(projectRoot, 'scripts/copier/pilot.ts');
  await Promise.all([access(esbuild), access(pilotSource)]);
  await execFileAsync(esbuild, [
    pilotSource,
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--target=node20',
    `--outfile=${runtimePath}`,
  ]);
  await chmod(runtimePath, 0o700);

  const stdout = resolve(pilotRoot, 'mac-agent.stdout.log');
  const stderr = resolve(pilotRoot, 'mac-agent.stderr.log');
  const programArguments = [
    '/usr/bin/caffeinate', '-dimsu', process.execPath, runtimePath, 'agent',
    '--leader', String(leader),
    '--follower', String(follower),
    ...(followers ? ['--followers', followers] : ['--multiplier', flags.get('multiplier')?.trim() || '1']),
    '--minutes', '720',
    '--port', flags.get('port')?.trim() || '3211',
    ...connectionArguments,
  ];
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>${programArguments.map(value => `<string>${xml(value)}</string>`).join('')}</array>
  <key>WorkingDirectory</key><string>${xml(pilotRoot)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(stdout)}</string>
  <key>StandardErrorPath</key><string>${xml(stderr)}</string>
  <key>ProcessType</key><string>Interactive</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>ALPHATRADE_TV_AUTO_LAUNCH</key><string>on</string>
  </dict>
</dict></plist>
`;
  await writeFile(plistPath, plist, { mode: 0o600 });
  await chmod(plistPath, 0o600);
  const domain = `gui/${process.getuid?.() ?? 501}`;
  await execFileAsync('/bin/launchctl', ['bootout', domain, plistPath]).catch(() => undefined);
  await execFileAsync('/bin/launchctl', ['bootstrap', domain, plistPath]);
  await execFileAsync('/bin/launchctl', ['enable', `${domain}/${LABEL}`]);
  await execFileAsync('/bin/launchctl', ['kickstart', '-k', `${domain}/${LABEL}`]);
  console.log(`Mac copier service běží: ${LABEL}`);
  console.log(device
    ? `Device: ${device.deviceName} (${device.paired ? 'spárován' : 'čeká na kliknutí na klíč v LIVE Connections'})`
    : `Multi-OAuth manifest: ${connectionsManifestPath}`);
  console.log(`Logy: ${stdout} / ${stderr}`);
  console.log('Execution runtime je po startu DISARMED. ARM se neobnovuje automaticky.');
}

async function status(): Promise<void> {
  const domain = `gui/${process.getuid?.() ?? 501}`;
  const { stdout } = await execFileAsync('/bin/launchctl', ['print', `${domain}/${LABEL}`]);
  console.log(stdout);
  try {
    const response = await fetch('http://127.0.0.1:3211/v1/status', {
      headers: { Origin: 'https://alphatrade-mentor-15.vercel.app' },
    });
    const body = await response.json() as Record<string, unknown>;
    const device = body.device && typeof body.device === 'object'
      ? body.device as Record<string, unknown>
      : null;
    const devices = Array.isArray(body.devices)
      ? body.devices
        .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
        .map(item => ({
          state: item.state,
          deviceId: item.deviceId,
          connectionId: item.connectionId,
          deviceName: item.deviceName,
        }))
      : undefined;
    console.log(JSON.stringify({
      ...body,
      ...(device ? {
        device: {
          state: device.state,
          deviceId: device.deviceId,
          connectionId: device.connectionId,
          deviceName: device.deviceName,
        },
      } : {}),
      ...(devices ? { devices } : {}),
    }, null, 2));
  } catch (error) {
    console.error(`Loopback agent neodpovídá: ${error instanceof Error ? error.message : String(error)}`);
    console.error(`Zkontroluj ${resolve(pilotRoot, 'mac-agent.stderr.log')}`);
  }
}
