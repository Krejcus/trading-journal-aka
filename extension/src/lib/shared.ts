// ─────────────────────────────────────────────────────────────────────────────
// Sdílené konstanty extensionu — JEDINÝ zdroj pravdy pro TradeForm i recompute.
// (Dřív dvě ručně synchronizované kopie: rozjezd = live zápis a backfill počítaly
// excursion s jiným cutoffem / jiným instrument rootem, tiše a bez chyby.)
// POZOR: nic odsud se nesmí importovat do MAIN-world funkcí v positionReaderu
// (ty musí zůstat self-contained kvůli serializaci) — tam se hodnoty PŘEDÁVAJÍ.
// ─────────────────────────────────────────────────────────────────────────────

/** No-overnight cutoff: excursion/counterfactual sken končí 22:00 (flat-by). */
export const FLAT_BY_MIN = 22 * 60;

/** Normalizace kontraktu na mikro root pro párování obchod ↔ graf. */
export const INSTRUMENT_MAP: Record<string, string> = {
    NQ: 'MNQ', ES: 'MES', CL: 'MCL', GC: 'MGC', RTY: 'M2K', YM: 'MYM', SI: 'SIL', ZB: 'ZB', ZN: 'ZN',
};

export function instrRoot(symbol: string): string {
    const clean = String(symbol || '').replace(/[0-9!:_-].*$/, '').toUpperCase();
    return INSTRUMENT_MAP[clean] || clean;
}
