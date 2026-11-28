/**
 * Kdy je trh NQ zavřený: denní přestávka CME (po–čt 16:00–17:00 Chicago) a víkend (pá 16:00 – ne 17:00 Chicago).
 * Počítá se v America/Chicago, takže sedí i v týdnech, kdy USA a Evropa mění čas v jiný den (INV-RISK-04).
 * Svátky se neřeší (zkrácený den jen znamená, že se okno nevyužije).
 */

const CT_PARTS = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const ctParts = (ms: number) => {
  const p = Object.fromEntries(CT_PARTS.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, wd: WEEKDAYS[p.weekday] };
};

/** UTC ms pro místní čas v Chicagu. */
export function chicagoToUtcMs(y: number, m: number, d: number, h: number, mi = 0): number {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const offset = (ms: number) => { const p = ctParts(ms); return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) - Math.floor(ms / 60_000) * 60_000; };
  let ms = guess - offset(guess);
  ms = guess - offset(ms);
  return ms;
}

/**
 * Smí teď stahování historie pozastavit službu ve čtení? Jen v zavřeném trhu a s rezervou 10 min před otevřením.
 * Vrací čas (UTC ms), do kdy se musí čtení vrátit, nebo null (trh je otevřený nebo se brzy otevře).
 */
export function historyPauseDeadline(nowMs: number, reserveMin = 10): number | null {
  const p = ctParts(nowMs);
  const minutes = p.h * 60 + p.mi;
  const dayMs = (offsetDays: number) => { const t = new Date(Date.UTC(p.y, p.m - 1, p.d + offsetDays)); return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()] as const; };
  const reopenAt = (offsetDays: number) => { const [y, m, d] = dayMs(offsetDays); return chicagoToUtcMs(y, m, d, 17, 0) - reserveMin * 60_000; };
  let deadline: number | null = null;
  if (p.wd >= 1 && p.wd <= 4 && minutes >= 16 * 60 && minutes < 17 * 60) deadline = reopenAt(0);
  else if (p.wd === 5 && minutes >= 16 * 60) deadline = reopenAt(2);
  else if (p.wd === 6) deadline = reopenAt(1);
  else if (p.wd === 0 && minutes < 17 * 60) deadline = reopenAt(0);
  return deadline !== null && deadline > nowMs ? deadline : null;
}
