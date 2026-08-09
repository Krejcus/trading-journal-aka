import { describe, it, expect } from 'vitest';
import {
  DEFAULT_REPLAY_GO_TO_SETTINGS,
  defaultReplayGoToSettings,
  mergeReplayGoToSettings,
  nextTimeOccurrence,
  nextReplayCandleAtPrice,
  parseClockTime,
  replayCandleBeforeTarget,
  resolveReplayGoTo,
  wallClockToUnix,
  zonedClockParts,
} from '../services/replayGoTo';

const NY = 'America/New_York';
const PRAHA = 'Europe/Prague';
import type { MarketCandle } from '../services/marketData';

const at = (iso: string) => Math.floor(Date.parse(iso) / 1_000);

/** Minutové svíčky od `startIso`, `count` kusů, s volitelným cenovým profilem. */
const candles = (
  startIso: string,
  count: number,
  price: (index: number) => { high: number; low: number } = () => ({ high: 101, low: 99 }),
): MarketCandle[] => {
  const start = at(startIso);
  return Array.from({ length: count }, (_, index) => {
    const { high, low } = price(index);
    return {
      time: start + index * 60,
      open: (high + low) / 2, high, low, close: (high + low) / 2, volume: 1,
    } as MarketCandle;
  });
};

describe('wallClockToUnix — převod stěnové hodiny', () => {
  it('zimní čas (EST, UTC−5): 09:45 NY = 14:45 UTC', () => {
    expect(wallClockToUnix(2021, 2, 25, 9, 45, NY)).toBe(at('2021-02-25T14:45:00Z'));
  });

  it('letní čas (EDT, UTC−4): 09:45 NY = 13:45 UTC', () => {
    expect(wallClockToUnix(2021, 7, 15, 9, 45, NY)).toBe(at('2021-07-15T13:45:00Z'));
  });

  it('den přechodu na letní čas: 04:00 NY = 08:00 UTC', () => {
    // 14. 3. 2021 ve 02:00 EST se posunulo na 03:00 EDT.
    expect(wallClockToUnix(2021, 3, 14, 4, 0, NY)).toBe(at('2021-03-14T08:00:00Z'));
  });

  it('je inverzní k zonedClockParts', () => {
    const unix = wallClockToUnix(2021, 11, 7, 13, 0, NY);
    const parts = zonedClockParts(unix, NY);
    expect([parts.year, parts.month, parts.day, parts.hour, parts.minute]).toEqual([2021, 11, 7, 13, 0]);
  });
});

describe('nextTimeOccurrence — nejbližší budoucí výskyt', () => {
  const sbLondon = { hour: 4, minute: 0 };

  it('najde cíl ještě dnes, když je před ním', () => {
    const from = at('2021-02-25T01:00:00Z'); // 20:00 NY 24. 2.
    expect(nextTimeOccurrence(from, sbLondon, NY)).toBe(at('2021-02-25T09:00:00Z')); // 04:00 NY
  });

  it('přeskočí na další den, když už čas dnes minul', () => {
    const from = at('2021-02-25T10:00:00Z'); // 05:00 NY — 04:00 je za námi
    expect(nextTimeOccurrence(from, sbLondon, NY)).toBe(at('2021-02-26T09:00:00Z'));
  });

  it('shoda na sekundu se nepočítá — jinak by skok stál na místě', () => {
    const exact = at('2021-02-25T09:00:00Z');
    expect(nextTimeOccurrence(exact, sbLondon, NY)).toBe(at('2021-02-26T09:00:00Z'));
  });

  it('přeskočí zakázané dny v týdnu', () => {
    const friday = at('2021-02-26T10:00:00Z'); // pátek 05:00 NY
    // sobota (6) i neděle (0) přeskočené → padne na pondělí
    expect(nextTimeOccurrence(friday, sbLondon, NY, [6, 0])).toBe(at('2021-03-01T09:00:00Z'));
  });

  it('drží se stěnové hodiny přes přechod na letní čas', () => {
    const before = at('2021-03-13T10:00:00Z'); // sobota 05:00 NY
    const next = nextTimeOccurrence(before, sbLondon, NY);
    // Neděle 14. 3. je 04:00 NY už v EDT → 08:00 UTC, ne 09:00.
    expect(next).toBe(at('2021-03-14T08:00:00Z'));
    expect(zonedClockParts(next!, NY).hour).toBe(4);
  });

  it('vrátí null, když jsou přeskočené všechny dny v týdnu', () => {
    const from = at('2021-02-25T01:00:00Z');
    expect(nextTimeOccurrence(from, sbLondon, NY, [0, 1, 2, 3, 4, 5, 6])).toBeNull();
  });
});

describe('replayCandleBeforeTarget — přistání před cílem', () => {
  const series = candles('2021-02-25T08:50:00Z', 20); // 08:50–09:09 UTC

  it('zastaví na poslední svíčce před cílem, ne na cílové', () => {
    const target = at('2021-02-25T09:00:00Z');
    expect(replayCandleBeforeTarget(series, target)).toBe(at('2021-02-25T08:59:00Z'));
  });

  it('vrátí null, když je cíl před začátkem dat', () => {
    expect(replayCandleBeforeTarget(series, at('2021-02-25T08:00:00Z'))).toBeNull();
  });
});

describe('nextReplayCandleAtPrice — cenový cíl', () => {
  it('najde první svíčku, jejíž rozpětí obsahuje cenu', () => {
    const series = candles('2021-02-25T08:00:00Z', 10, index => ({
      high: 100 + index, low: 99 + index,
    }));
    const found = nextReplayCandleAtPrice(series, series[0].time, 105.5);
    expect(found).toBe(series[6].time); // high 106, low 105
  });

  it('vrátí null, když se cena už neobjeví', () => {
    const series = candles('2021-02-25T08:00:00Z', 5);
    expect(nextReplayCandleAtPrice(series, series[0].time, 500)).toBeNull();
  });

  it('hledá jen dopředu od kurzoru', () => {
    const series = candles('2021-02-25T08:00:00Z', 10, index => ({
      high: index === 1 ? 200 : 101, low: index === 1 ? 199 : 99,
    }));
    expect(nextReplayCandleAtPrice(series, series[5].time, 199.5)).toBeNull();
  });
});

describe('resolveReplayGoTo', () => {
  const settings = DEFAULT_REPLAY_GO_TO_SETTINGS;
  // 08:00–10:00 UTC 25. 2. 2021 = 03:00–05:00 NY, pokrývá SB London (04:00 NY).
  const series = candles('2021-02-25T08:00:00Z', 121);

  it('skočí na svíčku před začátkem SB London', () => {
    const result = resolveReplayGoTo(
      { kind: 'time', target: 'sb_london' },
      { candles: series, cursorTime: at('2021-02-25T08:10:00Z'), settings, timeZone: NY },
    );
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.targetTime).toBe(at('2021-02-25T09:00:00Z'));
    expect(result.value.cursorTime).toBe(at('2021-02-25T08:59:00Z'));
  });

  it('odmítne cíl za koncem načtených dat', () => {
    const result = resolveReplayGoTo(
      { kind: 'time', target: 'sb_ny_pm' }, // 13:00 NY = 18:00 UTC, mimo data
      { candles: series, cursorTime: series[0].time, settings, timeZone: NY },
    );
    expect(result).toEqual({ kind: 'error', reason: 'target_beyond_data' });
  });

  it('odmítne skok bez dat', () => {
    const result = resolveReplayGoTo(
      { kind: 'time', target: 'sb_london' },
      { candles: [], cursorTime: null, settings, timeZone: NY },
    );
    expect(result).toEqual({ kind: 'error', reason: 'no_candles' });
  });

  it('cenový cíl zastaví přímo na protínající svíčce', () => {
    const priced = candles('2021-02-25T08:00:00Z', 10, index => ({
      high: 100 + index, low: 99 + index,
    }));
    const result = resolveReplayGoTo(
      { kind: 'price', price: 104.5 },
      { candles: priced, cursorTime: priced[0].time, settings, timeZone: NY },
    );
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.cursorTime).toBe(priced[5].time);
  });

  it('skočí i za poslední načtený bar, když je cíl uvnitř session', () => {
    // Backtest dotahuje data po blocích: cíl (SB NY PM, 18:00 UTC) je za koncem
    // načtených svíček, ale session sahá dál — skok musí projít.
    const result = resolveReplayGoTo(
      { kind: 'time', target: 'sb_ny_pm' },
      {
        candles: series,
        cursorTime: series[0].time,
        settings,
        timeZone: NY,
        dataEndTime: at('2021-02-26T00:00:00Z'),
      },
    );
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.targetTime).toBe(at('2021-02-25T18:00:00Z'));
    // Kurzor sedne sekundu před cíl; prefetch zbytek dotáhne.
    expect(result.value.cursorTime).toBe(at('2021-02-25T18:00:00Z') - 1);
  });

  it('odmítne cíl až za koncem celé session', () => {
    const result = resolveReplayGoTo(
      { kind: 'time', target: 'sb_ny_pm' },
      {
        candles: series,
        cursorTime: series[0].time,
        settings,
        timeZone: NY,
        dataEndTime: at('2021-02-25T12:00:00Z'),
      },
    );
    expect(result).toEqual({ kind: 'error', reason: 'target_beyond_data' });
  });

  it('pásmo grafu rozhoduje — stejný čas míří jinam v Praze než v NY', () => {
    const pragueSettings = { ...settings, times: { ...settings.times, sb_london: { hour: 10, minute: 0 } } };
    const result = resolveReplayGoTo(
      { kind: 'time', target: 'sb_london' },
      { candles: series, cursorTime: at('2021-02-25T08:10:00Z'), settings: pragueSettings, timeZone: PRAHA },
    );
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    // 10:00 v Praze (v únoru UTC+1) = 09:00 UTC — stejný okamžik jako 04:00 NY.
    expect(result.value.targetTime).toBe(at('2021-02-25T09:00:00Z'));
  });

  it('nepohne se dozadu, když cíl leží před kurzorem', () => {
    const result = resolveReplayGoTo(
      { kind: 'date', unixSeconds: at('2021-02-25T08:05:00Z') },
      { candles: series, cursorTime: at('2021-02-25T09:30:00Z'), settings, timeZone: NY },
    );
    expect(result).toEqual({ kind: 'error', reason: 'invalid_target' });
  });
});

describe('defaultReplayGoToSettings — výchozí časy v pásmu grafu', () => {
  // Referenční den v zimě: NY je UTC−5, Praha UTC+1 → rozdíl 6 hodin.
  const winter = at('2021-02-25T12:00:00Z');

  it('v Praze posune newyorské kotvy o šest hodin', () => {
    const prague = defaultReplayGoToSettings(PRAHA, winter);
    expect(prague.times.sb_ny_am).toEqual({ hour: 15, minute: 45 });
    expect(prague.times.sb_ny_pm).toEqual({ hour: 19, minute: 0 });
    expect(prague.times.sb_london).toEqual({ hour: 10, minute: 0 });
  });

  it('v New Yorku nechá kanonické ICT časy beze změny', () => {
    const ny = defaultReplayGoToSettings(NY, winter);
    expect(ny.times.sb_ny_am).toEqual({ hour: 9, minute: 45 });
    expect(ny.times.session_london).toEqual({ hour: 3, minute: 0 });
  });

  it('neznámé pásmo neshodí výpočet', () => {
    expect(() => defaultReplayGoToSettings('Nikde/Nic', winter)).not.toThrow();
  });
});

describe('mergeReplayGoToSettings — odolnost uloženého stavu', () => {
  it('doplní defaulty pro chybějící klíče', () => {
    const merged = mergeReplayGoToSettings({ favorites: ['sb_london'] });
    expect(merged.favorites).toEqual(['sb_london']);
    expect(merged.times.sb_ny_am).toEqual({ hour: 9, minute: 45 });
  });

  it('zahodí nesmyslné časy místo aby je přijal', () => {
    const merged = mergeReplayGoToSettings({ times: { sb_london: { hour: 99, minute: 0 } } });
    expect(merged.times.sb_london).toEqual({ hour: 4, minute: 0 });
  });

  it('přežije poškozený vstup', () => {
    expect(mergeReplayGoToSettings(null)).toEqual(DEFAULT_REPLAY_GO_TO_SETTINGS);
    expect(mergeReplayGoToSettings('nesmysl')).toEqual(DEFAULT_REPLAY_GO_TO_SETTINGS);
  });

  it('vyfiltruje neznámé favority a dny', () => {
    const merged = mergeReplayGoToSettings({ favorites: ['nope', 'sb_london'], daysToSkip: [6, 42] });
    expect(merged.favorites).toEqual(['sb_london']);
    expect(merged.daysToSkip).toEqual([6]);
  });
});

describe('parseClockTime', () => {
  it('přijme HH:MM', () => {
    expect(parseClockTime('09:45')).toEqual({ hour: 9, minute: 45 });
    expect(parseClockTime('4:00')).toEqual({ hour: 4, minute: 0 });
  });

  it('odmítne nesmysly', () => {
    expect(parseClockTime('25:00')).toBeNull();
    expect(parseClockTime('09:60')).toBeNull();
    expect(parseClockTime('nope')).toBeNull();
  });
});
