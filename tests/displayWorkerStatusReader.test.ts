import { describe, expect, it } from 'vitest';
import { createDisplayWorkerStatusReader, EMPTY_DISPLAY_WORKER_STATUS, type DisplayWorkerStatus } from '../lib/displayWorkerStatusReader';
import type { LocalCopierAgentStatus } from '../lib/localCopierAgentProtocol';
import type { CopierRelayStatusEnvelope } from '../lib/copierRelayStatusPoll';

type Envelope = CopierRelayStatusEnvelope<LocalCopierAgentStatus> | null;
const now = 1_000_000;
const status = (revision: number, startedAt = '2026-10-27T07:00:00.000Z') =>
  ({ startedAt, controller: { revision } }) as unknown as LocalCopierAgentStatus;
const envelope = (value: LocalCopierAgentStatus, ageMs = 500, connected = true): Envelope =>
  ({ status: value, lastSeenAt: new Date(now - ageMs).toISOString(), connected, ageMs });

const setup = (responses: Record<string, () => Promise<Envelope>>, ids = Object.keys(responses)) => {
  const published: DisplayWorkerStatus[] = [];
  const calls: string[] = [];
  let foreground = true;
  const reader = createDisplayWorkerStatusReader({
    ids,
    load: id => { calls.push(id); return responses[id](); },
    now: () => now,
    isForeground: () => foreground,
    publish: state => published.push(state),
  });
  return { reader, published, calls, hide: () => { foreground = false; reader.setForeground(false); }, show: () => { foreground = true; reader.setForeground(true); } };
};

describe('čtečka stavu workeru pro deník (jen zobrazení)', () => {
  it('starý runtime na jednom připojení se přeskočí, přijme se živý z dalšího a příště se čte první', async () => {
    const live = status(5);
    const { reader, published, calls } = setup({
      a: async () => envelope(status(9, '2026-10-20T07:00:00.000Z'), 3_600_000, false),
      b: async () => envelope(live),
    });
    await reader.read();
    expect(published.at(-1)).toEqual({ status: live, observedAt: now - 500 });
    calls.length = 0;
    await reader.read();
    expect(calls[0]).toBe('b');
  });

  it('revize nejde zpět: starší odpověď se odmítne a zkusí se další připojení', async () => {
    let revision = 7;
    const { reader, published } = setup({ a: async () => envelope(status(revision)), b: async () => envelope(status(8)) }, ['a', 'b']);
    await reader.read();
    expect(published.at(-1)?.status).toEqual(status(7));
    revision = 3;
    await reader.read();
    // a vrátil starší revizi → přijme se b, ne prázdný stav ani revize 3.
    expect(published.at(-1)?.status).toEqual(status(8));
  });

  it('bez živého workeru (chyby, staré statusy) prázdný stav', async () => {
    const { reader, published } = setup({
      a: async () => { throw new Error('offline'); },
      b: async () => envelope(status(1), 60_000),
    });
    await reader.read();
    expect(published).toEqual([EMPTY_DISPLAY_WORKER_STATUS]);
  });

  it('čtení zahájené před odchodem do pozadí se po návratu nepoužije; návrat čte znovu', async () => {
    let release!: (value: Envelope) => void;
    let first = true;
    const fresh = status(4);
    const { reader, published, hide, show } = setup({
      a: () => (first ? (first = false, new Promise<Envelope>(resolve => { release = resolve; })) : Promise.resolve(envelope(fresh))),
    });
    const pending = reader.read();
    hide();
    expect(published).toEqual([EMPTY_DISPLAY_WORKER_STATUS]);
    show();
    release(envelope(status(3)));
    await pending;
    await Promise.resolve();
    await Promise.resolve();
    // Status 3 z čtení před uspáním nepublikován; po něm hned nové čtení.
    expect(published.map(state => state.status)).not.toContainEqual(status(3));
    expect(published.at(-1)?.status).toEqual(fresh);
  });

  it('v pozadí a po zastavení nic nečte ani nepublikuje', async () => {
    let release!: (value: Envelope) => void;
    const { reader, published, calls, hide } = setup({ a: () => new Promise<Envelope>(resolve => { release = resolve; }) });
    const pending = reader.read();
    reader.stop();
    release(envelope(status(1)));
    await pending;
    expect(published).toEqual([]);
    hide();
    await reader.read();
    expect(calls).toEqual(['a']);
  });
});
