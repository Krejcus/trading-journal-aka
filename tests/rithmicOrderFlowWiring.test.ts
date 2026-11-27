import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Pojistky zapojení order flow do služby, která obchoduje naostro. Hlídají pořadí a místa v kódu,
 * na kterých stojí bezpečnost: data z druhého kontraktu (NQ) se nesmí dostat k upozorněním, svíčkám
 * ani cenám pro příkazy a order flow nesmí zdržet start cen ani rozpočet příkazů.
 */
const server = readFileSync('scripts/rithmic/devTradeServer.ts', 'utf8');
const launcher = readFileSync('scripts/rithmic/lucid.sh', 'utf8');
const hook = readFileSync('hooks/useRithmicLocalTrading.ts', 'utf8');
const at = (text: string, needle: string | RegExp): number => {
  const index = typeof needle === 'string' ? text.indexOf(needle) : text.search(needle);
  expect(index, `chybí: ${String(needle)}`).toBeGreaterThanOrEqual(0);
  return index;
};

describe('order flow ve službě — pojistky zapojení', () => {
  it('bez přepínače žádný feed: vzniká jen za --order-flow a jen na jednom místě', () => {
    expect(server).toMatch(/const ORDER_FLOW = process\.argv\.includes\('--order-flow'\);/);
    expect(server.match(/createOrderFlowFeed\(/g)).toHaveLength(1);
    const gate = at(server, 'if (ORDER_FLOW) {');
    const create = at(server, 'createOrderFlowFeed(');
    expect(create).toBeGreaterThan(gate);
    expect(create - gate).toBeLessThan(1_200);
    expect(server).toMatch(/let orderFlow: OrderFlowFeed \| null = null;/);
  });

  it('obchod jiného kontraktu (NQ) končí u order flow dřív než počítadlo, měření, upozornění a svíčky', () => {
    const handler = server.slice(at(server, 'onTick: (tick) => {'));
    const branch = at(handler, 'if (tick.symbol !== CONTRACT) {');
    const returns = handler.indexOf('return;', branch);
    expect(handler.slice(branch, returns)).toMatch(/orderFlow\?\.onTick\(tick\);/);
    expect(returns).toBeLessThan(at(handler, 'tickCount += 1;'));
    expect(returns).toBeLessThan(at(handler, 'exchangeLag.push('));
    expect(returns).toBeLessThan(at(handler, 'alertWatch?.onTrade('));
    expect(returns).toBeLessThan(at(handler, 'candles.onTick(tick)'));
    // Upozornění a svíčky dostávají vždy jen kontrakt grafu.
    expect(server).toMatch(/alertWatch\?\.onTrade\(tick\.tradePrice, tick\.receivedAt, CONTRACT\)/);
    expect(server.match(/candles\.onTick\(/g)).toHaveLength(1);
  });

  it('ceny pro kontroly příkazů se čtou jen z kontraktu grafu', () => {
    expect(server).toMatch(/serverPrice: \(symbol\) => \(symbol === CONTRACT \? freshPrice\(Date\.now\(\)\) : null\)/);
    expect(server).toMatch(/serverQuote: \(symbol\) => \(symbol === CONTRACT && feedOpen \? candles\.quote\(CONTRACT, Date\.now\(\), 30_000\) : null\)/);
  });

  it('start: feed vznikne bez čekání na síť, NQ se řeší až po odběru cen grafu a nečeká se na něj', () => {
    const create = at(server, 'createOrderFlowFeed(');
    const mainSubscribe = at(server, "const feedStartedAt = Date.now();\n  await ticker.subscribeMarketData(CONTRACT, 'CME');\n  feedOpen = true;");
    const nq = at(server, 'void startOrderFlowNq();');
    expect(create).toBeLessThan(mainSubscribe);
    expect(nq).toBeGreaterThan(mainSubscribe);
    expect(server.slice(at(server, 'if (ORDER_FLOW) {'), mainSubscribe)).not.toMatch(/await /);
    expect(server).not.toMatch(/await startOrderFlowNq\(/);
    expect(server).toMatch(/orderFlow\?\.feedOpened\(feedStartedAt, CONTRACT\);/);
  });

  it('odběr navíc je jen na obchody a kontrakt se značí za tekoucí až po jeho potvrzení', () => {
    const extra = server.slice(at(server, 'const subscribeOrderFlowExtra = async'), at(server, 'const startOrderFlowNq = async'));
    const subscribe = at(extra, "await ticker.subscribeMarketData(symbol, 'CME', 1);");
    expect(at(extra, 'flow.feedOpened(Date.now(), symbol);')).toBeGreaterThan(subscribe);
    expect(extra).toMatch(/if \(attempt < 2\) setTimeout\(/);
    expect(extra).toMatch(/if \(!flow \|\| forcedOut \|\| !feedOpen\) return;/);
  });

  it('obnova cen: nejdřív kontrakt grafu, druhý odběr bez čekání; výpadek se order flow oznámí', () => {
    const restore = server.slice(at(server, 'function scheduleFeedRestore('), at(server, "console.log('[ticker] ceny obnoveny');"));
    expect(restore).toMatch(/await ticker\.subscribeMarketData\(CONTRACT, 'CME'\);\s+feedOpen = true;\s+orderFlow\?\.feedOpened\(Date\.now\(\), CONTRACT\);/);
    expect(restore).toMatch(/for \(const symbol of orderFlowExtras\) void subscribeOrderFlowExtra\(symbol\);/);
    expect(restore).not.toMatch(/await subscribeOrderFlowExtra/);
    expect(server).toMatch(/alertWatch\?\.feedLost\(\);\s+orderFlow\?\.feedLost\(\);/);
  });

  it('žádost o odběr se řeší před rozpočtem příkazů, po kontrole odvolaného zařízení a nikdy nejde k brokerovi', () => {
    const handler = server.slice(at(server, "socket.on('message', (raw) => {"));
    const branch = at(handler, 'if (orderFlowRequest !== undefined && !message.command) {');
    const end = handler.indexOf('return;\n          }', branch);
    const body = handler.slice(branch, end);
    expect(body).toMatch(/if \(access\.deviceId && !activeDevice\(access\.deviceId\)\) \{ socket\.terminate\(\); return; \}/);
    expect(body).toMatch(/orderFlow \? orderFlow\.handle\(socket, orderFlowRequest\)/);
    expect(body).toMatch(/socket\.bufferedAmount < 64 \* 1024/);
    expect(body).not.toMatch(/exec[!.]|broker\.|recent\.push/);
    expect(branch).toBeLessThan(at(handler, "if (recent.length >= 20) throw new Error('příliš mnoho příkazů za krátkou dobu');"));
    expect(branch).toBeLessThan(at(handler, 'exec!.execute(message.command)'));
  });

  it('hello nabízí order flow jen když vrstva běží; odpojení klienta ji uklidí', () => {
    expect(server).toMatch(/\.\.\.\(orderFlow\?\.capability\(\) \? \{ orderFlow: orderFlow\.capability\(\) \} : \{\}\)/);
    expect(server).toMatch(/socket\.on\('close', \(\) => \{ clients\.delete\(socket\); orderFlow\?\.drop\(socket\); \}\);/);
  });

  it('spouštěč zapíná order flow jen proměnnou ORDER_FLOW=ano', () => {
    expect(launcher).toMatch(/FLOW=\(\)\n\[ "\$\{ORDER_FLOW:-\}" = "ano" \] && FLOW=\(--order-flow\)/);
    expect(launcher.match(/"\$\{FLOW\[@\]\}"/g)).toHaveLength(4);
  });

  it('appka: zprávy order flow jdou mimo stav Reactu a příkazy se jich netýkají', () => {
    const branch = hook.slice(at(hook, "} else if (message.type === 'of' || message.type === 'of-trade'"), at(hook, "} else if (message.type === 'tick') {"));
    expect(branch).toMatch(/orderFlow\?\.message\(message\);/);
    expect(branch).not.toMatch(/set[A-Z]\w*\(/);
    expect(hook).toMatch(/orderFlow\?\.sessionReset\(\);/);
    expect(hook).toMatch(/orderFlow = orderFlowLink\.attach\(\(request\) => connection\.sendOrderFlow\(request\)\);/);
  });
});
