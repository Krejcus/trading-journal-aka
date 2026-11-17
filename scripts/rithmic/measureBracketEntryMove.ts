/**
 * Měření na Rithmic Test: změní posun ceny ČEKAJÍCÍHO vstupu se serverovým SL/TP (314) jeho ochranu?
 * Zadá Limit hluboko pod trhem (nevyplní se), přečte bracket, posune cenu, přečte znovu, zruší.
 * Použití: RITHMIC_USER=… npx tsx scripts/rithmic/measureBracketEntryMove.ts --price 28000 [--symbol MNQZ6]
 */
import { execFileSync } from 'node:child_process';
import WebSocket from 'ws';
import { RithmicClient, type RithmicOrderUpdate } from '../../services/rithmic/rithmicClient';
import type { RithmicSocketLike } from '../../services/rithmic/rithmicPlant';

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const SYMBOL = arg('symbol') ?? 'MNQZ6';
const PRICE = Number(arg('price'));
/** --stop: vstup je Buy STOP_MARKET (cena = spoušť NAD trhem); jinak Buy LIMIT pod trhem. */
const STOP = process.argv.includes('--stop');
const STEP = STOP ? 2 : -2;
if (!Number.isFinite(PRICE) || PRICE <= 0) { console.error('Chybí --price (hluboko pod trhem)'); process.exit(1); }
const password = execFileSync('security', ['find-generic-password', '-s', 'alphatrade-rithmic-test', '-w'], { encoding: 'utf8' }).replace(/\n$/, '');
const updates: RithmicOrderUpdate[] = [];
const client = new RithmicClient({
  url: 'wss://rituz00100.rithmic.com:443',
  credentials: { user: process.env.RITHMIC_USER!, password, systemName: 'Rithmic Test', appName: 'AlphaTrade', appVersion: '0.1.0' },
  socketFactory: (url) => new WebSocket(url, { perMessageDeflate: false }) as unknown as RithmicSocketLike,
  events: { onOrderUpdate: (u) => { if (!u.isSnapshot) updates.push(u); } },
});
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const brief = (o: RithmicOrderUpdate) => `${o.basketId}|${o.status}|${o.notifyType}|price=${o.price}|trigger=${o.triggerPrice}|qty=${o.quantity}|type=${o.priceType}|bracket=${o.bracketType}|tag=${o.userTag}`;

(async () => {
  await client.connect(['order']);
  const account = client.accounts[0].accountId;
  const tag = `mv-${Date.now().toString(36)}`;
  const read = async (label: string, basketId?: string) => {
    const orders = await client.showOrders(account);
    const mine = orders.filter((o) => o.userTag === tag || (basketId && o.basketId === basketId));
    const targets = (await client.showBrackets(account)).filter((b) => mine.some((o) => o.basketId === b.basketId));
    const stops = (await client.showBracketStops(account)).filter((b) => mine.some((o) => o.basketId === b.basketId));
    console.log(`\n[${label}] příkazy:`, mine.map(brief));
    console.log(`[${label}] TP bracket:`, JSON.stringify(targets), 'SL bracket:', JSON.stringify(stops));
    return mine;
  };
  const ack = await client.placeBracketOrder({ accountId: account, userTag: tag, symbol: SYMBOL, exchange: 'CME', side: 'BUY', quantity: 1, ...(STOP ? { priceType: 'STOP_MARKET' as const, triggerPrice: PRICE } : { priceType: 'LIMIT' as const, price: PRICE }), stopTicks: 48, targetTicks: 96 });
  console.log('zadáno:', JSON.stringify(ack));
  await wait(1_500);
  const before = await read('před posunem');
  const basketId = before.find((o) => o.status !== 'complete')?.basketId ?? ack.basketId;
  if (!basketId) throw new Error('vstup nenalezen');
  let moveError: string | null = null;
  try {
    const response = await client.modifyOrder({ accountId: account, basketId, symbol: SYMBOL, exchange: 'CME', quantity: 1, ...(STOP ? { priceType: 'STOP_MARKET' as const, triggerPrice: PRICE + STEP } : { priceType: 'LIMIT' as const, price: PRICE + STEP }) });
    console.log('odpověď na 314:', JSON.stringify({ rows: response.rows.length, terminal: response.terminal?.fields }));
  } catch (error) { moveError = error instanceof Error ? error.message : String(error); console.log('314 selhalo:', moveError); }
  await wait(1_500);
  const after = await read('po posunu', basketId);
  console.log('\nprůběžné zprávy:', updates.filter((u) => u.userTag === tag || u.basketId === basketId).map(brief));
  for (const order of after.filter((o) => !['complete', 'cancelled', 'canceled'].includes(o.status.toLowerCase()))) {
    try { await client.cancelOrder(account, order.basketId); } catch (error) { console.log('zrušení selhalo:', (error as Error).message); }
  }
  await wait(1_500);
  await read('po zrušení', basketId);
  client.close();
  setTimeout(() => process.exit(0), 300);
})().catch((error) => { console.error('SELHALO', error instanceof Error ? error.message : error); client.close(); setTimeout(() => process.exit(1), 300); });
