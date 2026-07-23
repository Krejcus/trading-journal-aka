// ─────────────────────────────────────────────────────────────────────────────
// Backfill „pending" excursion — dopočítá obchody, u kterých sken při zápisu narazil
// na konec barů (den ještě nedojel do flat-by 22:00). Když je teď graf na správném
// instrumentu a bary už okno pokrývají, přepočítá counterfactual/excursion BEZ RR boxu
// (přes entryOverride) a uloží úplný výsledek. Volá se při otevření sidebaru + ručně.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from './supabase';
import { computeCounterfactual, getChartLayout } from './positionReader';
import { FLAT_BY_MIN, instrRoot } from './shared';

export interface BackfillResult { checked: number; completed: number; stillPending: number; }

/** Root symbolu AKTUÁLNĚ zobrazeného grafu (nebo '' když nejde přečíst). */
async function currentChartRoot(): Promise<string> {
    try {
        const lay: any = await getChartLayout();
        const sym = (lay && lay.panes && lay.panes[0] && lay.panes[0].sym) || '';
        return instrRoot(sym);
    } catch { return ''; }
}

/**
 * Dopočítá pending excursion pro obchody odpovídající aktuálnímu grafu.
 * @param chartSymbol symbol z aktivního panelu (getChartLayout().panes[0].sym)
 * @param opts.max max počet obchodů na jeden běh (default 12 — ať to netrvá věčnost)
 */
export async function backfillPendingExcursions(chartSymbol: string, opts?: { max?: number; shouldStop?: () => boolean }): Promise<BackfillResult> {
    const empty: BackfillResult = { checked: 0, completed: 0, stillPending: 0 };
    const root = instrRoot(chartSymbol);
    if (!root) return empty;

    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return empty;

    // Pending = excursion nebo nová 1m execution path ještě nemá dost budoucích barů.
    // Starší obchody bez těchto polí se neberou — cíleně jen nově označené záznamy.
    const { data: rows, error } = await supabase
        .from('trades')
        .select('id, direction, data')
        .eq('user_id', session.user.id)
        .or('data->>excursionComplete.eq.false,data->>executionPathComplete.eq.false')
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
        // Abort (zavřený sidebar) + OCHRANA PROTI CIZÍMU GRAFU: uživatel může uprostřed
        // běhu přepnout symbol — sken by pak počítal MNQ obchody z CL barů a trvale
        // uložil křivá čísla. Před každou skupinou ověř, že graf pořád ukazuje náš root.
        if (opts?.shouldStop?.()) { stillPending += groupRows.length; continue; }
        if ((await currentChartRoot()) !== root) {
            stillPending += groupRows.length;
            continue; // graf už není na našem instrumentu → zbytek nech pending
        }
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
        if (!res.ok) { stillPending += groupRows.length; continue; }
        const excursionDone = !!(res.excursion && res.excursion.available && res.excursion.stopReason !== 'end');
        const pathDone = !!(res.executionPath && res.executionPath.available && res.executionPath.complete);
        // Dokonči jen to, co daná skupina opravdu čeká. Na jiném než 1m grafu se execution
        // path nedopočítá a zůstane pending, ale hotovou excursion tím nezablokujeme.
        const waitsExcursion = groupRows.some((r: any) => r.data?.excursionComplete === false);
        const waitsPath = groupRows.some((r: any) => r.data?.executionPathComplete === false);
        const canResolveAny = (waitsExcursion && excursionDone) || (waitsPath && pathDone);
        if (!canResolveAny) {
            stillPending += groupRows.length; continue;
        }

        const cf = (res.swing || res.ote || res.fvg || res.tpTargets)
            ? { available: true, isLong: res.isLong, entry: res.entry, tp: res.tp, swing: res.swing, ote: res.ote, fvg: res.fvg, tpTargets: res.tpTargets }
            : null;

        // Aplikuj shodný výsledek na VŠECHNY kopie skupiny. Každá si drží svůj data blob
        // (účet, pnl, riskAmount) — přepisujeme jen counterfactual/excursion/entryMap + příznak.
        const results = await Promise.all(groupRows.map(async (r: any) => {
            const d = r.data || {};
            const nextExcursionComplete = d.excursionComplete === false ? (excursionDone ? true : false) : d.excursionComplete;
            const nextPathComplete = d.executionPathComplete === false ? (pathDone ? true : false) : d.executionPathComplete;
            const merged = {
                ...d,
                counterfactual: cf || d.counterfactual,
                excursion: d.excursionComplete === false && excursionDone ? res.excursion : d.excursion,
                entryMap: res.entryMap || d.entryMap,
                executionPath: d.executionPathComplete === false && pathDone ? res.executionPath : d.executionPath,
                excursionComplete: nextExcursionComplete,
                executionPathComplete: nextPathComplete,
            };
            const { error: upErr } = await supabase.from('trades').update({ data: merged }).eq('id', r.id).eq('user_id', session.user.id);
            return { ok: !upErr, pending: nextExcursionComplete === false || nextPathComplete === false };
        }));
        for (const result of results) {
            if (!result.ok || result.pending) stillPending++;
            else completed++;
        }
    }
    return { checked, completed, stillPending };
}
