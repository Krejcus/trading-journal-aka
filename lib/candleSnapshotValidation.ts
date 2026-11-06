import { barsContractConflicts, normalizeBarsContract, sanitizeTvBars, tvPriceFamily, tvSymbolRoot, type TvBar } from './tradingViewBars';

export type CandleFileProblem = 'invalid-json' | 'invalid-shape' | 'invalid-capture-time' | 'market-mismatch' | 'empty-bars' | 'download-failed' | 'snapshot-missing' | 'access-denied';
export interface CandleValidation {
  discardedRows: number;
  trimmedRows: number;
  unknownVolume: boolean;
  sourceVerified: boolean;
  priceFamilyProxy: boolean;
  contract: string | null;
}
export type CandleFileResult = { ok: false; problem: CandleFileProblem } | {
  ok: true; at: number; bars: TvBar[]; source: string; validation: CandleValidation;
};

const sourceRoot = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const symbol = value.slice(value.lastIndexOf(':') + 1);
  const dated = normalizeBarsContract(symbol);
  return dated ? tvSymbolRoot(dated.slice(0, -5)) : tvSymbolRoot(value);
};

/** Pure boundary validation; legacy files may omit root/contract, never invent them. */
export function inspectCandleSnapshot(text: string, requestedSymbol: string, now = Date.now()): CandleFileResult {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { ok: false, problem: 'invalid-json' }; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, problem: 'invalid-shape' };
  const body = value as Record<string, unknown>;
  const at = body.at;
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at <= 0 || at > now + 300_000) return { ok: false, problem: 'invalid-capture-time' };
  const root = sourceRoot(requestedSymbol);
  const source = typeof body.source === 'string' ? body.source.slice(0, 64) : '';
  const originRoot = sourceRoot(source);
  const declaredRoot = body.root == null ? null : sourceRoot(body.root);
  const contract = normalizeBarsContract(body.contract);
  if (body.contract != null && !contract) return { ok: false, problem: 'invalid-shape' };
  const sourceContract = normalizeBarsContract(source.slice(source.lastIndexOf(':') + 1));
  const sourceShortSymbol = sourceContract ? sourceContract.slice(0, -4) + sourceContract.slice(-2) : '';
  const requestedContract = normalizeBarsContract(requestedSymbol.slice(requestedSymbol.lastIndexOf(':') + 1));
  const requestedShortSymbol = requestedContract ? requestedContract.slice(0, -4) + requestedContract.slice(-2) : requestedSymbol;
  if (!root || (body.root != null && !declaredRoot)
    || [declaredRoot, originRoot, contract ? sourceRoot(contract) : null].some(candidate => candidate && tvPriceFamily(candidate) !== tvPriceFamily(root))
    || barsContractConflicts(contract, requestedShortSymbol)
    || barsContractConflicts(sourceContract, requestedShortSymbol)
    || (sourceContract && barsContractConflicts(contract, sourceShortSymbol))) return { ok: false, problem: 'market-mismatch' };
  const bars = sanitizeTvBars(body.bars, at);
  if (!bars.length) return { ok: false, problem: 'empty-bars' };
  const raw = body.bars as unknown[];
  const cutoff = Math.floor(at / 1000) - 27 * 3600;
  const trimmedRows = raw.filter(row => Array.isArray(row) && typeof row[0] === 'number' && row[0] < cutoff).length;
  const accepted = new Set(bars.map(bar => bar[0]));
  const unknownVolume = raw.some(row => Array.isArray(row) && accepted.has(row[0])
    && (typeof row[5] !== 'number' || !Number.isFinite(row[5]) || row[5] < 0));
  return { ok: true, at, bars, source, validation: {
    discardedRows: Math.max(0, raw.length - bars.length - trimmedRows), trimmedRows,
    unknownVolume, sourceVerified: !!originRoot, priceFamilyProxy: !!originRoot && originRoot !== root, contract,
  } };
}
