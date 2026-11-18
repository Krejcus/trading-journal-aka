/**
 * Správa spárovaných zařízení (telefon) místní služby — spouští se na Macu, kde služba běží. K Rithmicu se
 * NEPŘIPOJUJE: mluví jen s místní službou (127.0.0.1), a ta správu zařízení přijímá jen z tohoto počítače.
 *
 *   npx tsx scripts/rithmic/pairDevice.ts                    vydá párovací kód (platí 5 minut, plný rozsah)
 *   npx tsx scripts/rithmic/pairDevice.ts --scope close      zařízení smí jen zavírat a spravovat ochranu
 *   npx tsx scripts/rithmic/pairDevice.ts --scope read       zařízení smí jen číst
 *   npx tsx scripts/rithmic/pairDevice.ts --list             vypíše zařízení
 *   npx tsx scripts/rithmic/pairDevice.ts --revoke <id>      odvolá zařízení (otevřené spojení hned končí)
 *   … [--port 3311] [--host <jméno Macu v síti Tailscale>]   --host jen doplní adresu do párovacího odkazu
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const arg = (name: string): string | undefined => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const PORT = arg('port') ?? '3311';
const token = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'results', 'dev-token'), 'utf8').trim();
const command: Record<string, unknown> = process.argv.includes('--list') ? { op: 'devices' }
  : arg('revoke') ? { op: 'revoke-device', deviceId: arg('revoke') }
    : { op: 'pair-start', scope: arg('scope') ?? 'full' };
const SCOPE_TEXT: Record<string, string> = { full: 'vše, co dovolí režim služby', close: 'jen zavírat a spravovat ochranu', read: 'jen číst' };

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/?token=${token}`, { origin: 'http://localhost:3000' });
const timer = setTimeout(() => { console.error('Místní služba neodpověděla — běží? (scripts/rithmic/devTradeServer.ts … --mobile)'); process.exit(1); }, 8_000);
ws.on('error', (error) => { console.error('Místní služba není dostupná:', (error as Error).message); process.exit(1); });
ws.on('open', () => ws.send(JSON.stringify({ id: 'pair', command })));
ws.on('message', (raw) => {
  const message = JSON.parse(String(raw)) as { type?: string; id?: string; ok?: boolean; error?: string; result?: { code?: string; expiresAt?: number; scope?: string; devices?: Array<{ id: string; name: string; scope: string; createdAt: number; lastSeenAt: number | null; revokedAt: number | null; online?: boolean }> } };
  if (message.type !== 'reply' || message.id !== 'pair') return;
  clearTimeout(timer);
  if (!message.ok) { console.error(`Nešlo to: ${message.error ?? 'neznámá chyba'}`); process.exit(1); }
  const result = message.result ?? {};
  if (result.code) {
    const code = `${result.code.slice(0, 4)}-${result.code.slice(4)}`;
    const host = arg('host');
    console.log(`\nPárovací kód:  ${code}`);
    console.log(`Platí do ${new Date(result.expiresAt ?? 0).toTimeString().slice(0, 8)} · jedno použití · zařízení bude smět: ${SCOPE_TEXT[result.scope ?? 'full']}`);
    console.log('V telefonu: LIVE → Graf → „Spárovat s Macem", zadej adresu Macu v síti Tailscale a tento kód.');
    if (host) console.log(`Odkaz pro telefon (lze poslat sám sobě nebo udělat QR): alphatrade-native://rithmic-pair?host=${encodeURIComponent(host)}&code=${result.code}`);
    console.log('');
  }
  if (result.devices) {
    const when = (at: number | null) => (at ? new Date(at).toLocaleString('cs-CZ') : '—');
    if (!result.devices.length) console.log('Žádné spárované zařízení.');
    for (const device of result.devices) {
      console.log(`${device.id}  ${device.name.padEnd(24)} ${SCOPE_TEXT[device.scope] ?? device.scope} · spárováno ${when(device.createdAt)} · naposledy ${when(device.lastSeenAt)}${device.revokedAt ? ` · ODVOLÁNO ${when(device.revokedAt)}` : device.online ? ' · PŘIPOJENO' : ''}`);
    }
  }
  ws.close();
  setTimeout(() => process.exit(0), 100);
});
