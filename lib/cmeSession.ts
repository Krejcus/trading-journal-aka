/**
 * Hrubý odhad, zda CME Globex obchoduje: neděle 17:00 až pátek 16:00 v Chicagu, denní pauza 16:00–17:00.
 * **Jen zobrazení** (hlášení výpadku, nápis na telefonu), nikdy risk, ARM ani limity (INV-RISK-04): svátky
 * a zkrácené seance nezná, takže o nich tvrdí, že je otevřeno. Vlastní soubor, ať se vlákno
 * ceny nemusí vázat na `services/copierArmSession.ts`.
 */
const CHICAGO = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago', weekday: 'short', hour: '2-digit', hourCycle: 'h23',
});

export function cmeFuturesSessionOpen(at: number): boolean {
  const parts = CHICAGO.formatToParts(new Date(at));
  const weekday = parts.find(part => part.type === 'weekday')?.value ?? '';
  const hour = Number(parts.find(part => part.type === 'hour')?.value);
  if (!Number.isFinite(hour)) return false;
  if (weekday === 'Sat') return false;
  if (weekday === 'Sun') return hour >= 17;
  if (weekday === 'Fri') return hour < 16;
  return hour !== 16;
}
