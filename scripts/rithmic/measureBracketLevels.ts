/**
 * Měření na Rithmic Test (simulované peníze): změna VZDÁLENOSTÍ SL/TP u ČEKAJÍCÍHO vstupu s ochranou (šablony 334 / 332).
 * Buy Limit pod trhem se SL 40 / TP 80 ticků → změna na SL 60 / TP 100 → čtení ochrany → posun vstupu k trhu (vyplní se)
 * → nohy mají vzniknout v NOVÝCH vzdálenostech od ceny vyplnění. Nakonec vše zruší a pozici zavře.
 * Použití: RITHMIC_USER=… npx tsx scripts/rithmic/measureBracketLevels.ts --price <limit pod trhem> --fill <cena nad trhem v pásmu> [--stop]
 */
import { execFileSync } from 'node:child_process';
import WebSocket from 'ws';
import { RithmicClient, type RithmicOrderUpdate } from '../../services/rithmic/rithmicClient';
import type { RithmicSocketLike } from '../../services/rithmic/rithmicPlant';

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const SYMBOL = arg('symbol') ?? 'MNQZ6';
const PRICE = Number(arg('price'));
const FILL = Number(arg('fill'));
if (!Number.isFinite(PRICE) || !Number.isFinite(FILL)) { console.error('Chybí --price a --fill'); process.exit(1); }
const password = execFileSync('security', ['find-generic-password', '-s', 'alphatrade-rithmic-test', '-w'], { encoding: 'utf8' }).replace(/\n$/, '');
const t0 = Date.now();
const log = (text: string) => console.log(`${String(Date.now() - t0).padStart(6)} ms  ${text}`);
const brief = (o: RithmicOrderUpdate) => `${o.basketId}|${o.notifyType}|${o.status}|${o.side}|type=${o.priceType}|px=${o.price}|trg=${o.triggerPrice}|qty=${o.quantity}|fill=${o.totalFillSize}@${o.avgFillPrice ?? o.fillPrice}|orig=${o.originalBasketId}|bracket=${o.bracketType}|tag=${o.userTag}|${o.text}`;
const client = new RithmicClient({
  url: 'wss://rituz00100.rithmic.com:443',
  credentials: { user: process.env.RITHMIC_USER!, password, systemName: 'Rithmic Test', appName: 'fikr:AlphaTrade', appVersion: '0.1.0' },
  socketFactory: (url) => new WebSocket(url, { perMessageDeflate: false }) as unknown as RithmicSocketLike,
  events: {
    onOrderUpdate: (u) => { if (!u.isSnapshot && /MODIF|REJECT|FAIL|FILL|NOT_|BRACKET/i.test(u.notifyType)) log(`  zpráva ${brief(u)}`); },
    onBracketUpdate: (b) => log(`  bracket ${JSON.stringify(b)}`),
  } as never,
});
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const open = (o: RithmicOrderUpdate) => !['complete', 'cancelled', 'canceled'].includes(o.status.toLowerCase());

(async () => {
  await client.connect(['order']);
  const account = client.accounts[0].accountId;
  const read = async (label: string) => {
    const orders = (await client.showOrders(account)).filter(open);
    log(`[${label}] pracující: ${orders.length}`);
    for (const order of orders) log(`    ${brief(order)}`);
    try { log(`    TP: ${JSON.stringify(await client.showBrackets(account))}  SL: ${JSON.stringify(await client.showBracketStops(account))}`); } catch (error) { log(`    ochrana nejde přečíst: ${(error as Error).message}`); }
    return orders;
  };
  if ((await read('start')).length) { log('účet má pracující příkazy — neměřím'); client.close(); return; }
  try {
    const ack = await client.placeBracketOrder({ accountId: account, userTag: `bl-${Date.now().toString(36)}`, symbol: SYMBOL, exchange: 'CME', side: 'BUY', quantity: 1, priceType: 'LIMIT', price: PRICE, stopTicks: 40, targetTicks: 80 });
    log(`zadáno ${ack.basketId} (SL 40 / TP 80 ticků)`);
    await wait(1_500);
    await read('před změnou');
    for (const level of [0, 1]) {
      try { const r = await client.updateStopBracketLevel(account, ack.basketId, level, 60); log(`334 level ${level} → ${JSON.stringify(r.terminal?.fields)}`); } catch (error) { log(`334 level ${level} selhalo: ${(error as Error).message}`); }
      await wait(700);
    }
    for (const level of [0, 1]) {
      try { const r = await client.updateTargetBracketLevel(account, ack.basketId, level, 100); log(`332 level ${level} → ${JSON.stringify(r.terminal?.fields)}`); } catch (error) { log(`332 level ${level} selhalo: ${(error as Error).message}`); }
      await wait(700);
    }
    await read('po změně vzdáleností');
    log(`--- posun vstupu na ${FILL} (má se vyplnit) ---`);
    await client.modifyOrder({ accountId: account, basketId: ack.basketId, symbol: SYMBOL, exchange: 'CME', quantity: 1, priceType: 'LIMIT', price: FILL });
    await wait(3_000);
    await read('po vyplnění');
  } catch (error) { log(`SELHALO: ${error instanceof Error ? error.message : String(error)}`); }
  log('--- úklid ---');
  try { await client.cancelAllOrders(account); } catch (error) { log(`zrušení všeho: ${(error as Error).message}`); }
  await wait(800);
  try { await client.exitPosition(account, SYMBOL, 'CME'); } catch (error) { log(`zavření pozice: ${(error as Error).message}`); }
  await wait(1_500);
  await read('konec');
  client.close();
  setTimeout(() => process.exit(0), 300);
})().catch((error) => { console.error('SELHALO', error); process.exit(1); });
