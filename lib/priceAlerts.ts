/**
 * Upozornění na cenu (Filip 2. 11. 2026, náhled EkQateEvNCynqk8rLyQUrr):
 * čára se zvonečkem v grafu, založení z plusu u crosshairu, výběr, posun,
 * nastavení. Upozornění jen hlásí — nikdy nic neobchoduje a nevstupuje do
 * kopírky, rizika ani day locku.
 *
 * Úložiště: přihlášený uživatel = server (`services/priceAlertServerStore.ts`,
 * sdílené PC ↔ telefon, hlídá Mac worker z IBKR, doručuje APNs / web push);
 * bez přihlášení jen toto zařízení (`createLocalPriceAlertStore`). Rozhraní
 * `PriceAlertStore` je pro obě stejné.
 */

import { isAlertTone } from './priceAlertTones';

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
  /** Který zvuk přehraje PC (`lib/priceAlertTones.ts`, vlastní `custom:<id>`); telefon má systémový. */
  tone?: string;
}

export interface PriceAlertStyle {
  width: PriceAlertLineWidth;
  style: PriceAlertLineStyle;
  color: string;
  /** Krytí čáry v % z palety (PC); bez něj výchozí vzhled. */
  opacity?: number;
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
  /** Směr odvozený ze strany trhu v UI (ne ruční volba) — hlídač ho přepočítá z IBKR. */
  conditionAuto?: boolean;
  /** Stav ze serveru (jen serverový store); spouštění mění jen server. */
  status?: 'active' | 'triggered' | 'expired';
  version?: number;
  lastTriggeredAt?: number | null;
  triggerCount?: number;
}

/** Spuštění upozornění ze serveru (úroveň uživatele, nikdy cena trhu). */
export interface PriceAlertEvent {
  id: string;
  alertId: string;
  at: number;
  level: number;
  condition: PriceAlertCondition;
  suppressed: boolean;
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

/** Výchozí krytí čáry na PC (%). */
export const PRICE_ALERT_PC_OPACITY = 70;

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
  const condition = alert.condition === 'cross' ? 'cross' : alertConditionFor(next, market);
  return {
    ...alert,
    price: next,
    condition,
    conditionAuto: alert.condition === 'cross' ? alert.conditionAuto === true : condition !== 'cross',
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
    conditionAuto: market != null && Number.isFinite(market),
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
      // Libovolná barva z palety, jen ve tvaru #rrggbb (čáru kreslí `rgba` z téhož tvaru).
      color: typeof line.color === 'string' && /^#[0-9a-f]{6}$/i.test(line.color) ? line.color.toLowerCase() : base.line.color,
      ...(Number.isFinite(line.opacity) && (line.opacity as number) >= 0 && (line.opacity as number) <= 100 ? { opacity: Math.round(line.opacity as number) } : {}),
    },
    channels: {
      phone: bool(channels.phone, base.channels.phone),
      voice: bool(channels.voice, base.channels.voice),
      pc: bool(channels.pc, base.channels.pc),
      sound: bool(channels.sound, base.channels.sound),
      // Bez platného tónu pole chybí; přehrání a UI berou výchozí.
      ...(isAlertTone(channels.tone) ? { tone: channels.tone } : {}),
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
  /** Serverový store: `local` = jen zařízení, `syncing`, `synced`, `offline` (změny čekají). */
  sync?: 'local' | 'syncing' | 'synced' | 'offline';
  /** Poslední spuštění ze serveru (nejnovější poslední). */
  events?: readonly PriceAlertEvent[];
  /** Poslední trvalá chyba uložení (operace se zahodila) — UI ji ukáže. */
  error?: string | null;
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

/** Řádek ze serveru / cache → upozornění pro UI (stejné čištění jako v zařízení). */
export function sanitizePriceAlert(raw: unknown): PriceAlert | null {
  const alert = sanitizeAlert(raw);
  if (!alert) return null;
  const value = raw as Record<string, unknown>;
  const status = oneOf(value.status, ['active', 'triggered', 'expired'], 'active');
  return {
    ...alert,
    conditionAuto: value.conditionAuto === true,
    status,
    ...(Number.isSafeInteger(value.version) ? { version: value.version as number } : {}),
    lastTriggeredAt: Number.isFinite(Number(value.lastTriggeredAt)) && value.lastTriggeredAt != null ? Number(value.lastTriggeredAt) : null,
    triggerCount: Number.isSafeInteger(value.triggerCount) ? value.triggerCount as number : 0,
  };
}

export function sanitizePriceAlertDefaults(raw: unknown): PriceAlertDefaults {
  return sanitizeDefaults(raw);
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

/** Karta a hlas jen u čerstvého spuštění; pozdě doručená stará událost jen zmizí v seznamu. */
export const PRICE_ALERT_EVENT_FRESH_MS = 30_000;

/** Text spuštění: automaticky odvozený směr hlídač přepočítal z IBKR, tvrdí se jen „překročí“. */
export function priceAlertEventTitle(alert: PriceAlert | null | undefined, level: number): string {
  if (!alert) return `MNQ překročí ${level.toFixed(2)}`;
  return alertTitle({ ...alert, price: level, condition: alert.conditionAuto ? 'cross' : alert.condition });
}

/**
 * Stav čerstvě založeného upozornění na kartě (krátký text, řádek karty se ořezává).
 * „Hlídá“ jen když je uložené na serveru a Mac hlídá; jinak `warn` = delší a výraznější karta.
 */
export function quickAlertCardStatus(sync: PriceAlertState['sync'], watching: string | null): { line: string; warn: boolean } {
  if (!sync) return { line: 'Jen v tomto zařízení, nepřihlášeno', warn: true };
  if (sync === 'offline') return { line: 'NEULOŽENO, server nedostupný', warn: true };
  // Hned po založení je online vždy `syncing`, hlídání se proto musí hlásit i tehdy.
  if (!watching) return { line: 'Mac ho teď NEHLÍDÁ', warn: true };
  return { line: sync === 'synced' ? 'Hlídá Mac · dvojklik = nastavení' : 'Ukládám · Mac hlídá', warn: false };
}

/** Co udělá PC při spuštění: každý kanál zvlášť, jak píše nastavení. Bez upozornění jen karta. */
export function pcAlertFiredActions(alert: Pick<PriceAlert, 'channels'> | null | undefined): { card: boolean; voice: boolean; sound: boolean } {
  if (!alert) return { card: true, voice: false, sound: false };
  return { card: alert.channels.pc, voice: alert.channels.voice, sound: alert.channels.sound };
}

/**
 * Nové a čerstvé události; `seen` doplní. `seen === null` = první načtení nebo výměna úložiště:
 * staré události, nic se nehlásí (volající si drží vrácenou množinu).
 */
export function freshPriceAlertEvents<T extends { id: string; at: number }>(
  seen: Set<string> | null,
  events: readonly T[],
  now: number,
): { seen: Set<string>; fresh: T[] } {
  if (!seen) return { seen: new Set(events.map(event => event.id)), fresh: [] };
  const fresh: T[] = [];
  for (const event of events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    if (now - event.at <= PRICE_ALERT_EVENT_FRESH_MS) fresh.push(event);
  }
  return { seen, fresh };
}

/** Barva textu na štítku v barvě upozornění: na světlé tmavý, na tmavé bílý. */
export function alertTagInk(color: string): string {
  const n = Number.parseInt(color.slice(1), 16);
  if (!Number.isFinite(n)) return '#ffffff';
  const luminance = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return luminance > 0.6 ? '#0f172a' : '#ffffff';
}

/** Vzor čáry v grafu (CSS border-style) a tloušťka v px. */
export function alertLineCss(line: PriceAlertStyle, selected: boolean): { width: number; style: 'solid' | 'dashed' | 'dotted' } {
  const base = line.width === 'thick' ? 2.5 : line.style === 'dotted' ? 2 : 1;
  return { width: base + (selected ? 0.5 : 0), style: line.style };
}
