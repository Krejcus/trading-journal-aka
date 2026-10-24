/**
 * Dopočítávání čísel v KPI („+$4 710“, „43.8%“, „1.17“): text se rozdělí na
 * předponu, číslo a příponu a číslo se při animaci formátuje stejně jako
 * originál (oddělovač tisíců, počet desetinných míst). Neznámý tvar
 * (∞, —, text) se neanimuje.
 */

export interface NumericParts {
  prefix: string;
  value: number;
  decimals: number;
  groupSep: string | null;
  decimalSep: '.' | ',';
  suffix: string;
}

const TOKEN = /\d[\d   ,.']*\d|\d/;

export function splitNumeric(text: string): NumericParts | null {
  const match = TOKEN.exec(text);
  if (!match || match.index === undefined) return null;
  const token = match[0];
  const prefix = text.slice(0, match.index);
  const suffix = text.slice(match.index + token.length);
  // Desetinná čárka/tečka = poslední „.“ nebo „,“, za nímž nejsou přesně 3 číslice
  // (3 číslice = oddělovač tisíců, např. 4,710 v en).
  const lastSep = Math.max(token.lastIndexOf('.'), token.lastIndexOf(','));
  let decimals = 0;
  let decimalSep: '.' | ',' = '.';
  let intPart = token;
  if (lastSep >= 0) {
    const tail = token.slice(lastSep + 1);
    const sep = token[lastSep] as '.' | ',';
    const otherSeps = token.slice(0, lastSep).replace(/\d/g, '');
    const isDecimal = tail.length !== 3 || (otherSeps.includes(sep) === false && otherSeps.length > 0);
    if (isDecimal && /^\d+$/.test(tail)) {
      decimals = tail.length;
      decimalSep = sep;
      intPart = token.slice(0, lastSep);
    }
  }
  const groupMatch = /[^\d]/.exec(intPart);
  const groupSep = groupMatch ? groupMatch[0] : null;
  const digits = intPart.replace(/[^\d]/g, '');
  const fraction = decimals ? token.slice(lastSep + 1) : '';
  const value = Number(`${digits}${fraction ? `.${fraction}` : ''}`);
  if (!Number.isFinite(value)) return null;
  return { prefix, value, decimals, groupSep, decimalSep, suffix };
}

export function formatLike(value: number, parts: NumericParts): string {
  const fixed = Math.abs(value).toFixed(parts.decimals);
  const [int, frac] = fixed.split('.');
  const grouped = parts.groupSep ? int.replace(/\B(?=(\d{3})+(?!\d))/g, parts.groupSep) : int;
  return `${parts.prefix}${grouped}${frac ? `${parts.decimalSep}${frac}` : ''}${parts.suffix}`;
}

/** Stejný tvar čísla (předpona, přípona, desetinná místa) → lze plynule navázat. */
export const sameShape = (a: NumericParts, b: NumericParts) =>
  a.prefix === b.prefix && a.suffix === b.suffix && a.decimals === b.decimals;

/** Rychlý start, měkké doběhnutí. */
export const easeOutCubic = (t: number) => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3;
