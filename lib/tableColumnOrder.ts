/**
 * Pořadí sloupců v tabulkách na záložce LIVE.
 *
 * Uložené pořadí je jen seznam klíčů v localStorage. Kód se mění častěji než
 * uživatelovo nastavení, takže se nikdy nespoléhá na to, že uložený seznam
 * odpovídá dnešním sloupcům: neznámý klíč se zahodí a sloupec, který v appce
 * mezitím přibyl, se vrátí na své výchozí místo — jinak by po aktualizaci
 * tiše spadl na konec tabulky, kde by ho nikdo nehledal.
 */
export function applyColumnOrder<K extends string>(defaults: readonly K[], stored: readonly unknown[]): K[] {
  const known = new Set<string>(defaults);
  const seen = new Set<string>();
  const ordered: K[] = [];
  for (const key of stored) {
    if (typeof key !== 'string' || !known.has(key) || seen.has(key)) continue;
    ordered.push(key as K);
    seen.add(key);
  }
  defaults.forEach((key, index) => {
    if (seen.has(key)) return;
    ordered.splice(Math.min(index, ordered.length), 0, key);
  });
  return ordered;
}

/** Přesun jedné položky. Index mimo rozsah se ořízne, pořadí zůstane úplné. */
export function moveColumn<K>(order: readonly K[], from: number, to: number): K[] {
  const next = [...order];
  if (from < 0 || from >= next.length) return next;
  const target = Math.min(Math.max(to, 0), next.length - 1);
  next.splice(target, 0, next.splice(from, 1)[0]);
  return next;
}

/**
 * Sloupec s názvem účtu a sloupec s akcemi drží krajní pozice bez ohledu na
 * uložené pořadí: název je kotva řádku a akce jsou jediné místo, kde se dá
 * zasáhnout do obchodu — obojí musí být vždy tam, kde to oko čeká.
 */
export function pinColumnEdges<K extends string>(order: readonly K[], first: K, last: K): K[] {
  return [first, ...order.filter(key => key !== first && key !== last), last];
}
