/**
 * Doběhnutí čísla na dashboardu: z hotového textu („-$1,008“, „42.9%“,
 * „+0.42R“) vytáhne číslo a umí ho vypsat zpět ve stejné podobě s jinou
 * hodnotou. Čistě zobrazovací — konečný text je vždy přesně ten původní.
 */

export interface NumericText {
  prefix: string;
  suffix: string;
  /** Velikost čísla bez znaménka (znaménko zůstává v `prefix`). */
  value: number;
  decimals: number;
  groupSeparator: string;
  decimalSeparator: string;
}

const NUMBER_RUN = /\d(?:[\d.,\s]*\d)?/;

/** Vrátí null, když v textu není číslo, které jde bezpečně animovat (např. „∞“, „—“). */
export function parseNumericText(text: string): NumericText | null {
  const match = NUMBER_RUN.exec(text);
  if (!match) return null;
  const run = match[0];
  const prefix = text.slice(0, match.index), suffix = text.slice(match.index + run.length);
  // Druhé číslo v textu („12/40 dnů“) neumíme — raději neanimovat.
  if (/\d/.test(suffix) || /\d/.test(prefix)) return null;
  const lastSeparator = Math.max(run.lastIndexOf('.'), run.lastIndexOf(','));
  const tail = lastSeparator >= 0 ? run.length - lastSeparator - 1 : 0;
  // Oddělovač následovaný přesně třemi číslicemi je oddělovač tisíců („1,008“), jinak desetinný.
  const hasDecimal = lastSeparator >= 0 && tail !== 3;
  const decimalSeparator = hasDecimal ? run[lastSeparator] : '.';
  const integerPart = hasDecimal ? run.slice(0, lastSeparator) : run;
  const fraction = hasDecimal ? run.slice(lastSeparator + 1) : '';
  const groupMatch = /[^\d]/.exec(integerPart);
  const value = Number(`${integerPart.replace(/[^\d]/g, '')}${fraction ? `.${fraction}` : ''}`);
  if (!Number.isFinite(value)) return null;
  return { prefix, suffix, value, decimals: fraction.length, groupSeparator: groupMatch ? groupMatch[0] : '', decimalSeparator };
}

/** Vypíše `value` ve tvaru původního textu (stejný prefix, sufix, oddělovače a počet desetinných míst). */
export function formatNumericText(shape: NumericText, value: number): string {
  const fixed = Math.abs(value).toFixed(shape.decimals);
  const [integer, fraction] = fixed.split('.');
  const grouped = shape.groupSeparator ? integer.replace(/\B(?=(\d{3})+(?!\d))/g, shape.groupSeparator) : integer;
  return `${shape.prefix}${grouped}${fraction ? `${shape.decimalSeparator}${fraction}` : ''}${shape.suffix}`;
}

/** Zpomalení ke konci (ease-out cubic), 0–1 → 0–1. */
export const easeOutCubic = (t: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);
