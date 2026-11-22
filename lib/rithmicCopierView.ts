// Obrazovka kopírky pro Rithmic (příprava, 22. 11. 2026): datový model a výpočty pro zobrazení.
// JEN ZOBRAZENÍ: nic odtud neposílá příkazy ani nerozhoduje o riziku. Brány zapnutí tady jen ukazují,
// co by služba kontrolovala; skutečné ARM / DISARM a zápisy u brokera patří do jádra kopírky ve službě.

export type CopierAccountStatus = 'active' | 'dll-locked' | 'breached' | 'unverifiable';
export type CopierGroupState = 'armed' | 'disarmed' | 'halted' | 'kill';

export interface CopierPosition {
  side: 'long' | 'short';
  quantity: number;
  averagePrice: number;
  /** Cena SL u brokera; null = pozice nemá SL (nebo není známý). */
  stop: number | null;
  /** Cena TP u brokera; null = bez TP. */
  target: number | null;
}

export interface CopierAccount {
  id: string;
  name: string;
  firm: string;
  /** Zůstatek bez otevřené pozice (ranní + realizované dne); null = služba ho neposílá. */
  balance: number | null;
  /** Realizovaný P&L dne v USD; null = není znám (ukáže se „—“, nikdy nula). */
  realizedToday: number | null;
  /** Denní limit ztráty propky (USD); null = účet ho nemá. */
  dailyLossLimit: number | null;
  /** Rezerva do max loss / trailing DD bez otevřené pozice (USD); null = neznámá. */
  drawdownLeft: number | null;
  /** Celá šíře DD (USD) — jen pro ukazatel. */
  drawdownMax: number | null;
  position: CopierPosition | null;
  status: CopierAccountStatus;
  /** Follower má kopírování zapnuté. */
  copyOn: boolean;
  /** Poměr k leaderovi. */
  ratio: number;
  /** Strop kontraktů. */
  maxContracts: number;
  /** Poslední zpoždění kopie (ms); null = není. */
  latencyMs: number | null;
  /** Neshoda pozice: broker hlásí jiné množství, než kopírka čekala. */
  brokerQuantity?: number;
}

export interface CopierGroup {
  id: string;
  name: string;
  leaderId: string;
  followerIds: string[];
  state: CopierGroupState;
}

export interface CopierView {
  accounts: Record<string, CopierAccount>;
  groups: CopierGroup[];
  /** USD za bod (MNQ = 2). */
  pointValue: number;
  /** Poslední cena kontraktu; null = cena není. */
  price: number | null;
}

export type CopierSltpMode = 'sum' | 'avg';

const dir = (p: CopierPosition) => (p.side === 'long' ? 1 : -1);

/** Otevřený P&L účtu z pozice a ceny (USD); bez pozice nebo ceny 0. */
export function copierOpenPnl(account: CopierAccount, price: number | null, pointValue: number): number {
  const p = account.position;
  if (!p || price == null) return 0;
  const qty = account.brokerQuantity ?? p.quantity;
  return (price - p.averagePrice) * qty * pointValue * dir(p);
}

export function copierDayPnl(account: CopierAccount, price: number | null, pointValue: number): number | null {
  return account.realizedToday == null ? null : account.realizedToday + copierOpenPnl(account, price, pointValue);
}

/** Pozice bez SL: ztráta účtu není omezená a do součtu SL skupiny nepatří. */
export function copierUnprotected(account: CopierAccount): boolean {
  return Boolean(account.position && account.position.stop == null);
}

/** Kolik účet ztratí / vydělá, když trh dojde na SL / TP (USD). null = bez pozice nebo bez SL. */
export function copierSltpUsd(account: CopierAccount, pointValue: number): { sl: number; tp: number | null } | null {
  const p = account.position;
  if (!p || p.stop == null) return null;
  const qty = account.brokerQuantity ?? p.quantity;
  return {
    sl: (p.stop - p.averagePrice) * qty * pointValue * dir(p),
    tp: p.target == null ? null : (p.target - p.averagePrice) * qty * pointValue * dir(p),
  };
}

/** Rezerva a zbytek denního limitu s otevřenou pozicí (USD, nikdy pod 0). */
export function copierRisk(account: CopierAccount, price: number | null, pointValue: number): { ddLeft: number | null; dllLeft: number | null } {
  const open = copierOpenPnl(account, price, pointValue);
  const ddLeft = account.drawdownLeft == null ? null : Math.max(0, account.drawdownLeft + open);
  if (account.status === 'breached') return { ddLeft: 0, dllLeft: 0 };
  if (account.dailyLossLimit == null) return { ddLeft, dllLeft: null };
  const day = (account.realizedToday ?? 0) + open;
  const dll = Math.max(0, account.dailyLossLimit + Math.min(0, day));
  return { ddLeft, dllLeft: ddLeft == null ? dll : Math.min(dll, ddLeft) };
}

export type CopierTileKind = 'copy' | 'off' | 'lock' | 'prob' | 'bad';
export function copierTileKind(account: CopierAccount): CopierTileKind {
  if (account.brokerQuantity != null) return 'bad';
  if (copierUnprotected(account)) return 'prob';
  if (!account.copyOn) return 'off';
  if (account.status === 'dll-locked') return 'lock';
  if (account.status !== 'active') return 'prob';
  return 'copy';
}

export interface CopierGroupSummary {
  /** null = některý účet nemá známý realizovaný výsledek. */
  day: number | null;
  open: number;
  balance: number | null;
  /** SL / TP v USD podle režimu (součet nebo průměr na účet v pozici); null = nikdo v pozici se SL. */
  sl: number | null;
  tp: number | null;
  /** Účty v pozici, které se do SL/TP počítají. */
  protectedCount: number;
  /** Účty v pozici bez SL. */
  unprotectedIds: string[];
  inPosition: number;
  contracts: number;
  copying: number;
  enabled: number;
  /** Nejbližší denní limit (nejméně zbývá); null = nikdo limit nemá. */
  nearestDll: { id: string; left: number } | null;
  /** Nejmenší rezerva DD. */
  minDd: { id: string; left: number } | null;
}

export function copierGroupMembers(group: CopierGroup): string[] {
  return [group.leaderId, ...group.followerIds];
}

export function copierGroupSummary(view: CopierView, group: CopierGroup, mode: CopierSltpMode): CopierGroupSummary {
  let day: number | null = 0, open = 0, balance: number | null = 0, sl = 0, tp = 0, tpKnown = 0, protectedCount = 0, inPosition = 0, contracts = 0;
  const unprotectedIds: string[] = [];
  let nearestDll: CopierGroupSummary['nearestDll'] = null, minDd: CopierGroupSummary['minDd'] = null;
  for (const id of copierGroupMembers(group)) {
    const a = view.accounts[id]; if (!a) continue;
    const o = copierOpenPnl(a, view.price, view.pointValue);
    open += o;
    day = day == null || a.realizedToday == null ? null : day + a.realizedToday + o;
    balance = balance == null || a.balance == null ? null : balance + a.balance + o;
    if (a.position) { inPosition += 1; contracts += a.brokerQuantity ?? a.position.quantity; }
    if (copierUnprotected(a)) unprotectedIds.push(id);
    const v = copierSltpUsd(a, view.pointValue);
    if (v) { protectedCount += 1; sl += v.sl; if (v.tp != null) { tp += v.tp; tpKnown += 1; } }
    if (a.status === 'breached') continue;
    const r = copierRisk(a, view.price, view.pointValue);
    if (r.dllLeft != null && (!nearestDll || r.dllLeft < nearestDll.left)) nearestDll = { id, left: r.dllLeft };
    if (r.ddLeft != null && (!minDd || r.ddLeft < minDd.left)) minDd = { id, left: r.ddLeft };
  }
  const followers = group.followerIds.map(id => view.accounts[id]).filter(Boolean) as CopierAccount[];
  const avg = mode === 'avg';
  return {
    day, open, balance,
    sl: protectedCount ? (avg ? sl / protectedCount : sl) : null,
    tp: tpKnown ? (avg ? tp / tpKnown : tp) : null,
    protectedCount, unprotectedIds, inPosition, contracts,
    copying: followers.filter(a => copierTileKind(a) === 'copy').length,
    enabled: followers.filter(a => a.copyOn).length,
    nearestDll, minDd,
  };
}

/** Brány před zapnutím (jen ukázka toho, co služba kontroluje; rozhoduje služba, ne obrazovka). */
export interface CopierGate { label: string; detail: string; ok: boolean; fixAccountId?: string }
export function copierGates(view: CopierView, group: CopierGroup): CopierGate[] {
  const followers = group.followerIds.map(id => view.accounts[id]).filter(Boolean) as CopierAccount[];
  const all = copierGroupMembers(group).map(id => view.accounts[id]).filter(Boolean) as CopierAccount[];
  const bad = all.find(a => a.brokerQuantity != null);
  const naked = all.filter(copierUnprotected);
  const unv = followers.find(a => a.copyOn && a.status === 'unverifiable');
  return [
    { label: 'Pozice leadera = followeři', detail: bad ? `${bad.name}: broker má ${bad.brokerQuantity}, čekáno ${bad.position?.quantity ?? 0}` : 'pozice sedí', ok: !bad },
    { label: 'Každá pozice má SL a TP', detail: naked.length ? `${naked.map(a => a.name).join(', ')}: pozice bez ochrany` : 'všechny pozice chráněné', ok: !naked.length },
    { label: 'Účty způsobilé', detail: unv ? `${unv.name}: čtení selhalo, neověřitelný` : 'všechny zapnuté účty ověřené', ok: !unv, ...(unv ? { fixAccountId: unv.id } : {}) },
    { label: 'Kill switch vypnutý', detail: group.state === 'kill' ? 'kill platí do konce session' : 'vypnutý', ok: group.state !== 'kill' },
  ];
}

/** Skrývání názvů účtů (soukromí): zbytek nahradí tečky. */
export function copierRedact(name: string, start: number, end: number): string {
  const s = Math.max(0, Math.floor(start)), e = Math.max(0, Math.floor(end));
  if (name.length <= s + e) return name;
  return name.slice(0, s) + '•'.repeat(Math.min(6, name.length - s - e)) + (e ? name.slice(-e) : '');
}

// ── nastavení tabulky (per zařízení)
export type CopierColumnKey = 'balance' | 'position' | 'day' | 'dll' | 'open' | 'sl' | 'tp' | 'dd' | 'ratio' | 'latency' | 'limit' | 'link' | 'status';
export const COPIER_COLUMNS: Array<{ key: CopierColumnKey; label: string; width: number; right?: boolean; sort?: 'day' | 'dll' | 'dd' }> = [
  { key: 'balance', label: 'Zůstatek', width: 88, right: true },
  { key: 'position', label: 'Pozice', width: 64, right: true },
  { key: 'day', label: 'Denní P&L', width: 84, right: true, sort: 'day' },
  { key: 'dll', label: 'DLL zbývá', width: 84, right: true, sort: 'dll' },
  { key: 'open', label: 'Otevřený P&L', width: 88, right: true },
  { key: 'sl', label: 'SL', width: 78, right: true },
  { key: 'tp', label: 'TP', width: 78, right: true },
  { key: 'dd', label: 'Rezerva DD', width: 86, right: true, sort: 'dd' },
  { key: 'ratio', label: 'Násobek', width: 62, right: true },
  { key: 'latency', label: 'Rychlost kopie', width: 88, right: true },
  { key: 'limit', label: 'Strop', width: 60, right: true },
  { key: 'link', label: 'Připojení', width: 96 },
  { key: 'status', label: 'Stav', width: 92 },
];
export type CopierStripKey = 'day' | 'open' | 'sltp' | 'dll' | 'copy' | 'balance' | 'dd' | 'contracts';
export const COPIER_STRIP: Array<{ key: CopierStripKey; label: string }> = [
  { key: 'day', label: 'Dnes' }, { key: 'open', label: 'Otevřeno' }, { key: 'sltp', label: 'SL / TP v USD' },
  { key: 'dll', label: 'Nejbližší DLL' }, { key: 'copy', label: 'Kopíruje' }, { key: 'balance', label: 'Zůstatek' },
  { key: 'dd', label: 'Nejmenší rezerva DD' }, { key: 'contracts', label: 'Kontraktů v pozici' },
];

export interface CopierTableSettings {
  order: CopierColumnKey[];
  hidden: CopierColumnKey[];
  strip: CopierStripKey[];
  sltp: CopierSltpMode;
  firm: boolean;
  dense: boolean;
  redact: boolean;
  redactStart: number;
  redactEnd: number;
}
export const COPIER_TABLE_DEFAULTS: CopierTableSettings = {
  order: COPIER_COLUMNS.map(c => c.key),
  hidden: ['latency', 'limit', 'link'],
  strip: ['day', 'open', 'sltp', 'dll', 'copy'],
  sltp: 'sum', firm: true, dense: false, redact: false, redactStart: 3, redactEnd: 3,
};
export const COPIER_TABLE_STORAGE_KEY = 'at:copier:table';

/** Bezpečné čtení uloženého nastavení (neznámé klíče a nesmysly zahodí, chybějící sloupce doplní). */
export function parseCopierTableSettings(raw: unknown): CopierTableSettings {
  const d = COPIER_TABLE_DEFAULTS;
  if (!raw || typeof raw !== 'object') return { ...d, order: [...d.order], hidden: [...d.hidden], strip: [...d.strip] };
  const r = raw as Partial<Record<keyof CopierTableSettings, unknown>>;
  const cols = new Set<string>(COPIER_COLUMNS.map(c => c.key));
  const strips = new Set<string>(COPIER_STRIP.map(c => c.key));
  const list = <T extends string>(v: unknown, ok: Set<string>): T[] | null => (Array.isArray(v) ? [...new Set(v.filter((x): x is T => typeof x === 'string' && ok.has(x)))] : null);
  const order = list<CopierColumnKey>(r.order, cols) ?? [...d.order];
  for (const c of COPIER_COLUMNS) if (!order.includes(c.key)) order.push(c.key);
  const num = (v: unknown, def: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(12, Math.round(v))) : def);
  return {
    order,
    hidden: list<CopierColumnKey>(r.hidden, cols) ?? [...d.hidden],
    strip: list<CopierStripKey>(r.strip, strips) ?? [...d.strip],
    sltp: r.sltp === 'avg' ? 'avg' : 'sum',
    firm: typeof r.firm === 'boolean' ? r.firm : d.firm,
    dense: typeof r.dense === 'boolean' ? r.dense : d.dense,
    redact: typeof r.redact === 'boolean' ? r.redact : d.redact,
    redactStart: num(r.redactStart, d.redactStart),
    redactEnd: num(r.redactEnd, d.redactEnd),
  };
}

export const usdText = (v: number | null, opts: { unit?: boolean } = {}): string => {
  if (v == null || !Number.isFinite(v)) return '—';
  const s = `${v >= 0 ? '+' : '−'}${Math.abs(Math.round(v)).toLocaleString('cs-CZ')}`;
  return opts.unit === false ? s : `${s} USD`;
};
export const plainUsd = (v: number | null): string => (v == null || !Number.isFinite(v) ? '—' : `${Math.round(v).toLocaleString('cs-CZ')} USD`);

/**
 * Skutečný účet ze služby Rithmic jako leader skupiny bez followerů (22. 11.: kopírka ve službě zatím není).
 * Jen to, co služba opravdu posílá: název, systém, realizovaný P&L dne (jinak „—“), pozice se SL/TP, cena.
 * Zůstatek, DLL ani rezervu Rithmic v použitelném tvaru neposílá → null, nikdy vymyšlené číslo.
 * Neznámý stav pozice (spojení) = null pohled: obrazovka to řekne, netváří se jako „bez pozice“.
 */
export function rithmicCopierViewFromService(input: {
  accountName: string | null | undefined;
  system: string | null | undefined;
  closedPnl: number | null | undefined;
  positionKnown: boolean;
  position: { side: 'long' | 'short'; quantity: number; entry: number | null; stop: number | null; target: number | null } | null;
  price: number | null;
  pointValue: number | null;
  maxContracts: number;
}): CopierView | null {
  const name = input.accountName?.trim();
  if (!name || !input.positionKnown) return null;
  const p = input.position;
  const account: CopierAccount = {
    id: name, name, firm: input.system?.trim() || 'Rithmic', balance: null,
    realizedToday: typeof input.closedPnl === 'number' && Number.isFinite(input.closedPnl) ? input.closedPnl : null,
    dailyLossLimit: null, drawdownLeft: null, drawdownMax: null,
    position: p && p.quantity > 0 && p.entry != null ? { side: p.side, quantity: p.quantity, averagePrice: p.entry, stop: p.stop, target: p.target } : null,
    status: 'active', copyOn: true, ratio: 1, maxContracts: Math.max(0, input.maxContracts), latencyMs: null,
  };
  return {
    accounts: { [name]: account },
    groups: [{ id: 'rithmic', name: 'Hlavní', leaderId: name, followerIds: [], state: 'disarmed' }],
    pointValue: input.pointValue ?? 2,
    price: input.price,
  };
}
