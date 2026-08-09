/**
 * České popisky časové osy ve stylu TradingView.
 *
 * Lightweight Charts formátuje časy výhradně v UTC, takže veškerý převod do
 * pražského času musí proběhnout tady. `Intl` s explicitní zónou zvládne i
 * přechody letního času — ruční posun o dvě hodiny by v zimě lhal o hodinu.
 */

export const CHART_TIME_ZONE = 'Europe/Prague';

/** Zkratky podle TradingView v češtině (bez teček, aby se osa nezaplnila). */
const MONTHS_SHORT = ['led', 'úno', 'bře', 'dub', 'kvě', 'čvn', 'čvc', 'srp', 'zář', 'říj', 'lis', 'pro'];
const WEEKDAYS_SHORT = ['ne', 'po', 'út', 'st', 'čt', 'pá', 'so'];

/**
 * Typy značek, které Lightweight Charts posílá do `tickMarkFormatter`.
 * Knihovna je exportuje jen jako číselný enum, takže si je pojmenováváme.
 */
export const CHART_TICK_MARK = {
  year: 0,
  month: 1,
  dayOfMonth: 2,
  time: 3,
  timeWithSeconds: 4,
} as const;

export interface ZonedTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = neděle, jako u `Date.getDay()`. */
  weekday: number;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

const partsCache = new Map<string, Intl.DateTimeFormat>();

const zonedFormatter = (timeZone: string): Intl.DateTimeFormat => {
  const cached = partsCache.get(timeZone);
  if (cached) return cached;
  // Formátovač je drahý na vytvoření a osa ho volá pro každou značku.
  const created = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  partsCache.set(timeZone, created);
  return created;
};

export const zonedTimeParts = (
  unixSeconds: number,
  timeZone: string = CHART_TIME_ZONE,
): ZonedTimeParts => {
  const parts = zonedFormatter(timeZone).formatToParts(new Date(unixSeconds * 1_000));
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find(part => part.type === type)?.value ?? '';
  // `hour12: false` vrací v některých enginech půlnoc jako 24.
  const hour = Number(value('hour')) % 24;
  return {
    year: Number(value('year')),
    month: Number(value('month')),
    day: Number(value('day')),
    hour,
    minute: Number(value('minute')),
    second: Number(value('second')),
    weekday: WEEKDAY_INDEX[value('weekday')] ?? 0,
  };
};

const pad = (value: number) => String(value).padStart(2, '0');

/** `'26` — dvouciferný rok s apostrofem, jak ho píše TradingView. */
const shortYear = (year: number) => `'${pad(year % 100)}`;

/**
 * Formáty data z nastavení grafu. Klíč je vzor, jak ho pojmenovává TradingView,
 * aby se dal uložený výběr přečíst i bez převodní tabulky.
 */
export const CHART_DATE_FORMATS = [
  "qq-'yy",
  'qq-yyyy',
  "dd-MMM-'yy",
  "MMM-'yy",
  'MMM-dd,-yyyy',
  'MMM-d,-yyyy',
  'MMM-yyyy',
  'MMM-dd',
  'dd-MMM',
  'yyyy-MM-dd',
  'yy-MM-dd',
  'yy/MM/dd',
  'yyyy/MM/dd',
  'dd-MM-yyyy',
  'dd-MM-yy',
  'dd/MM/yy',
  'dd/MM/yyyy',
  'MM/dd/yy',
  'MM/dd/yyyy',
] as const;

export type ChartDateFormat = typeof CHART_DATE_FORMATS[number];

export const DEFAULT_CHART_DATE_FORMAT: ChartDateFormat = "dd-MMM-'yy";

export interface ChartTimeFormatOptions {
  timeZone?: string;
  dateFormat?: ChartDateFormat;
  /** Přidá zkratku dne v týdnu před datum, jako `Day of week on labels`. */
  dayOfWeek?: boolean;
  /** 12hodinový čas s dopoledne/odpoledne místo 24hodinového. */
  hour12?: boolean;
}

/** Čtvrtletí 1–4 z čísla měsíce. */
const quarter = (month: number) => Math.floor((month - 1) / 3) + 1;

/** Datum podle zvoleného vzoru; měsíce zůstávají česky. */
export const formatChartDate = (
  parts: ZonedTimeParts,
  format: ChartDateFormat = DEFAULT_CHART_DATE_FORMAT,
): string => {
  const month = MONTHS_SHORT[parts.month - 1] ?? '';
  switch (format) {
    case "qq-'yy": return `Q${quarter(parts.month)} ${shortYear(parts.year)}`;
    case 'qq-yyyy': return `Q${quarter(parts.month)} ${parts.year}`;
    case "MMM-'yy": return `${month} ${shortYear(parts.year)}`;
    case 'MMM-dd,-yyyy': return `${month} ${pad(parts.day)}, ${parts.year}`;
    case 'MMM-d,-yyyy': return `${month} ${parts.day}, ${parts.year}`;
    case 'MMM-yyyy': return `${month} ${parts.year}`;
    case 'MMM-dd': return `${month} ${pad(parts.day)}`;
    case 'dd-MMM': return `${parts.day}. ${month}`;
    case 'yyyy-MM-dd': return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
    case 'yy-MM-dd': return `${pad(parts.year % 100)}-${pad(parts.month)}-${pad(parts.day)}`;
    case 'yy/MM/dd': return `${pad(parts.year % 100)}/${pad(parts.month)}/${pad(parts.day)}`;
    case 'yyyy/MM/dd': return `${parts.year}/${pad(parts.month)}/${pad(parts.day)}`;
    case 'dd-MM-yyyy': return `${pad(parts.day)}-${pad(parts.month)}-${parts.year}`;
    case 'dd-MM-yy': return `${pad(parts.day)}-${pad(parts.month)}-${pad(parts.year % 100)}`;
    case 'dd/MM/yy': return `${pad(parts.day)}/${pad(parts.month)}/${pad(parts.year % 100)}`;
    case 'dd/MM/yyyy': return `${pad(parts.day)}/${pad(parts.month)}/${parts.year}`;
    case 'MM/dd/yy': return `${pad(parts.month)}/${pad(parts.day)}/${pad(parts.year % 100)}`;
    case 'MM/dd/yyyy': return `${pad(parts.month)}/${pad(parts.day)}/${parts.year}`;
    default: return `${parts.day}. ${month} ${shortYear(parts.year)}`;
  }
};

/** Hodiny a minuty ve zvoleném 12/24hodinovém formátu. */
export const formatChartClock = (
  parts: ZonedTimeParts,
  options: { hour12?: boolean; withSeconds?: boolean } = {},
): string => {
  const { hour12 = false, withSeconds = false } = options;
  const seconds = withSeconds ? `:${pad(parts.second)}` : '';
  if (!hour12) return `${pad(parts.hour)}:${pad(parts.minute)}${seconds}`;
  const suffix = parts.hour < 12 ? 'dop.' : 'odp.';
  const hour = parts.hour % 12 === 0 ? 12 : parts.hour % 12;
  return `${hour}:${pad(parts.minute)}${seconds} ${suffix}`;
};

/**
 * Popisek značky na časové ose. Knihovna sama rozhodne, jestli jde o rok,
 * měsíc, den nebo čas — my jen dodáme české pojmenování.
 */
export const chartAxisTickLabel = (
  unixSeconds: number,
  tickMarkType: number,
  options: ChartTimeFormatOptions = {},
): string => {
  const { timeZone = CHART_TIME_ZONE, hour12 = false } = options;
  const parts = zonedTimeParts(unixSeconds, timeZone);
  const month = MONTHS_SHORT[parts.month - 1] ?? '';
  switch (tickMarkType) {
    case CHART_TICK_MARK.year:
      return String(parts.year);
    case CHART_TICK_MARK.month:
      return `${month} ${shortYear(parts.year)}`;
    case CHART_TICK_MARK.dayOfMonth:
      return `${parts.day}. ${month}`;
    case CHART_TICK_MARK.timeWithSeconds:
      return formatChartClock(parts, { hour12, withSeconds: true });
    default:
      return formatChartClock(parts, { hour12 });
  }
};

/**
 * Popisek pod křížovým kurzorem: `pá 7. srp '26  22:20`.
 *
 * Na denním a vyšším timeframe nemá čas co říct (svíčka pokrývá celý den),
 * takže se vynechá — stejně jako v TradingView.
 */
export const chartCrosshairTimeLabel = (
  unixSeconds: number,
  options: ChartTimeFormatOptions & { withTime?: boolean } = {},
): string => {
  const {
    withTime = true,
    timeZone = CHART_TIME_ZONE,
    dateFormat = DEFAULT_CHART_DATE_FORMAT,
    dayOfWeek = true,
    hour12 = false,
  } = options;
  const parts = zonedTimeParts(unixSeconds, timeZone);
  const weekday = dayOfWeek ? `${WEEKDAYS_SHORT[parts.weekday]} ` : '';
  const date = `${weekday}${formatChartDate(parts, dateFormat)}`;
  return withTime ? `${date}  ${formatChartClock(parts, { hour12 })}` : date;
};
