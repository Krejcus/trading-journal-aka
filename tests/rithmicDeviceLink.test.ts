import { describe, expect, it } from 'vitest';
import { normalizeRithmicEndpoint, pairRithmicDevice, parseRithmicPairLink, readRithmicDeviceKey, forgetRithmicDevice, RITHMIC_DEVICE_SECRET_KEY, type RithmicKeyVault, type RithmicPairSocket } from '../lib/rithmicDeviceLink';
import { RithmicLocalConnection, type RithmicLinkSocket } from '../lib/rithmicLocalConnection';

const KEY = 'k'.repeat(43);
function memoryVault(): RithmicKeyVault & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, secureGet: async ({ key }) => ({ value: data.get(key) ?? null }), secureSet: async ({ key, value }) => { data.set(key, value); }, secureRemove: async ({ key }) => { data.delete(key); } };
}
function fakeSocket(onSent: (socket: RithmicPairSocket, data: string) => void): { factory: (url: string) => RithmicPairSocket; urls: string[] } {
  const urls: string[] = [];
  return { urls, factory: (url) => {
    urls.push(url);
    const socket: RithmicPairSocket = { send: (data) => onSent(socket, data), close: () => undefined, onopen: null, onclose: null, onerror: null, onmessage: null };
    setTimeout(() => socket.onopen?.({}), 0);
    return socket;
  } };
}

describe('spárování zařízení: adresa služby', () => {
  it('přijme jen jméno ze sítě Tailscale (šifrovaně); cokoli jiného odmítne', () => {
    expect(normalizeRithmicEndpoint(' MacBook-Air.tail1234.ts.net ', false)).toBe('wss://macbook-air.tail1234.ts.net');
    expect(normalizeRithmicEndpoint('https://mac.tail1.ts.net/', false)).toBe('wss://mac.tail1.ts.net');
    for (const bad of ['', 'evil.com', 'ws://mac.tail1.ts.net', 'mac.ts.net.evil.com', 'mac.tail1.ts.net/path', 'mac.tail1.ts.net:8443', 'http://192.168.1.5:3313', 'wss://ts.net']) {
      expect(normalizeRithmicEndpoint(bad, false)).toBeNull();
    }
    // Místní adresa jen při vývoji.
    expect(normalizeRithmicEndpoint('ws://127.0.0.1:3313', true)).toBe('ws://127.0.0.1:3313');
    expect(normalizeRithmicEndpoint('ws://127.0.0.1:3313', false)).toBeNull();
  });

  it('párovací odkaz z QR kódu nese adresu a kód', () => {
    expect(parseRithmicPairLink('alphatrade-native://rithmic-pair?host=mac.tail1.ts.net&code=ABCD2345')).toEqual({ host: 'mac.tail1.ts.net', code: 'ABCD2345' });
    expect(parseRithmicPairLink('alphatrade-native://live')).toBeNull();
    expect(parseRithmicPairLink('alphatrade-native://rithmic-pair?host=mac.tail1.ts.net')).toBeNull();
  });
});

describe('spárování zařízení: nativní Klíčenka', () => {
  it('zástupce nativního pluginu se nevrací z async funkce přímo (vypadal by jako příslib a uložení by nedoběhlo)', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../lib/rithmicDeviceLink.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/return alphaTradeNativePlugin\b/);
    expect(source).toMatch(/secureSet: \(options\) => plugin\.secureSet\(options\),/);
    // Stejná past v malém: objekt, který na `then` vrací funkci, `await` nikdy nedokončí hodnotou.
    const proxy = new Proxy({}, { get: () => () => new Promise(() => undefined) });
    const wrapped = { secureGet: (options: { key: string }) => (proxy as { secureGet: (o: { key: string }) => unknown }).secureGet(options) };
    expect(await Promise.race([Promise.resolve(wrapped).then(() => 'hodnota'), new Promise((resolve) => setTimeout(() => resolve('visí'), 30))])).toBe('hodnota');
    expect(await Promise.race([(async () => proxy)().then(() => 'hodnota'), new Promise((resolve) => setTimeout(() => resolve('visí'), 30))])).toBe('visí');
  });
});

describe('spárování zařízení: průběh', () => {
  it('pošle kód a název, klíč uloží JEN do Klíčenky a do běžného úložiště dá jen netajné údaje', async () => {
    const vault = memoryVault();
    const stored = new Map<string, string>();
    const sent: string[] = [];
    const { factory, urls } = fakeSocket((socket, data) => {
      sent.push(data);
      socket.onmessage?.({ data: JSON.stringify({ type: 'paired', ok: true, deviceId: 'a1b2c3d4e5f6', key: KEY, scope: 'full', name: 'iPhone Filip' }) });
    });
    const result = await pairRithmicDevice({ endpoint: 'mac.tail1.ts.net', code: 'abcd-2345', name: 'iPhone Filip', socketFactory: factory, vault, storage: { setItem: (k, v) => { stored.set(k, v); } }, now: () => 5 });
    expect(result).toEqual({ ok: true, link: { endpoint: 'wss://mac.tail1.ts.net', deviceId: 'a1b2c3d4e5f6', name: 'iPhone Filip', scope: 'full', pairedAt: 5 } });
    expect(urls).toEqual(['wss://mac.tail1.ts.net']); // kód ani klíč nejsou v adrese
    expect(JSON.parse(sent[0])).toEqual({ pair: { code: 'ABCD2345', name: 'iPhone Filip' } });
    expect(vault.data.get(RITHMIC_DEVICE_SECRET_KEY)).toBe(KEY);
    expect([...stored.values()].join('')).not.toContain(KEY);
    expect(await readRithmicDeviceKey(vault)).toBe(KEY);
    await forgetRithmicDevice(vault);
    expect(await readRithmicDeviceKey(vault)).toBeNull();
  });

  it('Mac spojení zavře hned po odpovědi, zatímco se klíč ještě ukládá do Klíčenky — spárování je úspěch, ne chyba', async () => {
    const vault = memoryVault();
    const slow: RithmicKeyVault = { ...vault, secureSet: async (options) => { await new Promise((resolve) => setTimeout(resolve, 40)); await vault.secureSet(options); } };
    const { factory } = fakeSocket((socket) => {
      socket.onmessage?.({ data: JSON.stringify({ type: 'paired', ok: true, deviceId: 'a1b2c3d4e5f6', key: KEY, scope: 'full', name: 'iPhone' }) });
      socket.onclose?.({}); // zavření přijde dřív, než doběhne uložení
    });
    const result = await pairRithmicDevice({ endpoint: 'mac.tail1.ts.net', code: 'ABCD2345', name: 'iPhone', socketFactory: factory, vault: slow, storage: { setItem: () => undefined } });
    expect(result).toMatchObject({ ok: true });
    expect(vault.data.get(RITHMIC_DEVICE_SECRET_KEY)).toBe(KEY);
  });

  it('odmítnutí od Macu, špatná adresa a špatný kód skončí srozumitelnou chybou a nic se neuloží', async () => {
    const vault = memoryVault();
    const refused = fakeSocket((socket) => socket.onmessage?.({ data: JSON.stringify({ type: 'paired', ok: false, error: 'kód nesouhlasí' }) }));
    expect(await pairRithmicDevice({ endpoint: 'mac.tail1.ts.net', code: 'ABCD2345', name: 'x', socketFactory: refused.factory, vault })).toEqual({ ok: false, error: 'kód nesouhlasí' });
    expect(await pairRithmicDevice({ endpoint: 'evil.com', code: 'ABCD2345', name: 'x', socketFactory: refused.factory, vault })).toMatchObject({ ok: false });
    expect(await pairRithmicDevice({ endpoint: 'mac.tail1.ts.net', code: '123', name: 'x', socketFactory: refused.factory, vault })).toMatchObject({ ok: false });
    expect(vault.data.size).toBe(0);
    expect(refused.urls).toHaveLength(1); // neplatná adresa ani kód se nikam neposílají
  });

  it('když Mac neodpoví, párování skončí po lhůtě a neopakuje se', async () => {
    const silent = fakeSocket(() => undefined);
    const result = await pairRithmicDevice({ endpoint: 'mac.tail1.ts.net', code: 'ABCD2345', name: 'x', socketFactory: silent.factory, vault: memoryVault(), timeoutMs: 30 });
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/Mac neodpověděl/) });
    expect(silent.urls).toHaveLength(1);
  });
});

describe('spojení spárovaného zařízení: klíč první zprávou', () => {
  function link(auth: () => Promise<string | null>) {
    const sent: string[] = [];
    const links: string[] = [];
    const failures: string[] = [];
    const sockets: RithmicLinkSocket[] = [];
    const connection = new RithmicLocalConnection({
      url: 'wss://mac.tail1.ts.net', auth, reconnectMs: 10,
      socketFactory: () => { const socket: RithmicLinkSocket = { readyState: 1, send: (data) => { sent.push(data); }, close: () => { socket.readyState = 3; socket.onclose?.({}); }, onopen: null, onclose: null, onmessage: null }; sockets.push(socket); return socket; },
      handlers: { onLink: (state) => { links.push(state); }, onMessage: () => undefined, onSessionReset: () => undefined, onSilent: () => undefined, onUncertain: () => undefined, onAuthFailed: (reason) => { failures.push(reason); } },
    });
    return { connection, sent, links, failures, sockets };
  }
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

  it('do potvrzení službou není spojení otevřené a příkaz neodejde; po potvrzení ano', async () => {
    const t = link(async () => KEY);
    t.connection.start();
    t.sockets[0].onopen?.({});
    await tick();
    expect(JSON.parse(t.sent[0])).toEqual({ auth: KEY });
    expect(t.links).toEqual(['connecting']);
    expect(t.connection.isOpen()).toBe(false);
    expect(await t.connection.send({ op: 'flatten', clientId: 'x', symbol: 'MNQZ6' })).toMatchObject({ ok: false, sent: false });
    expect(t.sent).toHaveLength(1);
    // Zprávy před verdiktem (např. podvržený stav) se zahodí.
    t.sockets[0].onmessage?.({ data: JSON.stringify({ type: 'state', state: {} }) });
    expect(t.connection.isOpen()).toBe(false);
    t.sockets[0].onmessage?.({ data: JSON.stringify({ type: 'auth', ok: true }) });
    expect(t.links).toEqual(['connecting', 'open']);
    expect(t.connection.isOpen()).toBe(true);
    t.connection.stop();
  });

  it('odmítnuté zařízení: ohlásí důvod a samo se znovu nepřipojuje', async () => {
    const t = link(async () => KEY);
    t.connection.start();
    t.sockets[0].onopen?.({});
    await tick();
    t.sockets[0].onmessage?.({ data: JSON.stringify({ type: 'auth', ok: false, error: 'zařízení bylo odvoláno' }) });
    expect(t.failures).toEqual(['zařízení bylo odvoláno']);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(t.sockets).toHaveLength(1);
    expect(t.connection.isOpen()).toBe(false);
  });

  it('Klíčenku nejde přečíst (zamčený telefon): není to odmítnutí — spojení se zavře a zkouší se dál', async () => {
    let locked = true;
    const t = link(async () => { if (locked) throw new Error('errSecInteractionNotAllowed'); return KEY; });
    t.connection.start();
    t.sockets[0].onopen?.({});
    await tick();
    expect(t.sent).toHaveLength(0);
    expect(t.failures).toEqual([]); // žádná výzva k novému spárování
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(t.sockets.length).toBeGreaterThanOrEqual(2); // zkouší znovu
    locked = false;
    t.sockets.at(-1)!.onopen?.({});
    await tick();
    expect(JSON.parse(t.sent[0])).toEqual({ auth: KEY });
    t.connection.stop();
  });

  it('služba hlásí vlastní potíž (retry): zařízení se neodmítne a zkouší se dál', async () => {
    const t = link(async () => KEY);
    t.connection.start();
    t.sockets[0].onopen?.({});
    await tick();
    t.sockets[0].onmessage?.({ data: JSON.stringify({ type: 'auth', ok: false, retry: true, error: 'služba nemá čitelný seznam zařízení' }) });
    expect(t.failures).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(t.sockets.length).toBeGreaterThanOrEqual(2);
    t.connection.stop();
  });

  it('návrat do appky: po rozpadu spojení se připojí hned, nečeká na časovač; běžící spojení nechá být', async () => {
    const t = link(async () => KEY);
    t.connection.start();
    t.sockets[0].onopen?.({});
    await tick();
    t.sockets[0].onmessage?.({ data: JSON.stringify({ type: 'auth', ok: true }) });
    t.connection.kick();
    expect(t.sockets).toHaveLength(1); // spojení běží → nic
    t.sockets[0].close();
    expect(t.sockets).toHaveLength(1); // další pokus čeká na časovač (10 ms v testu)
    t.connection.kick();
    expect(t.sockets).toHaveLength(2); // hned
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(t.sockets).toHaveLength(2); // časovač už druhé spojení neotevře
    t.connection.stop();
    t.connection.kick();
    expect(t.sockets).toHaveLength(2); // po zastavení nic
  });

  it('chybí klíč v Klíčence: nic se službě nepošle a spojení se neobnovuje', async () => {
    const t = link(async () => null);
    t.connection.start();
    t.sockets[0].onopen?.({});
    await tick();
    expect(t.sent).toHaveLength(0);
    expect(t.failures).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(t.sockets).toHaveLength(1);
  });
});
