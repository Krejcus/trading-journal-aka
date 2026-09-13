import { tradovateSessionEndAt } from '../services/copierArmSession.js';

/** Date of the session ending at 17:00 Chicago, not the browser's date. */
export function tradovateDisplayTradeDate(now = Date.now()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'})
    .formatToParts(new Date(tradovateSessionEndAt(now)));
  return ['year','month','day'].map(type => parts.find(part => part.type === type)?.value).join('-');
}

export function explicitTradovateTradeDate(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const { year, month, day } = value as Record<string, unknown>;
  if (![year,month,day].every(Number.isSafeInteger)) return null;
  const date = new Date(Date.UTC(year as number, (month as number)-1, day as number));
  if (date.getUTCFullYear() !== year || date.getUTCMonth()+1 !== month || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0,10);
}
