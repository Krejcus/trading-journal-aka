import { describe, expect, it } from 'vitest';
import {
  RECORD_TYPES_ACCOUNT_ID,
  TYPES_ALL,
  TYPES_SCENARIO_ORDER,
  buildTypesOsoPayload,
  buildTypesPlacements,
  chicagoClock,
  classifyTypesOsoResponse,
  definitiveHttpRejection,
  describeTypesPlan,
  parseRecordTypesArgs,
  placementFromTypesResult,
  recordTypesMayPlace,
  recordTypesReference,
  recordTypesStatusProblems,
  redactSecrets,
  sanitizeRestRows,
  sanitizeTypesPayload,
  scenarioWindowProblem,
  typesPayloadProblems,
  typesPlacementVerdict,
  type RecordTypesPlan,
  type TypesObservation,
  type TypesOsoPayload,
  type TypesScenarioId,
} from '../scripts/copier/recordTypesPlan';

// Út 3. 11. 2026 10:00 CST (UTC−6) = obchodní doba.
const NOW = Date.UTC(2026, 10, 3, 16, 0);
// Út 3. 11. 2026 16:10 CST = denní pauza CME; Út 27. 10. 2026 16:10 CDT (UTC−5).
const PAUSE_CST = Date.UTC(2026, 10, 3, 22, 10);
const PAUSE_CDT = Date.UTC(2026, 9, 27, 21, 10);
const REF = 25_000;

const baseArgs = ['--account', String(RECORD_TYPES_ACCOUNT_ID), '--symbol', 'MNQZ6', '--market-price', String(REF)];
const plan = (patch: Partial<RecordTypesPlan> = {}): RecordTypesPlan => ({
  accountId: RECORD_TYPES_ACCOUNT_ID, symbol: 'MNQZ6', marketPrice: REF, quantity: 1, scenarios: ['stoplimit-cancel'],
  confirm: false, trailPeg: 'offset', mitTrigger: 'price', ...patch,
});
const status = (controller: Record<string, unknown> = {}, extra: Record<string, unknown> = {}, at = NOW - 1_000) => ({
  environment: 'demo',
  controller: {
    armed: false, connected: true, killSwitch: false, groupFlat: true, reconciliationRequired: false,
    lastError: null, manualRecovery: null, transportResume: null, divergentAccounts: [], workingOrderAccounts: [],
    unsupportedOrders: [], ...controller,
  },
  group: { leaderAccountId: RECORD_TYPES_ACCOUNT_ID, manualOnly: true, localOnly: true, followers: [] },
  marketPrices: [{ symbol: 'MNQZ6', price: REF, at }],
  ...extra,
});
const startProblems = (p = plan(), s: unknown = status(), now = NOW) => recordTypesStatusProblems(p, s, now, { kind: 'start' });

describe('REC-TYPES: argumenty', () => {
  it('platný plán; výchozí qty 1, bez --confirm, all = vše kromě pauzy v pevném pořadí', () => {
    const parsed = parseRecordTypesArgs([...baseArgs, '--scenario', 'all']);
    expect(parsed).toMatchObject({ accountId: RECORD_TYPES_ACCOUNT_ID, symbol: 'MNQZ6', quantity: 1, confirm: false, trailPeg: 'offset', mitTrigger: 'price' });
    expect(parsed.scenarios).toEqual(TYPES_ALL);
    expect(parsed.scenarios).not.toContain('tif-pause');
    expect(parseRecordTypesArgs([...baseArgs, '--scenario', 'leg-through-buy,stoplimit-cancel', '--confirm']).scenarios)
      .toEqual(['stoplimit-cancel', 'leg-through-buy']);
    expect(parseRecordTypesArgs([...baseArgs, '--scenario', 'tif-pause']).scenarios).toEqual(['tif-pause']);
  });

  it.each([
    [['--account', '4242'], '--account'],
    [['--symbol', 'NQZ6'], 'MNQ'],
    [['--symbol', 'MESZ6'], 'MNQ'],
    [['--symbol', 'MNQF7'], 'MNQ'],
    [['--qty', '3'], '--qty'],
    [['--qty', '0'], '--qty'],
    [['--qty', '1.5'], '--qty'],
    [['--environment', 'live'], 'DEMO'],
    [['--live'], 'Neznámý argument'],
    [['--confrim'], 'Neznámý argument'],
    [['--scenario', 'trailing'], 'Neznámý scénář'],
    [['--scenario', 'tif-pause,stoplimit-cancel'], 'samostatně'],
    [['--trail-peg', 'up'], '--trail-peg'],
    [['--mit-trigger', 'limit'], '--mit-trigger'],
  ])('odmítne %o', (patch, reason) => {
    const args = [...baseArgs, '--scenario', 'stoplimit-cancel'];
    for (let index = 0; index < patch.length; index += 2) {
      const at = args.indexOf(patch[index]);
      if (at >= 0 && patch[index + 1] !== undefined) args[at + 1] = patch[index + 1];
      else args.push(...patch.slice(index, index + 2));
    }
    expect(() => parseRecordTypesArgs(args)).toThrow(reason);
  });

  it('bez --scenario nebo --market-price neběží', () => {
    expect(() => parseRecordTypesArgs(baseArgs)).toThrow('--scenario');
    expect(() => parseRecordTypesArgs(['--account', String(RECORD_TYPES_ACCOUNT_ID), '--symbol', 'MNQZ6', '--scenario', 'all'])).toThrow('--market-price');
  });

  it('bez --confirm se nikdy nic neposílá, ani s čistými pojistkami; s problémem ani s --confirm', () => {
    expect(recordTypesMayPlace({ confirm: false }, [])).toBe(false);
    expect(recordTypesMayPlace({ confirm: true }, ['x'])).toBe(false);
    expect(recordTypesMayPlace({ confirm: true }, [])).toBe(true);
  });
});

describe('REC-TYPES: pojistky workeru', () => {
  it('bezpečný stav za DISARMED projde', () => {
    expect(startProblems()).toEqual([]);
    expect(recordTypesStatusProblems(plan(), status(), NOW, { kind: 'scenario', scenario: 'stoplimit-cancel' })).toEqual([]);
  });

  it.each([
    [{ armed: true }, 'DISARMED'], [{ armed: undefined }, 'DISARMED'],
    [{ transportResume: { phase: 'waiting' } }, 'pokračování'], [{ transportResume: { phase: 'ready' } }, 'pokračování'],
  ])('před každým scénářem (armed gate) %o zastaví', (controller, reason) => {
    expect(recordTypesStatusProblems(plan(), status(controller), NOW, { kind: 'scenario', scenario: 'stoplimit-cancel' }).join(' ')).toContain(reason);
    expect(startProblems(plan(), status(controller)).join(' ')).toContain(reason);
  });

  it.each([
    [{ connected: false }, 'připojený'], [{ killSwitch: true }, 'kill'], [{ groupFlat: false }, 'flat'],
    [{ reconciliationRequired: true }, 'kontrolu pozic'], [{ lastError: 'x' }, 'lastError'],
    [{ manualRecovery: { id: 'a' } }, 'ruční obnovu'], [{ divergentAccounts: [1] }, 'divergenci'], [{ workingOrderAccounts: [1] }, 'working'],
  ])('na startu plná kontrola: %o', (controller, reason) => {
    expect(startProblems(plan(), status(controller)).join(' ')).toContain(reason);
    // Po prvním scénáři worker čeká na kontrolu pozic — mezi scénáři se to už nežádá.
    if ('reconciliationRequired' in controller) {
      expect(recordTypesStatusProblems(plan(), status(controller), NOW, { kind: 'scenario', scenario: 'stoplimit-cancel' })).toEqual([]);
    }
  });

  it('jen DEMO, jen leader sólo skupiny (manual-only, local-only, bez followerů)', () => {
    expect(startProblems(plan(), status({}, { environment: 'live' })).join(' ')).toContain('DEMO');
    expect(startProblems(plan(), status({}, { environment: undefined })).join(' ')).toContain('DEMO');
    const group = { leaderAccountId: RECORD_TYPES_ACCOUNT_ID, manualOnly: true, localOnly: true, followers: [] };
    expect(startProblems(plan(), status({}, { group: { ...group, leaderAccountId: 7 } })).join(' ')).toContain('není leader');
    expect(startProblems(plan(), status({}, { group: { ...group, manualOnly: false } })).join(' ')).toContain('manual-only');
    expect(startProblems(plan(), status({}, { group: { ...group, localOnly: false } })).join(' ')).toContain('manual-only');
    expect(startProblems(plan(), status({}, { group: { ...group, followers: [{ accountId: 9 }] } })).join(' ')).toContain('followery');
    expect(startProblems(plan(), {}).length).toBeGreaterThan(3);
    expect(startProblems(plan({ accountId: 4242 })).join(' ')).toContain('jen účet');
    expect(startProblems(plan({ quantity: 3 })).join(' ')).toContain('qty');
    expect(startProblems(plan({ symbol: 'NQZ6' })).join(' ')).toContain('MNQ');
  });

  it('KRITICKÁ: S4–S6 jen s workerem s opravou C1 (controller.unsupportedOrders)', () => {
    const oldWorker = status({ unsupportedOrders: undefined });
    for (const scenario of ['trailing-leg', 'mit-cancel', 'mit-touch'] as const) {
      expect(startProblems(plan({ scenarios: [scenario] }), oldWorker).join(' ')).toContain('unsupportedOrders');
      expect(recordTypesStatusProblems(plan({ scenarios: [scenario] }), oldWorker, NOW, { kind: 'scenario', scenario }).join(' ')).toContain('opravu C1');
      expect(startProblems(plan({ scenarios: [scenario] }))).toEqual([]);
    }
    // Celá sada s S4–S6 na starém workeru neběží vůbec (ani S1–S3 před nimi).
    expect(startProblems(plan({ scenarios: [...TYPES_ALL] }), oldWorker).join(' ')).toContain('unsupportedOrders');
    // Cizí nepodporovaný příkaz už ve skupině = stop.
    expect(startProblems(plan({ scenarios: ['trailing-leg'] }), status({ unsupportedOrders: [{ brokerOrderId: '1' }] })).join(' ')).toContain('cizí');
    // Scénáře bez TrailingStop/MIT opravu nepotřebují.
    expect(startProblems(plan({ scenarios: ['stoplimit-cancel', 'leg-through-buy'] }), oldWorker)).toEqual([]);
    expect(recordTypesStatusProblems(plan({ scenarios: [...TYPES_ALL] }), oldWorker, NOW, { kind: 'scenario', scenario: 'tif-readback' })).toEqual([]);
  });

  it('kotva: čerstvá cena workeru ≤ 3 s, souhlas s --market-price 0,3 % na startu a 1,5 % před scénářem', () => {
    expect(startProblems(plan(), status({}, { marketPrices: [] })).join(' ')).toContain('čerstvou cenu');
    expect(startProblems(plan(), status({}, {}, NOW - 5_000)).join(' ')).toContain('čerstvou cenu');
    expect(startProblems(plan({ marketPrice: 25_100 })).join(' ')).toContain('nesedí');
    const drift = status({}, { marketPrices: [{ symbol: 'MNQZ6', price: 25_250, at: NOW - 500 }] });
    expect(startProblems(plan(), drift).join(' ')).toContain('nesedí');
    expect(recordTypesStatusProblems(plan(), drift, NOW, { kind: 'scenario', scenario: 'stoplimit-cancel' })).toEqual([]);
    const far = status({}, { marketPrices: [{ symbol: 'MNQZ6', price: 25_500, at: NOW - 500 }] });
    expect(recordTypesStatusProblems(plan(), far, NOW, { kind: 'scenario', scenario: 'stoplimit-cancel' }).join(' ')).toContain('nesedí');
    expect(recordTypesReference(plan(), status(), NOW, 'market')).toEqual({ price: REF, source: 'worker', anchor: REF });
  });
});

describe('REC-TYPES: časová okna CME (America/Chicago, DST)', () => {
  it('hodiny Chicaga v CST i CDT', () => {
    expect(chicagoClock(NOW)).toEqual({ weekday: 2, minute: 10 * 60 });
    expect(chicagoClock(PAUSE_CST)).toEqual({ weekday: 2, minute: 16 * 60 + 10 });
    expect(chicagoClock(PAUSE_CDT)).toEqual({ weekday: 2, minute: 16 * 60 + 10 });
  });

  it('scénáře s trhem ne v rezervě před pauzou, v pauze ani o víkendu', () => {
    expect(scenarioWindowProblem('market', NOW)).toBeNull();
    expect(scenarioWindowProblem('market', Date.UTC(2026, 10, 3, 21, 46))).toContain('pauzy'); // 15:46 CST
    expect(scenarioWindowProblem('market', PAUSE_CST)).toContain('pauzy');
    expect(scenarioWindowProblem('market', Date.UTC(2026, 10, 3, 23, 6))).toBeNull(); // 17:06 CST
    expect(scenarioWindowProblem('market', Date.UTC(2026, 10, 7, 16, 0))).toContain('víkend'); // sobota
    expect(scenarioWindowProblem('market', Date.UTC(2026, 10, 6, 21, 50))).toContain('víkend'); // pátek 15:50
    expect(scenarioWindowProblem('market', Date.UTC(2026, 10, 8, 22, 0))).toContain('víkend'); // neděle 16:00
    expect(scenarioWindowProblem('market', Date.UTC(2026, 10, 8, 23, 10))).toBeNull(); // neděle 17:10
  });

  it('scénář pauzy jen Po–Čt 16:00–16:50 CT, jinak odmítne', () => {
    expect(scenarioWindowProblem('pause', PAUSE_CST)).toBeNull();
    expect(scenarioWindowProblem('pause', PAUSE_CDT)).toBeNull();
    expect(scenarioWindowProblem('pause', NOW)).toContain('16:00–16:50');
    expect(scenarioWindowProblem('pause', Date.UTC(2026, 10, 3, 21, 59))).toContain('16:00–16:50'); // 15:59 CST
    expect(scenarioWindowProblem('pause', Date.UTC(2026, 10, 3, 22, 50))).toContain('16:00–16:50'); // 16:50 CST
    expect(scenarioWindowProblem('pause', Date.UTC(2026, 9, 27, 20, 10))).toContain('16:00–16:50'); // 15:10 CDT
    expect(scenarioWindowProblem('pause', Date.UTC(2026, 10, 6, 22, 10))).toContain('Po–Čt'); // pátek 16:10
    const pausePlan = plan({ scenarios: ['tif-pause'] });
    expect(startProblems(pausePlan, status({}, { marketPrices: [] }), PAUSE_CST)).toEqual([]);
    expect(startProblems(pausePlan, status({}, { marketPrices: [] }), NOW).join(' ')).toContain('16:00–16:50');
    expect(startProblems(plan(), status({}, {}, PAUSE_CST - 1_000), PAUSE_CST).join(' ')).toContain('pauzy');
    // V pauze reference = --market-price (bez obchodů není čerstvá cena).
    expect(recordTypesReference(pausePlan, status({}, { marketPrices: [] }), PAUSE_CST, 'pause')).toMatchObject({ price: REF, source: 'market-price' });
  });
});

const context = (quantity = 1, mitTrigger: RecordTypesPlan['mitTrigger'] = 'price') => ({
  accountId: RECORD_TYPES_ACCOUNT_ID, accountSpec: 'DEMO8661118', symbol: 'MNQZ6', quantity, tag: 'rtyabc', mitTrigger,
});
const payloadFor = (scenario: TypesScenarioId, index = 0, options: Partial<RecordTypesPlan> = {}, now = NOW) =>
  buildTypesOsoPayload(buildTypesPlacements(scenario, REF, plan(options), now)[index], context(options.quantity ?? 1, options.mitTrigger ?? 'price'));
const guard = (payload: TypesOsoPayload, scenario: TypesScenarioId, patch: Partial<RecordTypesPlan> = {}, now = NOW) =>
  typesPayloadProblems(payload, { plan: plan({ scenarios: [scenario], ...patch }), scenario, reference: REF, now });

describe('REC-TYPES: příkazy scénářů', () => {
  it('každý scénář projde posledním sítem (i qty 2, MIT v obou polích, flip pegu)', () => {
    for (const scenario of TYPES_SCENARIO_ORDER) {
      const count = buildTypesPlacements(scenario, REF, plan(), NOW).length;
      for (let index = 0; index < count; index += 1) {
        expect(guard(payloadFor(scenario, index), scenario), `${scenario}[${index}]`).toEqual([]);
        expect(guard(payloadFor(scenario, index, { quantity: 2 }), scenario, { quantity: 2 }), `${scenario}[${index}] qty 2`).toEqual([]);
      }
    }
    expect(guard(payloadFor('mit-cancel', 0, { mitTrigger: 'stopPrice' }), 'mit-cancel')).toEqual([]);
    expect(guard(payloadFor('trailing-leg', 0, { trailPeg: 'flip' }), 'trailing-leg')).toEqual([]);
  });

  it('S1–S3 StopLimit: daleko / na trhu / přes trh', () => {
    const [s1] = buildTypesPlacements('stoplimit-cancel', REF, plan(), NOW);
    expect(s1.entry).toMatchObject({ side: 'Buy', orderType: 'StopLimit', stopPrice: 25_375, price: 25_375.5 });
    expect(s1.flow).toBe('hold');
    const [s2] = buildTypesPlacements('stoplimit-fill', REF, plan(), NOW);
    expect(s2.entry).toMatchObject({ stopPrice: 25_000.25, price: 25_002.25 });
    expect(s2.stopLoss).toMatchObject({ side: 'Sell', orderType: 'Stop', stopPrice: 24_990 });
    expect(s2.flow).toBe('fill');
    const [s3] = buildTypesPlacements('stoplimit-through', REF, plan(), NOW);
    expect(s3.entry).toMatchObject({ stopPrice: 24_998, price: 24_998.5 });
    expect(s3.entry.stopPrice!).toBeLessThan(REF);
  });

  it('S4 TrailingStop: pegDifference = stopPrice − trh (Sell trailing záporný), --trail-peg flip otočí znaménko', () => {
    const [offset] = buildTypesPlacements('trailing-leg', REF, plan(), NOW);
    expect(offset.stopLoss).toEqual({ side: 'Sell', orderType: 'TrailingStop', stopPrice: 24_990, pegDifference: -10 });
    expect(offset.entry).toMatchObject({ orderType: 'Limit', price: 25_000.5 });
    expect(offset.holdMs).toBe(15_000);
    expect(buildTypesPlacements('trailing-leg', REF, plan({ trailPeg: 'flip' }), NOW)[0].stopLoss.pegDifference).toBe(10);
    expect(payloadFor('trailing-leg').bracket1).toMatchObject({ orderType: 'TrailingStop', stopPrice: 24_990, pegDifference: -10, clOrdId: 'rtyabcs' });
  });

  it('S5–S6 MIT: daleko pod trhem / už dotčený; spoušť v price nebo stopPrice', () => {
    expect(buildTypesPlacements('mit-cancel', REF, plan(), NOW)[0].entry).toMatchObject({ orderType: 'MIT', price: 24_625 });
    expect(buildTypesPlacements('mit-touch', REF, plan(), NOW)[0].entry).toMatchObject({ orderType: 'MIT', price: 25_001 });
    const inPrice = payloadFor('mit-cancel');
    expect(inPrice).toMatchObject({ orderType: 'MIT', price: 24_625 });
    expect(inPrice.stopPrice).toBeUndefined();
    const inStop = payloadFor('mit-cancel', 0, { mitTrigger: 'stopPrice' });
    expect(inStop).toMatchObject({ orderType: 'MIT', stopPrice: 24_625 });
    expect(inStop.price).toBeUndefined();
  });

  it('S7–S8b TIF: tři varianty postupně, GTD jen s expireTime v krátkém okně, nohy bez TIF', () => {
    const s7 = buildTypesPlacements('tif-readback', REF, plan(), NOW);
    expect(s7.map(item => item.entry.timeInForce)).toEqual([undefined, 'Day', 'GTC']);
    expect(s7.every(item => item.readback && item.entry.price === 24_625)).toBe(true);
    expect(payloadFor('tif-readback', 0).timeInForce).toBeUndefined();
    expect(payloadFor('tif-readback', 2).timeInForce).toBe('GTC');
    const [s8] = buildTypesPlacements('tif-gtd-expire', REF, plan(), NOW);
    expect(s8).toMatchObject({ flow: 'expire', afterExpireMs: 20_000, entry: { timeInForce: 'GTD', expireAt: NOW + 90_000 } });
    expect(payloadFor('tif-gtd-expire').expireTime).toBe(new Date(NOW + 90_000).toISOString());
    const [s8b] = buildTypesPlacements('tif-gtd-fill', REF, plan(), NOW);
    expect(s8b).toMatchObject({ flow: 'expire', entry: { price: 25_000.5, timeInForce: 'GTD', expireAt: NOW + 60_000 } });
    for (const leg of [payloadFor('tif-gtd-fill').bracket1, payloadFor('tif-gtd-fill').bracket2]) {
      expect(leg).not.toHaveProperty('timeInForce');
      expect(leg).not.toHaveProperty('expireTime');
    }
  });

  it('S9 noha přes trh: Buy i Sell — SL mezi trhem a limitem vstupu', () => {
    const [buy] = buildTypesPlacements('leg-through-buy', REF, plan(), NOW);
    expect(buy.entry).toMatchObject({ side: 'Buy', price: 25_002 });
    expect(buy.stopLoss).toMatchObject({ side: 'Sell', stopPrice: 25_000.5 });
    const [sell] = buildTypesPlacements('leg-through-sell', REF, plan(), NOW);
    expect(sell.entry).toMatchObject({ side: 'Sell', price: 24_998 });
    expect(sell.stopLoss).toMatchObject({ side: 'Buy', stopPrice: 24_999.5 });
    expect(sell.takeProfit).toMatchObject({ side: 'Buy', price: 24_625 });
  });

  it('R12d pauza: Limit 3 % pod --market-price s TIF Day, pak bez TIF', () => {
    const pause = buildTypesPlacements('tif-pause', REF, plan(), PAUSE_CST);
    expect(pause.map(item => [item.entry.price, item.entry.timeInForce])).toEqual([[24_250, 'Day'], [24_250, undefined]]);
  });
});

describe('REC-TYPES: poslední síto před POSTem', () => {
  const good = () => payloadFor('leg-through-buy');
  const mutate = (patch: (payload: TypesOsoPayload) => void, scenario: TypesScenarioId = 'leg-through-buy', base = good()) => {
    const copy = structuredClone(base);
    patch(copy);
    return guard(copy, scenario).join(' ');
  };

  it.each([
    ['jiný účet', (p: TypesOsoPayload) => { p.accountId = 4242; }, 'účet'],
    ['jiný accountSpec', (p: TypesOsoPayload) => { p.accountSpec = 'LUCID123'; }, 'accountSpec'],
    ['jiný symbol', (p: TypesOsoPayload) => { p.symbol = 'NQZ6'; }, 'symbol'],
    ['qty 3', (p: TypesOsoPayload) => { p.orderQty = 3; }, 'qty'],
    ['isAutomated false', (p: TypesOsoPayload) => { (p as { isAutomated: boolean }).isAutomated = false; }, 'isAutomated'],
    ['noha na straně vstupu', (p: TypesOsoPayload) => { p.bracket1.action = 'Buy'; }, 'opačné strany'],
    ['cena mimo tick', (p: TypesOsoPayload) => { p.price = 25_002.1; }, 'tick'],
    ['cena daleko od reference', (p: TypesOsoPayload) => { p.bracket2.price = 27_000; }, 'reference'],
    ['SL nad vstupem (Buy)', (p: TypesOsoPayload) => { p.bracket1.stopPrice = 25_003; }, 'ochranné'],
    ['SL příliš daleko (riziko)', (p: TypesOsoPayload) => { p.bracket1.stopPrice = 24_980; }, 'riziko'],
    ['TP pod vstupem', (p: TypesOsoPayload) => { p.bracket2.price = 24_990; }, 'TP'],
    ['typ vstupu mimo scénář', (p: TypesOsoPayload) => { p.orderType = 'Market'; }, 'nepatří'],
    ['TrailingStop mimo S4', (p: TypesOsoPayload) => { p.bracket1.orderType = 'TrailingStop'; p.bracket1.pegDifference = -0.5; }, 'nepatří'],
    ['GTC mimo S7', (p: TypesOsoPayload) => { p.timeInForce = 'GTC'; }, 'TIF'],
    ['TIF na noze', (p: TypesOsoPayload) => { (p.bracket1 as unknown as Record<string, unknown>).timeInForce = 'Day'; }, 'nohy bez'],
    ['expireTime bez GTD', (p: TypesOsoPayload) => { p.expireTime = new Date(NOW + 60_000).toISOString(); }, 'expireTime'],
    ['stopPrice u Limitu', (p: TypesOsoPayload) => { p.stopPrice = 25_001; }, 'stopPrice'],
  ])('odmítne: %s', (_name, patch, reason) => {
    expect(mutate(patch)).toContain(reason);
  });

  it('GTD: expireTime musí být 30–150 s od teď; pegDifference jen nenulový a omezený', () => {
    const gtd = payloadFor('tif-gtd-expire');
    expect(mutate(p => { p.expireTime = new Date(NOW + 10_000).toISOString(); }, 'tif-gtd-expire', gtd)).toContain('GTD');
    expect(mutate(p => { p.expireTime = new Date(NOW + 600_000).toISOString(); }, 'tif-gtd-expire', gtd)).toContain('GTD');
    expect(mutate(p => { delete p.expireTime; }, 'tif-gtd-expire', gtd)).toContain('GTD');
    const trail = payloadFor('trailing-leg');
    expect(mutate(p => { p.bracket1.pegDifference = 0; }, 'trailing-leg', trail)).toContain('pegDifference');
    expect(mutate(p => { p.bracket1.pegDifference = -20; }, 'trailing-leg', trail)).toContain('pegDifference');
    expect(mutate(p => { delete p.bracket1.pegDifference; }, 'trailing-leg', trail)).toContain('pegDifference');
    expect(mutate(p => { p.bracket2.pegDifference = 1; }, 'trailing-leg', trail)).toContain('TP bez pegDifference');
  });

  it('StopLimit: limit 0–20 t za spouští; MIT spoušť právě v jednom poli', () => {
    const stopLimit = payloadFor('stoplimit-cancel');
    expect(mutate(p => { p.price = p.stopPrice! - 0.25; }, 'stoplimit-cancel', stopLimit)).toContain('StopLimit');
    expect(mutate(p => { p.price = p.stopPrice! + 10; p.bracket2.price = p.price + 40; }, 'stoplimit-cancel', stopLimit)).toContain('StopLimit');
    const mit = payloadFor('mit-cancel');
    expect(mutate(p => { p.stopPrice = p.price; }, 'mit-cancel', mit)).toContain('právě v jednom');
  });
});

describe('REC-TYPES: klasifikace výsledků', () => {
  it('odpověď placeoso: přijato / odmítnuto / částečně / nejisté', () => {
    expect(classifyTypesOsoResponse({ orderId: 11, oso1Id: 12, oso2Id: 13 })).toEqual({ result: 'accepted', entryId: '11', stopId: '12', targetId: '13' });
    expect(classifyTypesOsoResponse({ failureReason: 'UnknownReason', failureText: 'Invalid order type' })).toEqual({ result: 'rejected', reason: 'Invalid order type' });
    expect(classifyTypesOsoResponse({ orderId: 11, oso1Id: 12 })).toMatchObject({ result: 'partial', entryId: '11', stopId: '12', targetId: null });
    expect(classifyTypesOsoResponse(undefined).result).toBe('ambiguous');
    expect(classifyTypesOsoResponse({ failureReason: 'Success' }).result).toBe('ambiguous');
    expect(classifyTypesOsoResponse({ orderId: '11', oso1Id: 12, oso2Id: 13 }).result).toBe('ambiguous');
  });

  it('HTTP chyba placeoso: 4xx validace = jisté odmítnutí; 408/425/429, 5xx a síť = nejisté', () => {
    const rejected = definitiveHttpRejection(400, 'Invalid pegDifference Bearer eyJsecret');
    expect(rejected?.failureText).toContain('HTTP 400: Invalid pegDifference');
    expect(rejected?.failureText).not.toContain('eyJsecret');
    expect(classifyTypesOsoResponse(rejected).result).toBe('rejected');
    for (const status of [undefined, 200, 408, 425, 429, 500, 503]) expect(definitiveHttpRejection(status, 'x')).toBeNull();
  });

  it('úklid: „čisto“ jen po plném ACK nebo jistém odmítnutí, jinak nejisté', () => {
    expect(placementFromTypesResult(classifyTypesOsoResponse({ orderId: 11, oso1Id: 12, oso2Id: 13 }), 'Buy'))
      .toEqual({ kind: 'acknowledged', entryId: '11', legIds: ['12', '13'] });
    expect(placementFromTypesResult(classifyTypesOsoResponse({ failureText: 'x' }), 'Buy')).toEqual({ kind: 'not-sent' });
    expect(placementFromTypesResult(classifyTypesOsoResponse({ orderId: 11 }), 'Sell')).toEqual({ kind: 'uncertain', entrySide: 'Sell' });
    expect(placementFromTypesResult(classifyTypesOsoResponse(undefined), 'Buy')).toEqual({ kind: 'uncertain', entrySide: 'Buy' });
  });

  const accepted = classifyTypesOsoResponse({ orderId: 11, oso1Id: 12, oso2Id: 13 });
  const seen = (entry: string, stop: string, target = 'working', net = 1): TypesObservation => ({
    netPosition: net,
    orders: [
      { id: '11', status: entry, filledQuantity: entry === 'filled' ? 1 : 0 },
      { id: '12', status: stop, filledQuantity: 0, parentOrderId: '11' },
      { id: '13', status: target, filledQuantity: 0, parentOrderId: '11' },
    ],
  });

  it('S9: SL přes trh odmítnut = větev B, hned spuštěn = větev A, nevyplněný vstup nerozhoduje', () => {
    expect(typesPlacementVerdict('leg-through-buy', accepted, { afterFill: seen('filled', 'rejected'), last: seen('filled', 'rejected') }).summary).toContain('větev B');
    expect(typesPlacementVerdict('leg-through-sell', accepted, { afterFill: seen('filled', 'filled', 'canceled', 0), last: seen('filled', 'filled', 'canceled', 0) }).summary).toContain('větev A');
    const unfilled = typesPlacementVerdict('leg-through-buy', accepted, { afterFill: seen('working', 'pending', 'pending', 0), last: seen('working', 'pending', 'pending', 0) });
    expect(unfilled.summary).toContain('nerozhoduje');
    expect(unfilled.stopLossAtActivation).toBe('pending');
  });

  it('S3, S6, S8, S8b a odmítnuté OSO', () => {
    expect(typesPlacementVerdict('stoplimit-through', accepted, { last: seen('rejected', 'canceled', 'canceled', 0) }).summary).toContain('ODMÍTNUT');
    expect(typesPlacementVerdict('stoplimit-through', accepted, { last: seen('working', 'pending', 'pending', 0) }).summary).toContain('pracuje');
    expect(typesPlacementVerdict('mit-touch', accepted, { afterFill: seen('filled', 'working'), last: seen('filled', 'working') }).summary).toContain('hned spustil');
    expect(typesPlacementVerdict('tif-gtd-expire', accepted, { last: seen('canceled', 'canceled', 'canceled', 0) }).summary).toContain('vypršel');
    expect(typesPlacementVerdict('tif-gtd-fill', accepted, { afterFill: seen('filled', 'working'), last: seen('filled', 'canceled', 'canceled') }).summary).toContain('bez ochrany');
    expect(typesPlacementVerdict('tif-gtd-fill', accepted, { afterFill: seen('filled', 'working'), last: seen('filled', 'working') }).summary).toContain('přežily');
    expect(typesPlacementVerdict('trailing-leg', { result: 'rejected', reason: 'Invalid pegDifference' }, { last: null }).summary).toContain('Invalid pegDifference');
    expect(typesPlacementVerdict('stoplimit-cancel', accepted, { last: null })).toMatchObject({ entry: 'unknown', stopLoss: 'unknown' });
  });
});

describe('REC-TYPES: anonymizace a tajemství', () => {
  it('payload do záznamu bez accountSpec a clOrdId, účet zástupně', () => {
    const sanitized = sanitizeTypesPayload(payloadFor('trailing-leg'));
    const text = JSON.stringify(sanitized);
    expect(text).not.toContain('DEMO8661118');
    expect(text).not.toContain('rtyabc');
    expect(text).not.toContain(String(RECORD_TYPES_ACCOUNT_ID));
    expect(sanitized).toMatchObject({ accountId: 1001, orderType: 'Limit', bracket1: { orderType: 'TrailingStop', pegDifference: -10 } });
  });

  it('REST řádky bez soukromých klíčů, účty přemapované', () => {
    const rows = sanitizeRestRows([{ id: 5, accountId: RECORD_TYPES_ACCOUNT_ID, name: 'DEMO8661118', clOrdId: 'rty', timeInForce: 'Day' }, 'x'],
      new Map([[RECORD_TYPES_ACCOUNT_ID, 1001]]));
    expect(rows).toEqual([{ id: 5, accountId: 1001, timeInForce: 'Day' }]);
    expect(sanitizeRestRows({ id: 1, accountId: 999 }, new Map())).toEqual([{ id: 1, accountId: 0 }]);
    expect(sanitizeRestRows(null, new Map())).toEqual([]);
  });

  it('token se nikdy nedostane do textu chyby ani záznamu', () => {
    const text = redactSecrets('401 Bearer eyJabc.def-ghi {"accessToken":"secret","mdAccessToken":"x"} conn:1234-abcd');
    expect(text).not.toMatch(/eyJabc|secret|1234-abcd/);
    expect(text).toContain('Bearer ***');
  });

  it('dry-run popis plánu: kódy scénářů a varování u S4–S6', () => {
    const text = describeTypesPlan(plan({ scenarios: [...TYPES_ALL] }), NOW);
    for (const code of ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S8b', 'S9a', 'S9b']) expect(text).toContain(`- ${code} `);
    expect(text).toContain('jen s opravou C1');
    expect(text).not.toContain(String(RECORD_TYPES_ACCOUNT_ID * 10));
  });
});
