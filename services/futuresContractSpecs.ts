/**
 * USD hodnota jednoho celého bodu ceny pro běžné futures kontrakty.
 *
 * Copier ji potřebuje jedině pro denní risk počítadlo (auto day-lock):
 * realizovaný P&L leadera = rozdíl cen × point value. Broker API hodnotu
 * kontraktu neposílá a copier nesmí kvůli počítadlu tahat market data.
 *
 * Neznámý symbol vrací `null` — volající pak USD částku NEpočítá (žádný
 * tichý odhad multiplikátorem 1) a smí dál používat jen znaménko P&L
 * v bodech, které hodnotu kontraktu nepotřebuje.
 */

const POINT_VALUE_USD: Record<string, number> = {
  // CME equity index
  ES: 50, MES: 5,
  NQ: 20, MNQ: 2,
  RTY: 50, M2K: 5,
  YM: 5, MYM: 0.5,
  NKD: 5,
  // Energie
  CL: 1000, MCL: 100,
  NG: 10_000, MNG: 1000,
  RB: 42_000, HO: 42_000,
  // Kovy
  GC: 100, MGC: 10,
  SI: 5000, SIL: 1000,
  HG: 25_000, MHG: 2500,
  PL: 50,
  // Úrokové
  ZB: 1000, ZN: 1000, ZF: 1000, ZT: 2000,
  UB: 1000, TN: 1000,
  // FX (cena v USD za jednotku × velikost kontraktu)
  '6E': 125_000, M6E: 12_500,
  '6B': 62_500, M6B: 6250,
  '6A': 100_000, M6A: 10_000,
  '6C': 100_000, '6J': 12_500_000, '6S': 125_000,
  // Krypto
  BTC: 5, MBT: 0.1,
  ETH: 50, MET: 0.1,
};

/**
 * Tradovate symbol = kořen + měsíční písmeno + 1–2 číslice roku
 * (`MNQZ5`, `NQH26`, `M2KU5`, `6EZ5`). Kořen smí obsahovat číslice,
 * proto je non-greedy a měsíční písmeno se párá od konce.
 */
const SYMBOL_PATTERN = /^([A-Z0-9]+?)([FGHJKMNQUVXZ])(\d{1,2})$/;

export function futuresSymbolRoot(symbol: string): string {
  const normalized = symbol.trim().toUpperCase();
  const match = SYMBOL_PATTERN.exec(normalized);
  return match ? match[1] : normalized;
}

/** USD za jeden celý bod ceny, nebo `null` pro neznámý kontrakt. */
export function pointValueUsd(symbol: string): number | null {
  return POINT_VALUE_USD[futuresSymbolRoot(symbol)] ?? null;
}
