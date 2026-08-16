/**
 * Intradenní hranice, za kterou backtest nesmí držet futures pozici.
 *
 * Výchozí profil odpovídá FundedNext Futures / Topstep (15:10 CT). Není
 * schovaný v pražském čase, takže přechody evropského a amerického DST datum
 * neposunou. Jiné prop firmy mohou config přepsat (např. Tradeify 16:45 ET).
 */
export const DEFAULT_BACKTEST_FLAT_TIME_ZONE = 'America/Chicago';
export const DEFAULT_BACKTEST_FLAT_BY_MINUTE = 15 * 60 + 10;

const localClock = (unixSeconds: number, timeZone: string): { minute: number; second: number } => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(unixSeconds * 1_000));
  const value = (type: string) => Number(parts.find(part => part.type === type)?.value ?? '0');
  return { minute: value('hour') * 60 + value('minute'), second: value('second') };
};

/** Cutoff obchodní session, do které daný okamžik patří. */
export const backtestSessionCutoffSeconds = (
  openedAt: number,
  timeZone = DEFAULT_BACKTEST_FLAT_TIME_ZONE,
  flatByMinute = DEFAULT_BACKTEST_FLAT_BY_MINUTE,
): number => {
  const current = localClock(openedAt, timeZone);
  const remaining = flatByMinute - current.minute;
  return openedAt - current.second + (remaining >= 0 ? remaining : remaining + 24 * 60) * 60;
};
