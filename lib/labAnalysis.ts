import type { LabDecision } from './labDataset.js';

/**
 * Výpočty sekcí nového Labu nad rozhodnutími (`buildLabDecisions`). Všechna
 * čísla počítá tenhle kód — UI i AI coach je jen zobrazují. Peníze jsou $ na
 * leaderovi; R jen u rozhodnutí se SL (pokrytí se vždy vrací, nikdy se
 * nedopočítává).
 */
export type LabUnit = 'usd' | 'r';

export const labValue = (decision: LabDecision, unit: LabUnit): number | null => unit === 'usd' ? decision.pnlUsd : decision.r;

export interface LabStats {
  /** Rozhodnutí ve skupině. */
  count: number;
  /** Rozhodnutí, která mají hodnotu v dané jednotce (v R jen se SL). */
  covered: number;
  wins: number;
  losses: number;
  /** Výhry / (výhry + prohry); break-even se nepočítá. */
  winRate: number | null;
  total: number;
  average: number | null;
  /** Kumulativní součet v čase (po výstupech). */
  equity: { at: number; value: number }[];
}

export function labStats(decisions: readonly LabDecision[], unit: LabUnit): LabStats {
  const ordered = [...decisions].sort((a, b) => a.exitAt - b.exitAt);
  let total = 0, covered = 0, wins = 0, losses = 0;
  const equity: LabStats['equity'] = [];
  for (const decision of ordered) {
    const value = labValue(decision, unit);
    if (value == null) continue;
    covered += 1; total += value;
    if (value > 0) wins += 1; else if (value < 0) losses += 1;
    equity.push({ at: decision.exitAt, value: total });
  }
  return { count: decisions.length, covered, wins, losses, winRate: wins + losses ? wins / (wins + losses) : null,
    total, average: covered ? total / covered : null, equity };
}

// ── A: plán vs. mimo plán ────────────────────────────────────────────────────

export interface LabPlanComparison {
  yes: LabStats;
  no: LabStats;
  partial: LabStats;
  unreviewed: LabStats;
  reviewed: number;
}

export function labPlanComparison(decisions: readonly LabDecision[], unit: LabUnit): LabPlanComparison {
  const pick = (test: (d: LabDecision) => boolean) => labStats(decisions.filter(test), unit);
  return {
    yes: pick(d => d.reviewed && d.plan === 'yes'),
    no: pick(d => d.reviewed && d.plan === 'no'),
    partial: pick(d => d.reviewed && d.plan === 'partial'),
    unreviewed: pick(d => !d.reviewed),
    reviewed: decisions.filter(d => d.reviewed).length,
  };
}

export const LAB_NO_REASON = 'Bez důvodu';

/** Důvody „mimo plán“: kolikrát a kolik stály (nejdražší první). Obchod s víc důvody se počítá u každého. */
export function labInvalidReasons(decisions: readonly LabDecision[], unit: LabUnit) {
  const rows = new Map<string, { reason: string; count: number; total: number; covered: number; decisions: LabDecision[] }>();
  for (const decision of decisions) {
    if (!decision.reviewed || decision.plan !== 'no') continue;
    for (const reason of decision.invalidReasons.length ? decision.invalidReasons : [LAB_NO_REASON]) {
      const row = rows.get(reason) ?? { reason, count: 0, total: 0, covered: 0, decisions: [] };
      const value = labValue(decision, unit);
      row.count += 1; row.decisions.push(decision);
      if (value != null) { row.total += value; row.covered += 1; }
      rows.set(reason, row);
    }
  }
  return [...rows.values()].sort((a, b) => a.total - b.total || b.count - a.count);
}

// ── B: disciplína dne ────────────────────────────────────────────────────────

/** Vstup do tolika minut po ztrátě = „rychlý návrat“. */
export const LAB_QUICK_REENTRY_MIN = 5;
/** Eskalace = aspoň tolikrát větší velikost než úvodní velikost dne. */
export const LAB_ESCALATION_FACTOR = 2;

/**
 * Značky u rozhodnutí: `quick` a `flip` (po ztrátě) jsou jen značky na ose —
 * Filip skalpuje a rychlé návraty i otočení patří k jeho běžnému stylu.
 * Tilt dělá `escalation`: velikost ≥ 2× úvodní velikost dne, když je po
 * ztrátě nebo je den v mínusu (vzorec 2. 9., 22. 9. a 30. 9.: 2–4 ks → 10–20 ks).
 */
export type LabHotSignal = 'quick' | 'flip' | 'escalation';

export interface LabDay {
  dayKey: string;
  decisions: LabDecision[];
  pnlUsd: number;
  count: number;
  wins: number;
  losses: number;
  maxSize: number;
  /** Medián velikosti prvních 3 rozhodnutí dne. */
  baseSize: number;
  signals: LabHotSignal[][];
  /** Index prvního rozhodnutí s eskalací velikosti v mínusu. */
  breakIndex: number | null;
  tilt: boolean;
}

const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

export function labDays(decisions: readonly LabDecision[]): LabDay[] {
  const byDay = new Map<string, LabDecision[]>();
  for (const decision of [...decisions].sort((a, b) => a.entryAt - b.entryAt)) {
    byDay.set(decision.dayKey, [...(byDay.get(decision.dayKey) ?? []), decision]);
  }
  return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([dayKey, list]) => {
    const baseSize = median(list.slice(0, 3).map(d => d.size));
    let running = 0;
    const signals = list.map(decision => {
      const items: LabHotSignal[] = [];
      if (decision.afterLoss && decision.minutesSincePrevExit != null && decision.minutesSincePrevExit <= LAB_QUICK_REENTRY_MIN) items.push('quick');
      if (decision.afterLoss && decision.directionFlip) items.push('flip');
      if ((decision.afterLoss || running < 0) && baseSize > 0 && decision.size >= baseSize * LAB_ESCALATION_FACTOR) items.push('escalation');
      running += decision.pnlUsd;
      return items;
    });
    const breakIndex = signals.findIndex(items => items.includes('escalation'));
    return {
      dayKey, decisions: list, signals, baseSize,
      pnlUsd: list.reduce((sum, d) => sum + d.pnlUsd, 0),
      count: list.length,
      wins: list.filter(d => d.pnlUsd > 0).length,
      losses: list.filter(d => d.pnlUsd < 0).length,
      maxSize: Math.max(0, ...list.map(d => d.size)),
      breakIndex: breakIndex >= 0 ? breakIndex : null,
      tilt: breakIndex >= 0,
    };
  });
}

// ── B: pravidla na tvých dnech ───────────────────────────────────────────────

export type LabRule =
  | { kind: 'maxLosses'; count: number }
  | { kind: 'dailyStop'; usd: number }
  | { kind: 'cooldown'; minutes: number }
  | { kind: 'noSizeUp' }
  | { kind: 'endAt'; minute: number };

export function labRuleLabel(rule: LabRule): string {
  switch (rule.kind) {
    case 'maxLosses': return `Max ${rule.count} ztrátové obchody za den`;
    case 'dailyStop': return `Denní stop −$${rule.usd.toLocaleString('cs-CZ')} (leader účet)`;
    case 'cooldown': return `Pauza ${rule.minutes} min po ztrátě`;
    case 'noSizeUp': return 'Po ztrátě nezvyšovat velikost';
    case 'endAt': return `Konec v ${Math.floor(rule.minute / 60)}:${String(rule.minute % 60).padStart(2, '0')}`;
  }
}

export interface LabRuleDay {
  dayKey: string;
  actual: number;
  simulated: number;
  /** Rozhodnutí, která by pravidlo nepustilo (nebo zmenšilo). */
  affected: LabDecision[];
  /** Kde pravidlo poprvé zasáhlo. */
  stopAt: LabDecision | null;
}

export interface LabRuleResult {
  rule: LabRule;
  label: string;
  days: LabRuleDay[];
  affectedDays: number;
  /** Součet zlepšení ve dnech, kde pravidlo pomohlo. */
  added: number;
  /** Součet zhoršení ve dnech, kde pravidlo vzalo zisk. */
  taken: number;
  net: number;
}

/**
 * Co by pravidlo udělalo s tvými dny ($ na leaderovi). Předpoklad: ostatní
 * obchody by proběhly stejně — pravidlo jen vynechá (u „nezvyšovat velikost“
 * zmenší na předchozí velikost) obchody, které by nepustilo.
 */
export function labSimulateRule(days: readonly LabDay[], rule: LabRule): LabRuleResult {
  const result: LabRuleDay[] = [];
  for (const day of days) {
    let simulated = 0, losses = 0, stopped = false;
    let lastKept: LabDecision | null = null;
    const affected: LabDecision[] = [];
    for (const decision of day.decisions) {
      let skip = stopped;
      let value = decision.pnlUsd;
      if (!skip && rule.kind === 'endAt' && decision.entryMinute >= rule.minute) skip = true;
      if (!skip && rule.kind === 'cooldown' && lastKept && lastKept.pnlUsd < 0
        && (decision.entryAt - lastKept.exitAt) / 60_000 < rule.minutes) skip = true;
      if (!skip && rule.kind === 'noSizeUp' && lastKept && lastKept.pnlUsd < 0 && decision.size > lastKept.size && decision.size > 0) {
        value = decision.pnlUsd * lastKept.size / decision.size;
        affected.push(decision);
      }
      if (skip) { affected.push(decision); continue; }
      simulated += value;
      lastKept = decision;
      if (decision.pnlUsd < 0) losses += 1;
      if (rule.kind === 'maxLosses' && losses >= rule.count) stopped = true;
      if (rule.kind === 'dailyStop' && simulated <= -rule.usd) stopped = true;
    }
    result.push({ dayKey: day.dayKey, actual: day.pnlUsd, simulated, affected, stopAt: affected[0] ?? null });
  }
  const touched = result.filter(day => day.affected.length > 0);
  const added = touched.reduce((sum, day) => sum + Math.max(0, day.simulated - day.actual), 0);
  const taken = touched.reduce((sum, day) => sum + Math.min(0, day.simulated - day.actual), 0);
  return { rule, label: labRuleLabel(rule), days: result, affectedDays: touched.length, added, taken, net: added + taken };
}

/** Výchozí sada pravidel ke srovnání (Filipova pravidla dne, 2. 9. 2026). */
export const LAB_DEFAULT_RULES: LabRule[] = [
  { kind: 'maxLosses', count: 2 },
  { kind: 'maxLosses', count: 3 },
  { kind: 'dailyStop', usd: 500 },
  { kind: 'cooldown', minutes: 15 },
  { kind: 'noSizeUp' },
  { kind: 'endAt', minute: 17 * 60 },
];
