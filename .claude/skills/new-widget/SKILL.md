---
name: new-widget
description: Přidá nový dashboard widget do AlphaTrade (registr, render case, constraints, default layout). Použij když uživatel chce nový widget na dashboard (live nebo backtest).
---

# Přidání dashboard widgetu

Postav nový widget konzistentně podle existujícího vzoru. Argument = popis widgetu (co má počítat/zobrazit). Pokud chybí, zeptej se na: id (snake_case), label, kategorie, jestli live/backtest/oba, velikost (KPI 1-řádek vs velký graf).

## Kroky (všechny soubory, nevynech žádný)

1. **Komponenta** v `components/Dashboard.tsx` — napiš `<Xxx>Widget: React.FC<{ stats: TradeStats; theme: any }>`. Vzor: `glass-panel` container, `<InfoIcon>` v hlavičce, počítej z `stats.trades` (memoizuj přes `useMemo`). Pro win/loss klasifikaci použij `_isWin`/`_isLoss`/`_isBEt`. Peníze přes `_money`/`money`. Vlož PŘED `const MASTER_WIDGET_LIST`.

2. **MASTER_WIDGET_LIST** (Dashboard.tsx) — přidej `{ id, label, category, icon: <... size={18} />, description, preview: <...>, defaultRowSpan }`. Ikony jsou z lucide (ověř import nahoře v Dashboard.tsx).

3. **Render case** v `renderWidget` switchi (Dashboard.tsx) — `case 'id': return <XxxWidget stats={stats} theme={theme} />;`.

4. **WIDGET_CONSTRAINTS** A **WIDGET_CONSTRAINTS_XXL** v `App.tsx` — obě! Bez toho ho `sanitizeLayouts` zahodí při loadu. KPI: `{minW:2,minH:2,maxW:6,maxH:4}` (lg) / `{...maxW:8}` (xxl). Velký: `{minW:4,minH:3,maxW:12,maxH:8}` (lg) / `{...minW:6,maxW:24}` (xxl).

5. **Scope (jen pokud backtest-related):**
   - Backtest-only widget → přidej id do `BACKTEST_ONLY_IDS` (Dashboard.tsx) — pak se nenabízí ani nerenderuje v live.
   - Backtest svět ho má vidět → přidej do `BACKTEST_WIDGET_IDS` (Dashboard.tsx).
   - Live default → přidej řádek do `DEFAULT_WIDGETS_LG` (App.tsx); backtest default → `DEFAULT_BACKTEST_WIDGETS_LG`.

6. **Ověř:** `npx tsc --noEmit` (žádné nové chyby). Pokud je to velký vizuální widget, ověř v preview.

## Pozn.
- KPI karty (jeden velký číselný stat) renderuj přes sdílenou `ProKpiCard` (label/value/subValue/info/icon) místo vlastního markupu — drží to konzistenci.
- `MASTER_WIDGET_LIST` se filtruje přes `visibleMaster` dle `dashboardMode` (live = bez `BACKTEST_ONLY_IDS`, backtest = jen `BACKTEST_WIDGET_IDS`).
