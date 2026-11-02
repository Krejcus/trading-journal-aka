/**
 * Upozornění na cenu (Filip 2. 11. 2026, náhled EkQateEvNCynqk8rLyQUrr):
 * čára se zvonečkem v grafu, založení z plusu u crosshairu, výběr, posun,
 * nastavení. Upozornění jen hlásí — nikdy nic neobchoduje a nevstupuje do
 * kopírky, rizika ani day locku.
 *
 * Úložiště je zatím jen v tomto zařízení (`localStorage`). Hlídání ceny
 * (Mac worker z IBKR), sdílení PC ↔ telefon a doručení (APNs, web push)
 * napojí datová vrstva — viz `PriceAlertStore`, který stačí nahradit.
 */

export type PriceAlertCondition = 'cross' | 'up' | 'down';
export type PriceAlertFrequency = 'once' | 'every';
export type PriceAlertExpiry = 'session' | 'gtc';
export type PriceAlertLineWidth = 'thin' | 'thick' | 'none';
export type PriceAlertLineStyle = 'solid' | 'dashed' | 'dotted';

export interface PriceAlertChannels {
  /** Běžná notifikace iOS (APNs), i při zamčeném telefonu. */
  phone: boolean;
  /** Hlas: telefon i PC přečtou „MNQ nahoru přes 21 480“. */
  voice: boolean;
  /** PC: karta vlevo dole jako u obchodů, push v prohlížeči. */
  pc: boolean;
  sound: boolean;
}

export interface PriceAlertStyle {
  width: PriceAlertLineWidth;
  style: PriceAlertLineStyle;
  color: string;
}

export interface PriceAlert {
  id: string;
  /** Kořen kontraktu (MNQ a NQ mají stejnou cenu indexu). */
  symbol: string;
  price: number;
  condition: PriceAlertCondition;
  frequency: PriceAlertFrequency;
  expiry: PriceAlertExpiry;
  line: PriceAlertStyle;
  channels: PriceAlertChannels;
  note: string;
  createdAt: number;
  updatedAt: number;
}

/** Nastavení, které dostane nové upozornění (naposledy uložené). */
export type PriceAlertDefaults = Pick<PriceAlert, 'frequency' | 'expiry' | 'line' | 'channels'>;

export const PRICE_ALERT_COLORS = ['#f5b53d', '#60a5fa', '#2dd4bf', '#f472b6', '#a78bfa', '#e2e8f0'] as const;
export const PRICE_ALERT_COLOR_NAMES: Record<(typeof PRICE_ALERT_COLORS)[number], string> = {
  '#f5b53d': 'Jantarová', '#60a5fa': 'Modrá', '#2dd4bf': 'Tyrkysová', '#f472b6': 'Růžová', '#a78bfa': 'Fialová', '#e2e8f0': 'Bílá',
};

export const DEFAULT_PRICE_ALERT: PriceAlertDefaults = {
  frequency: 'once',
  expiry: 'session',
  line: { width: 'thin', style: 'dashed', color: PRICE_ALERT_COLORS[0] },
  channels: { phone: true, voice: true, pc: true, sound: true },
};

export const PRICE_ALERTS_STORAGE_KEY = 'alphatrade:price-alerts:v1';
export const PRICE_ALERT_DEFAULTS_KEY = 'alphatrade:price-alert-defaults:v1';
const TICK = 0.25;
const MAX_ALERTS = 50;

const snap = (price: number) => Math.round(price / TICK) * TICK;

/** Podmínka podle strany trhu: nad trhem „nahoru přes“, pod ním „dolů přes“. */
export function alertConditionFor(price: number, market: number | null): PriceAlertCondition {
  if (market == null || !Number.isFinite(market)) return 'cross';
  return price >= market ? 'up' : 'down';
}

export function alertConditionText(condition: PriceAlertCondition): string {
  return condition === 'up' ? 'Nahoru přes' : condition === 'down' ? 'Dolů přes' : 'Překročí';
}

/** Posun čáry: „nahoru/dolů přes“ se přepne podle nové strany trhu, „překročí“ zůstává. */
export function movedAlert(alert: PriceAlert, price: number, market: number | null, now = Date.now()): PriceAlert {
  const next = snap(price);
  return {
    ...alert,
    price: next,
    condition: alert.condition === 'cross' ? 'cross' : alertConditionFor(next, market),
    updatedAt: now,
  };
}

export function newPriceAlert(price: number, market: number | null, defaults: PriceAlertDefaults, now = Date.now(), symbol = 'MNQ'): PriceAlert {
  const at = snap(price);
  return {
    id: `pa-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    symbol,
    price: at,
    condition: alertConditionFor(at, market),
    frequency: defaults.frequency,
    expiry: defaults.expiry,
    line: { ...defaults.line },
    channels: { ...defaults.channels },
    note: '',
    createdAt: now,
    updatedAt: now,
  };
}

const oneOf = <T extends string>(value: unknown, options: readonly T[], fallback: T): T => (
  typeof value === 'string' && (options as readonly string[]).includes(value) ? value as T : fallback
);
const bool = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);

function sanitizeDefaults(raw: unknown): PriceAlertDefaults {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const line = (value.line && typeof value.line === 'object' ? value.line : {}) as Record<string, unknown>;
  const channels = (value.channels && typeof value.channels === 'object' ? value.channels : {}) as Record<string, unknown>;
  const base = DEFAULT_PRICE_ALERT;
  return {
    frequency: oneOf(value.frequency, ['once', 'every'], base.frequency),
    expiry: oneOf(value.expiry, ['session', 'gtc'], base.expiry),
    line: {
      width: oneOf(line.width, ['thin', 'thick', 'none'], base.line.width),
      style: oneOf(line.style, ['solid', 'dashed', 'dotted'], base.line.style),
      color: oneOf(line.color, PRICE_ALERT_COLORS, base.line.color),
    },
    channels: {
      phone: bool(channels.phone, base.channels.phone),
      voice: bool(channels.voice, base.channels.voice),
      pc: bool(channels.pc, base.channels.pc),
      sound: bool(channels.sound, base.channels.sound),
    },
  };
}

function sanitizeAlert(raw: unknown): PriceAlert | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const price = Number(value.price);
  if (typeof value.id !== 'string' || !Number.isFinite(price) || price <= 0) return null;
  const rest = sanitizeDefaults(value);
  return {
    id: value.id,
    symbol: typeof value.symbol === 'string' && value.symbol ? value.symbol : 'MNQ',
    price: snap(price),
    condition: oneOf(value.condition, ['cross', 'up', 'down'], 'cross'),
    ...rest,
    note: typeof value.note === 'string' ? value.note.slice(0, 80) : '',
    createdAt: Number.isFinite(Number(value.createdAt)) ? Number(value.createdAt) : 0,
    updatedAt: Number.isFinite(Number(value.updatedAt)) ? Number(value.updatedAt) : 0,
  };
}

interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void }

export interface PriceAlertState {
  alerts: readonly PriceAlert[];
  defaults: PriceAlertDefaults;
}

/**
 * Úložiště upozornění pro UI. Datová vrstva ho nahradí serverovým (Supabase +
 * realtime), rozhraní zůstane: `subscribe`, `getState`, `add`, `update`, `remove`,
 * `setDefaults`.
 */
export interface PriceAlertStore {
  subscribe(listener: () => void): () => void;
  getState(): PriceAlertState;
  add(alert: PriceAlert): void;
  update(alert: PriceAlert): void;
  remove(id: string): void;
  setDefaults(defaults: PriceAlertDefaults): void;
}

export function readPriceAlertState(storage: StorageLike | null | undefined): PriceAlertState {
  const read = (key: string): unknown => {
    try { const raw = storage?.getItem(key); return raw ? JSON.parse(raw) : null; } catch { return null; }
  };
  const list = read(PRICE_ALERTS_STORAGE_KEY);
  const alerts = Array.isArray(list) ? list.map(sanitizeAlert).filter((alert): alert is PriceAlert => alert != null).slice(0, MAX_ALERTS) : [];
  return { alerts, defaults: sanitizeDefaults(read(PRICE_ALERT_DEFAULTS_KEY)) };
}

export function createLocalPriceAlertStore(storage: StorageLike | null | undefined): PriceAlertStore {
  let state = readPriceAlertState(storage);
  const listeners = new Set<() => void>();
  const write = (next: PriceAlertState) => {
    state = next;
    try {
      storage?.setItem(PRICE_ALERTS_STORAGE_KEY, JSON.stringify(state.alerts));
      storage?.setItem(PRICE_ALERT_DEFAULTS_KEY, JSON.stringify(state.defaults));
    } catch { /* plné nebo zakázané úložiště: zůstane v paměti */ }
    listeners.forEach(listener => listener());
  };
  return {
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getState: () => state,
    add: alert => write({ ...state, alerts: [...state.alerts, alert].slice(-MAX_ALERTS) }),
    update: alert => write({ ...state, alerts: state.alerts.map(item => (item.id === alert.id ? alert : item)) }),
    remove: id => write({ ...state, alerts: state.alerts.filter(item => item.id !== id) }),
    setDefaults: defaults => write({ ...state, defaults: sanitizeDefaults(defaults) }),
  };
}

/** Text spuštěného / posunutého upozornění (karta, notifikace, hlas). */
export function alertTitle(alert: Pick<PriceAlert, 'symbol' | 'condition' | 'price'>): string {
  const price = alert.price.toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${alert.symbol} ${alertConditionText(alert.condition).toLowerCase()} ${price}`;
}

/** Vzor čáry v grafu (CSS border-style) a tloušťka v px. */
export function alertLineCss(line: PriceAlertStyle, selected: boolean): { width: number; style: 'solid' | 'dashed' | 'dotted' } {
  const base = line.width === 'thick' ? 2.5 : line.style === 'dotted' ? 2 : 1;
  return { width: base + (selected ? 0.5 : 0), style: line.style };
}
