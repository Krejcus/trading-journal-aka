/**
 * Expirace ARM vázaná na session brokera.
 *
 * Tradovate uzavírá obchodní den v 17:00 America/Chicago. ARM, který
 * přežije konec session, je ARM bez dozoru — proto TTL nekončí po pevném
 * počtu hodin od armování, ale na hranici session.
 *
 * Záměrně jen počítá čas. Co se stane po expiraci, řeší risk gate
 * (`arm-expired` → DISARM), runtime controller (risk-redukující auto-flatten
 * podle `safety.armExpiryFlatten` — jediná automatická broker akce copieru)
 * a watchdog (notifikace).
 */

export const TRADOVATE_SESSION_TIMEZONE = 'America/Chicago';
export const TRADOVATE_SESSION_END_HOUR = 17;

interface ZonedStamp {
  year: number;
  month: number;
  day: number;
  offsetMs: number;
}

function zonedStamp(epochMs: number, timeZone: string): ZonedStamp {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZoneName: 'longOffset',
  }).formatToParts(new Date(epochMs));
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? '';
  const offsetMatch = /GMT([+-])(\d{2}):(\d{2})/.exec(get('timeZoneName'));
  if (!offsetMatch) throw new Error(`Nelze určit offset časové zóny ${timeZone}`);
  const sign = offsetMatch[1] === '-' ? -1 : 1;
  const offsetMs = sign * ((Number(offsetMatch[2]) * 60 + Number(offsetMatch[3])) * 60_000);
  return { year: Number(get('year')), month: Number(get('month')), day: Number(get('day')), offsetMs };
}

/** Epoch okamžiku `endHour:00` daného kalendářního dne v `timeZone`. */
function sessionEndOfDay(
  year: number,
  month: number,
  day: number,
  guessOffsetMs: number,
  timeZone: string,
  endHour: number,
): number {
  // Dvouprůchodová konverze: offset se čte znovu v cílovém okamžiku, aby
  // výpočet seděl i v den přechodu na letní čas. `Date.UTC` normalizuje
  // přetečení dne (31 + 1 apod.).
  let candidate = Date.UTC(year, month - 1, day, endHour) - guessOffsetMs;
  for (let pass = 0; pass < 2; pass += 1) {
    const check = zonedStamp(candidate, timeZone);
    const next = Date.UTC(year, month - 1, day, endHour) - check.offsetMs;
    if (next === candidate) break;
    candidate = next;
  }
  return candidate;
}

/**
 * Milisekundy do nejbližšího konce Tradovate session (17:00 CT).
 *
 * Výsledek je vždy kladný a nejvýše ~25 h (den přechodu času). Armování
 * přesně v 17:00:00 dostane TTL do konce následujícího dne — hranice patří
 * už nové session.
 */
export function msUntilTradovateSessionEnd(
  nowMs: number,
  timeZone: string = TRADOVATE_SESSION_TIMEZONE,
  endHour: number = TRADOVATE_SESSION_END_HOUR,
): number {
  if (!Number.isFinite(nowMs)) throw new Error('msUntilTradovateSessionEnd vyžaduje konečný čas');
  const stamp = zonedStamp(nowMs, timeZone);
  let end = sessionEndOfDay(stamp.year, stamp.month, stamp.day, stamp.offsetMs, timeZone, endHour);
  if (end <= nowMs) {
    // Po 17:00 patří TTL následujícímu KALENDÁŘNÍMU dni zóny. Posun epochy
    // o 24 h by v den přechodu času uměl celý den přeskočit.
    end = sessionEndOfDay(stamp.year, stamp.month, stamp.day + 1, stamp.offsetMs, timeZone, endHour);
  }
  return end - nowMs;
}
