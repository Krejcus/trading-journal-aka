/** Jen čtení: vypíše surové řádky snímku příkazů a historie dne z Rithmic Test (pro slovník stavů). */
import { execFileSync } from 'node:child_process';
import WebSocket from 'ws';
import { RithmicClient } from '../../services/rithmic/rithmicClient';
import type { RithmicSocketLike } from '../../services/rithmic/rithmicPlant';

const password = execFileSync('security', ['find-generic-password', '-s', 'alphatrade-rithmic-test', '-w'], { encoding: 'utf8' }).replace(/\n$/, '');
const user = process.env.RITHMIC_USER!;
const client = new RithmicClient({
  url: 'wss://rituz00100.rithmic.com:443',
  credentials: { user, password, systemName: 'Rithmic Test', appName: 'AlphaTrade', appVersion: '0.1.0' },
  socketFactory: (url) => new WebSocket(url, { perMessageDeflate: false }) as unknown as RithmicSocketLike,
  events: { onOrderUpdate: (u) => { if (u.isSnapshot) late.push(`${u.source}:${u.basketId}:${u.notifyType}`); } },
});
/** Řádky snímku doručené mimo svůj požadavek (tedy až po jeho ukončení). */
const late: string[] = [];
const pick = (f: Record<string, unknown>) => Object.fromEntries(Object.entries(f).filter(([k]) =>
  ['basket_id', 'user_tag', 'notify_type', 'status', 'completion_reason', 'report_type', 'quantity', 'price', 'trigger_price', 'price_type', 'transaction_type',
   'total_fill_size', 'total_unfilled_size', 'bracket_type', 'original_basket_id', 'linked_basket_ids', 'text', 'report_text', 'symbol', 'ssboe', 'sequence_number'].includes(k)));
(async () => {
  await client.connect(['order']);
  const account = client.accounts[0].accountId;
  const open = await client.showOrders(account);
  console.log('320 rows:', open.length, 'by source:', JSON.stringify(open.reduce((m: Record<string, number>, o) => ((m[o.source] = (m[o.source] ?? 0) + 1), m), {})));
  await new Promise((r) => setTimeout(r, 2_000));
  console.log('late snapshot rows after terminal (2 s wait):', late.length, JSON.stringify(late.slice(0, 5)));
  console.log('rithmic-only rows:', JSON.stringify(open.filter((o) => o.source === 'rithmic').map((o) => `${o.basketId}|${o.status}|${o.completionReason}|${o.text}`).slice(0, 4)));
  for (const o of open.slice(-4)) console.log(JSON.stringify(pick(o.raw)));
  console.log('status values 320:', JSON.stringify([...new Set(open.map((o) => `${o.status}|${o.completionReason}|${o.notifyType}`))]));
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  try {
    const hist = await client.showOrderHistorySummary(account, day);
    console.log('324 rows:', hist.length, JSON.stringify([...new Set(hist.map((o) => `${o.status}|${o.completionReason}|${o.notifyType}`))]));
    for (const o of hist.slice(-2)) console.log(JSON.stringify(pick(o.raw)));
  } catch (e) { console.log('324 error:', (e as Error).message); }
  client.close();
  setTimeout(() => process.exit(0), 300);
})().catch((e) => { console.error('SELHALO', e.message); process.exit(1); });
