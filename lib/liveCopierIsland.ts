import type { LiveAccount, LiveOrder } from '../services/tradecopiaLiveService';
import { pointValueUsd } from '../services/futuresContractSpecs';
import { pickCopierMarketPrice } from './copierMarketPrice';

/**
 * Model plovoucího stavového ostrova LIVE.
 *
 * Ostrov je nejnápadnější místo v UI, takže platí dvě pravidla:
 * 1. Neznámý stav se NIKDY nevydává za vypnutý — dokud worker nepotvrdí stav,
 *    ostrov to řekne nahlas (`phase: 'unknown'`).
 * 2. Nepotvrzená čísla se nezobrazují. Když broker nedodal hodnotu, pole se
 *    vynechá; prázdno je lepší než stará hodnota tvářící se jako aktuální.
 */
export type LiveIslandPhase = 'unknown' | 'off' | 'armed' | 'limit' | 'position' | 'divergence';

/** Vizuální rodina: klid, připraveno, obchod běží, porucha. */
export type LiveIslandTone = 'muted' | 'ok' | 'active' | 'danger';

export type LiveIslandAction = 'arm' | 'disarm' | 'cancel' | 'flatten' | 'show' | null;

export interface LiveIslandField {
  label: string;
  value: string;
  tone?: 'pnl-positive' | 'pnl-negative' | 'warn' | 'danger';
}

export interface LiveCopierIslandModel {
  phase: LiveIslandPhase;
  tone: LiveIslandTone;
  /** Hlavní věta — co se právě děje. */
  title: string;
  /** Doplněk vedle titulku; u pozice nese P&L, proto může mít vlastní tón. */
  detail?: LiveIslandField;
  /** Třetí údaj v compact řádku (shoda followerů, počet účtů mimo). */
  extra?: LiveIslandField;
  action: LiveIslandAction;
  actionLabel: string | null;
  /** Obsah rozbaleného řádku: stálé jádro + pole podle fáze. */
  fields: LiveIslandField[];
}

export interface LiveCopierIslandInput {
  /** Stav známe jen tehdy, když worker odpověděl. Jinak fail-closed 'unknown'. */
  statusKnown: boolean;
  armed: boolean;
  killSwitch?: boolean;
  groupName: string | null;
  /** Účty skupiny (leader první), už zúžené na tuto skupinu. */
  accounts: LiveAccount[];
  /** Kolik účtů skupina konfiguruje, včetně těch, co nejsou v snapshotu. */
  configuredAccountCount: number;
  orders: LiveOrder[];
  leaderAccountId: number | null;
  divergentAccounts: number[];
  /** Čas automatické expirace ARM (ms epoch); 0 = neznámý. */
  armExpiresAt?: number;
  /** Denní P&L skupiny; null = nepotvrzeno, pole se vynechá. */
  groupDailyPnl: number | null;
  /** Počet uzavřených obchodů dne a případný strop. */
  tradesToday?: number | null;
  maxTradesPerDay?: number | null;
  /** `marketPrices` z workeru (TradingView). Jen pro zobrazení, nikdy do rozhodování. */
  marketPrices?: readonly unknown[];
  /** Vstřikovatelné kvůli testům. */
  now?: number;
}

// `signDisplay` kvůli kladným hodnotám: „124,50 US$" vedle „−16,20 US$"
// vypadalo jako dvě různé věci, i když jde o totéž se znaménkem.
const money = new Intl.NumberFormat('cs-CZ', {
  style: 'currency', currency: 'USD', maximumFractionDigits: 2, signDisplay: 'exceptZero',
});
/** Riziko a cíl se uvádějí jako velikost, ne jako pohyb — bez znaménka. */
const amount = new Intl.NumberFormat('cs-CZ', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const plain = new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 0 });

/** Rozdíl cen v bodech; víc než dvě desetinná místa jsou tu šum. */
const points = new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 2 });

/**
 * Ochranné příkazy leadera k otevřené pozici: opačná akce než pozice,
 * stop = SL, limit = TP. Bere jen `working`, aby vyplněné nohy nestrašily.
 */
const protectiveLegs = (orders: LiveOrder[], accountId: number | null, long: boolean) => {
  const wanted = long ? /sell/i : /buy/i;
  const legs = orders.filter(order => order.working
    && order.accountId === accountId
    && wanted.test(order.action));
  return {
    stop: legs.find(order => /stop/i.test(order.orderType) && order.stopPrice != null)?.stopPrice ?? null,
    target: legs.find(order => /limit/i.test(order.orderType) && order.price != null)?.price ?? null,
  };
};

/** Riziko/cíl v dolarech. Bez známé hodnoty bodu se ukáže jen vzdálenost. */
const legField = (label: string, entry: number | null, level: number | null,
  symbol: string, qty: number, tone: LiveIslandField['tone']): LiveIslandField | null => {
  if (level == null) return null;
  if (entry == null || !Number.isFinite(entry)) {
    return { label, value: points.format(level), tone };
  }
  const distance = Math.abs(entry - level);
  const value = pointValueUsd(symbol);
  const usd = value != null && qty > 0 ? distance * value * qty : null;
  return {
    label,
    value: usd != null
      ? `${amount.format(usd)} · ${points.format(distance)} b`
      : `${points.format(level)} · ${points.format(distance)} b`,
    tone,
  };
};

const pnlTone = (value: number): LiveIslandField['tone'] =>
  value > 0 ? 'pnl-positive' : value < 0 ? 'pnl-negative' : undefined;

const shortAccount = (name: string): string =>
  name.length > 10 ? `${name.slice(0, 3)}…${name.slice(-3)}` : name;

const armTime = (at: number): string | null => {
  if (!Number.isFinite(at) || at <= 0) return null;
  return new Date(at).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
};

/** Účty, jejichž DLL rezervu známe, seřazené od nejtěsnější. */
const tightestReserve = (accounts: LiveAccount[]): LiveIslandField | null => {
  const known = accounts
    .filter(account => account.cushion != null && Number.isFinite(account.cushion) && !account.riskDisplayPending)
    .sort((a, b) => (a.cushion ?? 0) - (b.cushion ?? 0));
  const tightest = known[0];
  if (!tightest) return null;
  return {
    label: 'Nejblíž limitu',
    value: `${shortAccount(tightest.name)} · ${plain.format(tightest.cushion ?? 0)}`,
    tone: 'warn',
  };
};

export function buildLiveCopierIsland(input: LiveCopierIslandInput): LiveCopierIslandModel {
  const {
    statusKnown, armed, killSwitch, groupName, accounts, configuredAccountCount,
    orders, leaderAccountId, divergentAccounts, armExpiresAt = 0, groupDailyPnl,
    tradesToday, maxTradesPerDay, marketPrices = [], now = Date.now(),
  } = input;

  const label = groupName?.trim() || 'Skupina';

  // Stálé jádro rozbalení. Denní P&L se vynechá, dokud není potvrzené.
  // Pozor na záměnu s „X/Y zařazených“ v tabulce skupin — to je způsobilost
  // ke kopírování, tohle je jen dostupnost dat účtu v aktuálním snapshotu.
  const core: LiveIslandField[] = [
    { label: 'Dostupných', value: `${accounts.length} / ${configuredAccountCount}` },
  ];
  if (groupDailyPnl != null && Number.isFinite(groupDailyPnl)) {
    core.push({ label: 'Denní P&L', value: money.format(groupDailyPnl), tone: pnlTone(groupDailyPnl) });
  }

  // 0) Stav neznáme — nesmíme tvrdit, že je vypnuto.
  if (!statusKnown) {
    return {
      phase: 'unknown', tone: 'muted', title: 'Stav kopírky neověřen',
      detail: { label: '', value: 'Čekám na odpověď workeru' },
      action: null, actionLabel: null, fields: core,
    };
  }

  // 1) Divergence přebíjí všechno ostatní — skupina je zastavená.
  if (divergentAccounts.length > 0) {
    // Divergentní účet bývá zrovna ten, co vypadl z OAuth snapshotu — jméno
    // pak neznáme a holé „1×“ je k ničemu. Fallback na ID je pořád stopa.
    const names = divergentAccounts.map(id => {
      const known = accounts.find(account => account.id === id)?.name;
      return known ? shortAccount(known) : `#${id}`;
    });
    return {
      phase: 'divergence', tone: 'danger',
      title: 'Divergence · skupina zastavena',
      detail: { label: '', value: `${divergentAccounts.length} ${divergentAccounts.length === 1 ? 'účet mimo' : 'účty mimo'}`, tone: 'danger' },
      action: 'show', actionLabel: 'Zobrazit',
      fields: [
        ...core,
        { label: 'Mimo synchron', value: names.length > 0 ? names.join(' · ') : `${divergentAccounts.length}×`, tone: 'danger' },
      ],
    };
  }

  if (killSwitch) {
    return {
      phase: 'off', tone: 'danger', title: 'Kill switch aktivní',
      detail: { label: '', value: 'Kopírka je trvale zastavená', tone: 'danger' },
      action: null, actionLabel: null, fields: core,
    };
  }

  const open = accounts.filter(account => account.positions.some(position => position.netPosition !== 0));
  const leader = leaderAccountId != null ? accounts.find(account => account.id === leaderAccountId) : undefined;
  const leaderPosition = leader?.positions.find(position => position.netPosition !== 0);

  // 2) Otevřená pozice — nejnaléhavější běžný stav.
  if (open.length > 0) {
    const symbol = leaderPosition?.symbol ?? open[0]?.positions.find(p => p.netPosition !== 0)?.symbol ?? '';
    const side = leaderPosition ? (leaderPosition.netPosition > 0 ? 'Long' : 'Short') : '';
    const size = Math.abs(leaderPosition?.netPosition ?? 0);
    // Otevřený P&L jen z potvrzených zdrojů; jediný stale účet stačí k vynechání.
    const confirmed = open.every(account => account.unrealizedPnlSource === 'broker');
    const unrealized = open.reduce((sum, account) => sum + (account.unrealizedPnl ?? 0), 0);
    const fields: LiveIslandField[] = [...core];
    // SL/TP leadera přepočtené na dolary: „−$340“ řekne víc než „12,5 b“,
    // protože body si musíš sám vynásobit počtem kontraktů.
    const entry = leaderPosition?.netPrice ?? null;
    const legs = protectiveLegs(orders, leaderAccountId, (leaderPosition?.netPosition ?? 0) > 0);
    const sl = legField('SL', entry, legs.stop, symbol, size, 'danger');
    const tp = legField('TP', entry, legs.target, symbol, size, 'pnl-positive');
    if (sl) fields.push(sl);
    if (tp) fields.push(tp);
    const reserve = tightestReserve(accounts);
    if (reserve) fields.push(reserve);
    return {
      phase: 'position', tone: 'active',
      title: `${size > 0 ? `${size}× ` : ''}${symbol}${side ? ` ${side}` : ''}`.trim() || 'Pozice běží',
      detail: confirmed
        ? { label: '', value: money.format(unrealized), tone: pnlTone(unrealized) }
        : { label: '', value: 'Čekám na potvrzení' },
      extra: { label: '', value: `${open.length}/${accounts.length} v pozici` },
      action: 'flatten', actionLabel: 'Flatten',
      fields,
    };
  }

  // 3) Čekající limit — příkaz visí v trhu, ale nic se ještě nestalo.
  const workingLimits = orders.filter(order => order.working && /limit/i.test(order.orderType));
  const leaderLimit = workingLimits.find(order => order.accountId === leaderAccountId) ?? workingLimits[0];
  if (leaderLimit) {
    const long = /buy/i.test(leaderLimit.action);
    const side = long ? 'Long' : 'Short';
    const fields: LiveIslandField[] = [...core];
    // Cena z TradingView je jediné, co u čekajícího limitu ukáže, jak daleko
    // jsme od vstupu. Když je stará nebo chybí, pole se vynechá — nic se
    // neodhaduje. Do rozhodování copieru tahle cena nikdy nevstupuje.
    const market = pickCopierMarketPrice(marketPrices, leaderLimit.symbol, now);
    const distance = market != null && leaderLimit.price != null
      ? Math.abs(market - leaderLimit.price)
      : null;
    if (leaderLimit.price != null) {
      fields.push({ label: 'Limit', value: points.format(leaderLimit.price) });
    }
    if (distance != null) {
      fields.push({ label: 'Do fillu', value: `${points.format(distance)} b`, tone: 'warn' });
    }
    const legs = protectiveLegs(orders, leaderLimit.accountId, long);
    const sl = legField('SL', leaderLimit.price, legs.stop, leaderLimit.symbol, leaderLimit.quantity, 'danger');
    const tp = legField('TP', leaderLimit.price, legs.target, leaderLimit.symbol, leaderLimit.quantity, 'pnl-positive');
    if (sl) fields.push(sl);
    if (tp) fields.push(tp);
    return {
      phase: 'limit', tone: 'active',
      title: `Limit čeká · ${leaderLimit.symbol} ${side}`,
      detail: leaderLimit.price != null
        ? { label: '', value: `@ ${points.format(leaderLimit.price)}` }
        : undefined,
      extra: distance != null
        ? { label: '', value: `${points.format(distance)} b do vstupu` }
        : workingLimits.length > 1 ? { label: '', value: `${workingLimits.length} příkazů` } : undefined,
      action: 'cancel', actionLabel: 'Zrušit',
      fields,
    };
  }

  // 4) Zapnuto, nic neběží.
  if (armed) {
    const fields: LiveIslandField[] = [...core];
    const reserve = tightestReserve(accounts);
    if (reserve) fields.push(reserve);
    if (tradesToday != null) {
      fields.push({ label: 'Obchodů dnes', value: maxTradesPerDay ? `${tradesToday} / ${maxTradesPerDay}` : String(tradesToday) });
    }
    const expiry = armTime(armExpiresAt);
    if (expiry) fields.push({ label: 'ARM do', value: expiry });
    return {
      phase: 'armed', tone: 'ok',
      title: `${label} zapnutá`,
      detail: { label: '', value: `${accounts.length}/${configuredAccountCount} účtů` },
      extra: expiry ? { label: '', value: `do ${expiry}` } : undefined,
      action: 'disarm', actionLabel: 'Vypnout',
      fields,
    };
  }

  // 5) Vypnuto.
  const fields: LiveIslandField[] = [...core];
  if (tradesToday != null) {
    fields.push({ label: 'Obchodů dnes', value: maxTradesPerDay ? `${tradesToday} / ${maxTradesPerDay}` : String(tradesToday) });
  }
  return {
    phase: 'off', tone: 'muted',
    title: `${label} vypnutá`,
    detail: { label: '', value: 'Sama se nezapne' },
    action: null, actionLabel: null,
    fields,
  };
}
