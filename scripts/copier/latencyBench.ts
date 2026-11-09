/**
 * Měření latence příkazů z grafu proti LOKÁLNÍMU workeru (loopback 127.0.0.1).
 *
 * Jen sólo DEMO: skript odmítne běžet, pokud worker není `environment=demo`,
 * skupina není `manualOnly` bez followerů a leader není účet z `--account`.
 * Každý cyklus: Market vstup 1 MNQ se SL/TP → posuny SL a TP → zavření;
 * volitelně Limit daleko od trhu → zrušení. Na konci vždy ověří flat.
 *
 *   npx tsx scripts/copier/latencyBench.ts --account 61038658 --cycles 3 --label baseline
 *
 * Měří: odpověď workeru (HTTP), čas do změny ve statusu workeru (pozice,
 * nová cena nohy, flat). Neměří relay (Vercel/Supabase) ani prohlížeč.
 */
import { performance } from 'node:perf_hooks';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createClient } from '@supabase/supabase-js';
import { enqueueTradovateCopierCommand, readTradovateCopierCommand } from '../../server/tradovateCopierCommandRelay';
import { copierKickWaitsForPush, pushBoundCopierCommand, readCopierRelayIdle, scheduleCopierKickAfterPush } from '../../server/copierCommandPushRelay';
import { buildLeaderEntryPreviewCommand } from '../../lib/leaderEntryPreview';
import { leaderEntryPayloadHash } from '../../lib/leaderEntryPlace';
import { buildLeaderOrderManageCommand } from '../../lib/leaderOrderManage';

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const BASE = 'http://127.0.0.1:3211';
const ORIGIN = flag('origin', 'http://localhost:3000');
const ACCOUNT = Number(flag('account', '0'));
const CYCLES = Math.max(1, Math.min(20, Number(flag('cycles', '3'))));
const MOVES = Math.max(0, Math.min(10, Number(flag('moves', '3'))));
const LABEL = flag('label', 'run');
const OUT = flag('out', '');
const WITH_LIMIT = flag('limit', 'on') === 'on';
const DISTANCE = Number(flag('distance', '60'));

type Status = any;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const tick = (value: number) => Math.round(value * 4) / 4;
const newId = (prefix: string) => `${prefix}:${[...crypto.getRandomValues(new Uint8Array(12))].map(b => b.toString(16).padStart(2, '0')).join('')}`;

async function status(): Promise<Status> {
  const response = await fetch(`${BASE}/v1/status`, { headers: { Origin: ORIGIN } });
  if (!response.ok) throw new Error(`status ${response.status}`);
  return response.json();
}

// Relay cesta jako v api/tradovate/oauth/copier-relay.ts (admission → push/kick → čtení výsledku),
// jen spuštěná lokálně se service-role klíčem z env souboru (hodnoty se nikdy nevypisují).
const envFile = (path: string) => Object.fromEntries(readFileSync(path, 'utf8').split('\n')
  .map(line => /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())).filter((m): m is RegExpExecArray => !!m)
  .map(m => [m[1], m[2].replace(/^"|"$/g, '')]));
const ENV_DIR = flag('env-dir', `${homedir()}/Documents/trading-journal-aka`);
const secrets = { ...envFile(`${ENV_DIR}/.env.local`), ...envFile(`${ENV_DIR}/.env.vercel.txt`) };
const SUPABASE_URL = secrets.VITE_SUPABASE_URL;
const SERVICE_KEY = secrets.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) throw new Error('chybí Supabase URL nebo service-role klíč');
const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const LOG = `${homedir()}/Library/Application Support/AlphaTrade/copier/mac-agent.stdout.log`;
let userId = '';
let connectionId = '';
interface Sent { ms: number; payload: any; commandId: string }
async function send(command: unknown): Promise<Sent> {
  const wrapped = { type: 'copy-command', command } as never;
  const started = performance.now();
  const relayIdle = readCopierRelayIdle({ db, userId, connectionId });
  const queued = await enqueueTradovateCopierCommand({ db, userId, connectionId, command: wrapped, relayIdle });
  const { preclaimed } = queued as any;
  const push = pushBoundCopierCommand({ db, deviceId: queued.deviceId, supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_KEY, prefetched: relayIdle, preclaimed });
  const sendKick = async () => {
    await fetch(`${SUPABASE_URL}/realtime/v1/api/broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
      body: JSON.stringify({ messages: [{ topic: `copier-kick-${queued.deviceId}`, event: 'kick', payload: {} }] }),
      signal: AbortSignal.timeout(1500),
    }).catch(() => undefined);
  };
  let settled = false;
  void (copierKickWaitsForPush(wrapped) ? scheduleCopierKickAfterPush({ push, sendKick, settled: () => settled }) : sendKick());
  const deadline = performance.now() + 12_000;
  while (performance.now() < deadline) {
    await sleep(25);
    const current: any = await readTradovateCopierCommand({ db, userId, commandId: queued.id });
    if (current.status === 'succeeded' || current.status === 'rejected' || current.status === 'expired') {
      settled = true;
      const ms = performance.now() - started;
      if (current.status !== 'succeeded') throw new Error(`relay ${current.status}: ${JSON.stringify(current.error ?? current.result).slice(0, 500)}`);
      return { ms, payload: current.result, commandId: queued.id };
    }
  }
  settled = true;
  throw new Error(`relay timeout ${queued.id}`);
}
/** Časy workeru z jeho logu: fronta relaye, provedení, ACK. */
function workerTimes(commandId: string): { queueMs?: number; execMs?: number; ackMs?: number } {
  try {
    const text = readFileSync(LOG, 'utf8');
    const tail = text.slice(-400_000);
    const pick = (pattern: RegExp) => { const m = pattern.exec(tail); return m ? Number(m[1]) : undefined; };
    return {
      queueMs: pick(new RegExp(`RELAY CMD \\S+ id=${commandId} queueMs=([0-9.]+)`)),
      execMs: pick(new RegExp(`RELAY EXECUTED id=${commandId} durationMs=([0-9.]+)`)),
      ackMs: pick(new RegExp(`RELAY ACK id=${commandId} .*durationMs=([0-9.]+)`)),
    };
  } catch { return {}; }
}

/** Čeká na podmínku ve statusu; vrací ms od `since` (performance.now) nebo null po timeoutu. */
async function until(since: number, predicate: (s: Status) => boolean, timeoutMs = 8000): Promise<number | null> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const current = await status();
    if (predicate(current)) return performance.now() - since;
    await sleep(15);
  }
  return null;
}

const leaderNet = (s: Status, symbol: string): number => {
  const rows = (s.controller.exposure?.positions ?? []) as any[];
  const hit = rows.find(row => row.symbol === symbol && Number(row.netQuantity ?? 0) !== 0);
  return hit ? Number(hit.netQuantity) : 0;
};
const ordersText = (s: Status) => JSON.stringify(s.controller.exposure ?? {});
const hasPrice = (s: Status, price: number) => ordersText(s).includes(`${price}`);

function guard(s: Status) {
  const group = s.group;
  if (s.environment !== 'demo') throw new Error('worker není v prostředí demo');
  if (!group || group.manualOnly !== true || (group.followers ?? []).length !== 0) throw new Error('skupina není sólo manual-only DEMO');
  if (!ACCOUNT || group.leaderAccountId !== ACCOUNT) throw new Error('leader neodpovídá --account');
  if (s.controller.armed !== true || s.controller.connected !== true) throw new Error('worker není ARMED/connected');
  if (s.controller.lastError) throw new Error(`lastError: ${JSON.stringify(s.controller.lastError).slice(0, 200)}`);
}

function quote(s: Status, symbol: string): { price: number; at: number } {
  const row = (s.marketPrices ?? []).find((entry: any) => entry.symbol === symbol);
  if (!row || Date.now() - row.at > 3000) throw new Error('chybí čerstvá cena workeru');
  return { price: row.price, at: row.at };
}

function entryCommand(s: Status, draft: Record<string, unknown>) {
  const preview = buildLeaderEntryPreviewCommand(draft as never, {
    group: s.group, armedAt: s.controller.armedAt, excludedFollowers: new Set<number>(),
    participation: [], operationId: newId('entry'),
  });
  const base = { ...preview, type: 'place-leader-entry' as const };
  return { ...base, payloadHash: leaderEntryPayloadHash(base as never) };
}

interface Sample { cycle: number; action: string; responseMs: number; statusMs: number | null; status: string; commandId?: string; queueMs?: number; execMs?: number; ackMs?: number }
const samples: Sample[] = [];
const record = (sample: Sample) => {
  samples.push(sample);
  console.log(`${LABEL} c${sample.cycle} ${sample.action.padEnd(14)} total=${sample.responseMs.toFixed(0).padStart(5)} ms  status=${sample.statusMs == null ? '  n/a' : sample.statusMs.toFixed(0).padStart(5)} ms  ${sample.status}`);
};

async function ensureFlat(symbol: string) {
  const s = await status();
  if (leaderNet(s, symbol) !== 0 || (s.controller.pendingOwnEntries ?? []).length > 0 || s.controller.groupFlat !== true) {
    throw new Error(`účet není flat / má čekající příkazy: net=${leaderNet(s, symbol)} pending=${(s.controller.pendingOwnEntries ?? []).length} groupFlat=${s.controller.groupFlat}`);
  }
}

async function cycle(index: number) {
  let s = await status();
  guard(s);
  if (!userId) {
    connectionId = flag('connection', (s.connectionUsage ?? [])[0]?.connectionId ?? '');
    const { data, error } = await db.from('tradovate_oauth_connections').select('user_id').eq('id', connectionId).maybeSingle<{ user_id: string }>();
    if (error || !data) throw new Error('připojení nenalezeno');
    userId = data.user_id;
  }
  const symbol: string = s.controller.brokerFrontContract?.contract;
  if (!symbol) throw new Error('chybí front kontrakt');
  const GAP = Number(flag('gap', '2600'));
  let stop = 0;
  let target = 0;
  let started = performance.now();
  let q = quote(s, symbol);
  let entry: { operationId: string };
  const adopted = (s.controller.manageableLeaderTrades ?? []).find((trade: any) => trade.source === 'own' && trade.symbol === symbol && trade.entryOperationId);
  if (adopted && leaderNet(s, symbol) === 1) {
    // Rozpracovaný cyklus (např. po chybě): převezmi otevřený vlastní obchod a jen ho dokonči.
    const orders = (s.controller.exposure?.orders ?? []) as any[];
    stop = orders.find(order => order.orderType === 'Stop' && order.status === 'working')?.stopPrice;
    target = orders.find(order => order.orderType === 'Limit' && order.status === 'working')?.limitPrice;
    if (!stop || !target) throw new Error('otevřený obchod nemá obě nohy — zavři ručně');
    entry = { operationId: adopted.entryOperationId };
    console.log(`${LABEL} c${index} převzat otevřený obchod ${entry.operationId} SL ${stop} TP ${target}`);
  } else {
    await ensureFlat(symbol);
    stop = tick(q.price - DISTANCE);
    target = tick(q.price + DISTANCE);
    const placedEntry = entryCommand(s, { symbol, side: 'Buy', quantity: 1, orderType: 'Market', referencePrice: q.price, quoteReceivedAt: q.at, stopLoss: stop, takeProfit: target });
    entry = placedEntry;
    started = performance.now();
    const positionWatch = until(started, current => leaderNet(current, symbol) !== 0);
    const placed = await send(placedEntry);
    const result = placed.payload.result;
    const positionMs = result?.status === 'acknowledged' ? await positionWatch : null;
    record({ cycle: index, action: 'market-entry', responseMs: placed.ms, statusMs: positionMs, status: result?.status ?? 'no-result', commandId: placed.commandId });
    if (result?.status !== 'acknowledged') throw new Error(`vstup: ${JSON.stringify(result).slice(0, 500)}`);
    const manageableMs = await until(started, current => (current.controller.manageableLeaderTrades ?? []).some((trade: any) => trade.entryOperationId === placedEntry.operationId)
      && (current.controller.exposure?.orders ?? []).filter((order: any) => order.status === 'working').length >= 2, 10_000);
    record({ cycle: index, action: 'manage-ready', responseMs: 0, statusMs: manageableMs, status: manageableMs == null ? 'timeout' : 'ok' });
    if (index === 1 && OUT) writeFileSync(`${OUT}.status-open.json`, JSON.stringify(await status(), null, 1));
  }

  const manage = async (action: string, fields: Record<string, unknown>, done: (s: Status) => boolean) => {
    const command = buildLeaderOrderManageCommand({
      groupId: s.group.id, operationId: newId('manage'), leaderAccountId: ACCOUNT,
      entryOperationId: entry.operationId, symbol, action, ...fields,
    } as never);
    const startedAt = performance.now();
    const watch = until(startedAt, done);
    const sent = await send(command);
    const managed = sent.payload.result;
    const seenMs = managed?.status === 'acknowledged' ? await watch : null;
    record({ cycle: index, action, responseMs: sent.ms, statusMs: seenMs, commandId: sent.commandId, status: managed?.status === 'acknowledged' ? 'acknowledged' : `${managed?.status}: ${managed?.reason ?? JSON.stringify(managed?.blockers ?? []).slice(0, 200)}` });
    return managed?.status === 'acknowledged';
  };

  for (let move = 0; move < MOVES; move += 1) {
    await sleep(GAP);
    const next = tick(stop - 0.25);
    if (await manage('move-stop', { expect: { price: stop, quantity: 1 }, newPrice: next }, current => hasPrice(current, next))) stop = next;
    await sleep(GAP);
    const nextTarget = tick(target + 0.25);
    if (await manage('move-target', { expect: { price: target, quantity: 1 }, newPrice: nextTarget }, current => hasPrice(current, nextTarget))) target = nextTarget;
  }

  await sleep(GAP);
  started = performance.now();
  const closed = await manage('close-position', { expect: { price: stop, quantity: 1 } }, current => leaderNet(current, symbol) === 0);
  if (!closed) throw new Error('zavření nepotvrzeno — zkontroluj účet');
  const flatMs = await until(started, current => current.controller.groupFlat === true && leaderNet(current, symbol) === 0, 10_000);
  record({ cycle: index, action: 'close-flat', responseMs: 0, statusMs: flatMs, status: flatMs == null ? 'timeout' : 'ok' });

  if (WITH_LIMIT) {
    await sleep(GAP + 1500);
    s = await status();
    guard(s);
    q = quote(s, symbol);
    const limit = tick(q.price - DISTANCE);
    const limitEntry = entryCommand(s, { symbol, side: 'Buy', quantity: 1, orderType: 'Limit', price: limit, stopLoss: tick(limit - DISTANCE), takeProfit: tick(limit + DISTANCE) });
    started = performance.now();
    const pendingWatch = until(started, current => (current.controller.pendingOwnEntries ?? []).some((row: any) => row.entryOperationId === limitEntry.operationId), 5000);
    const limitPlaced = await send(limitEntry);
    const limitResult = limitPlaced.payload.result;
    const pendingMs = limitResult?.status === 'acknowledged' ? await pendingWatch : null;
    record({ cycle: index, action: 'limit-entry', responseMs: limitPlaced.ms, statusMs: pendingMs, commandId: limitPlaced.commandId,
      status: limitResult?.status === 'acknowledged' ? 'acknowledged' : `${limitResult?.status}: ${JSON.stringify(limitResult?.blockers ?? limitResult?.reason ?? '').slice(0, 300)}` });
    if (limitResult?.status === 'acknowledged') {
      await sleep(GAP);
      const cancel = buildLeaderOrderManageCommand({
        groupId: s.group.id, operationId: newId('manage'), leaderAccountId: ACCOUNT,
        entryOperationId: limitEntry.operationId, symbol, action: 'cancel-entry', expect: { price: limit, quantity: 1 },
      } as never);
      started = performance.now();
      const goneWatch = until(started, current => !(current.controller.pendingOwnEntries ?? []).some((row: any) => row.entryOperationId === limitEntry.operationId));
      const cancelSent = await send(cancel);
      const cancelResult = cancelSent.payload.result;
      const goneMs = await goneWatch;
      record({ cycle: index, action: 'cancel-entry', responseMs: cancelSent.ms, statusMs: goneMs, status: cancelResult?.status ?? 'no-result', commandId: cancelSent.commandId });
      if (cancelResult?.status !== 'acknowledged') throw new Error(`zrušení limitu: ${JSON.stringify(cancelResult).slice(0, 400)}`);
    }
  }
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : Number.NaN;
};

(async () => {
  let failure: unknown = null;
  for (let index = 1; index <= CYCLES; index += 1) {
    try { await cycle(index); } catch (reason) { failure = reason; break; }
    await sleep(1500);
  }
  await sleep(1500);
  for (const sample of samples) if (sample.commandId) Object.assign(sample, workerTimes(sample.commandId));
  console.log(`\n${LABEL} souhrn (medián / min / max, n):`);
  for (const action of [...new Set(samples.map(sample => sample.action))]) {
    const rows = samples.filter(sample => sample.action === action);
    const line = (label: string, values: number[]) => values.length
      ? `${label} ${median(values).toFixed(0)} / ${Math.min(...values).toFixed(0)} / ${Math.max(...values).toFixed(0)} (n=${values.length})` : `${label} —`;
    const nums = (pick: (row: Sample) => number | null | undefined) => rows.map(pick).filter((value): value is number => value != null && value > 0);
    console.log(`  ${action.padEnd(14)} ${line('total', nums(row => row.responseMs))} | ${line('status', nums(row => row.statusMs))} | ${line('queue', nums(row => row.queueMs))} | ${line('exec', nums(row => row.execMs))} | ${line('ack', nums(row => row.ackMs))}`);
  }
  if (OUT) writeFileSync(`${OUT}.json`, JSON.stringify({ label: LABEL, at: new Date().toISOString(), samples }, null, 1));
  const end = await status();
  console.log(`\nkonec: armed=${end.controller.armed} groupFlat=${end.controller.groupFlat} positions=${JSON.stringify(end.controller.leaderPositions)} pending=${(end.controller.pendingOwnEntries ?? []).length} lastError=${JSON.stringify(end.controller.lastError)}`);
  if (failure) { console.error(`CHYBA: ${failure instanceof Error ? failure.message : String(failure)}`); process.exit(1); }
})();
