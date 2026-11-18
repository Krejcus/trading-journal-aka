import { afterEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { createDeviceGateway, type DeviceStore } from '../services/rithmic/deviceGateway';
import type { DeviceRegistryState, PairedDevice } from '../services/rithmic/devicePairing';

// Skutečný WebSocket na 127.0.0.1 (žádný broker): brána je jediné místo, kudy se ke službě dostane něco mimo Mac.
const open: Array<{ close: () => void }> = [];
afterEach(() => { for (const item of open.splice(0)) item.close(); });

async function setup(options: { store?: DeviceStore; authTimeoutMs?: number } = {}) {
  let saved: DeviceRegistryState = { devices: [] };
  const store: DeviceStore = options.store ?? { load: () => saved, save: (state) => { saved = structuredClone(state); } };
  const served: Array<{ device: PairedDevice; socket: WebSocket }> = [];
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, verifyClient: (info: { origin?: string }) => gateway.verify(info.origin) });
  const gateway = createDeviceGateway<WebSocket>({
    store, origins: new Set(['capacitor://localhost']), authTimeoutMs: options.authTimeoutMs ?? 300,
    serve: (socket, device) => { served.push({ device, socket }); socket.send(JSON.stringify({ type: 'hello', account: 'TAJNY-UCET' })); },
  });
  server.on('connection', (socket) => gateway.accept(socket));
  await new Promise((resolve) => server.once('listening', resolve));
  open.push(server);
  const url = `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
  /** Připojí se, pošle první zprávu (nebo nic) a sbírá vše, co přijde, do zavření nebo do lhůty. */
  const talk = (first: unknown, origin: string | undefined = 'capacitor://localhost', waitMs = 250) => new Promise<{ messages: Array<Record<string, unknown>>; closed: number | null; refused: boolean }>((resolve) => {
    const messages: Array<Record<string, unknown>> = [];
    const socket = new WebSocket(url, origin ? { origin } : {});
    open.push(socket);
    let closed: number | null = null;
    socket.on('unexpected-response', () => resolve({ messages, closed: null, refused: true }));
    socket.on('error', () => resolve({ messages, closed, refused: true }));
    socket.on('open', () => { if (first !== undefined) socket.send(typeof first === 'string' ? first : JSON.stringify(first)); });
    socket.on('message', (raw) => messages.push(JSON.parse(String(raw)) as Record<string, unknown>));
    socket.on('close', (code) => { closed = code; });
    setTimeout(() => resolve({ messages, closed, refused: false }), waitMs);
  });
  const pair = async (scope?: string) => {
    const { code } = gateway.manage({ op: 'pair-start', ...(scope ? { scope } : {}) }) as { code: string };
    const reply = await talk({ pair: { code, name: 'iPhone Filip' } });
    return reply.messages.find((m) => m.type === 'paired') as { ok: boolean; key: string; deviceId: string; scope: string };
  };
  return { gateway, talk, pair, served, saved: () => saved, url };
}

describe('brána pro spárovaná zařízení', () => {
  it('bez klíče nebo se špatným klíčem neodejde nic o účtu a spojení skončí', async () => {
    const t = await setup();
    for (const first of [{ auth: 'x'.repeat(43) }, { auth: 123 }, {}, 'není json', { command: { op: 'flatten' } }]) {
      const reply = await t.talk(first);
      expect(reply.messages).toEqual([{ type: 'auth', ok: false, error: 'zařízení není spárované nebo bylo odvoláno' }]);
      expect(reply.closed).toBe(4003);
    }
    expect(t.served).toHaveLength(0);
  });

  it('kdo se do lhůty neprokáže, je odpojen a nedostane nic', async () => {
    const t = await setup({ authTimeoutMs: 60 });
    const reply = await t.talk(undefined);
    expect(reply.messages).toEqual([]);
    expect(reply.closed).toBe(4001);
  });

  it('cizí webová stránka (jiný Origin) se nepřipojí vůbec; nativní klient bez Originu ano', async () => {
    const t = await setup();
    expect((await t.talk({ auth: 'x'.repeat(43) }, 'https://evil.example')).refused).toBe(true);
    expect((await t.talk({ auth: 'x'.repeat(43) }, undefined)).refused).toBe(false);
  });

  it('párování kódem z Macu vydá klíč; s ním se zařízení přihlásí a teprve pak dostane data služby', async () => {
    const t = await setup();
    const paired = await t.pair();
    expect(paired).toMatchObject({ ok: true, scope: 'full' });
    expect(JSON.stringify(t.saved())).not.toContain(paired.key); // v úložišti je jen otisk
    const reply = await t.talk({ auth: paired.key });
    expect(reply.messages[0]).toEqual({ type: 'auth', ok: true, deviceId: paired.deviceId, scope: 'full' });
    expect(reply.messages[1]).toEqual({ type: 'hello', account: 'TAJNY-UCET' });
    expect(t.served).toHaveLength(1);
    expect(t.served[0].device.name).toBe('iPhone Filip');
  });

  it('kód jde použít jednou a špatné pokusy ho po pěti zneplatní', async () => {
    const t = await setup();
    const { code } = t.gateway.manage({ op: 'pair-start' }) as { code: string };
    const ok = await t.talk({ pair: { code, name: 'A' } });
    expect(ok.messages[0]).toMatchObject({ type: 'paired', ok: true });
    expect((await t.talk({ pair: { code, name: 'B' } })).messages[0]).toMatchObject({ ok: false, error: 'na Macu není vydaný párovací kód' });
    const second = t.gateway.manage({ op: 'pair-start' }) as { code: string };
    const errors: unknown[] = [];
    for (let i = 0; i < 5; i += 1) {
      errors.push((await t.talk({ pair: { code: 'ZZZZZZZZ', name: 'C' } }, 'capacitor://localhost', 150)).messages[0]?.error);
      await new Promise((resolve) => setTimeout(resolve, 1_050)); // povinný odstup mezi pokusy
    }
    expect(errors.at(-1)).toBe('příliš mnoho špatných pokusů — vydej na Macu nový kód');
    expect((await t.talk({ pair: { code: second.code, name: 'C' } })).messages[0]).toMatchObject({ ok: false });
  }, 20_000);

  it('odvolání na Macu odpojí otevřené spojení hned a klíč už neplatí', async () => {
    const t = await setup();
    const paired = await t.pair('close');
    expect(paired.scope).toBe('close');
    const live = new WebSocket(t.url, { origin: 'capacitor://localhost' });
    open.push(live);
    const closed = new Promise<number>((resolve) => live.on('close', (code) => resolve(code)));
    live.on('open', () => live.send(JSON.stringify({ auth: paired.key })));
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect((t.gateway.manage({ op: 'devices' }) as { devices: Array<{ online: boolean }> }).devices[0].online).toBe(true);
    t.gateway.manage({ op: 'revoke-device', deviceId: paired.deviceId });
    expect(await closed).toBe(4003);
    expect(t.gateway.active(paired.deviceId)).toBeNull();
    expect((await t.talk({ auth: paired.key })).closed).toBe(4003);
    expect(() => t.gateway.manage({ op: 'revoke-device', deviceId: paired.deviceId })).toThrow();
  });

  it('seznam zařízení nikdy neobsahuje klíč ani jeho otisk', async () => {
    const t = await setup();
    const paired = await t.pair();
    const listed = JSON.stringify(t.gateway.manage({ op: 'devices' }));
    expect(listed).not.toContain(paired.key);
    expect(listed).not.toContain('keyHash');
  });

  it('nečitelný seznam zařízení: nikdo neprojde a správa hlásí chybu (neznámý seznam není prázdný seznam)', async () => {
    const t = await setup({ store: { load: () => { throw new Error('poškozený soubor'); }, save: () => undefined } });
    const reply = await t.talk({ auth: 'x'.repeat(43) });
    expect(reply.messages).toEqual([{ type: 'auth', ok: false, error: 'služba nemá čitelný seznam zařízení' }]);
    expect(() => t.gateway.manage({ op: 'pair-start' })).toThrow(/nejde přečíst/);
    expect(t.gateway.summary()).toMatch(/NEJDE PŘEČÍST/);
  });

  it('když zařízení nejde uložit, klíč se nevydá', async () => {
    let saved: DeviceRegistryState = { devices: [] };
    const t = await setup({ store: { load: () => saved, save: () => { throw new Error('plný disk'); } } });
    const { code } = t.gateway.manage({ op: 'pair-start' }) as { code: string };
    const reply = await t.talk({ pair: { code, name: 'A' } });
    expect(reply.messages[0]).toMatchObject({ type: 'paired', ok: false });
    expect(JSON.stringify(reply.messages)).not.toMatch(/"key"/);
    saved = { devices: [] };
  });

  it('neověřených spojení smí být naráz jen pár', async () => {
    const t = await setup({ authTimeoutMs: 800 });
    const idle = Array.from({ length: 4 }, () => t.talk(undefined, 'capacitor://localhost', 200));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await t.talk(undefined, 'capacitor://localhost', 100)).refused).toBe(true);
    await Promise.all(idle);
  });
});
