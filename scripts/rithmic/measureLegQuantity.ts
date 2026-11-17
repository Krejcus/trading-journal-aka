/**
 * Měření na Rithmic Test (simulované peníze): jde u nohy serverové ochrany (bracket) změnit MNOŽSTVÍ (314)?
 * Market 2 ks se SL/TP → nohy po 2 ks → TP na 1 ks → SL na 1 ks → co ukáže snímek a co se stane se sestrou.
 * Podklad pro dělení jednoho vstupu s víc kusy (částečné zavření). Nakonec vše zruší a pozici zavře.
 * Použití: RITHMIC_USER=… npx tsx scripts/rithmic/measureLegQuantity.ts [--symbol MNQZ6]
 */
import { execFileSync } from 'node:child_process';
import WebSocket from 'ws';
import { RithmicClient, type RithmicOrderUpdate } from '../../services/rithmic/rithmicClient';
import type { RithmicSocketLike } from '../../services/rithmic/rithmicPlant';

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const SYMBOL = arg('symbol') ?? 'MNQZ6';
const password = execFileSync('security', ['find-generic-password', '-s', 'alphatrade-rithmic-test', '-w'], { encoding: 'utf8' }).replace(/\n$/, '');
const t0 = Date.now();
const log = (text: string) => console.log(`${String(Date.now() - t0).padStart(6)} ms  ${text}`);
const brief = (o: RithmicOrderUpdate) => `${o.basketId}|${o.notifyType}|${o.status}|${o.side}|type=${o.priceType}|px=${o.price}|trg=${o.triggerPrice}|qty=${o.quantity}|fill=${o.totalFillSize}|orig=${o.originalBasketId}|linked=${o.linkedBasketIds}|bracket=${o.bracketType}|tag=${o.userTag}|${o.text}`;
const client = new RithmicClient({
  url: 'wss://rituz00100.rithmic.com:443',
  credentials: { user: process.env.RITHMIC_USER!, password, systemName: 'Rithmic Test', appName: 'fikr:AlphaTrade', appVersion: '0.1.0' },
  socketFactory: (url) => new WebSocket(url, { perMessageDeflate: false }) as unknown as RithmicSocketLike,
  events: { onOrderUpdate: (u) => { if (!u.isSnapshot && /MODIF|REJECT|FAIL|CANCEL|COMPLETE|FILL|NOT_/i.test(u.notifyType)) log(`  zpráva ${brief(u)}`); } },
});
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const open = (o: RithmicOrderUpdate) => !['complete', 'cancelled', 'canceled'].includes(o.status.toLowerCase());

(async () => {
  await client.connect(['order']);
  const account = client.accounts[0].accountId;
  const snapshot = async (label: string) => {
    const orders = (await client.showOrders(account)).filter(open);
    log(`[${label}] pracující příkazy: ${orders.length}`);
    for (const order of orders) log(`    ${brief(order)}`);
    try { log(`    brackety TP: ${JSON.stringify(await client.showBrackets(account))} SL: ${JSON.stringify(await client.showBracketStops(account))}`); } catch (error) { log(`    brackety nejdou přečíst: ${(error as Error).message}`); }
    return orders;
  };
  if ((await snapshot('start')).length) { log('účet má pracující příkazy — neměřím'); client.close(); return; }
  try {
    log('--- Market 2 ks se SL 160 / TP 160 ticků ---');
    await client.placeBracketOrder({ accountId: account, userTag: `lq-${Date.now().toString(36)}`, symbol: SYMBOL, exchange: 'CME', side: 'BUY', quantity: 2, priceType: 'MARKET', stopTicks: 160, targetTicks: 160 });
    await wait(2_500);
    const legs = await snapshot('po vyplnění');
    const tp = legs.find((o) => o.priceType === 'LIMIT');
    const sl = legs.find((o) => o.priceType.includes('STOP'));
    if (!tp || !sl) throw new Error('nohy nenalezeny');
    log('--- TP: množství 2 → 1 (314) ---');
    try { await client.modifyOrder({ accountId: account, basketId: tp.basketId, symbol: SYMBOL, exchange: 'CME', quantity: 1, priceType: 'LIMIT', price: tp.price! }); log('314 TP přijato'); } catch (error) { log(`314 TP selhalo: ${(error as Error).message}`); }
    await wait(2_000);
    await snapshot('po změně TP');
    log('--- SL: množství 2 → 1 (314) ---');
    try { await client.modifyOrder({ accountId: account, basketId: sl.basketId, symbol: SYMBOL, exchange: 'CME', quantity: 1, priceType: 'STOP_MARKET', triggerPrice: sl.triggerPrice! }); log('314 SL přijato'); } catch (error) { log(`314 SL selhalo: ${(error as Error).message}`); }
    await wait(2_000);
    await snapshot('po změně SL');
  } catch (error) { log(`SELHALO: ${error instanceof Error ? error.message : String(error)}`); }
  log('--- úklid ---');
  try { await client.cancelAllOrders(account); } catch (error) { log(`zrušení všeho: ${(error as Error).message}`); }
  await wait(800);
  try { await client.exitPosition(account, SYMBOL, 'CME'); } catch (error) { log(`zavření pozice: ${(error as Error).message}`); }
  await wait(1_500);
  await snapshot('konec');
  client.close();
  setTimeout(() => process.exit(0), 300);
})().catch((error) => { console.error('SELHALO', error); process.exit(1); });
