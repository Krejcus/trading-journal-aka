/**
 * JSON s klíči objektů seřazenými rekurzivně (pole drží pořadí). Postgres `jsonb`
 * vrací klíče v jiném pořadí, než je appka zapsala — porovnání přes obyčejný
 * `JSON.stringify` by pak hlásilo změnu, která není.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (!value || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(source).sort().map(key => [key, sortKeysDeep(source[key])]));
}
