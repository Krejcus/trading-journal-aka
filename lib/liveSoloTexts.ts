/**
 * Texty pro obchodování na JEDNOM účtu bez kopírky (napojení na Rithmic). Obrazovka LIVE vznikla
 * pro leadera s kopírkou a její hlášky mluví o „leaderovi" a „kopiích" — tady nic takového není.
 * Jen zobrazení: význam výsledku se nemění, jen slova.
 */
const EXACT: Readonly<Record<string, string>> = {
  'Vstup zrušen; kopírka zruší kopie.': 'Vstup zrušen.',
  'Leader zavřen; kopírka zavírá kopie.': 'Pozice zavřena.',
  'Posunuto u leadera; kopírka posune kopie.': 'Posunuto.',
  'SL a TP doplněny u leadera; kopírka je doplní kopiím.': 'SL a TP doplněny.',
  'Přidáno u leadera.': 'Přidáno.',
  'Zrušeno u leadera.': 'Zrušeno.',
  'Výsledek neznámý — zkontroluj leadera v Tradovate.': 'Výsledek neznámý — zkontroluj účet u brokera.',
};

export function liveSoloNoticeText(text: string): string {
  const exact = EXACT[text];
  if (exact) return exact;
  return text
    .replace(/ — kopírka by followerům posun nestihla\./, '.')
    .replace(/zkontroluj leadera v Tradovate/g, 'zkontroluj účet u brokera')
    .replace(/ u leadera/g, '');
}
