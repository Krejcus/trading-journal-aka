/**
 * Měření svázaného příkazu (OCO, šablona 328) na Rithmic Test — simulované peníze.
 * A: Market 1 → OCO (SL stop + TP limit) → co přijde ve zprávách a ve snímku → posun SL (314) → zrušení JEDNÉ nohy → zruší se sestra?
 * B: nové OCO → TP posunout za trh (vyplní se) → zruší se SL sám? pozice 0?
 * Použití: RITHMIC_USER=… npx tsx scripts/rithmic/measureOco.ts [--symbol MNQZ6]
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
const updates: RithmicOrderUpdate[] = [];
const brief = (o: RithmicOrderUpdate) => `${o.basketId}|${o.source}|${o.notifyType}|${o.status}|${o.side}|type=${o.priceType}|px=${o.price}|trg=${o.triggerPrice}|qty=${o.quantity}|fill=${o.totalFillSize}@${o.avgFillPrice ?? o.fillPrice}|orig=${o.originalBasketId}|linked=${o.linkedBasketIds}|bracket=${o.bracketType}|tag=${o.userTag}|${o.completionReason}|${o.text}`;
const client = new RithmicClient({
  url: 'wss://rituz00100.rithmic.com:443',
  credentials: { user: process.env.RITHMIC_USER!, password, systemName: 'Rithmic Test', appName: 'fikr:AlphaTrade', appVersion: '0.1.0' },
  socketFactory: (url) => new WebSocket(url, { perMessageDeflate: false }) as unknown as RithmicSocketLike,
  events: { onOrderUpdate: (u) => { if (!u.isSnapshot) { updates.push(u); log(`  zpráva ${brief(u)}`); } } },
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
    return orders;
  };
  const cleanup = async () => {
    try { await client.cancelAllOrders(account); } catch (error) { log(`zrušení všeho selhalo: ${(error as Error).message}`); }
    await wait(800);
    try { await client.exitPosition(account, SYMBOL, 'CME'); } catch (error) { log(`zavření pozice: ${(error as Error).message}`); }
    await wait(1_500);
  };
  if ((await snapshot('start')).length) { log('účet má pracující příkazy — neměřím'); client.close(); return; }
  const run = Date.now().toString(36);
  log('--- vstup Market 1 ---');
  await client.placeOrder({ accountId: account, userTag: `oco-in-${run}`, symbol: SYMBOL, exchange: 'CME', side: 'BUY', quantity: 1, priceType: 'MARKET' });
  await wait(2_000);
  const fill = updates.find((u) => u.userTag === `oco-in-${run}` && (u.avgFillPrice ?? u.fillPrice) != null);
  const px = fill ? (fill.avgFillPrice ?? fill.fillPrice)! : NaN;
  if (!Number.isFinite(px)) { log('vstup se nevyplnil — končím'); await cleanup(); client.close(); return; }
  const grid = (v: number) => Math.round(v * 4) / 4;
  const oco = (suffix: string) => client.placeOcoOrder({ accountId: account, legs: [
    { userTag: `oco-sl-${suffix}`, symbol: SYMBOL, exchange: 'CME', side: 'SELL', quantity: 1, priceType: 'STOP_MARKET', triggerPrice: grid(px - 40) },
    { userTag: `oco-tp-${suffix}`, symbol: SYMBOL, exchange: 'CME', side: 'SELL', quantity: 1, priceType: 'LIMIT', price: grid(px + 40) },
  ] });
  try {
    log(`--- A: OCO (SL ${grid(px - 40)}, TP ${grid(px + 40)}) ---`);
    const a = await oco(`a${run}`);
    log(`odpověď 328 za ${a.ackAt - a.sentAt} ms: ${JSON.stringify(a.basketIds)}`);
    await wait(1_500);
    const legsA = await snapshot('A po zadání');
    const sl = legsA.find((o) => o.userTag === `oco-sl-a${run}`) ?? legsA.find((o) => o.priceType.includes('STOP'));
    const tp = legsA.find((o) => o.userTag === `oco-tp-a${run}`) ?? legsA.find((o) => o.priceType === 'LIMIT');
    if (!sl || !tp) throw new Error('nohy OCO nejsou ve snímku');
    log('--- A: posun SL o 2 b (314) ---');
    await client.modifyOrder({ accountId: account, basketId: sl.basketId, symbol: SYMBOL, exchange: 'CME', quantity: 1, priceType: 'STOP_MARKET', triggerPrice: grid(px - 38) });
    await wait(1_500);
    await snapshot('A po posunu SL');
    log('--- A: zrušení jen TP (316) ---');
    await client.cancelOrder(account, tp.basketId);
    await wait(2_000);
    const afterCancel = await snapshot('A po zrušení TP');
    log(`A výsledek: po zrušení TP zbylo pracujících ${afterCancel.length} (0 = zrušení jedné nohy ruší obě)`);
    if (afterCancel.length) { await client.cancelAllOrders(account); await wait(1_000); }
    log('--- B: nové OCO, TP za trh ---');
    const b = await oco(`b${run}`);
    log(`odpověď 328 za ${b.ackAt - b.sentAt} ms`);
    await wait(1_500);
    const legsB = await snapshot('B po zadání');
    const tpB = legsB.find((o) => o.userTag === `oco-tp-b${run}`) ?? legsB.find((o) => o.priceType === 'LIMIT');
    if (!tpB) throw new Error('TP druhého OCO není ve snímku');
    await client.modifyOrder({ accountId: account, basketId: tpB.basketId, symbol: SYMBOL, exchange: 'CME', quantity: 1, priceType: 'LIMIT', price: grid(px - 25) });
    await wait(3_000);
    const afterFill = await snapshot('B po vyplnění TP');
    log(`B výsledek: po vyplnění TP zbylo pracujících ${afterFill.length} (0 = vyplnění jedné nohy ruší druhou)`);
  } catch (error) {
    log(`SELHALO: ${error instanceof Error ? error.message : String(error)}`);
  }
  log('--- úklid ---');
  await cleanup();
  await snapshot('konec');
  client.close();
  setTimeout(() => process.exit(0), 300);
})().catch((error) => { console.error('SELHALO', error); process.exit(1); });
