/// <reference types="chrome"/>

// ─────────────────────────────────────────────────────────────────────────────
// Čtení Long/Short position drawingu (LineToolRiskReward) z TradingView grafu.
//
// `pageReadActivePosition` běží v MAIN world stránky (injektováno přes
// chrome.scripting.executeScript). MUSÍ být plně samostatná — žádné importy,
// žádné closure proměnné, a žádná syntaxe, kterou by bundler přepsal na helper
// (proto se vyhýbáme ?. a ??). API cesta je ověřená na živém TradingView:
//   window._exposed_chartWidgetCollection
//     .activeChartWidget.value().model()
//     .dataSources()  → filtr LineToolRiskRewardLong/Short
// ─────────────────────────────────────────────────────────────────────────────
export function pageReadActivePosition(boxId?: any) {
    try {
        const wc = (window as any)._exposed_chartWidgetCollection;
        if (!wc) return { ok: false, reason: 'no-widget-collection' };
        const acw = wc.activeChartWidget.value();
        const model = acw.model();
        const series = model.mainSeries();
        const si = series.symbolInfo();
        const minTick = si.minmov / si.pricescale;
        const ts = model.timeScale();

        const isPos = (d: any) => d && (d.toolname === 'LineToolRiskRewardLong' || d.toolname === 'LineToolRiskRewardShort');
        const getId = (d: any) => { try { return typeof d.id === 'function' ? d.id() : d.id; } catch (e) { return null; } };
        const all = model.dataSources().filter(isPos);
        if (!all.length) return { ok: false, reason: 'no-position' };

        // Zamknuto na konkrétní box (boxId) → čti vždy ten samý, i když klikneš jinam.
        // Bez boxId: přednost vybraný (kliknutý) box; jinak poslední přidaný.
        let target: any = null;
        if (boxId != null) {
            for (const d of all) { if (getId(d) === boxId) { target = d; break; } }
            if (!target) return { ok: false, reason: 'box-gone' };
        } else {
            try {
                const sel = model.selection();
                const sp = (sel.allSources() || []).filter(isPos);
                if (sp.length) target = sp[sp.length - 1];
            } catch (e) { /* selection API nemusí být — fallback níž */ }
            if (!target) target = all[all.length - 1];
        }
        const boxIdOut = getId(target);

        const props = target.properties();
        const rd = (k: string) => { const v = props[k]; return v && typeof v.value === 'function' ? v.value() : v; };
        const pts = target.points();

        const entry = pts[0].price;
        const isLong = target.toolname === 'LineToolRiskRewardLong';
        const stopLevel = rd('stopLevel');     // ticky
        const profitLevel = rd('profitLevel'); // ticky
        const sl = isLong ? entry - stopLevel * minTick : entry + stopLevel * minTick;
        const tp = isLong ? entry + profitLevel * minTick : entry - profitLevel * minTick;

        const qtyRaw = rd('qty');
        // Když box qty nemá (undefined/NaN), spadni na 1 — ne na NaN, který by se propsal do formuláře.
        const qtyNum = Number(qtyRaw);
        const qty = Number.isFinite(qtyNum) && qtyNum > 0 ? Math.max(1, Math.round(qtyNum)) : 1; // kontrakty = celá čísla, min 1
        const rr = stopLevel ? Math.round((profitLevel / stopLevel) * 100) / 100 : null;

        // Box má risk pro zlomkové qty. Po zaokrouhlení na celé kontrakty se
        // skutečný risk dopočítá: risk_na_kontrakt × počet_kontraktů.
        const boxRisk = rd('risk');
        // Guard: když box nemá vyplněný `risk` (undefined/NaN), nedopusť NaN do výpočtu —
        // NaN by prosáklo do formuláře jako "NaN" i do všech R-výpočtů (mfeR/maeR).
        const perContractRisk = (qtyRaw && Number.isFinite(Number(boxRisk))) ? Number(boxRisk) / qtyRaw : 0;
        // Centová přesnost (NE integer) — SL na půl ticku dává risk 88,5 $; zaokrouhlení na 89
        // dřív prosáklo do pnl (R×89 místo body×size×pv) i do mfeR (děleno 89 místo 88,5).
        const riskActual = Math.round(perContractRisk * qty * 100) / 100;

        // points()[0] = entry (levý okraj), points()[1] = pravý okraj boxu (~exit, když ho táhneš k exit candle)
        const entryTime = ts.indexToTimePoint(pts[0].index);
        const exitTime = pts.length > 1 ? ts.indexToTimePoint(pts[1].index) : null;

        // ── Jeden průchod barů: MFE/MAE + auto-detekce výsledku (první zásah SL/TP) ──
        // Bar = [time, O, H, L, C, V]. Forward scan od entry; jakmile se trefí SL nebo TP,
        // obchod tam končí (break) → MFE/MAE počítáme jen po reálnou délku obchodu.
        let mfeUsd: number | null = null, maeUsd: number | null = null, mfeR: number | null = null, maeR: number | null = null, mfePoints: number | null = null, maePoints: number | null = null;
        let autoOutcome: string | null = null, autoExitPrice: number | null = null, autoExitTime: number | null = null, autoBarsHeld: number | null = null, autoAmbiguous = false;
        try {
            const bars = series.bars();
            let si0 = Math.round(pts[0].index);
            let si1 = pts.length > 1 ? Math.round(pts[1].index) : bars.lastIndex();
            if (si1 < si0) { const tmp = si0; si0 = si1; si1 = tmp; }
            const lo0 = bars.firstIndex(), hi0 = bars.lastIndex();
            if (si0 < lo0) si0 = lo0;
            if (si1 > hi0) si1 = hi0;
            const detectHits = stopLevel > 0 && profitLevel > 0; // SL/TP musí být reálné
            let maxHigh = -Infinity, minLow = Infinity, scanned = 0, exitIdx = -1;
            for (let i = si0; i <= si1; i++) {
                const bar = bars.valueAt(i);
                if (!bar) continue;
                scanned++;
                if (bar[2] > maxHigh) maxHigh = bar[2]; // high
                if (bar[3] < minLow) minLow = bar[3];   // low
                // Detekce zásahu — vstupní bar (i === si0) přeskoč (na vlastním entry baru se neukončuje).
                if (detectHits && exitIdx < 0 && i > si0) {
                    const hitSL = isLong ? (bar[3] <= sl) : (bar[2] >= sl);
                    const hitTP = isLong ? (bar[2] >= tp) : (bar[3] <= tp);
                    if (hitSL && hitTP) { autoOutcome = 'LOSS'; autoExitPrice = sl; autoAmbiguous = true; exitIdx = i; } // oba v jednom baru → konzervativně SL
                    else if (hitTP) { autoOutcome = 'WIN'; autoExitPrice = tp; exitIdx = i; }
                    else if (hitSL) { autoOutcome = 'LOSS'; autoExitPrice = sl; exitIdx = i; }
                    if (exitIdx >= 0) break; // obchod skončil, MFE/MAE už dál nepočítej
                }
            }
            if (exitIdx >= 0) {
                autoExitTime = ts.indexToTimePoint(exitIdx);
                autoBarsHeld = exitIdx - si0;
            }
            if (scanned > 0 && maxHigh > -Infinity && minLow < Infinity) {
                const mfeP = isLong ? (maxHigh - entry) : (entry - minLow);
                const maeP = isLong ? (entry - minLow) : (maxHigh - entry);
                mfePoints = Math.round(mfeP * 100) / 100;
                maePoints = Math.round(maeP * 100) / 100;
                // $ převod odvozený z boxu: $/cenová_jednotka/kontrakt = perContractRisk / (vzdálenost_SL_v_ceně)
                const slDistPrice = stopLevel * minTick;
                const usdPerPriceUnit = slDistPrice > 0 ? (perContractRisk / slDistPrice) : 0;
                // Centová přesnost (NE integer round) → maeUsd == maePoints×usdPerPoint a maeR z téhož.
                // (Dřív integer round: 34,5 → 35 → maeR z 35 ≠ z bodů. MFE to neukázalo, bylo celé.)
                mfeUsd = Math.round(mfeP * usdPerPriceUnit * qty * 100) / 100;
                maeUsd = Math.round(maeP * usdPerPriceUnit * qty * 100) / 100;
                if (riskActual > 0) {
                    mfeR = Math.round((mfeUsd / riskActual) * 100) / 100;
                    maeR = Math.round((maeUsd / riskActual) * 100) / 100;
                }
            }
        } catch (e) { /* volitelné — když bary nejdou, vrátí null */ }

        return {
            ok: true,
            boxId: boxIdOut,
            symbol: si.name || si.full_name,
            direction: isLong ? 'LONG' : 'SHORT',
            entry: entry,
            sl: sl,
            tp: tp,
            risk: boxRisk,                                      // risk z boxu (pro zlomkové qty)
            riskActual: riskActual,                             // skutečný risk po zaokrouhlení kontraktů
            perContractRisk: Math.round(perContractRisk * 100) / 100,
            rr: rr,
            qtyRaw: qtyRaw,
            qty: qty,
            accountSize: rd('accountSize'),
            minTick: minTick,
            entryTime: entryTime,   // unix sekundy (historický čas baru i v replayi)
            exitTime: exitTime,
            mfeUsd: mfeUsd,         // max favorable excursion v $ (pro qty)
            maeUsd: maeUsd,         // max adverse excursion v $
            mfeR: mfeR,             // MFE v R-násobcích risku
            maeR: maeR,             // MAE v R-násobcích
            mfePoints: mfePoints,   // MFE v cenových bodech
            maePoints: maePoints,   // MAE v bodech
            autoOutcome: autoOutcome,       // 'WIN' | 'LOSS' | null — co se trefilo první (SL/TP)
            autoExitPrice: autoExitPrice,   // přesný exit (SL nebo TP úroveň)
            autoExitTime: autoExitTime,     // unix sekundy zásahového baru
            autoBarsHeld: autoBarsHeld,     // počet barů do zásahu
            autoAmbiguous: autoAmbiguous,   // true = SL i TP v jednom baru (default LOSS)
        };
    } catch (e) {
        return { ok: false, reason: String(e) };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Counterfactual: "co kdyby" pro 3 varianty SL placementu (FVG / OTE / swing).
// Pro každou úroveň projede svíčky dopředu od entry (i ZA reálný exit) a zjistí,
// jestli by se trefil SL nebo TP, kolikátý bar a jaké RR. Úrovně auto-detekuje
// (pivot 1/1 + close BoS, fib 0.79, FVG imbalance) NEBO použije override.
// MAIN world, samostatná, bez ?./?? a bez async/await.
//   overrideLevels = { fvg?:number, ote?:number, swing?:number }
// ─────────────────────────────────────────────────────────────────────────────
export async function pageComputeCounterfactual(overrideLevels: any, boxId?: any, flatByMin?: any, entryOverride?: any) {
    try {
        const wc = (window as any)._exposed_chartWidgetCollection;
        if (!wc) return { ok: false, reason: 'no-widget-collection' };
        const model = wc.activeChartWidget.value().model();
        const series = model.mainSeries();
        const si = series.symbolInfo();
        const minTick = si.minmov / si.pricescale;
        const ts = model.timeScale();
        let bars = series.bars();

        // Entry/SL/TP zdroj: buď z aktivního RR boxu (běžný capture), nebo z explicitního
        // entryOverride (recompute uloženého obchodu — nepotřebuje box, jen bary v okně kolem entry).
        let entry = 0, isLong = false, stopLevel = 0, profitLevel = 0, tp = 0;
        let entryUnixPre: number | null = null, boxEntryIndex = -1;
        const useOverride = !!(entryOverride && typeof entryOverride.entry === 'number' && typeof entryOverride.entryUnix === 'number');
        if (useOverride) {
            isLong = !!entryOverride.isLong;
            entry = entryOverride.entry;
            stopLevel = (minTick > 0) ? Math.round(Math.abs(entry - entryOverride.sl) / minTick) : 0;
            profitLevel = (minTick > 0) ? Math.round(Math.abs(entryOverride.tp - entry) / minTick) : 0;
            tp = entryOverride.tp;
            entryUnixPre = entryOverride.entryUnix;
        } else {
            const isPos = (d: any) => d && (d.toolname === 'LineToolRiskRewardLong' || d.toolname === 'LineToolRiskRewardShort');
            const getId = (d: any) => { try { return typeof d.id === 'function' ? d.id() : d.id; } catch (e) { return null; } };
            const allPos = model.dataSources().filter(isPos);
            if (!allPos.length) return { ok: false, reason: 'no-position' };
            let target: any = null;
            if (boxId != null) {
                for (const d of allPos) { if (getId(d) === boxId) { target = d; break; } }
                if (!target) return { ok: false, reason: 'box-gone' };
            } else {
                try { const sp = (model.selection().allSources() || []).filter(isPos); if (sp.length) target = sp[sp.length - 1]; } catch (e) { /* ignore */ }
                if (!target) target = allPos[allPos.length - 1];
            }
            const props = target.properties();
            const rd = (k: string) => { const v = props[k]; return v && typeof v.value === 'function' ? v.value() : v; };
            const pts = target.points();
            entry = pts[0].price;
            isLong = target.toolname === 'LineToolRiskRewardLong';
            stopLevel = rd('stopLevel'); profitLevel = rd('profitLevel');
            tp = isLong ? entry + profitLevel * minTick : entry - profitLevel * minTick;
            boxEntryIndex = Math.round(pts[0].index);
            entryUnixPre = ts.indexToTimePoint(boxEntryIndex);
        }

        // ── Auto-load: dožádej bary od ZAČÁTKU SESSION dne vstupu (jinak VWAP/deviace/odraz nesedí —
        // TradingView lazy-loaduje podle viditelného okna). requestMoreData + await dataEvents.completed.
        // Cíl: firstBar ≤ den vstupu 00:00 − 2h (pokrýt session open ~prev 23:00). Ověřeno naživo.
        // Pro override (recompute) to zároveň dotáhne HISTORII zpět k entry, i když je graf „dopředu". ──
        if (entryUnixPre != null) {
            const ed = new Date(entryUnixPre * 1000);
            const targetT = new Date(ed.getFullYear(), ed.getMonth(), ed.getDate(), 0, 0, 0, 0).getTime() / 1000 - 2 * 3600;
            for (let i = 0; i < 12; i++) {
                const ft = ts.indexToTimePoint(series.bars().firstIndex());
                if (ft != null && ft <= targetT) break;
                let canMore = false; try { canMore = series.requestMoreDataAvailable() && !series.endOfData(); } catch (e) { canMore = false; }
                if (!canMore) break;
                await new Promise<void>((res) => {
                    let done = false; let dele: any = null;
                    const finish = () => { if (done) return; done = true; try { dele && dele.unsubscribe(null, finish); } catch (e) { /* ignore */ } res(); };
                    try { dele = series.dataEvents().completed(); dele.subscribe(null, finish); } catch (e) { res(); return; }
                    try { series.requestMoreData(5000); } catch (e) { finish(); return; }
                    setTimeout(finish, 5000);
                });
            }
            bars = series.bars(); // po načtení re-fetch (firstIndex se posunul; si0 zůstává absolutní)
        }

        const first = bars.firstIndex(), lastI = bars.lastIndex();
        // si0 = bar index vstupu. Box: přímý index. Override: dohledej podle času (entryUnix).
        let si0 = -1;
        if (useOverride && entryUnixPre != null) {
            let bestD = Infinity;
            for (let i = lastI; i >= first; i--) {
                const t = ts.indexToTimePoint(i);
                if (t == null) continue;
                const d = Math.abs(t - entryUnixPre);
                if (d < bestD) { bestD = d; si0 = i; }
                if (t < entryUnixPre - 86400) break; // víc než den pod entry → dost, dál nescanuj
            }
        } else {
            si0 = boxEntryIndex;
        }
        // Entry musí být v načteném rozsahu barů — jinak nelze počítat strukturu/scan.
        if (si0 < first + 3 || si0 > lastI || ts.indexToTimePoint(si0) == null) {
            return { ok: false, reason: 'entry-mimo-graf' };
        }
        const wStart = Math.max(first + 1, si0 - 200);

        // ── pivoty 1/1 do entry ──
        const pivH: any[] = [], pivL: any[] = [];
        for (let i = wStart; i <= si0 - 1; i++) {
            const b = bars.valueAt(i), bp = bars.valueAt(i - 1), bn = bars.valueAt(i + 1);
            if (!b || !bp || !bn) continue;
            if (b[2] > bp[2] && b[2] > bn[2]) pivH.push({ i: i, p: b[2] });
            if (b[3] < bp[3] && b[3] < bn[3]) pivL.push({ i: i, p: b[3] });
        }
        // ── BoS/CHoCH (close prorazí poslední pivot), registruj jen nový pivot ──
        // structEvents = sekvence zlomů v pořadí (pro entry mapping: odraz + kolikátý zlom).
        let lastBrokenH: number | null = null, lastBrokenL: number | null = null;
        let lastBull: any = null, lastBear: any = null;
        const structEvents: any[] = [];
        for (let j = wStart + 2; j <= si0; j++) {
            const cb = bars.valueAt(j); if (!cb) continue;
            const c = cb[4];
            let curPH: any = null; for (let k = pivH.length - 1; k >= 0; k--) { if (pivH[k].i <= j - 1) { curPH = pivH[k]; break; } }
            let curPL: any = null; for (let k = pivL.length - 1; k >= 0; k--) { if (pivL[k].i <= j - 1) { curPL = pivL[k]; break; } }
            if (curPH && c > curPH.p && curPH.p !== lastBrokenH) { lastBrokenH = curPH.p; lastBull = { brokenHigh: curPH.p, protectedLow: curPL ? curPL.p : null, plIdx: curPL ? curPL.i : null }; structEvents.push({ dir: 'bull', broken: curPH.p, protPrice: curPL ? curPL.p : null, protIdx: curPL ? curPL.i : null, atIdx: j }); }
            if (curPL && c < curPL.p && curPL.p !== lastBrokenL) { lastBrokenL = curPL.p; lastBear = { brokenLow: curPL.p, protectedHigh: curPH ? curPH.p : null, phIdx: curPH ? curPH.i : null }; structEvents.push({ dir: 'bear', broken: curPL.p, protPrice: curPH ? curPH.p : null, protIdx: curPH ? curPH.i : null, atIdx: j }); }
        }

        // ── auto-detekce 3 úrovní ──
        let swingLvl: number | null = null, oteLvl: number | null = null, fvgLvl: number | null = null;
        // SWING = low/high posledního BoS/CHoCH ve směru (ověřeno správně).
        if (isLong && lastBull && lastBull.protectedLow != null) swingLvl = lastBull.protectedLow;
        else if (!isLong && lastBear && lastBear.protectedHigh != null) swingLvl = lastBear.protectedHigh;
        // OTE = 0.79 impulzní nohy. H = swing high posledního BoS (= swing úroveň), L = nejnižší
        // LOW od baru toho swing-highu po entry (skutečné dno impulzu). Zrcadlově pro long.
        // Ověřeno na reálném boxu: dává Filipovu červenou OTE čáru (30583).
        if (!isLong && lastBear && lastBear.protectedHigh != null && lastBear.phIdx != null) {
            const H = lastBear.protectedHigh;
            let L = Infinity;
            for (let i = lastBear.phIdx; i <= si0; i++) { const b = bars.valueAt(i); if (b && b[3] < L) L = b[3]; }
            if (L < H && L !== Infinity) oteLvl = L + 0.79 * (H - L);
        } else if (isLong && lastBull && lastBull.protectedLow != null && lastBull.plIdx != null) {
            const L = lastBull.protectedLow;
            let H = -Infinity;
            for (let i = lastBull.plIdx; i <= si0; i++) { const b = bars.valueAt(i); if (b && b[2] > H) H = b[2]; }
            if (H > L && H !== -Infinity) oteLvl = H - 0.79 * (H - L);
        }
        // FVG = DRUHÁ strana od entry. Entry leží na jedné hraně FVG (proximální) → SL je
        // protilehlá hrana (distální, na ochranné straně). Najdi 3-svíčkový FVG, jehož
        // proximální hrana ≈ entry, a vezmi distální. Ověřeno: short entry 30574 → SL 30579.5.
        let bestDist = Infinity;
        for (let i = Math.max(first + 1, si0 - 40); i <= si0; i++) {
            const a = bars.valueAt(i - 1), b3 = bars.valueAt(i + 1);
            if (!a || !b3) continue;
            if (isLong) {
                // bullish FVG: bottom = a.high, top = b3.low. Entry ≈ top (proximální), SL = bottom (pod entry).
                if (b3[3] > a[2]) { const top = b3[3], bottom = a[2]; const dEntry = Math.abs(entry - top); if (bottom < entry && dEntry < bestDist && dEntry <= 6) { bestDist = dEntry; fvgLvl = bottom; } }
            } else {
                // bearish FVG: top = a.low, bottom = b3.high. Entry ≈ bottom (proximální), SL = top (nad entry).
                if (b3[2] < a[3]) { const top = a[3], bottom = b3[2]; const dEntry = Math.abs(entry - bottom); if (top > entry && dEntry < bestDist && dEntry <= 6) { bestDist = dEntry; fvgLvl = top; } }
            }
        }

        // override (ruční úrovně z grafu)
        if (overrideLevels) {
            if (typeof overrideLevels.fvg === 'number') fvgLvl = overrideLevels.fvg;
            if (typeof overrideLevels.ote === 'number') oteLvl = overrideLevels.ote;
            if (typeof overrideLevels.swing === 'number') swingLvl = overrideLevels.swing;
        }

        // Zaokrouhli všechny úrovně na tick (NQ/MNQ = 0.25), jako reálné ceny.
        const roundTick = (x: number | null) => (x == null || !(minTick > 0)) ? x : Math.round(x / minTick) * minTick;
        swingLvl = roundTick(swingLvl); oteLvl = roundTick(oteLvl); fvgLvl = roundTick(fvgLvl);

        const roundTick2 = (x: number) => (minTick > 0 ? Math.round(x / minTick) * minTick : x);

        // Forward pivoty 1/1 od entry (sdílené pro všechny trailing simulace).
        const fpH: any[] = [], fpL: any[] = [];
        for (let i = si0; i <= lastI - 1; i++) {
            const b = bars.valueAt(i), bp = bars.valueAt(i - 1), bn = bars.valueAt(i + 1);
            if (!b || !bp || !bn) continue;
            if (b[2] > bp[2] && b[2] > bn[2]) fpH.push({ i: i, p: b[2] });
            if (b[3] < bp[3] && b[3] < bn[3]) fpL.push({ i: i, p: b[3] });
        }

        // ── Strukturní trailing od dané startovní SL úrovně. Long: na interní BoS UP posuň
        // SL pod nejbližší higher-low; jen ve prospěch, nikdy proti. Short zrcadlově. ──
        const trailFrom = (start: number | null) => {
            if (start == null) return null;
            let trail = start, fbH: number | null = null, fbL: number | null = null;
            let exitP: number | null = null, exitIdx = -1, reason = 'open', steps = 0;
            for (let j = si0 + 1; j <= lastI; j++) {
                const bar = bars.valueAt(j); if (!bar) continue;
                if (isLong) {
                    if (bar[3] <= trail) { exitP = trail; exitIdx = j; reason = trail > entry ? 'trail+' : 'trail'; break; }
                    if (bar[2] >= tp) { exitP = tp; exitIdx = j; reason = 'tp'; break; }
                } else {
                    if (bar[2] >= trail) { exitP = trail; exitIdx = j; reason = trail < entry ? 'trail+' : 'trail'; break; }
                    if (bar[3] <= tp) { exitP = tp; exitIdx = j; reason = 'tp'; break; }
                }
                let cH: any = null; for (let k = fpH.length - 1; k >= 0; k--) { if (fpH[k].i <= j - 1) { cH = fpH[k]; break; } }
                let cL: any = null; for (let k = fpL.length - 1; k >= 0; k--) { if (fpL[k].i <= j - 1) { cL = fpL[k]; break; } }
                if (isLong) { if (cH && bar[4] > cH.p && cH.p !== fbH) { fbH = cH.p; if (cL && cL.p > trail) { trail = cL.p; steps++; } } }
                else { if (cL && bar[4] < cL.p && cL.p !== fbL) { fbL = cL.p; if (cH && cH.p < trail) { trail = cH.p; steps++; } } }
            }
            if (exitP == null) { const lb = bars.valueAt(lastI); exitP = lb ? lb[4] : entry; reason = 'open'; }
            const risk = isLong ? entry - start : start - entry;
            const realizedR = risk > 0 ? (isLong ? (exitP - entry) / risk : (entry - exitP) / risk) : null;
            return {
                exit: roundTick2(exitP), reason: reason, bars: exitIdx > 0 ? exitIdx - si0 : null,
                realizedR: realizedR != null ? Math.round(realizedR * 100) / 100 : null,
                trailSteps: steps, trailFinal: roundTick2(trail), trailStart: roundTick2(start),
            };
        };

        // ── Pro jednu SL úroveň: fixní TP výsledek + strukturní trailing od té samé úrovně ──
        const scanSL = (lvl: number | null) => {
            if (lvl == null) return { ok: false };
            const valid = isLong ? lvl < entry : lvl > entry;
            // Neplatná varianta (SL na špatné straně entry = záporný risk) → nesimuluj a NEvykazuj -1.
            // Dřív scan přiřadil outcome LOSS / realizedR -1 → kazilo průměry cf variant (FVG/OTE/swing).
            if (!valid) {
                return { ok: true, valid: false, sl: Math.round(lvl * 100) / 100, rr: null, outcome: null, bars: null, realizedR: null, trail: null };
            }
            const riskDist = isLong ? entry - lvl : lvl - entry;
            const rr = riskDist > 0 ? (isLong ? (tp - entry) / riskDist : (entry - tp) / riskDist) : null;
            let outcome = 'OPEN', held = 0;
            for (let i = si0 + 1; i <= lastI; i++) {
                const bar = bars.valueAt(i); if (!bar) continue;
                const hitSL = isLong ? (bar[3] <= lvl) : (bar[2] >= lvl);
                const hitTP = isLong ? (bar[2] >= tp) : (bar[3] <= tp);
                if (hitSL && hitTP) { outcome = 'LOSS'; held = i - si0; break; }
                if (hitTP) { outcome = 'WIN'; held = i - si0; break; }
                if (hitSL) { outcome = 'LOSS'; held = i - si0; break; }
            }
            const realizedR = outcome === 'WIN' ? rr : (outcome === 'LOSS' ? -1 : null);
            return {
                ok: true, valid: valid, sl: Math.round(lvl * 100) / 100,
                rr: rr != null ? Math.round(rr * 100) / 100 : null,
                outcome: outcome, bars: held,
                realizedR: realizedR != null ? Math.round(realizedR * 100) / 100 : null,
                trail: trailFrom(lvl),  // trailing startující z TÉTO SL úrovně
            };
        };

        // ── TP targety: přečti likviditní levely (PDH/PDL/PWH/PWL/dHigh/dLow/VWAP…) z indikátoru
        // a pro každý ve směru obchodu zjisti, jestli tam cena došla dřív než SL (swing). ──
        const readLiquidityLevels = () => {
            const lv: any[] = [];
            // Dedup: víc instancí „Liquidity" indikátoru na grafu (nebo překrývající se levely) by
            // jinak načetlo každou úroveň víckrát → nafouklé tpTargets/excursion.levels. Klíč = text|cena.
            const seen = new Set<string>();
            try {
                const srcs = model.dataSources();
                for (let i = 0; i < srcs.length; i++) {
                    let nm = ''; try { nm = srcs[i].title ? srcs[i].title() : ''; } catch (e) { /* ignore */ }
                    if (!/Liquidity/i.test(String(nm))) continue;
                    let g: any; try { g = srcs[i].graphics(); } catch (e) { continue; }
                    let coll: any; try { const c = g.dwglabels; coll = typeof c === 'function' ? c.call(g) : c; } catch (e) { continue; }
                    // Vyfiltruj market-structure anotace (BOS/CHoCH/HH/LL/HL/LH/H/L) — nejsou to TP úrovně.
                    const isStructure = (t: string) => /^\s*(BOS|CHoCH|CHOCH|HH|LL|HL|LH|H|L)\s*$/i.test(t);
                    const pull = (m: any) => {
                        if (m && typeof m.values === 'function') {
                            const it = m.values(); let v;
                            while (!(v = it.next()).done) {
                                const val = v.value;
                                if (val && typeof val.values === 'function') pull(val);
                                else if (val && typeof val.y === 'number' && val.text && !isStructure(String(val.text))) {
                                    const text = String(val.text);
                                    const key = `${text.trim()}|${Math.round(val.y * 100)}`;
                                    if (seen.has(key)) continue;
                                    seen.add(key);
                                    lv.push({ text, price: val.y });
                                }
                            }
                        }
                    };
                    pull(coll);
                }
            } catch (e) { /* ignore */ }
            return lv;
        };

        // VWAP+σ k času ENTRY (snapshot): bary (anchor→entry) když je session načtená, jinak z LABELŮ
        // indikátoru (v replay dobové a přesné). Stejná logika jako excursion (ověřeno naživo 1:1).
        // → tpTargets může nabídnout i VWAP/deviace SPRÁVNĚ (ne zamrzlý label = ten starý rozpor).
        const entryVwapSnapshot = (): { source: 'bars' | 'indicator' | 'none'; w: number | null; sd: number } => {
            const eU = ts.indexToTimePoint(si0), lU = ts.indexToTimePoint(lastI);
            const lDay = (u: number | null) => { if (u == null) return ''; const d = new Date(u * 1000); return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); };
            let contemp = true;
            if (eU != null && lU != null) contemp = lDay(eU) === lDay(lU);
            const eDay = lDay(eU);
            let anc = first; for (let i = si0; i > first; i--) { if (lDay(ts.indexToTimePoint(i - 1)) !== eDay) { anc = i; break; } }
            const ancU = ts.indexToTimePoint(anc);
            const ancMin = ancU != null ? (new Date(ancU * 1000).getHours() * 60 + new Date(ancU * 1000).getMinutes()) : 0;
            const approx = ancMin > 30; // start session nenačten → bar-výpočet nespolehlivý
            // labely (fallback)
            let lw: number | null = null, lsd = 0;
            if (contemp) {
                const fam = readLiquidityLevels().filter((L: any) => /^\s*VWAP(\s*[+-]\s*[12]\s*σ)?\s*$/i.test(String(L.text)));
                const nz = (t: string) => String(t).replace(/\[.*?\]/g, '').replace(/\s+/g, '').toLowerCase();
                const fp = (re: RegExp) => { const m = fam.find((L: any) => re.test(nz(L.text))); return m ? m.price : null; };
                const w0 = fp(/^vwap$/);
                if (w0 != null) { lw = w0; const c: number[] = []; const p1 = fp(/^vwap\+1/), m1 = fp(/^vwap-1/), p2 = fp(/^vwap\+2/), m2 = fp(/^vwap-2/); if (p1 != null) c.push(Math.abs(p1 - w0)); if (m1 != null) c.push(Math.abs(w0 - m1)); if (p2 != null) c.push(Math.abs(p2 - w0) / 2); if (m2 != null) c.push(Math.abs(w0 - m2) / 2); if (c.length) lsd = c.reduce((a, b) => a + b, 0) / c.length; }
            }
            if (!approx) {
                let v = 0, pv = 0, pv2 = 0;
                for (let i = anc; i <= si0; i++) { const b = bars.valueAt(i); if (!b) continue; const tp = (b[2] + b[3] + b[4]) / 3; const vol = b[5] || 0; v += vol; pv += vol * tp; pv2 += vol * tp * tp; }
                if (v > 0) { const w = pv / v; const va = (pv2 / v) - w * w; return { source: 'bars', w, sd: va > 0 ? Math.sqrt(va) : 0 }; }
            }
            if (lw != null) return { source: 'indicator', w: lw, sd: lsd };
            return { source: 'none', w: null, sd: 0 };
        };

        const tpTargets = (() => {
            if (swingLvl == null) return [];
            // Live VWAP rodina z LABELŮ se VYNECHÁVÁ (zamrzlá cena) — místo ní přidáme SPRÁVNÝ
            // entry-snapshot VWAP/deviace (bary/label), takže rr sedí a neodporuje si s ladderem.
            const isLiveVwapTp = (t: string) => /^\s*VWAP(\s*[+-]\s*[12]\s*σ)?\s*$/i.test(t);
            const staticLv = readLiquidityLevels().filter((L: any) => (isLong ? L.price > entry : L.price < entry) && !isLiveVwapTp(String(L.text)));
            // Přidej VWAP/deviace ve směru (správný zdroj) jako TP kandidáty.
            const snap = entryVwapSnapshot();
            const vwapLv: any[] = [];
            if (snap.source !== 'none' && snap.w != null) {
                const specs = isLong ? [{ l: 'VWAP', k: 0 }, { l: 'VWAP +1σ', k: 1 }, { l: 'VWAP +2σ', k: 2 }]
                    : [{ l: 'VWAP', k: 0 }, { l: 'VWAP -1σ', k: -1 }, { l: 'VWAP -2σ', k: -2 }];
                for (const s of specs) { const price = snap.w + s.k * snap.sd; if (isLong ? price > entry : price < entry) vwapLv.push({ text: s.l, price }); }
            }
            const levels = [...staticLv, ...vwapLv];
            // dedupe na tick a seřaď dle vzdálenosti od entry
            const seen: any = {}; const uniq: any[] = [];
            levels.sort((a: any, b: any) => Math.abs(a.price - entry) - Math.abs(b.price - entry));
            for (const L of levels) { const k = String(roundTick2(L.price)); if (!seen[k]) { seen[k] = true; uniq.push(L); } }
            // Baseline = swing SL. Když je swing neplatný (SL na/za entry → risk ≤ 0, např. swing==entry),
            // spadni na REÁLNÝ SL boxu — jinak stop == entry → okamžitý stop-out a VŠECHNY targety zkolabují
            // na LOSS/-1, i když cena reálně došla výš (otrávený tpTargets).
            const boxSL = isLong ? entry - stopLevel * minTick : entry + stopLevel * minTick;
            const swingRisk = isLong ? entry - swingLvl : swingLvl - entry;
            const baseSL = swingRisk > 0 ? swingLvl : boxSL;
            const risk = isLong ? entry - baseSL : baseSL - entry;
            return uniq.slice(0, 8).map((L: any) => {
                let outcome = 'OPEN', held = 0;
                for (let i = si0 + 1; i <= lastI; i++) {
                    const bar = bars.valueAt(i); if (!bar) continue;
                    const hitSL = isLong ? bar[3] <= baseSL : bar[2] >= baseSL;
                    const hitTP = isLong ? bar[2] >= L.price : bar[3] <= L.price;
                    if (hitSL && hitTP) { outcome = 'LOSS'; held = i - si0; break; }
                    if (hitTP) { outcome = 'WIN'; held = i - si0; break; }
                    if (hitSL) { outcome = 'LOSS'; held = i - si0; break; }
                }
                const rrT = risk > 0 ? (isLong ? (L.price - entry) / risk : (entry - L.price) / risk) : null;
                const realizedR = outcome === 'WIN' ? rrT : (outcome === 'LOSS' ? -1 : null);
                return {
                    label: L.text, price: roundTick2(L.price), outcome: outcome,
                    bars: outcome === 'OPEN' ? null : held,  // null = nedosaženo (ne bars:0 = „bar 0")
                    rr: rrT != null ? Math.round(rrT * 100) / 100 : null,
                    realizedR: realizedR != null ? Math.round(realizedR * 100) / 100 : null,
                };
            });
        })();

        // ── ENTRY MAPPING: tvůj vstupní model = entry na hraně FVG + CHoCH/BoS ve směru + odraz od levelu.
        // Mapuje: (1) odraz level (rejekce → nejbližší level na straně odrazu), (2) struktura + kolikátý
        // zlom od odrazu (1.=CHoCH, další=BoS), (3) entry sedí na hraně FVG? ──
        const entryMap = (() => {
            const myDir = isLong ? 'bull' : 'bear';
            // Poslední zlom MÝM SMĚREM (entry je na pullbacku za ním; opačný šum po něm ignoruj).
            let lastMyIdx = -1;
            for (let k = structEvents.length - 1; k >= 0; k--) { if (structEvents[k].dir === myDir) { lastMyIdx = k; break; } }
            // Run = souvislá série zlomů mým směrem končící tím posledním (1.=CHoCH, další=BoS).
            let runStart = lastMyIdx;
            if (lastMyIdx >= 0) { for (let k = lastMyIdx; k >= 0; k--) { if (structEvents[k].dir === myDir) runStart = k; else break; } }
            const run = lastMyIdx >= 0 ? structEvents.slice(runStart, lastMyIdx + 1) : [];
            const order = run.length;                              // kolikátý zlom ve směru (entry na posledním)
            const structureType = order >= 1 ? (order === 1 ? 'CHoCH' : 'BoS') : null;
            // Odraz = swing extrém PRVNÍHO zlomu runu (protected extrém před flipem = bod rejekce).
            const odrazPrice = run.length ? run[0].protPrice : null;
            const odrazIdx = run.length ? run[0].protIdx : null;
            const odrazLevels: string[] = []; let odrazLevelPrice: number | null = null;
            if (odrazPrice != null) {
                const cand: { label: string; price: number }[] = [];
                for (const L of readLiquidityLevels()) { if (!/^\s*VWAP(\s*[+-]\s*[12]\s*σ)?\s*$/i.test(String(L.text))) cand.push({ label: String(L.text), price: L.price }); }
                // VWAP/deviace u odrazu — STEJNÝ zdroj jako jinde (TP tagy): bary (přesně v baru odrazu,
                // když je session načtená) → jinak z LABELŮ indikátoru (replay) → jinak vůbec (ať není
                // špatná deviace v „Odraz deviace ±N" tagu).
                const pushVwapSpecs = (w: number, sd: number) => { const specs: [string, number][] = [['VWAP', 0], ['VWAP +1σ', 1], ['VWAP -1σ', -1], ['VWAP +2σ', 2], ['VWAP -2σ', -2]]; for (const s of specs) cand.push({ label: s[0], price: w + s[1] * sd }); };
                const oSnap = entryVwapSnapshot();
                if (odrazIdx != null && oSnap.source === 'bars') {
                    const lDay = (u: number | null) => { if (u == null) return ''; const d = new Date(u * 1000); return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); };
                    const oDay = lDay(ts.indexToTimePoint(odrazIdx));
                    let an = first; for (let i = odrazIdx; i > first; i--) { if (lDay(ts.indexToTimePoint(i - 1)) !== oDay) { an = i; break; } }
                    let v = 0, pv = 0, pv2 = 0, pd = oDay;
                    for (let i = an; i <= odrazIdx; i++) { const b = bars.valueAt(i); if (!b) continue; const cd = lDay(ts.indexToTimePoint(i)); if (cd !== pd) { v = 0; pv = 0; pv2 = 0; } pd = cd; const tp = (b[2] + b[3] + b[4]) / 3, vol = b[5] || 0; v += vol; pv += vol * tp; pv2 += vol * tp * tp; }
                    if (v > 0) { const w = pv / v; const va = (pv2 / v) - w * w; pushVwapSpecs(w, va > 0 ? Math.sqrt(va) : 0); }
                } else if (oSnap.source === 'indicator' && oSnap.w != null) {
                    pushVwapSpecs(oSnap.w, oSnap.sd); // bary nespolehlivé → VWAP/σ z labelů (entry-snapshot ≈ odraz)
                }
                // Nejbližší level ke swing extrému (rejekce). BEZ filtru strany — cena wickne skrz
                // rezistenci/support, takže level leží těsně NA/POD (short) resp. NA/NAD (long) extrémem.
                let best: any = null, bd = Infinity;
                for (const c of cand) { const d = Math.abs(c.price - odrazPrice); if (d < bd) { bd = d; best = c; } }
                const tol = Math.max(minTick * 8, stopLevel * minTick);
                if (best && bd <= tol) {
                    // Konfluence: všechny levely blízko primárního (stacked na stejném místě) → tagni všechny.
                    const confBand = Math.max(minTick * 16, stopLevel * minTick * 0.6);
                    const seenL: any = {};
                    for (const c of cand) { if (Math.abs(c.price - best.price) <= confBand) { const lbl = String(c.label).replace(/\s*\[.*?\]\s*$/, '').trim(); if (!seenL[lbl]) { seenL[lbl] = true; odrazLevels.push(lbl); } } }
                    odrazLevelPrice = roundTick2(best.price);
                }
            }
            // ── ENTRY LEVEL: úroveň NEJBLIŽŠÍ skutečnému ENTRY (ne originu odrazu). Uživatel vstupuje
            // např. na -2σ, i když se pohyb OTOČIL na VWAP → odraz=VWAP (origin), entryLevel=-2σ (vstup). ──
            const entryLevels: string[] = []; let entryLevelPrice: number | null = null;
            {
                const ecand: { label: string; price: number }[] = [];
                for (const L of readLiquidityLevels()) { if (!/^\s*VWAP(\s*[+-]\s*[12]\s*σ)?\s*$/i.test(String(L.text))) ecand.push({ label: String(L.text), price: L.price }); }
                // VWAP/deviace AT ENTRY (stejný snapshot jako TP tagy) — bary → jinak labely → jinak nic.
                const eSnap = entryVwapSnapshot();
                if (eSnap.source !== 'none' && eSnap.w != null) {
                    const specs: [string, number][] = [['VWAP', 0], ['VWAP +1σ', 1], ['VWAP -1σ', -1], ['VWAP +2σ', 2], ['VWAP -2σ', -2]];
                    for (const s of specs) ecand.push({ label: s[0], price: eSnap.w + s[1] * eSnap.sd });
                }
                let eBest: any = null, ebd = Infinity;
                for (const c of ecand) { const d = Math.abs(c.price - entry); if (d < ebd) { ebd = d; eBest = c; } }
                const etol = Math.max(minTick * 8, stopLevel * minTick);
                if (eBest && ebd <= etol) {
                    const eConfBand = Math.max(minTick * 16, stopLevel * minTick * 0.6);
                    const seenE: any = {};
                    for (const c of ecand) { if (Math.abs(c.price - eBest.price) <= eConfBand) { const lbl = String(c.label).replace(/\s*\[.*?\]\s*$/, '').trim(); if (!seenE[lbl]) { seenE[lbl] = true; entryLevels.push(lbl); } } }
                    entryLevelPrice = roundTick2(eBest.price);
                }
            }
            return {
                available: structEvents.length > 0,
                structureType: structureType,                     // 'CHoCH' | 'BoS' | null
                structureOrder: order,                            // 1,2,3… (0 = žádný zlom ve směru u entry)
                odrazLevels: odrazLevels,                         // levely odrazu (konfluence) — může být víc
                odrazPrice: odrazPrice != null ? roundTick2(odrazPrice) : null,
                odrazLevelPrice: odrazLevelPrice,
                entryLevels: entryLevels,                         // levely u SKUTEČNÉHO entry (např. VWAP -2σ)
                entryLevelPrice: entryLevelPrice,
                entryFvg: fvgLvl != null,                         // entry sedí na hraně FVG? (tvoje pravidlo)
            };
        })();

        // ── Excursion: "kam by to došlo do konce dne" (flat-by), podlaha = PŮVODNÍ SL boxu.
        // Měří dopředu od entry, ignoruje reálný výstup. Stop na původní SL (held by umřel)
        // nebo na flat-by čase (no overnight). Level po levelu + klasický strukturní trailing. ──
        const excursion = (() => {
            const boxSL = isLong ? entry - stopLevel * minTick : entry + stopLevel * minTick;
            const risk = isLong ? entry - boxSL : boxSL - entry;
            if (!(risk > 0)) return { available: false, reason: 'bad-sl' };
            // Flat-by v LOKÁLNÍM čase (jak Filip přemýšlí: "jsem flat do 22:00"). Default 22:00.
            const fbMin = (typeof flatByMin === 'number' && flatByMin >= 0) ? flatByMin : 22 * 60;
            const entryUnix = ts.indexToTimePoint(si0);
            let cutoffMs: number | null = null;
            if (entryUnix != null) {
                const d = new Date(entryUnix * 1000);
                const c = new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(fbMin / 60), fbMin % 60, 0, 0);
                if (d.getHours() * 60 + d.getMinutes() >= fbMin) c.setDate(c.getDate() + 1); // vstup po cutoffu → další den
                cutoffMs = c.getTime();
            }
            // STATICKÉ levely (PDH/PDL/PWH/PWL/dHigh/dLow/DO/pdVWAP…) se čtou z labelů indikátoru —
            // jsou AKTUÁLNÍ (vodorovné, přepočet jen jednou denně), takže platí jen když je graf na
            // stejném dni jako vstup (Filipův replay backtest). Live VWAP rodinu (VWAP, ±1σ, ±2σ) z
            // labelů VYNECHÁVÁME — ta se hýbe každý bar a počítáme ji dynamicky níže.
            const lastUnix = ts.indexToTimePoint(lastI);
            let levelsContemporary = true;
            if (entryUnix != null && lastUnix != null) {
                const ed = new Date(entryUnix * 1000), ld = new Date(lastUnix * 1000);
                levelsContemporary = ed.getFullYear() === ld.getFullYear() && ed.getMonth() === ld.getMonth() && ed.getDate() === ld.getDate();
            }
            const isLiveVwap = (t: string) => /^\s*VWAP(\s*[+-]\s*[12]\s*σ)?\s*$/i.test(t); // "VWAP", "VWAP +1σ"… (NE pdVWAP)
            const seen: any = {}; const staticLevels: any[] = [];
            if (levelsContemporary) {
                const rawLv = readLiquidityLevels().filter((L: any) => (isLong ? L.price > entry : L.price < entry) && !isLiveVwap(String(L.text)));
                rawLv.sort((a: any, b: any) => Math.abs(a.price - entry) - Math.abs(b.price - entry));
                for (const L of rawLv) { const k = String(roundTick2(L.price)); if (!seen[k]) { seen[k] = true; staticLevels.push({ label: L.text, price: roundTick2(L.price), reached: false, bars: null as number | null, dynamic: false }); } }
            }

            // ── DYNAMICKÁ VWAP pásma (replika indikátoru ověřená 1:1): hlc3, objemově vážená,
            // populační stdev. Počítáno PER BAR, takže "hit deviace −2" je proti živému pásmu —
            // přesně jak Filip trailuje TP s deviacemi.
            // Anchor (newDay) = ZMĚNA LOKÁLNÍHO DATA (půlnoc). CME equity futures session se láme
            // o půlnoci lokálního času (18:00 ET = 00:00 Praha) → ověřeno 1:1 s indikátorem. Detekce
            // přes mezeru v barech byla nespolehlivá (přes noc jsou v datech díry → falešný reset). ──
            const localDay = (u: number | null) => { if (u == null) return ''; const d = new Date(u * 1000); return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); };
            const entryDayStr = localDay(entryUnix);
            let anchor = first; for (let i = si0; i > first; i--) { if (localDay(ts.indexToTimePoint(i - 1)) !== entryDayStr) { anchor = i; break; } }
            // Pojistka: pokud první bar session (anchor) není u půlnoci (>30 min), začátek session
            // není načtený (díry v datech) → VWAP je jen přibližný, neoznačuj ho jako přesný.
            const aU = ts.indexToTimePoint(anchor);
            const aMin = aU != null ? (new Date(aU * 1000).getHours() * 60 + new Date(aU * 1000).getMinutes()) : 0;
            const barApprox = aMin > 30; // start session nenačten → bar-výpočet VWAP nespolehlivý

            // FALLBACK (replay): když bary nestačí, vezmi VWAP+σ z LABELŮ indikátoru — v replay
            // zaparkovaném na dni jsou DOBOVÉ a přesné, bez nutnosti načítat začátek session.
            // σ odvodíme z rozestupu pásem (|VWAP±1σ − VWAP|, ±2σ /2, průměr dostupných).
            let labelVwap: number | null = null, labelSd = 0;
            if (levelsContemporary) {
                const fam = readLiquidityLevels().filter((L: any) => isLiveVwap(String(L.text)));
                const nrm = (t: string) => String(t).replace(/\[.*?\]/g, '').replace(/\s+/g, '').toLowerCase();
                const findP = (re: RegExp) => { const m = fam.find((L: any) => re.test(nrm(L.text))); return m ? m.price : null; };
                const w0 = findP(/^vwap$/);
                if (w0 != null) {
                    labelVwap = w0;
                    const cand: number[] = [];
                    const p1 = findP(/^vwap\+1/), m1 = findP(/^vwap-1/), p2 = findP(/^vwap\+2/), m2 = findP(/^vwap-2/);
                    if (p1 != null) cand.push(Math.abs(p1 - w0));
                    if (m1 != null) cand.push(Math.abs(w0 - m1));
                    if (p2 != null) cand.push(Math.abs(p2 - w0) / 2);
                    if (m2 != null) cand.push(Math.abs(w0 - m2) / 2);
                    if (cand.length) labelSd = cand.reduce((a, b) => a + b, 0) / cand.length;
                }
            }
            // Zdroj VWAP: 'bars' (načteno → per-bar, ověřená cesta) → 'indicator' (labely, fixní snapshot)
            // → 'none' (ani jedno → deviace neukazuj, ať není špatné číslo).
            const vwapSource: 'bars' | 'indicator' | 'none' = !barApprox ? 'bars' : (labelVwap != null ? 'indicator' : 'none');
            const vwapApprox = vwapSource === 'none'; // varování jen když fakt nemáme spolehlivý zdroj
            let cV = 0, cPV = 0, cPV2 = 0;
            const accBar = (b: any) => { const tp = (b[2] + b[3] + b[4]) / 3; const v = b[5] || 0; cV += v; cPV += v * tp; cPV2 += v * tp * tp; };
            for (let i = anchor; i <= si0; i++) { const b = bars.valueAt(i); if (b) accBar(b); }
            // Dynamické targety ve směru (short → VWAP/−1σ/−2σ; long → VWAP/+1σ/+2σ).
            const dynSpecs = isLong ? [{ label: 'VWAP', k: 0 }, { label: 'VWAP +1σ', k: 1 }, { label: 'VWAP +2σ', k: 2 }]
                : [{ label: 'VWAP', k: 0 }, { label: 'VWAP -1σ', k: -1 }, { label: 'VWAP -2σ', k: -2 }];
            const dynLv: any[] = dynSpecs.map(s => ({ label: s.label, k: s.k, reached: false, bars: null as number | null, price: null as number | null, dynamic: true, r: null as number | null }));
            // Pásma blízko reálné TP V BARU ZÁSAHU TP — pro auto-tag "TP VWAP"/"TP deviace ±N" (+ konfluence se statickými).
            const tpVwapSpecs = isLong ? [{ l: 'VWAP', k: 0 }, { l: 'VWAP +1σ', k: 1 }, { l: 'VWAP +2σ', k: 2 }, { l: 'VWAP -1σ', k: -1 }]
                : [{ l: 'VWAP', k: 0 }, { l: 'VWAP -1σ', k: -1 }, { l: 'VWAP -2σ', k: -2 }, { l: 'VWAP +1σ', k: 1 }];
            let tpLevels: string[] | null = null;                 // konfluence levelů u TP (dynamický VWAP + statické)
            let lastVwap: number | null = null, lastSd = 0, prevDay = entryDayStr;

            // ── Forward sken: max favorable + statické + dynamické reach; stop na cutoffu nebo původním SL. ──
            let maxFav = isLong ? -Infinity : Infinity, stopReason = 'end';
            for (let i = si0 + 1; i <= lastI; i++) {
                const bar = bars.valueAt(i); if (!bar) continue;
                const tpt = ts.indexToTimePoint(i);
                if (cutoffMs != null && tpt != null && tpt * 1000 > cutoffMs) { stopReason = 'cutoff'; break; }
                // VWAP akumulace pro tento bar (reset na novou session = změna lokálního dne, jako indikátor).
                const curDay = localDay(tpt);
                if (curDay !== prevDay) { cV = 0; cPV = 0; cPV2 = 0; }
                prevDay = curDay;
                accBar(bar);
                if (cV > 0) { const w = cPV / cV; const va = (cPV2 / cV) - w * w; lastVwap = w; lastSd = va > 0 ? Math.sqrt(va) : 0; }
                // Efektivní VWAP/σ pro pásma: 'indicator' = fixní snapshot z labelů, 'bars' = per-bar výpočet.
                const effW = vwapSource === 'indicator' ? labelVwap : lastVwap;
                const effSd = vwapSource === 'indicator' ? labelSd : lastSd;
                // V baru prvního zásahu reálné TP najdi level(y) u TP: VWAP/deviace + statické (konfluence).
                if (tpLevels === null && vwapSource !== 'none' && effW != null) {
                    const hitTP = isLong ? bar[2] >= tp : bar[3] <= tp;
                    if (hitTP) {
                        const cands: { label: string; price: number }[] = [];
                        for (const cc of tpVwapSpecs) cands.push({ label: cc.l, price: effW + cc.k * effSd });
                        for (const L of staticLevels) cands.push({ label: L.label, price: L.price });
                        let best: any = null, bd = Infinity;
                        for (const c of cands) { const d = Math.abs(tp - c.price); if (d < bd) { bd = d; best = c; } }
                        // Tolerance navázaná na σ (rozestup pásem) — viz pozn. níže. 0.35σ < půl rozestupu.
                        const tol = Math.max(minTick * 8, lastSd * 0.35);
                        if (best && bd <= tol) {
                            // Konfluence: všechny levely blízko primárního (stacked na TP) → tagni všechny.
                            const confBand = Math.max(minTick * 16, stopLevel * minTick * 0.6);
                            const seenT: any = {}; const arr: string[] = [];
                            for (const c of cands) { if (Math.abs(c.price - best.price) <= confBand) { const lbl = String(c.label).replace(/\s*\[.*?\]\s*$/, '').trim(); if (!seenT[lbl]) { seenT[lbl] = true; arr.push(lbl); } } }
                            tpLevels = arr;
                        }
                    }
                }
                const hitSL = isLong ? bar[3] <= boxSL : bar[2] >= boxSL;
                if (hitSL) { stopReason = 'sl'; break; } // konzervativně: bar zásahu SL do max favorable nepočítáme
                const fav = isLong ? bar[2] : bar[3];
                if (isLong ? fav > maxFav : fav < maxFav) maxFav = fav;
                for (const Lv of staticLevels) {
                    if (!Lv.reached) { const hit = isLong ? bar[2] >= Lv.price : bar[3] <= Lv.price; if (hit) { Lv.reached = true; Lv.bars = i - si0; } }
                }
                // Dynamické pásmo: hodnota AŽ V TOMTO BARU. Reached = cena se ho dotkla z favorable strany.
                if (vwapSource !== 'none' && effW != null) {
                    for (const Lv of dynLv) {
                        if (Lv.reached) continue;
                        const band = effW + Lv.k * effSd;
                        const fav2 = isLong ? band > entry : band < entry; // jen favorable cíl (za entry)
                        const hit = isLong ? bar[2] >= band : bar[3] <= band;
                        if (fav2 && hit) { Lv.reached = true; Lv.bars = i - si0; Lv.price = roundTick2(band); Lv.r = Math.round((isLong ? (band - entry) : (entry - band)) / risk * 100) / 100; }
                    }
                }
            }
            const favOk = maxFav !== Infinity && maxFav !== -Infinity;
            const favDist = isLong ? (maxFav - entry) : (entry - maxFav);
            // favDist < 0 = cena nešla vůbec ve prospěch → 0R (ne null), ať je null-handling konzistentní
            // napříč lossy (dřív #7 null vs #6 nula pro stejnou situaci). null jen když scan neproběhl.
            const mfePotentialR = favOk ? Math.max(0, Math.round((favDist / risk) * 100) / 100) : null;
            for (const Lv of staticLevels) { const d = isLong ? Lv.price - entry : entry - Lv.price; Lv.r = Math.round((d / risk) * 100) / 100; }
            // Nedosažená dynamická pásma: R z poslední hodnoty pásma (orientačně, kam doputovalo).
            const finalW = vwapSource === 'indicator' ? labelVwap : lastVwap;
            const finalSd = vwapSource === 'indicator' ? labelSd : lastSd;
            for (const Lv of dynLv) {
                if (!Lv.reached && vwapSource !== 'none' && finalW != null) { const band = finalW + Lv.k * finalSd; Lv.price = roundTick2(band); const fav2 = isLong ? band > entry : band < entry; Lv.r = fav2 ? Math.round((isLong ? (band - entry) : (entry - band)) / risk * 100) / 100 : null; }
            }
            // Spoj statické + dynamické (jen ta s platným favorable R), seřaď dle vzdálenosti, ořež na 8.
            const limited = [...staticLevels, ...dynLv.filter(d => d.r != null && d.r > 0)]
                .filter(L => L.r != null && L.r > 0)
                .sort((a, b) => a.r - b.r)
                .slice(0, 10);
            const tpR = Math.round((isLong ? (tp - entry) : (entry - tp)) / risk * 100) / 100;
            const trail = trailFrom(boxSL); // klasický strukturní trailing z PŮVODNÍHO SL boxu
            let topReached: any = null;
            for (const Lv of limited) { if (Lv.reached && (topReached == null || Lv.r > topReached.r)) topReached = Lv; }
            return {
                available: true,
                flatByMin: fbMin,
                levelsContemporary: levelsContemporary,       // false = graf je na jiném dni → levely neplatí
                vwapApprox: vwapApprox,                       // true = start session nenačten → VWAP pásma jen přibližná
                tpLevels: tpLevels,                           // level(y) u TP v baru zásahu (konfluence: VWAP + statické), nebo null
                survivedToCutoff: stopReason !== 'sl',
                stopReason: stopReason,                       // 'cutoff' | 'sl' | 'end'
                mfePotential: favOk ? roundTick2(maxFav) : null,
                mfePotentialR: mfePotentialR,
                tpR: tpR,
                // „Co zbylo na stole" = kolik R navíc bylo reálně dosažitelné ZA tvým TP.
                // Base = nejvyšší DOSAŽENÝ level (realistický limit exit), fallback na MFE peak (wick).
                // Clamp ≥0: na ztrátě / když TP nebyl překonán se nic nenechalo (dřív vycházelo záporně = nesmysl).
                leftOnTableR: (() => {
                    const achievableR = topReached ? topReached.r : mfePotentialR;
                    return achievableR != null ? Math.max(0, Math.round((achievableR - tpR) * 100) / 100) : null;
                })(),
                topReached: topReached ? { label: topReached.label, r: topReached.r } : null,
                levels: limited,
                trail: trail ? { exit: trail.exit, exitR: trail.realizedR, reason: trail.reason, bars: trail.bars } : null,
            };
        })();

        // ── KONTEXT VSTUPU (snapshot): poloha vs kotvy (DO/WO/pdVWAP/VWAP), stav sweepů
        // z labelů indikátoru ([Nx] = testováno, [Untested] = netknuté = magnet), Londýn vs
        // Asie, čas vstupu. Je to FOTKA momentu kliknutí — backfill/recompute ji nepřepisuje
        // (labely by už ukazovaly jiný den). Bias pravidla pak vzniknou z těchto dat. ──
        const entryContext = (() => {
            try {
                const lv = readLiquidityLevels();
                if (!lv || !lv.length) return { available: false, reason: 'no-levels' };
                const nrm = (t: string) => String(t).replace(/\[.*?\]/g, '').replace(/\s+/g, ' ').trim();
                const findP = (re: RegExp) => { for (const L of lv) { if (re.test(nrm(String(L.text)))) return L.price; } return null; };
                const doP = findP(/^DO$/i), woP = findP(/^WO$/i), pdV = findP(/^pdVWAP$/i), w0 = findP(/^VWAP$/i);
                // σ z rozestupu pásem (±1σ přímo, ±2σ /2) — stejný postup jako VWAP fallback výše.
                let sd = 0;
                if (w0 != null) {
                    const cand: number[] = [];
                    const p1 = findP(/^VWAP \+1σ$/i), m1 = findP(/^VWAP -1σ$/i), p2 = findP(/^VWAP \+2σ$/i), m2 = findP(/^VWAP -2σ$/i);
                    if (p1 != null) cand.push(Math.abs(p1 - w0));
                    if (m1 != null) cand.push(Math.abs(w0 - m1));
                    if (p2 != null) cand.push(Math.abs(p2 - w0) / 2);
                    if (m2 != null) cand.push(Math.abs(w0 - m2) / 2);
                    if (cand.length) sd = cand.reduce((a, b) => a + b, 0) / cand.length;
                }
                const isVwapFam = (t: string) => /^VWAP( [+-][12]σ)?$/i.test(t);
                const swept: string[] = [];
                let untAbove = 0, untBelow = 0;
                let nearUpD = Infinity, nearUp: string | null = null, nearDnD = Infinity, nearDn: string | null = null;
                for (const L of lv) {
                    const raw = String(L.text); const base = nrm(raw);
                    if (isVwapFam(base)) continue;
                    if (/\[\s*\d+\s*[x×]\s*\]/i.test(raw) && swept.length < 10) swept.push(base);
                    if (/untested/i.test(raw)) {
                        if (L.price > entry) { untAbove++; const d = L.price - entry; if (d < nearUpD) { nearUpD = d; nearUp = base; } }
                        else if (L.price < entry) { untBelow++; const d = entry - L.price; if (d < nearDnD) { nearDnD = d; nearDn = base; } }
                    }
                }
                const aH = findP(/^ASIA H$/i), aL = findP(/^ASIA L$/i), lH = findP(/^LON H$/i), lL = findP(/^LON L$/i);
                let londonVsAsia: string | null = null;
                if (aH != null && aL != null && lH != null && lL != null) {
                    const am = (aH + aL) / 2, lm = (lH + lL) / 2;
                    londonVsAsia = lm > am ? 'above' : (lm < am ? 'below' : 'inside');
                }
                const eU = ts.indexToTimePoint(si0);
                const ed = eU != null ? new Date(eU * 1000) : null;
                return {
                    available: true,
                    aboveDO: doP != null ? entry > doP : null,
                    aboveWO: woP != null ? entry > woP : null,
                    abovePdVWAP: pdV != null ? entry > pdV : null,
                    aboveVWAP: w0 != null ? entry > w0 : null,
                    vwapDistSigma: (w0 != null && sd > 0) ? Math.round((entry - w0) / sd * 100) / 100 : null,
                    sweptLevels: swept,
                    untappedAbove: untAbove, untappedBelow: untBelow,
                    nearestUntappedAbove: nearUp, nearestUntappedBelow: nearDn,
                    londonVsAsia: londonVsAsia,
                    entryMinutes: ed ? ed.getHours() * 60 + ed.getMinutes() : null,
                };
            } catch (e) { return { available: false, reason: String(e) }; }
        })();

        return {
            ok: true, isLong: isLong, entry: entry, tp: roundTick2(tp),
            swing: scanSL(swingLvl), ote: scanSL(oteLvl), fvg: scanSL(fvgLvl),
            tpTargets: tpTargets, excursion: excursion, entryMap: entryMap,
            entryContext: entryContext,
        };
    } catch (e) {
        return { ok: false, reason: String(e) };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Čistý snímek grafu přes nativní TradingView API (clientSnapshot → canvas).
// Vrací retina-rozlišení JPEG bez UI chromu, bez nutnosti ořezávat. Běží v MAIN
// world. executeScript v MV3 počká na vrácenou Promise.
//   window._exposed_chartWidgetCollection.clientSnapshot() → HTMLCanvasElement
// ─────────────────────────────────────────────────────────────────────────────
export function pageCaptureChart(): any {
    try {
        const wc = (window as any)._exposed_chartWidgetCollection;
        if (!wc || typeof wc.clientSnapshot !== 'function') return Promise.resolve({ ok: false, reason: 'no-snapshot-api' });
        return Promise.resolve(wc.clientSnapshot()).then((canvas: any) => {
            if (!canvas || typeof canvas.toDataURL !== 'function') return { ok: false, reason: 'no-canvas' };
            // JPEG 0.85 — menší než PNG, retina rozlišení zachováno
            const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
            return { ok: true, dataUrl: dataUrl, w: canvas.width, h: canvas.height };
        }).catch((e: any) => ({ ok: false, reason: String(e) }));
    } catch (e) {
        return Promise.resolve({ ok: false, reason: String(e) });
    }
}

// Content-side helper — požádá background, ať pustí snímač v MAIN world.
export function captureChartSnapshot(): Promise<{ ok: boolean; dataUrl?: string; reason?: string; w?: number; h?: number }> {
    return new Promise((resolve) => {
        try {
            chrome.runtime.sendMessage({ action: 'captureChart' }, (res) => {
                if (chrome.runtime.lastError) { resolve({ ok: false, reason: chrome.runtime.lastError.message }); return; }
                resolve(res || { ok: false, reason: 'no-response' });
            });
        } catch (e) {
            resolve({ ok: false, reason: String(e) });
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Layout grafu — kolik panelů (split screen) + jejich TF/symbol. MAIN world.
// ─────────────────────────────────────────────────────────────────────────────
export function pageGetLayout(): any {
    try {
        const wc = (window as any)._exposed_chartWidgetCollection;
        if (!wc || typeof wc.getAll !== 'function') return { ok: false, reason: 'no-collection' };
        const all = wc.getAll();
        const panes = all.map((cw: any) => {
            let res = ''; try { res = cw.getResolution(); } catch (e) { /* ignore */ }
            let sym = ''; try { sym = cw.model().mainSeries().symbolInfo().name; } catch (e) { /* ignore */ }
            return { res: res, sym: sym };
        });
        return { ok: true, paneCount: all.length, panes: panes };
    } catch (e) {
        return { ok: false, reason: String(e) };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Multi-timeframe snapshot. `frames` = pole "pohledů"; každý pohled = pole resolution
// per panel (split screen). Pro každý pohled přepne VŠECHNY panely, vyrámuje každý na
// obchod (searchByTime → zoomToBarsRange) a snímne CELÝ layout (clientSnapshot). Nakonec
// vrátí každému panelu původní TF i pohled. Prázdná resolution = panel se nemění.
// Bez async/await a bez ?./?? kvůli MAIN-world serializaci.
// ─────────────────────────────────────────────────────────────────────────────
export function pageCaptureMultiTF(frames: string[][]): any {
    try {
        const wc = (window as any)._exposed_chartWidgetCollection;
        if (!wc || typeof wc.clientSnapshot !== 'function') return Promise.resolve({ ok: false, reason: 'no-snapshot-api' });
        const panes: any[] = (typeof wc.getAll === 'function') ? wc.getAll() : [wc.activeChartWidget.value()];

        // Per-panel původní TF + pohled (indexy) pro restore.
        const orig = panes.map((cw) => {
            let res = ''; try { res = cw.getResolution(); } catch (e) { /* ignore */ }
            let range: any = null;
            try { const vr = cw.model().timeScale().visibleBarsStrictRange(); if (vr && typeof vr.firstBar === 'number') range = { from: vr.firstBar, to: vr.lastBar }; } catch (e) { /* ignore */ }
            return { res: res, range: range };
        });

        // Čas obchodu z RR boxu — hledá napříč panely (box je jen na jednom).
        let entryTime: number | null = null, exitTime: number | null = null;
        for (let p = 0; p < panes.length && entryTime == null; p++) {
            try {
                const model = panes[p].model(); const ts = model.timeScale();
                const isPos = (d: any) => d && (d.toolname === 'LineToolRiskRewardLong' || d.toolname === 'LineToolRiskRewardShort');
                const srcs = model.dataSources().filter(isPos);
                let target: any = srcs.length ? srcs[srcs.length - 1] : null;
                try { const sp = (model.selection().allSources() || []).filter(isPos); if (sp.length) target = sp[sp.length - 1]; } catch (e) { /* ignore */ }
                if (target) {
                    const pts = target.points();
                    entryTime = ts.indexToTimePoint(pts[0].index);
                    exitTime = pts.length > 1 ? ts.indexToTimePoint(pts[1].index) : entryTime;
                }
            } catch (e) { /* ignore */ }
        }

        const PAD_BEFORE = 30, PAD_AFTER = 15;
        const shots: any[] = [];
        const wait = (ms: number) => new Promise((res) => setTimeout(res, ms));
        const framePane = (cw: any) => {
            try {
                if (entryTime == null) return;
                const model = cw.model(); const ts = model.timeScale(); const bars = model.mainSeries().bars();
                const idxAt = (t: number | null) => {
                    if (t == null) return null;
                    let r: any = bars.searchByTime ? bars.searchByTime(t) : null;
                    if (r && typeof r === 'object' && typeof r.index === 'number') r = r.index;
                    return typeof r === 'number' ? r : null;
                };
                const e = idxAt(entryTime), x = idxAt(exitTime);
                if (e != null) { try { ts.zoomToBarsRange({ from: e - PAD_BEFORE, to: (x != null ? x : e) + PAD_AFTER }); } catch (err) { /* ignore */ } }
            } catch (err) { /* ignore */ }
        };

        const doFrame = (fi: number): any => {
            if (fi >= frames.length) return Promise.resolve();
            const frame = frames[fi] || [];
            for (let i = 0; i < panes.length; i++) { const r = frame[i]; if (r) { try { panes[i].setResolution(r); } catch (e) { /* ignore */ } } }
            return wait(1100).then(() => {
                for (let i = 0; i < panes.length; i++) framePane(panes[i]);
                return wait(350);
            }).then(() => Promise.resolve(wc.clientSnapshot())).then((canvas: any) => {
                if (canvas && typeof canvas.toDataURL === 'function') {
                    shots.push({ frame: frame.slice(), dataUrl: canvas.toDataURL('image/jpeg', 0.85), w: canvas.width, h: canvas.height });
                }
                return doFrame(fi + 1);
            });
        };

        return doFrame(0).then(() => {
            for (let i = 0; i < panes.length; i++) { if (orig[i].res) { try { panes[i].setResolution(orig[i].res); } catch (e) { /* ignore */ } } }
            return wait(700);
        }).then(() => {
            for (let i = 0; i < panes.length; i++) {
                try {
                    const ts = panes[i].model().timeScale();
                    if (orig[i].range) { ts.zoomToBarsRange(orig[i].range); }
                    else { ts.resetRightOffset(); ts.scrollToRealtime(); }
                } catch (e) { /* ignore */ }
            }
            return { ok: true, shots: shots, count: shots.length, paneCount: panes.length };
        }).catch((e: any) => {
            for (let i = 0; i < panes.length; i++) { if (orig[i].res) { try { panes[i].setResolution(orig[i].res); } catch (e2) { /* ignore */ } } }
            return { ok: false, reason: String(e), shots: shots };
        });
    } catch (e) {
        return Promise.resolve({ ok: false, reason: String(e) });
    }
}

// Content-side helpers.
export function getChartLayout(): Promise<{ ok: boolean; paneCount?: number; panes?: { res: string; sym: string }[]; reason?: string }> {
    return new Promise((resolve) => {
        try {
            chrome.runtime.sendMessage({ action: 'getLayout' }, (res) => {
                if (chrome.runtime.lastError) { resolve({ ok: false, reason: chrome.runtime.lastError.message }); return; }
                resolve(res || { ok: false, reason: 'no-response' });
            });
        } catch (e) {
            resolve({ ok: false, reason: String(e) });
        }
    });
}

export function captureMultiTF(frames: string[][]): Promise<{ ok: boolean; shots?: { frame: string[]; dataUrl: string; w: number; h: number }[]; paneCount?: number; reason?: string }> {
    return new Promise((resolve) => {
        try {
            chrome.runtime.sendMessage({ action: 'captureMultiTF', frames }, (res) => {
                if (chrome.runtime.lastError) { resolve({ ok: false, reason: chrome.runtime.lastError.message }); return; }
                resolve(res || { ok: false, reason: 'no-response' });
            });
        } catch (e) {
            resolve({ ok: false, reason: String(e) });
        }
    });
}

export interface CfManagement { exit: number; reason: string; bars: number | null; realizedR: number | null; trailSteps: number; trailFinal: number; trailStart: number; }
export interface CfSlResult { ok: boolean; valid?: boolean; sl?: number; rr?: number | null; outcome?: string | null; bars?: number | null; realizedR?: number | null; trail?: CfManagement | null; }
export interface CfTpTarget { label: string; price: number; outcome: string; bars: number; rr: number | null; realizedR: number | null; }
export interface CfExcLevel { label: string; price: number; reached: boolean; bars: number | null; r: number; dynamic?: boolean; }
export interface CfExcursion {
    available: boolean; reason?: string;
    flatByMin?: number; levelsContemporary?: boolean; vwapApprox?: boolean; tpLevels?: string[] | null; survivedToCutoff?: boolean; stopReason?: 'cutoff' | 'sl' | 'end';
    mfePotential?: number | null; mfePotentialR?: number | null; tpR?: number; leftOnTableR?: number | null;
    topReached?: { label: string; r: number } | null;
    levels?: CfExcLevel[];
    trail?: { exit: number; exitR: number | null; reason: string; bars: number | null } | null;
}
export interface CfEntryMap {
    available: boolean;
    structureType?: 'CHoCH' | 'BoS' | null;
    structureOrder?: number;
    odrazLevels?: string[];
    odrazPrice?: number | null;
    odrazLevelPrice?: number | null;
    entryLevels?: string[];
    entryLevelPrice?: number | null;
    entryFvg?: boolean;
}
export interface CfEntryContext {
    available: boolean; reason?: string;
    aboveDO?: boolean | null; aboveWO?: boolean | null; abovePdVWAP?: boolean | null; aboveVWAP?: boolean | null;
    vwapDistSigma?: number | null;
    sweptLevels?: string[]; untappedAbove?: number; untappedBelow?: number;
    nearestUntappedAbove?: string | null; nearestUntappedBelow?: string | null;
    londonVsAsia?: string | null; entryMinutes?: number | null;
}
export interface CounterfactualRead { ok: boolean; isLong?: boolean; entry?: number; tp?: number; swing?: CfSlResult; ote?: CfSlResult; fvg?: CfSlResult; tpTargets?: CfTpTarget[]; excursion?: CfExcursion; entryMap?: CfEntryMap; entryContext?: CfEntryContext; reason?: string; }

// entryOverride = recompute uloženého obchodu bez RR boxu na grafu:
//   { isLong, entry, sl, tp, entryUnix } (entryUnix = unix SEKUNDY vstupu).
export interface CfEntryOverride { isLong: boolean; entry: number; sl: number; tp: number; entryUnix: number; }
export function computeCounterfactual(overrideLevels?: { fvg?: number; ote?: number; swing?: number }, boxId?: any, flatByMin?: number, entryOverride?: CfEntryOverride | null): Promise<CounterfactualRead> {
    return new Promise((resolve) => {
        try {
            chrome.runtime.sendMessage({ action: 'computeCounterfactual', overrideLevels: overrideLevels || null, boxId: boxId ?? null, flatByMin: flatByMin ?? null, entryOverride: entryOverride || null }, (res) => {
                if (chrome.runtime.lastError) { resolve({ ok: false, reason: chrome.runtime.lastError.message }); return; }
                resolve(res || { ok: false, reason: 'no-response' });
            });
        } catch (e) {
            resolve({ ok: false, reason: String(e) });
        }
    });
}

export interface PositionRead {
    ok: boolean;
    reason?: string;
    boxId?: any;
    symbol?: string;
    direction?: 'LONG' | 'SHORT';
    entry?: number;
    sl?: number;
    tp?: number;
    risk?: number;
    riskActual?: number;
    perContractRisk?: number;
    rr?: number | null;
    qtyRaw?: number;
    qty?: number;
    accountSize?: number;
    minTick?: number;
    entryTime?: number;
    exitTime?: number | null;
    mfeUsd?: number | null;
    maeUsd?: number | null;
    mfeR?: number | null;
    maeR?: number | null;
    mfePoints?: number | null;
    maePoints?: number | null;
    autoOutcome?: string | null;
    autoExitPrice?: number | null;
    autoExitTime?: number | null;
    autoBarsHeld?: number | null;
    autoAmbiguous?: boolean;
}

// Volá se z content scriptu. Content script běží v isolated world a nevidí
// window._exposed_chartWidgetCollection, takže požádá background, ať reader
// spustí v MAIN world přes chrome.scripting.executeScript.
export function readActivePosition(boxId?: any): Promise<PositionRead> {
    return new Promise((resolve) => {
        try {
            chrome.runtime.sendMessage({ action: 'readPosition', boxId: boxId ?? null }, (res) => {
                if (chrome.runtime.lastError) { resolve({ ok: false, reason: chrome.runtime.lastError.message }); return; }
                resolve(res || { ok: false, reason: 'no-response' });
            });
        } catch (e) {
            resolve({ ok: false, reason: String(e) });
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Lehké čtení JEN úrovní boxu (entry/sl/tp/směr/index) — pro auto-sync polling.
// Žádný bar scan, žádný counterfactual → super levné, vhodné na opakované volání.
// ─────────────────────────────────────────────────────────────────────────────
export function pageReadBoxLevels(boxId?: any) {
    try {
        const wc = (window as any)._exposed_chartWidgetCollection;
        if (!wc) return { ok: false };
        const model = wc.activeChartWidget.value().model();
        const series = model.mainSeries();
        const si = series.symbolInfo();
        const minTick = si.minmov / si.pricescale;
        const isPos = (d: any) => d && (d.toolname === 'LineToolRiskRewardLong' || d.toolname === 'LineToolRiskRewardShort');
        const getId = (d: any) => { try { return typeof d.id === 'function' ? d.id() : d.id; } catch (e) { return null; } };
        const all = model.dataSources().filter(isPos);
        if (!all.length) return { ok: false };
        // Zamknuto na boxId → čti vždy ten samý box (i po kliknutí jinam zruší výběr).
        let target: any = null;
        if (boxId != null) {
            for (const d of all) { if (getId(d) === boxId) { target = d; break; } }
            if (!target) return { ok: false, boxGone: true };
        } else {
            try { const sp = (model.selection().allSources() || []).filter(isPos); if (sp.length) target = sp[sp.length - 1]; } catch (e) { /* ignore */ }
            if (!target) target = all[all.length - 1];
        }
        const props = target.properties();
        const rd = (k: string) => { const v = props[k]; return v && typeof v.value === 'function' ? v.value() : v; };
        const pts = target.points();
        const entry = pts[0].price;
        const isLong = target.toolname === 'LineToolRiskRewardLong';
        const stopLevel = rd('stopLevel'), profitLevel = rd('profitLevel');
        const sl = isLong ? entry - stopLevel * minTick : entry + stopLevel * minTick;
        const tp = isLong ? entry + profitLevel * minTick : entry - profitLevel * minTick;
        return { ok: true, boxId: getId(target), entry: entry, sl: sl, tp: tp, isLong: isLong, idx: Math.round(pts[0].index) };
    } catch (e) {
        return { ok: false };
    }
}

export function readBoxLevels(boxId?: any): Promise<{ ok: boolean; boxId?: any; boxGone?: boolean; entry?: number; sl?: number; tp?: number; isLong?: boolean; idx?: number }> {
    return new Promise((resolve) => {
        try {
            chrome.runtime.sendMessage({ action: 'readBoxLevels', boxId: boxId ?? null }, (res) => {
                if (chrome.runtime.lastError) { resolve({ ok: false }); return; }
                resolve(res || { ok: false });
            });
        } catch (e) {
            resolve({ ok: false });
        }
    });
}
