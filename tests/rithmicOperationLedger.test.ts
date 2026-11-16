import { describe, expect, it } from 'vitest';
import {
  OperationLedger,
  type OperationLedgerStore,
  type OperationLimits,
  type OperationRecord,
  type OperationRequest,
} from '../services/rithmic/operationLedger';

const limits: OperationLimits = {
  singlePendingKinds: ['entry', 'manage', 'arm'],
  spacingMs: { entry: 3_000, manage: 2_000 },
  dailyCap: { entry: 3, manage: 5, arm: 50 },
};
const DAY = 24 * 3_600_000;
const T = 1_000_000;

function memoryStore(initial: OperationRecord[] = [], sequence = initial.reduce((m, r) => Math.max(m, r.sequence), 0)) {
  const state = {
    records: initial.map((r) => ({ ...r })), sequence, revision: initial.length ? 1 : 0, saves: 0,
    failNext: false, failAfterWriteNext: false,
  };
  const store: OperationLedgerStore = {
    load: async () => ({ records: state.records.map((r) => ({ ...r })), revision: state.revision, sequence: state.sequence }),
    save: async (records, seq, expectedRevision) => {
      if (state.failNext) {
        state.failNext = false;
        throw new Error('disk full');
      }
      if (expectedRevision !== state.revision) throw new Error('revision conflict');
      state.records = records.map((r) => ({ ...r }));
      state.sequence = seq;
      state.revision += 1;
      state.saves += 1;
      if (state.failAfterWriteNext) {
        state.failAfterWriteNext = false;
        throw new Error('timeout after write');
      }
    },
  };
  return { store, state };
}

async function ledger(initial: OperationRecord[] = [], now = 0, sequence?: number) {
  const { store, state } = memoryStore(initial, sequence);
  const l = new OperationLedger(store, limits);
  const recovered = await l.load(now);
  return { l, store, state, recovered };
}

const entry = (id: string, at: number, patch: Partial<OperationRequest> = {}): OperationRequest => ({
  operationId: id, fingerprint: `fp-${id}`, operationClass: 'risk-increasing', kind: 'entry', target: 'acc1:MNQ', validUntil: at + 5_000, ...patch,
});
const close = (id: string, target = 'acc1:MNQ'): OperationRequest => ({
  operationId: id, fingerprint: `fp-${id}`, operationClass: 'risk-reducing', kind: 'close', target, validUntil: 0,
});
const brake = (id: string, kind = 'disarm'): OperationRequest => ({
  operationId: id, fingerprint: `fp-${id}`, operationClass: 'brake', kind, validUntil: 0,
});
const stored = (id: string, state: OperationRecord['state'], acceptedAt: number, patch: Partial<OperationRecord> = {}): OperationRecord => ({
  operationId: id, fingerprint: `fp-${id}`, operationClass: 'risk-increasing', kind: 'entry', target: 'acc1:MNQ', state, sequence: 1,
  acceptedAt, validUntil: acceptedAt + 5_000, ...(state === 'accepted' ? {} : { sendingAt: acceptedAt + 1 }), ...patch,
});

/** Celý průchod jedné operace; vrátí výsledek přijetí. */
async function run(l: OperationLedger, request: OperationRequest, at: number, end: 'done' | 'rejected' | 'unknown') {
  const outcome = await l.accept(request, at);
  if (outcome.status !== 'accepted') return outcome;
  const token = await l.beginSending(request.operationId, at + 1);
  await l.settleSent(request.operationId, token!, end, at + 100);
  return outcome;
}

describe('OperationLedger', () => {
  it('přijetí i začátek odesílání jsou uložené dřív, než se vrátí', async () => {
    const { l, state } = await ledger();
    expect((await l.accept(entry('op1', T), T)).status).toBe('accepted');
    expect(state.records.map((r) => `${r.operationId}:${r.state}`)).toEqual(['op1:accepted']);
    const token = await l.beginSending('op1', T + 10);
    expect(token).not.toBeNull();
    expect(state.records[0]).toMatchObject({ state: 'sending', sendingAt: T + 10 });
    const done = await l.settleSent('op1', token!, 'done', T + 150, { result: { basketId: '77' } });
    expect(done).toMatchObject({ state: 'done', settledAt: T + 150, result: { basketId: '77' } });
    expect(done.sendingToken).toBeUndefined();
  });

  it('stejné ID a záměr vrátí stav a nic nespustí; jiný otisk, druh nebo cíl je konflikt', async () => {
    const { l, state } = await ledger();
    await l.accept(entry('op1', T), T);
    await l.beginSending('op1', T + 1);
    expect(await l.accept(entry('op1', T), T + 50)).toMatchObject({ status: 'existing', record: { state: 'sending' } });
    expect((await l.accept(entry('op1', T, { fingerprint: 'jiny' }), T + 60)).status).toBe('conflict');
    expect((await l.accept(entry('op1', T, { kind: 'manage' }), T + 70)).status).toBe('conflict');
    expect((await l.accept(entry('op1', T, { target: 'acc2:MNQ' }), T + 80)).status).toBe('conflict');
    expect(state.records).toHaveLength(1);
    expect(state.saves).toBe(2);
  });

  it('prázdný cíl se bere jako žádný i při opakování', async () => {
    const { l } = await ledger();
    await l.accept({ ...brake('b1'), target: '' }, T);
    expect((await l.accept({ ...brake('b1'), target: '' }, T + 1)).status).toBe('existing');
    expect((await l.accept(brake('b1'), T + 2)).status).toBe('existing');
  });

  it('souběžné přijetí téže operace dá jedno přijetí a jeden záznam', async () => {
    const { l, state } = await ledger();
    const results = await Promise.all([l.accept(entry('op1', T), T), l.accept(entry('op1', T), T), l.accept(entry('op1', T), T)]);
    expect(results.map((r) => r.status).sort()).toEqual(['accepted', 'existing', 'existing']);
    expect(state.records).toHaveLength(1);
  });

  it('zrušení proti odeslání: vyhraje ten, kdo je ve frontě dřív, a letící zápis nejde prohlásit za neodeslaný', async () => {
    // zrušení dřív
    const a = await ledger();
    await a.l.accept(entry('op', T), T);
    const [cancelled, tokenAfterCancel] = await Promise.all([a.l.cancelBeforeSend('op', T + 1, 'brake'), a.l.beginSending('op', T + 1)]);
    expect([cancelled, tokenAfterCancel]).toEqual([true, null]);
    expect(a.l.get('op')).toMatchObject({ state: 'rejected', reason: 'brake' });
    // odeslání dřív
    const b = await ledger();
    await b.l.accept(entry('op', T), T);
    const [token, cancelledLate] = await Promise.all([b.l.beginSending('op', T + 1), b.l.cancelBeforeSend('op', T + 1, 'brake')]);
    expect(token).not.toBeNull();
    expect(cancelledLate).toBe(false);
    expect(b.l.get('op')?.state).toBe('sending');
    // bez dokladu ji uzavřít nejde
    await expect(b.l.settleSent('op', token! + 999, 'rejected', T + 2)).rejects.toThrow(/tímto dokladem/);
    expect((await b.l.settleSent('op', token!, 'done', T + 150)).state).toBe('done');
    // pozdní výsledek pro už uzavřený záznam je chyba, ne tiché přepsání
    await expect(b.l.settleSent('op', token!, 'rejected', T + 200)).rejects.toThrow(/ověř stav čtením/);
  });

  it('restart: accepted → rejected (nic neodešlo), sending → unknown; pořadí pokračuje', async () => {
    const { l, recovered, state } = await ledger(
      [stored('a', 'accepted', T), stored('s', 'sending', T, { sequence: 2, sendingToken: 5 }), stored('d', 'done', T, { sequence: 3 })],
      T + 60_000,
    );
    expect(recovered).toEqual({ rejected: ['a'], unknown: ['s'], reapply: [] });
    expect(l.get('a')).toMatchObject({ state: 'rejected', reason: 'restart-before-send' });
    expect(l.get('s')).toMatchObject({ state: 'unknown', reason: 'restart-during-send' });
    expect(state.records.find((r) => r.operationId === 's')?.state).toBe('unknown');
    expect(await l.accept(entry('s', T), T + 61_000)).toMatchObject({ status: 'existing', record: { state: 'unknown' } });
    expect(await l.beginSending('s', T + 61_000)).toBeNull();
    // původní odesílatel se starým dokladem po restartu záznam neuzavře
    await expect(l.settleSent('s', 5, 'done', T + 62_000)).rejects.toThrow(/ověř stav čtením/);
    const next = await l.accept(entry('n', T + 70_000, { target: 'acc2:MNQ' }), T + 70_000);
    expect(next.status === 'accepted' && next.record.sequence).toBe(4);
  });

  it('neznámý výsledek blokuje další riziko a správu na cíli; zavření a brzda projdou; po vyřešení se uvolní', async () => {
    const { l } = await ledger();
    await run(l, entry('e1', T), T, 'unknown');
    expect(await l.accept(entry('e2', T + 10_000), T + 10_000)).toMatchObject({ status: 'refused', reason: 'unresolved' });
    expect(await l.accept(entry('m1', T + 10_000, { kind: 'manage', operationClass: 'manage' }), T + 10_000)).toMatchObject({ status: 'refused', reason: 'unresolved' });
    expect((await l.accept(entry('e3', T + 10_000, { target: 'acc2:MNQ' }), T + 10_000)).status).toBe('accepted');
    expect((await l.accept(close('c1'), T + 10_001)).status).toBe('accepted');
    expect((await l.accept(brake('b1'), T + 10_002)).status).toBe('accepted');
    expect(l.unresolved().map((r) => r.operationId)).toEqual(['e1']);
    await expect(l.resolveUnknown('e3', 'done', T + 11_000, { reason: 'x' })).rejects.toThrow(/není ve stavu unknown/);
    expect((await l.resolveUnknown('e1', 'done', T + 20_000, { reason: 'found-by-lookup' })).state).toBe('done');
    expect(l.unresolved()).toEqual([]);
  });

  it('prošlý záměr se nepřijme, před odesláním se platnost ověří znovu a opakování ji neprodlouží', async () => {
    const { l } = await ledger();
    expect(await l.accept(entry('old', T - 10_000), T)).toMatchObject({ status: 'refused', reason: 'expired' });
    await l.accept(entry('slow', T), T);
    expect(await l.beginSending('slow', T + 6_000)).toBeNull();
    expect(l.get('slow')).toMatchObject({ state: 'rejected', reason: 'expired-before-send' });
    // stejný otisk s jinou platností: vrací původní záznam, platnost se nemění
    // (platnost patří do otisku — jiná platnost má od volajícího přijít s jiným otiskem)
    expect(await l.accept(entry('slow', T, { validUntil: T + 60_000 }), T + 7_000)).toMatchObject({ status: 'existing', record: { state: 'rejected' } });
    expect(l.get('slow')?.validUntil).toBe(T + 5_000);
  });

  it('jeden nevyřízený: druhý vstup i správa čekají, dokud první neskončí', async () => {
    const { l } = await ledger();
    await l.accept(entry('e1', T), T);
    expect(await l.accept(entry('e2', T + 5_000, { target: 'acc2:MNQ' }), T + 5_000)).toMatchObject({ status: 'refused', reason: 'busy' });
    const token = await l.beginSending('e1', T + 1);
    await l.settleSent('e1', token!, 'done', T + 200);
    expect((await l.accept(entry('m1', T + 5_000, { kind: 'manage', operationClass: 'manage' }), T + 5_000)).status).toBe('accepted');
  });

  it('do rozestupu a stropu se počítá vše, co začalo odesílat — i příkaz odmítnutý brokerem', async () => {
    const { l } = await ledger();
    expect((await run(l, entry('e1', T), T, 'rejected')).status).toBe('accepted');
    // broker odmítl, ale zápis odešel: rozestup platí
    expect(await run(l, entry('e2', T + 1_000), T + 1_000, 'done')).toMatchObject({ status: 'refused', reason: 'spacing' });
    expect((await run(l, entry('e2', T + 4_000), T + 4_000, 'rejected')).status).toBe('accepted');
    expect((await run(l, entry('e3', T + 8_000), T + 8_000, 'rejected')).status).toBe('accepted');
    // tři odmítnuté brokerem = strop 3 vyčerpán
    expect(await run(l, entry('e4', T + 12_000), T + 12_000, 'done')).toMatchObject({ status: 'refused', reason: 'daily-cap' });
    expect((await run(l, entry('e5', T + DAY + 9_000), T + DAY + 9_000, 'done')).status).toBe('accepted');
  });

  it('zrušené před odesláním se do rozestupu ani stropu nepočítá', async () => {
    const { l } = await ledger();
    await l.accept(entry('e1', T), T);
    await l.cancelBeforeSend('e1', T + 1, 'gate');
    expect((await l.accept(entry('e2', T + 100), T + 100)).status).toBe('accepted');
  });

  it('stejný cíl nikdy souběžně, ani u snížení rizika; jiný cíl ano; brzda vždy', async () => {
    const { l } = await ledger();
    expect((await l.accept(close('c1'), T)).status).toBe('accepted');
    expect(await l.accept(close('c2'), T + 1)).toMatchObject({ status: 'refused', reason: 'busy' });
    expect((await l.accept(close('c3', 'acc2:MNQ'), T + 2)).status).toBe('accepted');
    expect(await l.accept(entry('e1', T + 3), T + 3)).toMatchObject({ status: 'refused', reason: 'busy' });
    expect((await l.accept(brake('k', 'kill'), T + 4)).status).toBe('accepted');
    const token = await l.beginSending('c1', T + 5);
    await l.settleSent('c1', token!, 'rejected', T + 6, { reason: 'not-sent' });
    expect((await l.accept(close('c2'), T + 7)).status).toBe('accepted');
  });

  it('brzdy a snížení rizika jdou mimo zámek vstupů, rozestup, stropy i platnost', async () => {
    const { l } = await ledger();
    await l.accept(entry('e1', T), T);
    expect((await l.accept(brake('b1'), T + 1)).status).toBe('accepted');
    expect((await l.accept(close('f1', 'acc9:ES'), T + 2)).status).toBe('accepted');
    expect(await l.beginSending('b1', T + 999_999)).not.toBeNull();
  });

  it('přijatá brzda restart přežije, uloží se jako accepted a vrátí se k uplatnění', async () => {
    const b = (id: string, state: OperationRecord['state'], sequence: number, patch: Partial<OperationRecord> = {}) =>
      stored(id, state, T, { operationClass: 'brake', kind: 'lock-day', target: undefined, sequence, validUntil: 0, ...patch });
    const { l, recovered, state } = await ledger(
      [b('b-acc', 'accepted', 1), b('b-snd', 'sending', 2, { sendingToken: 9 }), b('b-done', 'done', 3), stored('e-later', 'done', T + 500, { sequence: 4 })],
      T + 60_000,
    );
    expect(recovered.reapply.map((r) => `${r.operationId}#${r.sequence}`)).toEqual(['b-acc#1', 'b-snd#2']);
    expect(recovered.rejected).toEqual([]);
    expect(recovered.unknown).toEqual([]);
    // volající vidí, že po brzdě existuje novější dokončená operace (pořadí 4 > 2)
    expect(l.get('e-later')!.sequence).toBeGreaterThan(recovered.reapply[1].sequence);
    expect(state.records.find((r) => r.operationId === 'b-snd')).toMatchObject({ state: 'accepted' });
    expect(state.records.find((r) => r.operationId === 'b-snd')?.sendingToken).toBeUndefined();
    const token = await l.beginSending('b-snd', T + 61_000);
    expect((await l.settleSent('b-snd', token!, 'done', T + 61_001)).state).toBe('done');
  });

  it('riziková operace bez cíle nebo bez nastaveného stropu se nepřijme', async () => {
    const { l } = await ledger();
    expect(await l.accept(entry('x', T, { target: undefined }), T)).toMatchObject({ status: 'refused', reason: 'invalid' });
    expect(await l.accept(entry('y', T, { kind: 'neznamy' }), T)).toMatchObject({ status: 'refused', reason: 'invalid' });
    expect(await l.accept(entry('', T), T)).toMatchObject({ status: 'refused', reason: 'invalid' });
  });

  it('selhání uložení nic nepřijme a kniha se musí znovu načíst', async () => {
    const { l, state } = await ledger();
    state.failNext = true;
    await expect(l.accept(entry('e1', T), T)).rejects.toThrow('disk full');
    expect(() => l.get('e1')).toThrow(/není načtená/);
    await expect(l.accept(brake('b1'), T)).rejects.toThrow(/není načtená/);
    await l.load(T);
    expect(l.get('e1')).toBeNull();
    expect((await l.accept(entry('e1', T), T)).status).toBe('accepted');
  });

  it('uložení, které se zapsalo a pak selhalo: po načtení je stav konzervativní', async () => {
    const { l, state } = await ledger();
    await l.accept(entry('e1', T), T);
    state.failAfterWriteNext = true;
    await expect(l.beginSending('e1', T + 1)).rejects.toThrow('timeout after write');
    // volající doklad nedostal, takže k brokerovi nepsal; kniha ale `sending` má → unknown
    const recovered = await l.load(T + 10);
    expect(recovered.unknown).toEqual(['e1']);
    expect(await l.accept(entry('e1', T), T + 20)).toMatchObject({ status: 'existing', record: { state: 'unknown' } });
  });

  it('selhání uložení uvnitř obnovy nechá knihu nenačtenou; další načtení projde', async () => {
    const { store, state } = memoryStore([stored('a', 'accepted', T)]);
    const l = new OperationLedger(store, limits);
    state.failNext = true;
    await expect(l.load(T + 1)).rejects.toThrow('disk full');
    expect(() => l.unresolved()).toThrow(/není načtená/);
    expect((await l.load(T + 2)).rejected).toEqual(['a']);
  });

  it('načtení za běhu s operací v letu: původní odesílatel ji už neuzavře, jde jen vyřešit', async () => {
    const { l } = await ledger();
    await l.accept(entry('e1', T), T);
    const token = await l.beginSending('e1', T + 1);
    await l.load(T + 5);
    expect(l.get('e1')?.state).toBe('unknown');
    await expect(l.settleSent('e1', token!, 'done', T + 150)).rejects.toThrow(/ověř stav čtením/);
    expect((await l.resolveUnknown('e1', 'done', T + 200, { reason: 'late-result' })).state).toBe('done');
  });

  it('dvě instance nad jednou knihou: druhá zápis neprovede', async () => {
    const { store } = memoryStore();
    const a = new OperationLedger(store, limits);
    const b = new OperationLedger(store, limits);
    await a.load(T);
    await b.load(T);
    await a.accept(entry('e1', T), T);
    await expect(b.accept(entry('e2', T + 5_000, { target: 'acc2:MNQ' }), T + 5_000)).rejects.toThrow('revision conflict');
  });

  it('ořez: otevřené, neznámé, brzdy a snížení rizika nikdy; pořadí se po ořezu a restartu neopakuje', async () => {
    const { l, store } = await ledger([
      stored('done-old', 'done', T),
      stored('rej-old', 'rejected', T, { sequence: 2 }),
      stored('unk-old', 'unknown', T, { sequence: 3 }),
      stored('close-old', 'done', T, { sequence: 4, operationClass: 'risk-reducing', kind: 'close', validUntil: 0 }),
      stored('brake-old', 'done', T, { sequence: 5, operationClass: 'brake', kind: 'disarm', target: undefined, validUntil: 0 }),
    ], T + 3 * DAY);
    expect(await l.prune(T + 3 * DAY, 1_000)).toBe(2);
    expect(l.get('done-old')).toBeNull();
    expect(l.get('unk-old')?.state).toBe('unknown');
    // přehrání starého zavření po dnech vrátí původní záznam, nic neprovede
    expect(await l.accept(close('close-old'), T + 3 * DAY)).toMatchObject({ status: 'existing', record: { state: 'done' } });
    // staré rizikové ID se starou platností po ořezu neprojde
    expect(await l.accept(entry('done-old', T), T + 3 * DAY)).toMatchObject({ status: 'refused', reason: 'expired' });
    const restarted = new OperationLedger(store, limits);
    await restarted.load(T + 3 * DAY);
    await restarted.resolveUnknown('unk-old', 'rejected', T + 3 * DAY, { reason: 'manual' });
    const next = await restarted.accept(entry('new', T + 3 * DAY + 10_000), T + 3 * DAY + 10_000);
    expect(next.status === 'accepted' && next.record.sequence).toBe(6);
  });

  it('poškozenou knihu odmítne načíst', async () => {
    const bad = async (records: OperationRecord[], sequence?: number) =>
      expect(new OperationLedger(memoryStore(records, sequence).store, limits).load(T)).rejects.toThrow(/poškozená/);
    await bad([stored('x', 'done', T), stored('x', 'done', T)]);
    await bad([stored('x', 'done', Number.NaN)]);
    await bad([stored('x', 'divny' as OperationRecord['state'], T)]);
    await bad([stored('x', 'done', T, { operationClass: 'jina' as OperationRecord['operationClass'] })]);
    await bad([stored('x', 'done', T, { fingerprint: '' })]);
    await bad([stored('x', 'done', T, { sequence: 9 })], 3);
  });
});
