import { describe, expect, it } from 'vitest';
import {
  assertValidIngressPolicy,
  createIngressGate,
  type IngressDecision,
  type IngressPolicy,
  type IngressProcessState,
  type IngressRequest,
} from '../services/rithmic/ingressGate';

/** Jedna z možných politik (varianta doporučená recenzenty) — NENÍ to schválené nastavení. */
const policy: IngressPolicy = {
  commands: {
    disarm: 'brake', 'kill-switch': 'brake', 'lock-until-session-end': 'brake',
    'flatten-account': 'risk-reducing', 'close-position': 'risk-reducing', 'cancel-entry': 'risk-reducing',
    'place-leader-entry': 'risk-increasing', 'arm-live': 'risk-increasing',
    'move-stop': 'manage',
    status: 'read',
  },
  classes: {
    brake: { paths: { direct: ['clientKey'], relay: ['relayUserAuth'] } },
    'risk-reducing': { paths: { direct: ['clientKey'], relay: ['relayUserAuth'] } },
    'risk-increasing': {
      paths: { direct: ['clientKey', 'userToken'] },
      time: { maxValidityMs: 5_000, clockToleranceMs: 2_000 },
      requireFreshBrakeKnowledge: true,
    },
    manage: { paths: { direct: ['clientKey', 'userToken'] }, time: { maxValidityMs: 5_000, clockToleranceMs: 2_000 } },
    read: { paths: { direct: ['clientKey'], relay: ['relayUserAuth'] } },
  },
};

const NOW = 1_000_000;
const state = (patch: Partial<IngressProcessState> = {}): IngressProcessState => ({
  processId: 'p1', startedAt: 500, brakeEpoch: 7, stateLoaded: true, brokerAlive: true, brakeKnowledgeFresh: true, now: NOW, ...patch,
});
const fence = { processId: 'p1', startedAt: 500, brakeEpoch: 7 };
const entry = (patch: Partial<IngressRequest> = {}): IngressRequest => ({
  path: 'direct', commandType: 'place-leader-entry', verified: ['clientKey', 'userToken'], fence,
  target: 'acc1:MNQ', createdAt: NOW - 100, validUntil: NOW + 4_900, ...patch,
});
const gate = createIngressGate(policy);
const evaluateIngress = (_policy: IngressPolicy, request: IngressRequest, s: IngressProcessState) => gate.evaluate(request, s);
const recheckBeforeWrite = (decision: Parameters<typeof gate.recheckBeforeWrite>[0], request: IngressRequest, s: IngressProcessState, _policy: IngressPolicy) =>
  gate.recheckBeforeWrite(decision, request, s);
const code = (d: IngressDecision) => (d.ok ? 'ok' : d.code);

describe('ingressGate', () => {
  it('politika z testu je platná; vstup projde a vyžádá si kontrolu před zápisem', () => {
    assertValidIngressPolicy(policy);
    expect(evaluateIngress(policy, entry(), state())).toEqual({ ok: true, commandClass: 'risk-increasing', recheck: 'process+brake' });
  });

  it('neznámý příkaz, zakázaná cesta a chybějící ověření se odmítnou dřív než cokoli dalšího', () => {
    expect(code(evaluateIngress(policy, entry({ commandType: 'activate-group' }), state()))).toBe('unknown-command');
    for (const type of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(code(evaluateIngress(policy, entry({ commandType: type }), state()))).toBe('unknown-command');
    }
    for (const path of ['constructor', '__proto__', 'foo']) {
      expect(code(evaluateIngress(policy, entry({ path: path as never }), state()))).toBe('path-not-allowed');
    }
    expect(code(evaluateIngress(policy, entry({ path: 'relay', verified: ['relayUserAuth'] }), state()))).toBe('path-not-allowed');
    expect(code(evaluateIngress(policy, entry({ verified: ['clientKey'] }), state()))).toBe('not-verified');
    expect(code(evaluateIngress(policy, entry({ verified: [] }), state()))).toBe('not-verified');
  });

  it('brzda: projde bez plotu, bez času, bez načteného stavu i s mrtvým brokerem — ale nikdy bez ověření', () => {
    const dead = state({ stateLoaded: false, brokerAlive: false, brakeKnowledgeFresh: false, brakeEpoch: 99 });
    const brake: IngressRequest = { path: 'relay', commandType: 'kill-switch', verified: ['relayUserAuth'] };
    expect(evaluateIngress(policy, brake, dead)).toEqual({ ok: true, commandClass: 'brake', recheck: 'none' });
    expect(code(evaluateIngress(policy, { ...brake, path: 'direct', verified: ['clientKey'], createdAt: NOW - 3_600_000 }, dead))).toBe('ok');
    expect(code(evaluateIngress(policy, { ...brake, verified: [] }, dead))).toBe('not-verified');
    // token nenahrazuje důkaz, který cesta vyžaduje
    expect(code(evaluateIngress(policy, { ...brake, path: 'direct', verified: ['userToken'] }, dead))).toBe('not-verified');
  });

  it('po brzdě: vstup a posun se starou epochou neprojdou, zavření a zrušení vstupu ano', () => {
    const afterBrake = state({ brakeEpoch: 8 });
    expect(code(evaluateIngress(policy, entry(), afterBrake))).toBe('stale-brake-epoch');
    expect(code(evaluateIngress(policy, entry({ commandType: 'move-stop' }), afterBrake))).toBe('stale-brake-epoch');
    const close: IngressRequest = { path: 'direct', commandType: 'close-position', verified: ['clientKey'], fence, target: 'acc1:trade42' };
    expect(evaluateIngress(policy, close, afterBrake)).toEqual({ ok: true, commandClass: 'risk-reducing', recheck: 'process' });
    expect(code(evaluateIngress(policy, { ...close, commandType: 'cancel-entry', path: 'relay', verified: ['relayUserAuth'] }, afterBrake))).toBe('ok');
  });

  it('snížení rizika: bez identity cíle ne; po restartu procesu ne; kontrolu času nemá', () => {
    const close: IngressRequest = { path: 'direct', commandType: 'close-position', verified: ['clientKey'], fence, target: 'acc1:trade42' };
    expect(code(evaluateIngress(policy, { ...close, target: undefined }, state()))).toBe('missing-target');
    expect(code(evaluateIngress(policy, close, state({ startedAt: 501 })))).toBe('stale-process');
    expect(code(evaluateIngress(policy, { ...close, fence: undefined }, state()))).toBe('stale-process');
    expect(code(evaluateIngress(policy, { ...close, createdAt: NOW - 3_600_000, validUntil: NOW - 3_500_000 }, state()))).toBe('ok');
    expect(code(evaluateIngress(policy, close, state({ brokerAlive: false, brakeKnowledgeFresh: false })))).toBe('ok');
  });

  it('bez načteného stavu projdou jen brzdy', () => {
    const unloaded = state({ stateLoaded: false });
    expect(code(evaluateIngress(policy, entry(), unloaded))).toBe('state-not-loaded');
    // čtení stavu projde i bez načteného stavu a bez plotu (klient z něj plot teprve získá)
    expect(evaluateIngress(policy, { path: 'direct', commandType: 'status', verified: ['clientKey'] }, unloaded)).toEqual({ ok: true, commandClass: 'read', recheck: 'none' });
    expect(code(evaluateIngress(policy, { path: 'direct', commandType: 'status', verified: [] }, unloaded))).toBe('not-verified');
    expect(code(evaluateIngress(policy, { path: 'direct', commandType: 'disarm', verified: ['clientKey'] }, unloaded))).toBe('ok');
  });

  it('čas záměru: prošlý, z budoucnosti, s příliš dlouhou nebo chybějící platností neprojde', () => {
    expect(code(evaluateIngress(policy, entry({ createdAt: NOW - 6_000, validUntil: NOW - 1_000 }), state()))).toBe('expired');
    expect(code(evaluateIngress(policy, entry({ createdAt: NOW + 3_000, validUntil: NOW + 8_000 }), state()))).toBe('from-future');
    expect(code(evaluateIngress(policy, entry({ createdAt: NOW + 1_500, validUntil: NOW + 6_500 }), state()))).toBe('ok');
    expect(code(evaluateIngress(policy, entry({ createdAt: NOW - 100, validUntil: NOW + 60_000 }), state()))).toBe('validity-too-long');
    expect(code(evaluateIngress(policy, entry({ validUntil: undefined }), state()))).toBe('missing-time');
    expect(code(evaluateIngress(policy, entry({ createdAt: Number.NaN }), state()))).toBe('missing-time');
    expect(code(evaluateIngress(policy, entry({ createdAt: NOW, validUntil: NOW }), state()))).toBe('invalid-validity');
    expect(code(evaluateIngress(policy, entry({ target: undefined }), state()))).toBe('missing-target');
  });

  it('zvýšení rizika: mrtvý broker nebo neznámý stav brzd znamená odmítnutí; správa lease nevyžaduje', () => {
    expect(code(evaluateIngress(policy, entry(), state({ brokerAlive: false })))).toBe('broker-not-alive');
    expect(code(evaluateIngress(policy, entry(), state({ brakeKnowledgeFresh: false })))).toBe('brake-knowledge-stale');
    expect(code(evaluateIngress(policy, entry({ commandType: 'move-stop' }), state({ brakeKnowledgeFresh: false })))).toBe('ok');
  });

  it('starý ARM po vypnutí a ztracený vstup po vypnutí a novém zapnutí neprojdou', () => {
    // ARM vznikl při epoše 7, mezitím přišlo vypnutí (8)
    expect(code(evaluateIngress(policy, entry({ commandType: 'arm-live' }), state({ brakeEpoch: 8 })))).toBe('stale-brake-epoch');
    // vstup vznikl při 7, pak vypnutí (8) a nové zapnutí (9)
    expect(code(evaluateIngress(policy, entry(), state({ brakeEpoch: 9 })))).toBe('stale-brake-epoch');
  });

  it('kontrola těsně před zápisem zastaví zápis po brzdě, restartu, pádu brokera i vypršení', () => {
    const request = entry();
    const decision = evaluateIngress(policy, request, state());
    if (!decision.ok) throw new Error('vstup měl projít');
    expect(recheckBeforeWrite(decision, request, state({ now: NOW + 50 }), policy)).toBe(decision);
    expect(code(recheckBeforeWrite(decision, request, state({ brakeEpoch: 8 }), policy))).toBe('stale-brake-epoch');
    expect(code(recheckBeforeWrite(decision, request, state({ startedAt: 999 }), policy))).toBe('stale-process');
    expect(code(recheckBeforeWrite(decision, request, state({ brokerAlive: false }), policy))).toBe('broker-not-alive');
    expect(code(recheckBeforeWrite(decision, request, state({ now: NOW + 6_000 }), policy))).toBe('expired');
    expect(code(recheckBeforeWrite(decision, request, state({ brakeKnowledgeFresh: false }), policy))).toBe('brake-knowledge-stale');
  });

  it('kontrola před zápisem u zavření hlídá jen restart procesu, ne brzdu', () => {
    const close: IngressRequest = { path: 'direct', commandType: 'close-position', verified: ['clientKey'], fence, target: 'acc1:trade42' };
    const decision = evaluateIngress(policy, close, state());
    if (!decision.ok) throw new Error('zavření mělo projít');
    expect(recheckBeforeWrite(decision, close, state({ brakeEpoch: 12, brokerAlive: false }), policy)).toBe(decision);
    expect(code(recheckBeforeWrite(decision, close, state({ processId: 'p2' }), policy))).toBe('stale-process');
  });

  it('neplatná čísla ve stavu procesu nebo plotu znamenají odmítnutí', () => {
    expect(code(evaluateIngress(policy, entry(), state({ now: Number.NaN })))).toBe('expired');
    expect(code(evaluateIngress(policy, entry(), state({ startedAt: Number.NaN })))).toBe('stale-process');
    expect(code(evaluateIngress(policy, entry(), state({ brakeEpoch: Number.NaN })))).toBe('stale-brake-epoch');
    expect(code(evaluateIngress(policy, entry({ fence: { ...fence, brakeEpoch: Number.NaN } }), state()))).toBe('stale-brake-epoch');
  });

  it('kontrola před zápisem přijme jen rozhodnutí této brány a hlídá i načtený stav', () => {
    const request = entry();
    const decision = evaluateIngress(policy, request, state());
    if (!decision.ok) throw new Error('vstup měl projít');
    expect(code(recheckBeforeWrite({ ok: true, commandClass: 'risk-increasing', recheck: 'none' }, request, state(), policy))).toBe('not-verified');
    expect(code(createIngressGate(policy).recheckBeforeWrite(decision, request, state()))).toBe('not-verified');
    expect(code(recheckBeforeWrite(decision, request, state({ stateLoaded: false }), policy))).toBe('state-not-loaded');
  });

  it('brána pracuje se zmrazenou kopií politiky: pozdější změna vstupu nic neovlivní', () => {
    const mutable: IngressPolicy = JSON.parse(JSON.stringify(policy));
    const own = createIngressGate(mutable);
    (mutable.commands as Record<string, string>)['place-leader-entry'] = 'brake';
    (mutable.classes['risk-increasing'].paths as Record<string, unknown>).relay = ['relayUserAuth'];
    expect(code(own.evaluate(entry({ fence: undefined, verified: ['clientKey'] }), state()))).toBe('not-verified');
    expect(code(own.evaluate(entry({ path: 'relay', verified: ['relayUserAuth'] }), state()))).toBe('path-not-allowed');
  });

  it('brzda nesmí být těžší než vstup a musí mít použitelnou cestu', () => {
    const withClass = (name: keyof IngressPolicy['classes'], rules: IngressPolicy['classes'][typeof name]): IngressPolicy => ({
      ...policy, classes: { ...policy.classes, [name]: rules },
    });
    // brzda jen relayem, vstup přímo → přímou cestou by nešlo zabrzdit
    expect(() => createIngressGate(withClass('brake', { paths: { relay: ['relayUserAuth'] } }))).toThrow(/smí přijít risk-increasing, ale ne brake/);
    // brzda chce důkaz navíc
    expect(() => createIngressGate(withClass('brake', { paths: { direct: ['clientKey', 'relayUserAuth'], relay: ['relayUserAuth'] } }))).toThrow(/vyžaduje důkaz, který/);
    expect(() => createIngressGate(withClass('risk-reducing', { paths: { relay: ['relayUserAuth'] } }))).toThrow(/ale ne risk-reducing/);
    // „cesta" s neznámým názvem se nepočítá
    expect(() => createIngressGate(withClass('brake', { paths: { foo: ['clientKey'] } as never }))).toThrow(/neznámou cestu/);
    expect(() => createIngressGate(withClass('brake', { paths: { direct: undefined } as never }))).toThrow(/žádnou cestu/);
    expect(() => createIngressGate(withClass('brake', { paths: { direct: [] } }))).toThrow(/žádný důkaz/);
    // nekonečná nebo přehnaná platnost
    for (const time of [{ maxValidityMs: Infinity, clockToleranceMs: 0 }, { maxValidityMs: 5_000, clockToleranceMs: Infinity }, { maxValidityMs: 3_600_000, clockToleranceMs: 0 }]) {
      expect(() => createIngressGate(withClass('manage', { paths: { direct: ['clientKey', 'userToken'] }, time }))).toThrow(/neplatné časy/);
    }
    expect(() => createIngressGate(withClass('read', { paths: { direct: ['clientKey'] }, time: { maxValidityMs: 1_000, clockToleranceMs: 0 } }))).toThrow(/čtení nemá kontrolu času/);
    expect(() => createIngressGate(withClass('read', { paths: { direct: ['clientKey'] }, requireFreshBrakeKnowledge: true }))).toThrow(/nesmí čekat/);
  });

  it('politika porušující pevná pravidla se odmítne už při startu', () => {
    const withClass = (name: keyof IngressPolicy['classes'], rules: IngressPolicy['classes'][typeof name]): IngressPolicy => ({
      ...policy, classes: { ...policy.classes, [name]: rules },
    });
    expect(() => assertValidIngressPolicy(withClass('brake', { paths: { direct: [] } }))).toThrow(/žádný důkaz/);
    expect(() => assertValidIngressPolicy(withClass('brake', { paths: {} }))).toThrow(/žádnou cestu|ale ne brake/);
    expect(() => assertValidIngressPolicy(withClass('brake', { paths: { direct: ['clientKey'] }, time: { maxValidityMs: 1, clockToleranceMs: 0 } }))).toThrow(/kontrolu času/);
    expect(() => assertValidIngressPolicy(withClass('risk-reducing', { paths: { direct: ['clientKey'] }, time: { maxValidityMs: 1, clockToleranceMs: 0 } }))).toThrow(/identitu cíle/);
    expect(() => assertValidIngressPolicy(withClass('risk-reducing', { paths: { direct: ['clientKey'] }, requireFreshBrakeKnowledge: true }))).toThrow(/nesmí čekat/);
    expect(() => assertValidIngressPolicy(withClass('risk-increasing', { paths: { direct: ['clientKey'] } }))).toThrow(/musí mít kontrolu času/);
    expect(() => assertValidIngressPolicy(withClass('manage', { paths: { direct: ['clientKey'] }, time: { maxValidityMs: 0, clockToleranceMs: 0 } }))).toThrow(/neplatné časy/);
    expect(() => assertValidIngressPolicy({ ...policy, commands: { x: 'jina' as never } })).toThrow(/neznámou třídu/);
  });
});
