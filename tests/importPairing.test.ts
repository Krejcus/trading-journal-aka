import { describe, expect, it } from 'vitest';
import {
  normalizeSymbol,
  executionEntryPrice,
  scoreCandidate,
  pairExecutions,
  describeExecutionContext,
  groupExecutions,
  buildManualLinkOptions,
  describeGroupContext,
  type ImportedExecution,
  type JournalTrade,
} from '../services/importPairing';
import { parseDurationMinutes } from '../services/importService';

const PRAGUE_OFFSET = '+02:00';
const at = (hhmmss: string) => `2026-07-30T${hhmmss}${PRAGUE_OFFSET}`;
const ms = (hhmmss: string) => new Date(at(hhmmss)).getTime();

function exec(over: Partial<ImportedExecution> & { id: string }): ImportedExecution {
  return {
    account_ext_id: 100,
    symbol: 'MNQU6',
    direction: 'Long',
    buy_price: 28000,
    sell_price: 28020,
    qty: 2,
    pnl: 40,
    entry_at: at('16:00:00'),
    exit_at: at('16:05:00'),
    status: 'pending',
    ...over,
  };
}

function trade(over: Partial<JournalTrade> & { id: string }): JournalTrade {
  return {
    accountId: 'acc-app',
    instrument: 'MNQ',
    entryPrice: 28000,
    entryTime: ms('16:00:00'),
    timestamp: ms('16:00:00'),
    pnl: 40,
    ...over,
  };
}

const accountMap = new Map([[100, 'acc-app']]);

describe('normalizeSymbol', () => {
  it('odstraní kontraktní měsíc a rok', () => {
    expect(normalizeSymbol('MNQU6')).toBe('MNQ');
    expect(normalizeSymbol('NQZ5')).toBe('NQ');
    expect(normalizeSymbol('ESH26')).toBe('ES');
  });

  it('kořen bez kontraktu nechá být', () => {
    expect(normalizeSymbol('MNQ')).toBe('MNQ');
    expect(normalizeSymbol(null)).toBe('');
  });
});

describe('executionEntryPrice', () => {
  it('u shortu je vstupem prodejní cena', () => {
    expect(executionEntryPrice(exec({ id: 'e', direction: 'Short', buy_price: 27900, sell_price: 28000 }))).toBe(28000);
  });

  it('u longu je vstupem nákupní cena', () => {
    expect(executionEntryPrice(exec({ id: 'e', direction: 'Long', buy_price: 27900, sell_price: 28000 }))).toBe(27900);
  });
});

describe('scoreCandidate', () => {
  it('odmítne jiný instrument', () => {
    expect(scoreCandidate(exec({ id: 'e' }), trade({ id: 't', instrument: 'ES' }))).toBeNull();
  });

  it('odmítne cenu mimo toleranci ticku', () => {
    expect(scoreCandidate(exec({ id: 'e' }), trade({ id: 't', entryPrice: 28000.5 }))).toBeNull();
  });

  it('odmítne obchod mimo časové okno', () => {
    expect(scoreCandidate(exec({ id: 'e' }), trade({ id: 't', entryTime: ms('16:30:00') }))).toBeNull();
  });

  it('deníkový obchod bez direction spáruje (direction je jen bonus)', () => {
    const score = scoreCandidate(exec({ id: 'e' }), trade({ id: 't', direction: undefined }));
    expect(score).not.toBeNull();
  });

  it('shoda výstupní ceny zvýší skóre', () => {
    const bez = scoreCandidate(exec({ id: 'e' }), trade({ id: 't' }))!;
    const s = scoreCandidate(exec({ id: 'e' }), trade({ id: 't', exitPrice: 28020 }))!;
    expect(s).toBeGreaterThan(bez);
  });
});

describe('pairExecutions', () => {
  it('spáruje jednoznačnou dvojici', () => {
    const r = pairExecutions({
      executions: [exec({ id: 'e1' })],
      tradesByAccount: new Map([['acc-app', [trade({ id: 't1' })]]]),
      accountMap,
    });
    expect(r.matched).toHaveLength(1);
    expect(r.matched[0].trade.id).toBe('t1');
    expect(r.unmatched).toHaveLength(0);
  });

  // Filipův edge case: SL vykopne a hned následuje re-entry ve stejné minutě.
  it('rozliší dva vstupy ve stejné minutě podle vstupní ceny', () => {
    const r = pairExecutions({
      executions: [
        exec({ id: 'e-prvni', buy_price: 28000, entry_at: at('17:12:31') }),
        exec({ id: 'e-druhy', buy_price: 27994.25, entry_at: at('17:12:52') }),
      ],
      tradesByAccount: new Map([['acc-app', [
        trade({ id: 't-prvni', entryPrice: 28000, entryTime: ms('17:12:00') }),
        trade({ id: 't-druhy', entryPrice: 27994.25, entryTime: ms('17:12:00') }),
      ]]]),
      accountMap,
    });
    expect(r.matched).toHaveLength(2);
    const byExec = new Map(r.matched.map(m => [m.execution.id, m.trade.id]));
    expect(byExec.get('e-prvni')).toBe('t-prvni');
    expect(byExec.get('e-druhy')).toBe('t-druhy');
    expect(r.ambiguous).toHaveLength(0);
  });

  it('shodná cena i čas → ambiguous, nikdy tichý odhad', () => {
    const r = pairExecutions({
      executions: [exec({ id: 'e1', entry_at: at('16:00:10') })],
      tradesByAccount: new Map([['acc-app', [
        trade({ id: 't1', entryPrice: 28000, entryTime: ms('16:00:00') }),
        trade({ id: 't2', entryPrice: 28000, entryTime: ms('16:00:00') }),
      ]]]),
      accountMap,
    });
    expect(r.matched).toHaveLength(0);
    expect(r.ambiguous).toHaveLength(1);
    expect(r.ambiguous[0].candidates.map(c => c.id).sort()).toEqual(['t1', 't2']);
  });

  it('spáruje short podle prodejní ceny', () => {
    const r = pairExecutions({
      executions: [exec({ id: 'e-short', direction: 'Short', buy_price: 27900, sell_price: 28000 })],
      tradesByAccount: new Map([['acc-app', [trade({ id: 't-short', entryPrice: 28000, exitPrice: 27900 })]]]),
      accountMap,
    });
    expect(r.matched).toHaveLength(1);
    expect(r.matched[0].trade.id).toBe('t-short');
  });

  it('fan-out: každá kopie se spáruje na svém účtu', () => {
    const r = pairExecutions({
      executions: [
        exec({ id: 'e-a', account_ext_id: 100 }),
        exec({ id: 'e-b', account_ext_id: 200 }),
      ],
      tradesByAccount: new Map([
        ['acc-a', [trade({ id: 't-a', accountId: 'acc-a', groupId: 'g1' })]],
        ['acc-b', [trade({ id: 't-b', accountId: 'acc-b', groupId: 'g1' })]],
      ]),
      accountMap: new Map([[100, 'acc-a'], [200, 'acc-b']]),
    });
    expect(r.matched).toHaveLength(2);
    expect(r.matched.map(m => m.trade.id).sort()).toEqual(['t-a', 't-b']);
  });

  it('jeden obchod nespáruje dvě exekuce', () => {
    const r = pairExecutions({
      executions: [
        exec({ id: 'e1', entry_at: at('16:00:05') }),
        exec({ id: 'e2', entry_at: at('16:00:20') }),
      ],
      tradesByAccount: new Map([['acc-app', [trade({ id: 't1' })]]]),
      accountMap,
    });
    expect(r.matched.length + r.ambiguous.length).toBeLessThanOrEqual(1);
    expect(r.matched.length + r.ambiguous.length + r.unmatched.length).toBe(2);
  });

  it('kandidát ambiguous není zároveň přiřazen jiné exekuci', () => {
    const r = pairExecutions({
      executions: [
        exec({ id: 'e-amb', buy_price: 28000.1, direction: 'Long' }),
        exec({ id: 'e-only', buy_price: 27999.9, direction: null }),
      ],
      tradesByAccount: new Map([['acc-app', [
        trade({ id: 't1', entryPrice: 28000, direction: 'Long' }),
        trade({ id: 't2', entryPrice: 28000.2, direction: 'Long' }),
      ]]]),
      accountMap,
    });
    const matchedIds = new Set(r.matched.map(m => String(m.trade.id)));
    const ambiguousIds = new Set(r.ambiguous.flatMap(a => a.candidates.map(c => String(c.id))));
    expect([...ambiguousIds].filter(id => matchedIds.has(id))).toHaveLength(0);
    expect(r.matched).toHaveLength(2);
  });

  it('exekuce bez záznamu v deníku zůstane unmatched', () => {
    const r = pairExecutions({
      executions: [exec({ id: 'e-sam', buy_price: 27000 })],
      tradesByAccount: new Map([['acc-app', [trade({ id: 't1' })]]]),
      accountMap,
    });
    expect(r.unmatched.map(e => e.id)).toEqual(['e-sam']);
  });

  it('respektuje cutoff — starší exekuce se přeskočí', () => {
    const r = pairExecutions({
      executions: [exec({ id: 'e-stary', entry_at: '2026-07-01T16:00:00+02:00' })],
      tradesByAccount: new Map([['acc-app', []]]),
      accountMap,
      cutoffByAccount: new Map([['acc-app', '2026-07-30']]),
    });
    expect(r.skipped).toEqual([{ execution: expect.objectContaining({ id: 'e-stary' }), reason: 'before-cutoff' }]);
    expect(r.unmatched).toHaveLength(0);
  });

  it('nenamapovaný účet se přeskočí, ne spáruje naslepo', () => {
    const r = pairExecutions({
      executions: [exec({ id: 'e1', account_ext_id: 999 })],
      tradesByAccount: new Map([['acc-app', [trade({ id: 't1' })]]]),
      accountMap,
    });
    expect(r.skipped[0].reason).toBe('no-account-map');
    expect(r.matched).toHaveLength(0);
  });
});

describe('groupExecutions', () => {
  it('sloučí fan-out kopie do jednoho obchodu a sečte PnL', () => {
    const groups = groupExecutions([
      exec({ id: 'k1', account_ext_id: 1, pnl: -84 }),
      exec({ id: 'k2', account_ext_id: 2, pnl: -84 }),
      exec({ id: 'k3', account_ext_id: 3, pnl: -84 }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].accountCount).toBe(3);
    expect(groups[0].totalPnl).toBe(-252);
  });

  // copyMultiplier: tentýž obchod jede na jednom účtu 2× a na druhém 4×.
  it('různé množství kopií nerozpadne obchod na víc skupin', () => {
    const groups = groupExecutions([
      exec({ id: 'maly', account_ext_id: 1, qty: 2, pnl: -212 }),
      exec({ id: 'velky', account_ext_id: 2, qty: 4, pnl: -424 }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].accountCount).toBe(2);
    expect(groups[0].totalPnl).toBe(-636);
  });

  it('sloučí kopie s malou latencí a jedním tickem slippage', () => {
    const groups = groupExecutions([
      exec({ id: 'fast', account_ext_id: 1, entry_at: at('16:00:01'), exit_at: at('16:05:01'), buy_price: 28000, sell_price: 28020, group_key: 'old-a' }),
      exec({ id: 'slow', account_ext_id: 2, entry_at: at('16:00:04'), exit_at: at('16:05:04'), buy_price: 28000.25, sell_price: 28020.25, group_key: 'old-b' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].accountCount).toBe(2);
  });

  it('rychlý re-entry na stejném účtu nikdy nesloučí jako fan-out', () => {
    const groups = groupExecutions([
      exec({ id: 'first', account_ext_id: 1, entry_at: at('16:00:01'), exit_at: at('16:05:01') }),
      exec({ id: 'reentry', account_ext_id: 1, entry_at: at('16:00:03'), exit_at: at('16:05:03') }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it('jiná vstupní cena = jiný obchod', () => {
    const groups = groupExecutions([
      exec({ id: 'a', buy_price: 28000 }),
      exec({ id: 'b', buy_price: 27994.25 }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it('řadí od nejnovějšího obchodu', () => {
    const groups = groupExecutions([
      exec({ id: 'stary', entry_at: at('16:00:00'), buy_price: 27900 }),
      exec({ id: 'novy', entry_at: at('17:26:00'), buy_price: 28100 }),
    ]);
    expect(groups[0].sample.id).toBe('novy');
  });
});

describe('describeGroupContext', () => {
  it('počítá odstup mezi obchody, ne mezi kopiemi', () => {
    const groups = groupExecutions([
      exec({ id: 'a1', account_ext_id: 1, buy_price: 27900, entry_at: at('17:11:01') }),
      exec({ id: 'a2', account_ext_id: 2, buy_price: 27900, entry_at: at('17:11:01') }),
      exec({ id: 'b1', account_ext_id: 1, buy_price: 28100, entry_at: at('17:12:31') }),
      exec({ id: 'b2', account_ext_id: 2, buy_price: 28100, entry_at: at('17:12:31') }),
    ]);
    const later = groups.find(g => g.sample.id.startsWith('b'))!;
    expect(describeGroupContext(later, groups).gapSeconds).toBe(90);
  });
});

describe('buildManualLinkOptions', () => {
  it('propojí fan-out skupinu 1:1 podle účtů jedním výběrem', () => {
    const group = groupExecutions([
      exec({ id: 'e1', account_ext_id: 101 }),
      exec({ id: 'e2', account_ext_id: 102 }),
    ])[0];
    const option = buildManualLinkOptions(
      group,
      new Map([[101, 'acc-a'], [102, 'acc-b']]),
      new Map([
        ['acc-a', [trade({ id: 't-a', accountId: 'acc-a', groupId: 'journal-group' })]],
        ['acc-b', [trade({ id: 't-b', accountId: 'acc-b', groupId: 'journal-group' })]],
      ]),
    )[0];

    expect(option.coverage).toBe(2);
    expect(option.pairs.map(pair => [pair.execution.id, pair.trade.id])).toEqual([
      ['e1', 't-a'],
      ['e2', 't-b'],
    ]);
    expect(new Set(option.pairs.map(pair => String(pair.trade.id))).size).toBe(2);
  });

  it('stejný deníkový obchod nikdy nepoužije pro dva účty', () => {
    const group = groupExecutions([
      exec({ id: 'e1', account_ext_id: 101 }),
      exec({ id: 'e2', account_ext_id: 102 }),
    ])[0];
    const option = buildManualLinkOptions(
      group,
      new Map([[101, 'acc-a'], [102, 'acc-b']]),
      new Map([['acc-a', [trade({ id: 'only-one', accountId: 'acc-a' })]]]),
    )[0];

    expect(option.coverage).toBe(1);
    expect(option.totalExecutions).toBe(2);
    expect(option.pairs[0].trade.id).toBe('only-one');
  });
});

describe('parseDurationMinutes', () => {
  it('rozparsuje formát Tradecopie', () => {
    expect(parseDurationMinutes('5min 50sec')).toBe(6);
    expect(parseDurationMinutes('1min 21sec')).toBe(1);
    expect(parseDurationMinutes('57sec')).toBe(1);
    expect(parseDurationMinutes('4min')).toBe(4);
  });

  it('neznámý vstup nevrací nulu, ale undefined', () => {
    expect(parseDurationMinutes(null)).toBeUndefined();
    expect(parseDurationMinutes('')).toBeUndefined();
    expect(parseDurationMinutes('nesmysl')).toBeUndefined();
  });
});

describe('describeExecutionContext', () => {
  it('spočítá odstup od předchozí exekuce a počet ve stejné minutě', () => {
    const all = [
      exec({ id: 'e1', entry_at: at('17:11:01') }),
      exec({ id: 'e2', entry_at: at('17:12:31') }),
      exec({ id: 'e3', entry_at: at('17:12:52') }),
    ];
    expect(describeExecutionContext(all[1], all).gapSeconds).toBe(90);
    expect(describeExecutionContext(all[2], all).gapSeconds).toBe(21);
    expect(describeExecutionContext(all[2], all).sameMinuteCount).toBe(2);
  });

  it('první exekuce nemá odstup', () => {
    const all = [exec({ id: 'e1' })];
    expect(describeExecutionContext(all[0], all).gapSeconds).toBeNull();
  });
});
