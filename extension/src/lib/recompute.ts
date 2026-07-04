// ─────────────────────────────────────────────────────────────────────────────
// Backfill „pending" excursion — dopočítá obchody, u kterých sken při zápisu narazil
// na konec barů (den ještě nedojel do flat-by 22:00). Když je teď graf na správném
// instrumentu a bary už okno pokrývají, přepočítá counterfactual/excursion BEZ RR boxu
// (přes entryOverride) a uloží úplný výsledek. Volá se při otevření sidebaru + ručně.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from './supabase';
import { computeCounterfactual } from './positionReader';

const FLAT_BY_MIN = 22 * 60; // musí sedět s TradeForm (no-overnight cutoff)

// Root instrumentu pro párování s aktuálním grafem (kopie z TradeForm — extension nemá sdílený util).
const INSTRUMENT_MAP: Record<string, string> = { NQ: 'MNQ', ES: 'MES', CL: 'MCL', GC: 'MGC', RTY: 'M2K', YM: 'MYM', SI: 'SIL', ZB: 'ZB', ZN: 'ZN' };
function instrRoot(symbol: string): string {
    const clean = String(symbol || '').replace(/[0-9!:_-].*$/, '').toUpperCase();
    return INSTRUMENT_MAP[clean] || clean;
}

export interface BackfillResult { checked: number; completed: number; stillPending: number; }

/**
 * Dopočítá pending excursion pro obchody odpovídající aktuálnímu grafu.
 * @param chartSymbol symbol z aktivního panelu (getChartLayout().panes[0].sym)
 * @param opts.max max počet obchodů na jeden běh (default 12 — ať to netrvá věčnost)
 */
export async function backfillPendingExcursions(chartSymbol: string, opts?: { max?: number }): Promise<BackfillResult> {
    const empty: BackfillResult = { checked: 0, completed: 0, stillPending: 0 };
    const root = instrRoot(chartSymbol);
    if (!root) return empty;

    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return empty;

    // Pending = AlphaBridge zápis, u kterého excursion sken nedojel (excursionComplete === false).
    // Starší obchody bez tohoto pole se neberou (null ≠ 'false') — cíleně jen nově označené.
    const { data: rows, error } = await supabase
        .from('trades')
        .select('id, direction, data')
        .eq('user_id', session.user.id)
        .eq('data->>excursionComplete', 'false')
        .limit(200);
    if (error || !rows || !rows.length) return empty;

    // Jen obchody na aktuálním instrumentu (root match) — jinak by se počítaly z cizích barů.
    const minePending = rows.filter((r: any) => instrRoot((r.data || {}).instrument || '') === root);
    if (!minePending.length) return empty;

    // Fan-out kopie (1 reálný obchod = N zápisů na účty) sdílí STEJNÝ entry/SL/TP/čas → excursion
    // (R hodnoty i ceny) je identický. Grupujeme podle signatury a počítáme JEDNOU na skupinu,
    // výsledek aplikujeme na všechny kopie. Den s 10 kopiemi se tak dopočítá jedním skenem (ne deseti)
    // a strop `max` (počet skupin = reálných obchodů) přestane omezovat počet kopií.
    const groups = new Map<string, any[]>();
    for (const r of minePending) {
        const d = r.data || {};
        const dir = String(r.direction || d.direction || '').toUpperCase();
        const key = `${d.entryPrice}|${d.stopLoss}|${d.takeProfit}|${d.entryTime}|${dir}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(r);
    }
    const groupList = Array.from(groups.values()).slice(0, opts?.max ?? 12);

    let checked = 0, completed = 0, stillPending = 0;
    for (const groupRows of groupList) {
        checked += groupRows.length;
        const d0 = groupRows[0].data || {};
        const entry = Number(d0.entryPrice), sl = Number(d0.stopLoss), tp = Number(d0.takeProfit);
        const entryMs = Number(d0.entryTime);
        if (![entry, sl, tp, entryMs].every(Number.isFinite)) { stillPending += groupRows.length; continue; }
        const isLong = String(groupRows[0].direction || d0.direction || '').toUpperCase() === 'LONG';

        // Jeden sken na celou skupinu.
        const res = await computeCounterfactual(undefined, null, FLAT_BY_MIN, {
            isLong, entry, sl, tp, entryUnix: Math.round(entryMs / 1000),
        });
        if (!res.ok || !res.excursion || !res.excursion.available || res.excursion.stopReason === 'end') {
            stillPending += groupRows.length; continue; // bary pořád nestačí → nech celou skupinu pending
        }

        const cf = (res.swing || res.ote || res.fvg || res.tpTargets)
            ? { available: true, isLong: res.isLong, entry: res.entry, tp: res.tp, swing: res.swing, ote: res.ote, fvg: res.fvg, tpTargets: res.tpTargets }
            : null;

        // Aplikuj shodný výsledek na VŠECHNY kopie skupiny. Každá si drží svůj data blob
        // (účet, pnl, riskAmount) — přepisujeme jen counterfactual/excursion/entryMap + příznak.
        for (const r of groupRows) {
            const d = r.data || {};
            const merged = {
                ...d,
                counterfactual: cf || d.counterfactual,
                excursion: res.excursion,
                entryMap: res.entryMap || d.entryMap,
                excursionComplete: true,
            };
            const { error: upErr } = await supabase.from('trades').update({ data: merged }).eq('id', r.id).eq('user_id', session.user.id);
            if (upErr) stillPending++; else completed++;
        }
    }
    return { checked, completed, stillPending };
}
