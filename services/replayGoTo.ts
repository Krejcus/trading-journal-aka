import type { MarketCandle } from './marketData';

/**
 * "Go To" pro Bar Replay — skok kurzoru na nejbližší budoucí událost.
 *
 * Chování je odpozorované z FX Replay: skok NEskočí na cílový čas samotný, ale
 * na poslední svíčku PŘED ním. Otevření session pak uživatel vidí naživo místo
 * toho, aby ho zmeškal (v FX Replay se to projeví jako skok na 09:59:59 při
 * cíli 10:00).
 *
 * Časy jsou zadané v pásmu, které má uživatel nastavené na grafu — co vidí na
 * časové ose, to zadá do nastavení. Převod jde přes Intl (stejný vzor jako
 * marketData/liquidityLevels), takže letní čas daného pásma sedí sám.
 *
 * POZOR: cíle jsou tím pádem ukotvené v pásmu grafu, ne v New Yorku. Ve dnech,
 * kdy je americký a evropský přechod na letní čas rozjetý (dva týdny v březnu,
 * týden v listopadu), padne pražských 15:45 na 10:45 NY místo 09:45 NY.
 */

export type ReplayGoToTargetId =
  | 'session_asian'
  | 'session_london'
  | 'session_newyork'
  | 'day_open'
  | 'sb_london'
  | 'sb_ny_am'
  | 'sb_ny_pm'
  | 'price'
  | 'future_date';

export type ReplayGoToWeekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface ReplayGoToTimeSetting {
  /** Hodina v New Yorku, 0–23. */
  hour: number;
  /** Minuta v New Yorku, 0–59. */
  minute: number;
}

export interface ReplayGoToSettings {
  times: Record<Exclude<ReplayGoToTargetId, 'price' | 'future_date'>, ReplayGoToTimeSetting>;
  /** Cíle označené hvězdičkou — jen ty se nabízejí v rychlém menu. */
  favorites: ReplayGoToTargetId[];
  /** Dny týdne (0 = neděle), které skok přeskočí. */
  daysToSkip: ReplayGoToWeekday[];
}

export interface ReplayGoToTargetDefinition {
  id: ReplayGoToTargetId;
  label: string;
  /** Krátký název do rychlého menu — FX Replay tam píše "SB London" apod. */
  shortLabel: string;
  group: 'session' | 'day' | 'silver_bullet' | 'manual';
}

export const REPLAY_GO_TO_TARGETS: ReplayGoToTargetDefinition[] = [
  { id: 'session_asian', label: 'Začátek asijské session', shortLabel: 'Asian', group: 'session' },
  { id: 'session_london', label: 'Začátek londýnské session', shortLabel: 'London', group: 'session' },
  { id: 'session_newyork', label: 'Začátek newyorské session', shortLabel: 'New York', group: 'session' },
  { id: 'day_open', label: 'Otevření dalšího dne', shortLabel: 'Day Open', group: 'day' },
  { id: 'sb_london', label: 'Silver Bullet London', shortLabel: 'SB London', group: 'silver_bullet' },
  { id: 'sb_ny_am', label: 'Silver Bullet NY AM', shortLabel: 'SB New York AM', group: 'silver_bullet' },
  { id: 'sb_ny_pm', label: 'Silver Bullet NY PM', shortLabel: 'SB New York PM', group: 'silver_bullet' },
  { id: 'price', label: 'Cena', shortLabel: 'Cena', group: 'manual' },
  { id: 'future_date', label: 'Konkrétní datum', shortLabel: 'Datum', group: 'manual' },
];

/**
 * Kanonické časy, jak je definuje ICT a jak je má FX Replay v "Reset to
 * defaults" — vždy v New Yorku. Slouží jen k odvození výchozích hodnot;
 * jakmile je uživatel jednou uvidí ve svém pásmu, jsou to už jeho čísla.
 */
const NY_ANCHOR_TIMES: ReplayGoToSettings['times'] = {
  session_asian: { hour: 19, minute: 0 },
  session_london: { hour: 3, minute: 0 },
  session_newyork: { hour: 7, minute: 0 },
  day_open: { hour: 17, minute: 0 },
  sb_london: { hour: 4, minute: 0 },
  sb_ny_am: { hour: 9, minute: 45 },
  sb_ny_pm: { hour: 13, minute: 0 },
};

const DEFAULT_FAVORITES: ReplayGoToTargetId[] = ['sb_ny_am', 'sb_ny_pm', 'sb_london'];

/** Pásmo, ve kterém běží graf, když si session žádné neuloží. */
export const DEFAULT_REPLAY_GO_TO_TIME_ZONE = 'Europe/Prague';

const NY_TIME_ZONE = 'America/New_York';

/**
 * Výchozí nastavení přepočtené do pásma grafu — v Praze tedy SB NY AM vyjde
 * jako 15:45, ne 09:45. Bez toho by uživatel při prvním otevření viděl časy,
 * které na jeho časové ose nikde nejsou.
 */
export const defaultReplayGoToSettings = (
  timeZone: string,
  referenceUnixSeconds: number = Math.floor(Date.now() / 1_000),
): ReplayGoToSettings => {
  const day = zonedClockParts(referenceUnixSeconds, NY_TIME_ZONE);
  const times = {} as ReplayGoToSettings['times'];
  (Object.keys(NY_ANCHOR_TIMES) as (keyof ReplayGoToSettings['times'])[]).forEach(key => {
    const anchor = NY_ANCHOR_TIMES[key];
    const unix = wallClockToUnix(day.year, day.month, day.day, anchor.hour, anchor.minute, NY_TIME_ZONE);
    const local = zonedClockParts(unix, timeZone);
    times[key] = { hour: local.hour, minute: local.minute };
  });
  return { times, favorites: [...DEFAULT_FAVORITES], daysToSkip: [] };
};

/** Fallback pro volající bez znalosti pásma (merge uloženého stavu, testy). */
export const DEFAULT_REPLAY_GO_TO_SETTINGS: ReplayGoToSettings = {
  times: { ...NY_ANCHOR_TIMES },
  favorites: [...DEFAULT_FAVORITES],
  daysToSkip: [],
};

const formatters = new Map<string, Intl.DateTimeFormat>();

const zoneFormatter = (timeZone: string): Intl.DateTimeFormat => {
  const cached = formatters.get(timeZone);
  if (cached) return cached;
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  };
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', { ...options, timeZone });
  } catch {
    // Neznámé pásmo z uloženého nastavení nesmí shodit skok.
    formatter = new Intl.DateTimeFormat('en-US', { ...options, timeZone: DEFAULT_REPLAY_GO_TO_TIME_ZONE });
  }
  formatters.set(timeZone, formatter);
  return formatter;
};

const WEEKDAY_INDEX: Record<string, ReplayGoToWeekday> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

export interface ZonedClockParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: ReplayGoToWeekday;
}

/** Rozloží unixový čas na složky kalendáře daného pásma (včetně jeho DST). */
export const zonedClockParts = (unixSeconds: number, timeZone: string): ZonedClockParts => {
  const parts = Object.fromEntries(
    zoneFormatter(timeZone).formatToParts(new Date(unixSeconds * 1_000)).map(part => [part.type, part.value]),
  ) as Record<string, string>;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAY_INDEX[parts.weekday] ?? 0,
  };
};

/**
 * Unixový čas stěnové hodiny v daném pásmu.
 *
 * Intl umí jen směr UTC→zóna, takže opačný převod dělá dvoukrokové doladění:
 * z odhadu se změří skutečný offset a ten se odečte. Druhá iterace ošetří skok
 * přes hranici DST, kde první odhad použije ještě starý offset.
 */
export const wallClockToUnix = (
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number => {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0) / 1_000;
  let result = utcGuess;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const actual = zonedClockParts(result, timeZone);
    const actualAsUtc = Date.UTC(
      actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, 0,
    ) / 1_000;
    const drift = actualAsUtc - utcGuess;
    if (drift === 0) break;
    result -= drift;
  }
  return result;
};

const DAY_SECONDS = 86_400;

/**
 * Nejbližší budoucí okamžik, kdy hodiny v daném pásmu ukážou zadaný čas.
 *
 * Striktně budoucí: shoda na aktuální sekundě se přeskočí na další den, jinak
 * by opakovaný skok na stejný cíl zůstal stát na místě.
 */
export const nextTimeOccurrence = (
  fromUnixSeconds: number,
  time: ReplayGoToTimeSetting,
  timeZone: string,
  daysToSkip: ReplayGoToWeekday[] = [],
): number | null => {
  if (!Number.isFinite(fromUnixSeconds)) return null;
  const skip = new Set(daysToSkip);
  // Sedm dní by stačilo, kdyby nebyly přeskakované dny — s nimi je strop 14 dní
  // pojistkou proti zacyklení, když si uživatel odškrtne celý týden.
  for (let dayOffset = 0; dayOffset <= 14; dayOffset += 1) {
    const probe = zonedClockParts(fromUnixSeconds + dayOffset * DAY_SECONDS, timeZone);
    const candidate = wallClockToUnix(probe.year, probe.month, probe.day, time.hour, time.minute, timeZone);
    if (candidate <= fromUnixSeconds) continue;
    if (skip.has(zonedClockParts(candidate, timeZone).weekday)) continue;
    return candidate;
  }
  return null;
};

const upperBound = (candles: MarketCandle[], unixSeconds: number): number => {
  let low = 0;
  let high = candles.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (candles[middle].time <= unixSeconds) low = middle + 1;
    else high = middle;
  }
  return low;
};

/**
 * Svíčka, na které replay po skoku zastaví: poslední PŘED cílovým časem.
 *
 * Cílová svíčka tak zůstane neodhalená a uživatel ji uvidí vzniknout — to je
 * celý smysl skoku na začátek session.
 */
export const replayCandleBeforeTarget = (
  candles: MarketCandle[],
  targetTime: number,
): number | null => {
  if (candles.length === 0 || !Number.isFinite(targetTime)) return null;
  const index = upperBound(candles, targetTime - 1) - 1;
  return index >= 0 ? candles[index].time : null;
};

/**
 * První svíčka po kurzoru, jejíž rozpětí obsahuje zadanou cenu.
 *
 * Zastaví se NA ní, ne před ní: u cenového cíle je zajímavý právě ten bar, kde
 * se úroveň protla.
 */
export const nextReplayCandleAtPrice = (
  candles: MarketCandle[],
  cursorTime: number,
  price: number,
): number | null => {
  if (candles.length === 0 || !Number.isFinite(price)) return null;
  for (let index = upperBound(candles, cursorTime); index < candles.length; index += 1) {
    const candle = candles[index];
    if (candle.low <= price && price <= candle.high) return candle.time;
  }
  return null;
};

export type ReplayGoToRequest =
  | { kind: 'time'; target: Exclude<ReplayGoToTargetId, 'price' | 'future_date'> }
  | { kind: 'price'; price: number }
  | { kind: 'date'; unixSeconds: number };

export interface ReplayGoToResolution {
  /** Čas svíčky, na kterou se má kurzor přesunout. */
  cursorTime: number;
  /** Cíl, o který uživatel žádal — pro hlášku ve stavovém řádku. */
  targetTime: number;
}

export type ReplayGoToFailure =
  | 'no_candles'
  | 'target_beyond_data'
  | 'price_not_reached'
  | 'invalid_target';

/**
 * Diskriminátor je řetězec, ne boolean: projekt běží bez `strict`, a bez
 * `strictNullChecks` TypeScript nezúží union podle `ok: true | false`.
 */
export type ReplayGoToResult =
  | { kind: 'ok'; value: ReplayGoToResolution }
  | { kind: 'error'; reason: ReplayGoToFailure };

/**
 * Spočítá, kam replay skočí. Vrací buď cíl, nebo důvod, proč skok nejde —
 * volající tak může uživateli říct pravdu místo tichého nicnedělání.
 */
export const resolveReplayGoTo = (
  request: ReplayGoToRequest,
  options: {
    candles: MarketCandle[];
    cursorTime: number | null;
    settings: ReplayGoToSettings;
    timeZone: string;
    /**
     * Konec dat, která session vůbec může mít (ne konec už načtených svíček).
     * Backtest dotahuje historii po blocích, takže `candles` skoro vždy končí
     * dřív než cíl — bez tohoto rozlišení by Go To fungovalo jen uvnitř
     * posledního načteného bloku. Když chybí, bere se konec `candles`.
     */
    dataEndTime?: number | null;
  },
): ReplayGoToResult => {
  const { candles, settings } = options;
  if (candles.length === 0) return { kind: 'error', reason: 'no_candles' };
  const cursorTime = options.cursorTime ?? candles[0].time;
  const lastCandleTime = candles[candles.length - 1].time;
  const dataEndTime = Number.isFinite(options.dataEndTime as number)
    ? Math.max(options.dataEndTime as number, lastCandleTime)
    : lastCandleTime;

  if (request.kind === 'price') {
    const found = nextReplayCandleAtPrice(candles, cursorTime, request.price);
    if (found === null) return { kind: 'error', reason: 'price_not_reached' };
    return { kind: 'ok', value: { cursorTime: found, targetTime: found } };
  }

  const targetTime = request.kind === 'date'
    ? request.unixSeconds
    : nextTimeOccurrence(cursorTime, settings.times[request.target], options.timeZone, settings.daysToSkip);

  if (targetTime === null || !Number.isFinite(targetTime)) return { kind: 'error', reason: 'invalid_target' };
  if (targetTime <= cursorTime) return { kind: 'error', reason: 'invalid_target' };

  // Až za koncem celé session — dál se nedostaneme ani po dotažení dat.
  if (targetTime > dataEndTime) return { kind: 'error', reason: 'target_beyond_data' };

  // Když cíl padne do už načtených dat, kurzor sedne na konkrétní svíčku —
  // zbytek replay logiky s časy skutečných barů počítá. Když je cíl až za
  // posledním načteným barem, posuň kurzor na sekundu před cíl: odhalí se
  // všechno dostupné a prefetch zbytek dotáhne. Zastavit se na hranici bloku
  // by znamenalo, že uživatel musí skákat znovu a znovu.
  const landing = targetTime <= lastCandleTime ? replayCandleBeforeTarget(candles, targetTime) : null;
  const nextCursor = landing !== null && landing > cursorTime ? landing : targetTime - 1;
  if (nextCursor <= cursorTime) return { kind: 'error', reason: 'invalid_target' };

  return { kind: 'ok', value: { cursorTime: nextCursor, targetTime } };
};

export const REPLAY_GO_TO_FAILURE_MESSAGES: Record<ReplayGoToFailure, string> = {
  no_candles: 'Graf zatím nemá načtená data',
  target_beyond_data: 'Cíl leží za koncem načtených dat',
  price_not_reached: 'Cena už se v načtených datech neobjevila',
  invalid_target: 'Cíl nejde spočítat',
};

const SETTINGS_STORAGE_KEY = 'alphatrade.replay-go-to.v1';

const isWeekday = (value: unknown): value is ReplayGoToWeekday =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 6;

const isTargetId = (value: unknown): value is ReplayGoToTargetId =>
  typeof value === 'string' && REPLAY_GO_TO_TARGETS.some(target => target.id === value);

/** Sloučí uložený stav s defaulty — starší snapshot bez nových cílů tím přežije. */
export const mergeReplayGoToSettings = (
  raw: unknown,
  base: ReplayGoToSettings = DEFAULT_REPLAY_GO_TO_SETTINGS,
): ReplayGoToSettings => {
  if (!raw || typeof raw !== 'object') return base;
  const value = raw as Partial<ReplayGoToSettings>;
  const times = { ...base.times };
  if (value.times && typeof value.times === 'object') {
    (Object.keys(times) as (keyof typeof times)[]).forEach(key => {
      const candidate = (value.times as Record<string, unknown>)[key] as ReplayGoToTimeSetting | undefined;
      if (!candidate || typeof candidate !== 'object') return;
      const hour = Number(candidate.hour);
      const minute = Number(candidate.minute);
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) return;
      if (!Number.isInteger(minute) || minute < 0 || minute > 59) return;
      times[key] = { hour, minute };
    });
  }
  return {
    times,
    favorites: Array.isArray(value.favorites) ? value.favorites.filter(isTargetId) : base.favorites,
    daysToSkip: Array.isArray(value.daysToSkip) ? value.daysToSkip.filter(isWeekday) : base.daysToSkip,
  };
};

export const loadReplayGoToSettings = (timeZone: string): ReplayGoToSettings => {
  const base = defaultReplayGoToSettings(timeZone);
  try {
    return mergeReplayGoToSettings(JSON.parse(window.localStorage.getItem(SETTINGS_STORAGE_KEY) ?? 'null'), base);
  } catch {
    return base;
  }
};

export const saveReplayGoToSettings = (settings: ReplayGoToSettings): void => {
  try {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Persistence nastavení je volitelná.
  }
};

export const formatClockTime = (time: ReplayGoToTimeSetting): string =>
  `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`;

export const parseClockTime = (value: string): ReplayGoToTimeSetting | null => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
};
