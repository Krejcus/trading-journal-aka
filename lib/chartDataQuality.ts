import type { MarketCandle } from '../services/marketDataCalculations';
import type { CandleFileProblem, CandleValidation } from './candleSnapshotValidation';

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

const PROBLEMS: Record<CandleFileProblem, string> = {
  'download-failed': 'Živý snapshot se nepodařilo přečíst. Příčinou může být síť, přihlášení nebo neexistující soubor; přesnou příčinu zatím nemáme potvrzenou.',
  'snapshot-missing': 'Soubor živých svíček v úložišti chybí (404). Zdroj ho zatím nevytvořil nebo už není dostupný.',
  'access-denied': 'Úložiště odmítlo přístup ke svíčkám (401/403). Je potřeba ověřit přihlášení a oprávnění.',
  'invalid-json': 'Zdroj vrátil poškozený soubor svíček (neplatný JSON). Nový soubor se nepoužil.',
  'invalid-shape': 'Zdroj vrátil neplatný formát souboru svíček. Nový soubor se nepoužil.',
  'invalid-capture-time': 'Soubor má neplatný nebo budoucí čas pořízení. Nový soubor se nepoužil.',
  'market-mismatch': 'Trh nebo kontrakt v souboru neodpovídá tomuto grafu. Nový soubor se nepoužil.',
  'empty-bars': 'Soubor neobsahuje žádné platné minutové svíčky. Nový soubor se nepoužil.',
};

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
  liveSource: string | null; liveProblem?: CandleFileProblem | null;
  validation?: CandleValidation; historicalError?: string | null; historicalLoading?: boolean;
}): ChartDataQuality {
  const reasons: string[] = [];
  const start = Math.floor(input.dayStart / 60_000) * 60;
  const end = Math.floor(Math.min(input.dayEnd, input.now) / 60_000) * 60;
  const times = new Set(input.candles.filter(c => c.time >= start && c.time < end).map(c => c.time));
  let missingMinutes = 0;
  // Only the selected day, not its full 14-day indicator context. Never fill gaps.
  for (let t = start; t < end; t += 60) if (!times.has(t) && regularNasdaqSession(t * 1000)) missingMinutes++;
  if (input.historicalError) reasons.push('Historická data se nepodařilo obnovit. Případná dříve načtená historie zůstává zobrazená.');
  else if (input.historicalLoading) reasons.push('Historie se ještě načítá; dostupný rozsah zatím není konečný.');
  if (input.needsLive) {
    if (input.liveProblem) reasons.push(PROBLEMS[input.liveProblem]);
    else if (input.liveStatus === 'loading') reasons.push('Čekáme na živý snapshot. Historie má přibližně 24 hodin a 20 minut zpoždění, poslední část dne proto zatím může chybět.');
    else if (input.liveStatus === 'unavailable') reasons.push('Živý snapshot není dostupný. Zpožděná historie sama poslední část dne nepokryje.');
    if (input.liveStatus === 'stale') {
      reasons.push(regularNasdaqSession(input.now)
        ? 'Snapshot je starší než 5 minut. Zdroj svíček se neobnovuje v očekávaném intervalu; může být vypnutý worker, cenový zdroj nebo přerušené spojení.'
        : 'Snapshot je starší než 5 minut. Podle běžného rozvrhu je trh zavřený; starý snapshot sám o sobě nedokazuje chybějící poslední seanci.');
    }
    if (input.validation?.discardedRows) reasons.push(`Validace vyřadila ${input.validation.discardedRows} vadných, duplicitních nebo neseřazených řádků. Jejich hodnoty se v grafu nepoužily.`);
    if (input.validation?.unknownVolume) reasons.push('Část svíček nemá ověřený objem. Objemové indikátory mohou být nepřesné.');
    if (input.validation?.priceFamilyProxy) reasons.push('Zdroj používá jiný nástroj ze stejné cenové rodiny (například NQ místo MNQ). Jejich skutečné OHLC a objemy nemusí být totožné.');
    if (input.validation && !input.validation.sourceVerified) reasons.push('U souboru nelze ověřit označení cenového zdroje.');
  }
  if (missingMinutes) reasons.push(`V běžné seanci chybí minutové záznamy: ${missingMinutes}. Bez úplných dat poskytovatele nerozlišíme výpadek, svátek ani minutu bez obchodů. Pokrytí je neověřené; svíčky nedoplňujeme odhadem.`);
  const warned = reasons.length > 0;
  const last = input.candles.at(-1);
  return {
    tone: warned ? 'warn' : 'info',
    title: input.historicalError || input.liveProblem ? 'Svíčky: obnova selhala'
      : input.liveStatus === 'stale' && input.needsLive ? 'Svíčky: starý snapshot'
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
