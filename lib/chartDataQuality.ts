import type { MarketCandle } from '../services/marketDataCalculations';

const ny = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
/** Regular NQ/MNQ session only; holiday/exception calendars are not inferred. */
export function regularNasdaqSession(timeMs: number): boolean {
  const parts = ny.formatToParts(timeMs);
  const day = parts.find(p => p.type === 'weekday')?.value;
  const hour = Number(parts.find(p => p.type === 'hour')?.value);
  const minute = Number(parts.find(p => p.type === 'minute')?.value);
  // CME Micro E-mini FAQ: 18:00–17:00 ET, with the 16:15–16:30 halt.
  return day !== 'Sat' && !(day === 'Sun' && hour < 18) && !(day === 'Fri' && hour >= 17) && hour !== 17
    && !(hour === 16 && minute >= 15 && minute < 30);
}

export interface ChartDataQuality {
  tone: 'info' | 'warn';
  title: string;
  reasons: string[];
  lastCandleAt: number | null;
  capturedAt: number | null;
  missingMinutes: number;
  source: string;
}

export function chartDataQuality(input: {
  candles: readonly MarketCandle[]; dayStart: number; dayEnd: number; now: number;
  needsLive: boolean; liveStatus: string | null; liveCapturedAt: number | null;
  liveSource: string | null; historicalError?: string | null; historicalLoading?: boolean;
}): ChartDataQuality {
  const reasons: string[] = [];
  const start = Math.floor(input.dayStart / 60_000) * 60;
  const end = Math.floor(Math.min(input.dayEnd, input.now) / 60_000) * 60;
  const times = new Set(input.candles.filter(c => c.time >= start && c.time < end).map(c => c.time));
  let missingMinutes = 0;
  // Only the selected day, not its full 14-day indicator context. Never fill gaps.
  for (let t = start; t < end; t += 60) if (!times.has(t) && regularNasdaqSession(t * 1000)) missingMinutes++;
  if (input.historicalError) reasons.push(`Historická data se nepodařilo obnovit: ${input.historicalError} Případná dříve načtená historie zůstává zobrazená.`);
  else if (input.historicalLoading) reasons.push('Historie se ještě načítá; dostupný rozsah zatím není konečný.');
  if (input.needsLive) {
    if (input.liveStatus === 'loading') reasons.push('Čekáme na svíčky ze služby Rithmic. Historie má přibližně 24 hodin a 20 minut zpoždění, poslední část dne proto zatím může chybět.');
    else if (input.liveStatus === 'unavailable') reasons.push('Služba Rithmic na Macu neběží nebo neposílá tento trh. Zpožděná historie sama poslední část dne nepokryje.');
    if (input.liveStatus === 'stale') {
      reasons.push(regularNasdaqSession(input.now)
        ? 'Služba Rithmic neposílá čerstvé ceny: spojení se službou spadlo, služba mlčí nebo její spojení pro ceny stojí. Poslední část dne může chybět.'
        : 'Služba Rithmic neposílá čerstvé ceny. Podle běžného rozvrhu je trh zavřený; samo o sobě to nedokazuje chybějící poslední seanci.');
    }
  }
  if (missingMinutes) reasons.push(`V běžné seanci chybí minutové záznamy: ${missingMinutes}. Bez úplných dat poskytovatele nerozlišíme výpadek, svátek ani minutu bez obchodů. Pokrytí je neověřené; svíčky nedoplňujeme odhadem.`);
  const warned = reasons.length > 0;
  const last = input.candles.at(-1);
  return {
    tone: warned ? 'warn' : 'info',
    title: input.historicalError ? 'Svíčky: obnova selhala'
      : input.liveStatus === 'stale' && input.needsLive ? 'Svíčky: živá data stojí'
      : input.historicalLoading || (input.needsLive && input.liveStatus === 'loading') ? 'Svíčky: načítání'
      : !input.candles.length ? 'Svíčky: data chybí'
      : warned ? 'Svíčky: pokrytí neověřené' : 'Svíčky: načtené',
    reasons: warned ? reasons : ['V načtené části běžné seance nejsou zjištěné mezery. To není nezávislé potvrzení úplnosti ani přesnosti vůči burze.'],
    lastCandleAt: last ? last.time * 1000 : null,
    capturedAt: input.needsLive ? input.liveCapturedAt : null,
    missingMinutes,
    source: input.needsLive && input.liveSource ? `Historie + ${input.liveSource}` : 'Historie',
  };
}
