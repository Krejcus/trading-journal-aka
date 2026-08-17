import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { access, chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createMacCopierDevice, loadMacCopierDevice } from '../../server/macCopierDevice';

const execFileAsync = promisify(execFile);
const LABEL = 'com.alphatrade.copier';
const projectRoot = resolve(new URL('../..', import.meta.url).pathname);
const pilotRoot = resolve(projectRoot, '.copier-pilot');
const launchAgents = resolve(homedir(), 'Library/LaunchAgents');
const plistPath = resolve(launchAgents, `${LABEL}.plist`);
const deviceConfigPath = resolve(pilotRoot, 'mac-device.json');

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

if (action === 'install') await install();
else if (action === 'status') await status();
else {
  console.log(`
AlphaTrade Mac copier service

  npm run copier:mac -- install --connection-id UUID --leader ID --follower ID --lease /cesta/lease.json
  npm run copier:mac -- status

Instalace vytvoří LaunchAgent, drží Mac vzhůru přes caffeinate a každý start
nechá execution runtime DISARMED. ARM zůstává výhradně ruční akcí v LIVE UI.
`);
}

async function install(): Promise<void> {
  const connectionId = required('connection-id');
  const leader = positiveInteger('leader');
  const follower = positiveInteger('follower');
  if (leader === follower) throw new Error('Leader a follower musí být různé účty');
  const sourceLease = resolve(required('lease'));
  await access(sourceLease);
  await mkdir(pilotRoot, { recursive: true, mode: 0o700 });
  await mkdir(launchAgents, { recursive: true, mode: 0o700 });
  const stableLease = resolve(pilotRoot, 'bootstrap-lease.json');
  await copyFile(sourceLease, stableLease);
  await chmod(stableLease, 0o600);

  let device;
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

  const tsx = resolve(projectRoot, 'node_modules/.bin/tsx');
  const pilot = resolve(projectRoot, 'scripts/copier/pilot.ts');
  await Promise.all([access(tsx), access(pilot)]);
  const stdout = resolve(pilotRoot, 'mac-agent.stdout.log');
  const stderr = resolve(pilotRoot, 'mac-agent.stderr.log');
  const programArguments = [
    '/usr/bin/caffeinate', '-dimsu', tsx, pilot, 'agent',
    '--leader', String(leader),
    '--follower', String(follower),
    '--multiplier', flags.get('multiplier')?.trim() || '1',
    '--minutes', '720',
    '--port', flags.get('port')?.trim() || '3211',
    '--device-config', deviceConfigPath,
    '--lease', stableLease,
    '--private-key', resolve(pilotRoot, 'pilot-private.pem'),
  ];
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>${programArguments.map(value => `<string>${xml(value)}</string>`).join('')}</array>
  <key>WorkingDirectory</key><string>${xml(projectRoot)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(stdout)}</string>
  <key>StandardErrorPath</key><string>${xml(stderr)}</string>
  <key>ProcessType</key><string>Interactive</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
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
  console.log(`Device: ${device.deviceName} (${device.paired ? 'spárován' : 'čeká na kliknutí na klíč v LIVE Connections'})`);
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
    console.log(JSON.stringify(await response.json(), null, 2));
  } catch (error) {
    console.error(`Loopback agent neodpovídá: ${error instanceof Error ? error.message : String(error)}`);
    console.error(`Zkontroluj ${resolve(pilotRoot, 'mac-agent.stderr.log')}`);
  }
}
