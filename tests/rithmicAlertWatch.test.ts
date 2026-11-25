import { describe, expect, it } from 'vitest';
import { createRithmicAlertWatch, type AlertWatchPersisted, type AlertWatchStatus } from '../services/rithmic/alertWatch';
import { alertListDigest, alertUserTag, parseRithmicAlertFired, parseRithmicAlertWatchStatus, rithmicAlertWatchLabel, rithmicAlertWatchProblem, rithmicWatchedAlerts } from '../lib/rithmicAlertWatch';
import { priceAlertWatchGrant, signPriceAlertWatchRequest, verifyPriceAlertWatchRequest } from '../server/priceAlertWatchKey';
import { readFileSync } from 'node:fs';

const USER = '0b9d1c64-1f0a-4c55-9d21-6a3f7e2b8c11';
const OTHER = '7a1e3b52-9c0d-4e8f-a1b2-c3d4e5f60718';
const SECRET = 's'.repeat(48);
const KEY = priceAlertWatchGrant(USER, SECRET)!.key;
const NOW = 1_800_000_000_000;
const alert = (patch: Record<string, unknown> = {}) => ({ id: 'pa-a1', symbol: 'MNQ', price: 100, condition: 'cross', conditionAuto: false, frequency: 'once', version: 1, expiresAt: null, ...patch });

function setup(options: { saved?: AlertWatchPersisted | null; reply?: (body: { triggers: Array<{ triggerId: string }> }) => { status: number; json: unknown } | Error } = {}) {
  let clock = NOW;
  let n = 0;
  const posts: Array<{ url: string; headers: Record<string, string>; payload: string }> = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const statuses: AlertWatchStatus[] = [];
  const logs: string[] = [];
  const fired: Array<{ alertId: string; version: number; triggerId: string; user: string }> = [];
  let saved: AlertWatchPersisted | null = options.saved ?? null;
  const reply = options.reply ?? ((body) => ({ status: 200, json: { results: body.triggers.map((t) => ({ triggerId: t.triggerId, status: 'triggered' })) } }));
  const watch = createRithmicAlertWatch({
    now: () => clock,
    uuid: () => `00000000-0000-4000-8000-${String(n += 1).padStart(12, '0')}`,
    apiBase: 'https://app.example',
    sign: signPriceAlertWatchRequest,
    post: async (url, headers, body) => {
      const payload = (JSON.parse(body) as { payload: string }).payload;
      posts.push({ url, headers, payload });
      const out = reply(JSON.parse(payload) as { triggers: Array<{ triggerId: string }> });
      if (out instanceof Error) throw out;
      return out;
    },
    load: () => saved,
    save: (state) => { saved = JSON.parse(JSON.stringify(state)) as AlertWatchPersisted; },
    onStatus: (status) => { statuses.push(status); },
    onFired: (item) => { fired.push(item); },
    log: (line) => { logs.push(line); },
    // Sdružený zápis na disk (250 ms) proběhne v testu hned; časovače opakování se sbírají.
    setTimer: (fn, ms) => { if (ms === 250) fn(); else timers.push({ fn, ms }); return 0; },
  });
  const trade = (price: number, afterMs = 100) => { clock += afterMs; watch.onTrade(price, clock, 'MNQZ6'); };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { watch, posts, timers, statuses, logs, fired, trade, settle, saved: () => saved, now: () => clock };
}

describe('hlídání upozornění ve službě Rithmic', () => {
  it('křížení úrovně se podepsané ohlásí serveru; první obchod je jen výchozí cena', async () => {
    const t = setup();
    expect(t.watch.setKey({ userId: USER, key: KEY })).toEqual({ ok: true });
    expect(t.watch.setAlerts({ userId: USER, alerts: [alert()] })).toEqual({ ok: true, count: 1 });
    t.trade(99); t.trade(99.5);
    expect(t.posts).toHaveLength(0);
    t.trade(100.25);
    await t.settle();
    expect(t.posts).toHaveLength(1);
    expect(t.posts[0].url).toBe('https://app.example/api/price-alerts/watch');
    expect(verifyPriceAlertWatchRequest(t.posts[0].headers['x-alphatrade-alert-auth'], t.posts[0].payload, t.now(), SECRET)).toEqual({ userId: USER });
    expect(JSON.parse(t.posts[0].payload)).toMatchObject({ action: 'trigger', triggers: [{ alertId: 'pa-a1', version: 1, front: 'MNQZ6' }] });
    // „Jednou“: další křížení už nic neposílá.
    t.trade(99); t.trade(101);
    await t.settle();
    expect(t.posts).toHaveLength(1);
    expect(t.watch.status()).toEqual({ count: 1, keyed: true, feed: true, error: null, digest: alertListDigest([{ id: 'pa-a1', version: 1 }]), user: alertUserTag(USER) });
  });

  it('výpadek cen: skok přes úroveň po obnově nic neohlásí', async () => {
    const t = setup();
    t.watch.setKey({ userId: USER, key: KEY });
    t.watch.setAlerts({ userId: USER, alerts: [alert()] });
    t.trade(99); t.trade(99.5);
    t.watch.feedLost();
    expect(t.watch.status().feed).toBe(false);
    t.trade(101, 30_000);
    await t.settle();
    expect(t.posts).toHaveLength(0);
    expect(t.watch.status().feed).toBe(true);
  });

  it('server nedostupný: dva další pokusy se stejným ID, pak se křížení uvolní pro příští ohlášení', async () => {
    const t = setup({ reply: () => new Error('síť') });
    t.watch.setKey({ userId: USER, key: KEY });
    t.watch.setAlerts({ userId: USER, alerts: [alert()] });
    t.trade(99); t.trade(99.5); t.trade(100.5);
    await t.settle();
    expect(t.timers.map((x) => x.ms)).toEqual([5_000]);
    // Nové obchody během čekání neposílají nic mimo pořadí pokusů.
    t.trade(100.75);
    await t.settle();
    expect(t.posts).toHaveLength(1);
    t.timers[0].fn(); await t.settle();
    t.timers[1].fn(); await t.settle();
    expect(t.posts).toHaveLength(3);
    const ids = t.posts.map((p) => (JSON.parse(p.payload) as { triggers: Array<{ triggerId: string }> }).triggers[0].triggerId);
    expect(new Set(ids).size).toBe(1);
    expect(t.timers).toHaveLength(2);
    expect(t.watch.status().error).toMatch(/nedostupný/);
    // Uvolněno: další křížení se ohlásí znovu (nové ID).
    t.trade(99); t.trade(100.5);
    await t.settle();
    expect(t.posts).toHaveLength(4);
  });

  it('server klíč neuzná (401): klíč se zahodí a služba čeká na nový od appky', async () => {
    const t = setup({ reply: () => ({ status: 401, json: { error: 'invalid-alert-auth' } }) });
    t.watch.setKey({ userId: USER, key: KEY });
    t.watch.setAlerts({ userId: USER, alerts: [alert()] });
    t.trade(99); t.trade(99.5); t.trade(100.5);
    await t.settle();
    expect(t.watch.status()).toMatchObject({ keyed: false });
    expect(t.saved()).toMatchObject({ userId: USER, key: null });
    expect(t.timers).toHaveLength(0);
  });

  it('upozornění, které server už nezná (smazané, vypršelé), přestane hlídat; odstup „pokaždé“ ho nechá', async () => {
    const status = { value: 'rejected:expired' };
    const t = setup({ reply: (body) => ({ status: 200, json: { results: body.triggers.map((x) => ({ triggerId: x.triggerId, status: status.value })) } }) });
    t.watch.setKey({ userId: USER, key: KEY });
    t.watch.setAlerts({ userId: USER, alerts: [alert(), alert({ id: 'pa-b2', price: 200, frequency: 'every' })] });
    t.trade(99); t.trade(99.5); t.trade(100.5);
    await t.settle();
    expect(t.watch.status().count).toBe(1);
    status.value = 'rejected:cooldown';
    t.trade(199); t.trade(200.5);
    await t.settle();
    expect(t.watch.status().count).toBe(1);
    expect(t.saved()!.alerts.map((a) => a.id)).toEqual(['pa-b2']);
  });

  it('stav přežije restart služby; seznam jiného uživatele se odmítne a nový klíč jiného uživatele začne načisto', () => {
    const first = setup();
    first.watch.setKey({ userId: USER, key: KEY });
    first.watch.setAlerts({ userId: USER, alerts: [alert(), alert({ id: 'pa-b2', price: 5 }), { id: 'nesmysl' }] });
    const second = setup({ saved: first.saved() });
    expect(second.watch.status()).toMatchObject({ count: 2, keyed: true, feed: false, error: null, user: alertUserTag(USER) });
    expect(second.watch.setAlerts({ userId: OTHER, alerts: [] })).toMatchObject({ ok: false });
    expect(second.watch.status().count).toBe(2);
    expect(second.watch.setKey({ userId: OTHER, key: priceAlertWatchGrant(OTHER, SECRET)!.key })).toEqual({ ok: true });
    expect(second.watch.status()).toMatchObject({ count: 0, user: alertUserTag(OTHER) });
    expect(second.watch.setKey({ userId: USER, key: 'krátký' })).toMatchObject({ ok: false });
  });

  it('jiný trh než NQ/MNQ se nehlídá a služba se netváří, že ano', async () => {
    const t = setup();
    t.watch.setKey({ userId: USER, key: KEY });
    t.watch.setAlerts({ userId: USER, alerts: [alert()] });
    for (const price of [99, 99.5, 100.5]) t.watch.onTrade(price, t.now(), 'ESZ6');
    await t.settle();
    expect(t.posts).toHaveLength(0);
    expect(t.watch.status().feed).toBe(false);
  });

  it('čekání na opakování se nezasekne, když se fronta mezitím vyprázdní (klíč jiného uživatele)', async () => {
    let fail = true;
    const t = setup({ reply: (body) => (fail ? new Error('síť') : { status: 200, json: { results: body.triggers.map((x) => ({ triggerId: x.triggerId, status: 'triggered' })) } }) });
    t.watch.setKey({ userId: USER, key: KEY });
    t.watch.setAlerts({ userId: USER, alerts: [alert()] });
    t.trade(99); t.trade(99.5); t.trade(100.5);
    await t.settle();
    expect(t.timers).toHaveLength(1);
    const otherKey = priceAlertWatchGrant(OTHER, SECRET)!.key;
    t.watch.setKey({ userId: OTHER, key: otherKey }); // fronta pryč
    t.timers[0].fn(); await t.settle();
    fail = false;
    t.watch.setAlerts({ userId: OTHER, alerts: [alert({ id: 'pa-z9' })] });
    t.trade(99); t.trade(99.5); t.trade(100.5);
    await t.settle();
    expect(JSON.parse(t.posts.at(-1)!.payload)).toMatchObject({ triggers: [{ alertId: 'pa-z9' }] });
  });

  it('odpověď serveru s nesmyslným řádkem nic neshodí; křížení se uvolní pro příští ohlášení', async () => {
    const t = setup({ reply: () => ({ status: 200, json: { results: [null] } }) });
    t.watch.setKey({ userId: USER, key: KEY });
    t.watch.setAlerts({ userId: USER, alerts: [alert()] });
    t.trade(99); t.trade(99.5); t.trade(100.5);
    await t.settle();
    expect(t.watch.status().count).toBe(1);
    t.trade(99); t.trade(100.5);
    await t.settle();
    expect(t.posts).toHaveLength(2);
  });

  it('bez klíče se křížení neposílá a řekne proč; nesmyslný obchod nic neshodí', async () => {
    const t = setup();
    t.watch.setAlerts({ userId: USER, alerts: [alert()] });
    t.trade(99); t.trade(99.5); t.trade(100.5);
    t.watch.onTrade(Number.NaN, NOW, 'MNQZ6');
    await t.settle();
    expect(t.posts).toHaveLength(0);
    expect(t.watch.status()).toMatchObject({ keyed: false, error: expect.stringMatching(/klíč/) });
  });
});

describe('hlídání upozornění: část v appce', () => {
  it('službě jdou jen aktivní a serverem potvrzená upozornění', () => {
    const base = { symbol: 'MNQ', price: 1, condition: 'cross', frequency: 'once', expiry: 'session', line: {}, channels: {}, note: '', createdAt: 0, updatedAt: 0 };
    const list = rithmicWatchedAlerts([
      { ...base, id: 'pa-b', status: 'active', version: 2 },
      { ...base, id: 'pa-a', status: 'active', version: 1, conditionAuto: true },
      { ...base, id: 'pa-c', status: 'triggered', version: 1 },
      { ...base, id: 'pa-d' },
    ] as never);
    expect(list.map((a) => [a.id, a.version, a.conditionAuto])).toEqual([['pa-a', 1, true], ['pa-b', 2, false]]);
  });

  it('„hlídá“ jen když služba má klíč TOHOTO uživatele, ceny a přesně stejný seznam (stejný počet nestačí); jinak řekne důvod', () => {
    const mine = [{ id: 'pa-a', version: 1 }, { id: 'pa-b', version: 2 }];
    const want = { digest: alertListDigest(mine), user: alertUserTag(USER) };
    const ok = { count: 2, keyed: true, feed: true, error: null, ...want };
    expect(rithmicAlertWatchLabel(ok, want)).toBe('Hlídá služba Rithmic na Macu · 2 upozornění');
    // Stejný počet, jiný obsah (jiná verze po úpravě) → nehlídá se to, co appka ukazuje.
    expect(rithmicAlertWatchLabel({ ...ok, digest: alertListDigest([{ id: 'pa-a', version: 1 }, { id: 'pa-b', version: 3 }]) }, want)).toBeNull();
    expect(alertListDigest([...mine].reverse())).toBe(want.digest);
    // Klíč jiného uživatele appky.
    expect(rithmicAlertWatchLabel({ ...ok, user: alertUserTag(OTHER) }, want)).toBeNull();
    expect(rithmicAlertWatchProblem({ ...ok, user: alertUserTag(OTHER) }, true, want.user)).toMatch(/jiného účtu/);
    expect(rithmicAlertWatchLabel({ ...ok, feed: false }, want)).toBeNull();
    expect(rithmicAlertWatchLabel({ ...ok, keyed: false }, want)).toBeNull();
    expect(rithmicAlertWatchLabel(null, want)).toBeNull();
    expect(rithmicAlertWatchProblem(null, true)).toMatch(/starší verze/);
    expect(rithmicAlertWatchProblem(ok, false)).toMatch(/není připojená/);
    expect(rithmicAlertWatchProblem({ ...ok, feed: false }, true)).toMatch(/ceny/);
    expect(rithmicAlertWatchProblem(ok, true)).toBeNull();
    expect(parseRithmicAlertWatchStatus({ count: 1.7, keyed: true, feed: false, error: '' })).toEqual({ count: 1, keyed: true, feed: false, error: null, digest: '', user: '' });
    expect(parseRithmicAlertWatchStatus({ count: 'x' })).toBeNull();
  });
});

describe('křížení rovnou připojeným appkám (bez čekání na server)', () => {
  it('ohlásí se hned při křížení, se stejným triggerId jako jde serveru, a jen jednou', async () => {
    const t = setup();
    t.watch.setKey({ userId: USER, key: KEY });
    t.watch.setAlerts({ userId: USER, alerts: [alert()] });
    t.trade(99); t.trade(100.25);
    // Ještě před odpovědí serveru.
    expect(t.fired).toHaveLength(1);
    expect(t.fired[0]).toMatchObject({ alertId: 'pa-a1', version: 1, user: alertUserTag(USER) });
    await t.settle();
    expect((JSON.parse(t.posts[0].payload) as { triggers: Array<{ triggerId: string }> }).triggers[0].triggerId).toBe(t.fired[0].triggerId);
    t.trade(99); t.trade(100.5);
    await t.settle();
    expect(t.fired).toHaveLength(1);
  });

  it('bez klíče se appkám nic neohlásí (křížení se ani neposílá serveru)', async () => {
    const t = setup();
    t.watch.setAlerts({ userId: USER, alerts: [alert()] });
    t.trade(99); t.trade(100.25);
    await t.settle();
    expect(t.fired).toEqual([]);
    expect(t.posts).toEqual([]);
  });

  it('zpráva služby se čte přísně', () => {
    const ok = { type: 'alert-fired', alertId: 'pa-a1', version: 3, triggerId: '00000000-0000-4000-8000-0000000000AA', user: 'abc123' };
    expect(parseRithmicAlertFired(ok)).toEqual({ alertId: 'pa-a1', version: 3, triggerId: '00000000-0000-4000-8000-0000000000aa', user: 'abc123' });
    for (const bad of [null, {}, { ...ok, triggerId: 'x' }, { ...ok, alertId: '' }, { ...ok, user: '' }, { ...ok, alertId: 5 }, { ...ok, version: 0 }, { ...ok, version: '3' }]) expect(parseRithmicAlertFired(bad)).toBeNull();
  });

  it('služba zprávu rozesílá a appka ji bere jen pro svého uživatele na skutečném trhu', () => {
    const source = (path: string) => readFileSync(path, 'utf8');
    expect(source('scripts/rithmic/devTradeServer.ts')).toContain("onFired: (fired) => broadcast({ type: 'alert-fired', ...fired }),");
    const hook = source('hooks/useRithmicAlertWatch.ts');
    expect(hook).toContain('if (!gate.enabled || !gate.userTag || fired.user !== gate.userTag) return;');
    // Přímé křížení jen ukáže kartu: nic neposílá službě ani serveru.
    expect(hook).toContain('store.fired?.({ alertId: fired.alertId, version: fired.version, triggerId: fired.triggerId, at: Date.now() });');
  });
});

describe('hlídání upozornění je oddělené od příkazů (INV-UI-01)', () => {
  const source = (path: string) => readFileSync(path, 'utf8');
  it('služba předává hlídači cenu obchodu z tiku (pole tradePrice — `scripts/` typová kontrola nehlídá)', () => {
    const server = source('scripts/rithmic/devTradeServer.ts');
    expect(server).toContain('if (tick.tradePrice !== null) alertWatch?.onTrade(tick.tradePrice, tick.receivedAt, CONTRACT);');
    expect(source('services/rithmic/rithmicClient.ts')).toMatch(/interface RithmicTick \{[^}]*tradePrice: number \| null;[^}]*receivedAt: number;/s);
    expect(server).not.toMatch(/tick\.price\b/);
  });
  it('funkce spuštění běží vedle databáze (arn1): jinak každý dotaz letí přes Atlantik (25. 11. ~1,5 s do iPhonu)', () => {
    const vercel = JSON.parse(source('vercel.json')) as { functions?: Record<string, { regions?: string[] }> };
    expect(vercel.functions?.['api/price-alerts/watch.ts']?.regions).toEqual(['arn1']);
  });
  it('hlídač neimportuje nic z obchodní části služby a zprávy o upozorněních nejsou sledovaný příkaz', () => {
    const watch = source('services/rithmic/alertWatch.ts');
    expect(watch).not.toMatch(/from '\.\/(localExec|rithmicBroker|rithmicClient|rithmicProtection)/);
    expect(source('lib/rithmicLocalConnection.ts')).toMatch(/UNTRACKED_OPS = new Set\(\['ack', 'lookup', 'alerts-key', 'alerts-set'\]\)/);
    const server = source('scripts/rithmic/devTradeServer.ts');
    // Zprávy o upozorněních se vyřídí PŘED rozpočtem obchodních příkazů i před obchodní částí a nikdy do nich
    // nepropadnou: úpravy upozornění nesmí zdržet posun SL ani zavření.
    const branch = server.indexOf("if (alertOp === 'alerts-key' || alertOp === 'alerts-set') {");
    expect(branch).toBeGreaterThan(0);
    expect(branch).toBeLessThan(server.indexOf("if (recent.length >= 20) throw new Error('příliš mnoho příkazů za krátkou dobu');"));
    expect(branch).toBeLessThan(server.indexOf('exec!.execute(message.command)'));
    expect(server.slice(branch, branch + 1_200)).toMatch(/recentAlertOps\.length >= 12[\s\S]*return;\n          \}/);
    // Telefon (nativní appka) si pro klíč chodí z jiného původu: endpoint musí odpovědět na preflight.
    expect(source('api/price-alerts/watch.ts')).toMatch(/if \(handleNativeCors\(req, res, \['POST'\]\)\) return;/);
    expect(server).toMatch(/IS_TEST_SYSTEM \? null : createRithmicAlertWatch/);
  });
});
