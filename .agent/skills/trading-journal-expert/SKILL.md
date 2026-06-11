---
name: trading-journal-expert
description: Advanced analysis of trading metrics, psychological patterns, and errors in the trading journal codebase. Use when modifying or advising on trading stats, charts, database models, or coach logic.
---

# Trading Journal Expert Skill

This skill guides the agent in analyzing trade logs, performance metrics, and psychological indicators inside the AlphaTrade Mentor codebase.

## 📊 Core Analytical Concepts

When writing code or advising on trading logic, always apply these analytical frameworks:

### 1. Expectancy & Mathematical Edge
A trade system's value is defined by its expectancy, not just win rate.
$$\text{Expectancy} = (\text{Win Rate} \times \text{Average Win}) - (\text{Loss Rate} \times \text{Average Loss})$$
*   Ensure calculations in `services/analysis.ts` treat Break-Even (BE) overrides correctly so they do not artificially distort win/loss ratios.

### 2. MAFE (Maximum Adverse / Favorable Excursion)
Utilize `runUp` and `drawdown` to evaluate trade execution quality:
*   **MAE (Maximum Adverse Excursion / Drawdown):** Tells us the maximum paper loss a trade experienced. Compare it to the `stopLoss` to determine if stop-losses are set too wide.
*   **MFE (Maximum Favorable Excursion / Run-Up):** Tells us the maximum paper profit a trade reached. Compare it to the final `pnl` to see if the trader left money on the table (bad exits).
*   **Implementation Guide:** Look at `findBadExits` in `services/analysis.ts` which identifies trades where the trade went up significantly (`runUp > 50`) but closed with low profit (`pnl < runUp * 0.2`).

### 3. Mistake Cost & Discipline Metrics
*   **Mistake Cost:** Sum of P&L from trades where `planAdherence === 'No'` or specific mistake tags (e.g., `FOMO`, `Revenge`) are present.
*   **Clean Equity:** Cumulative P&L calculated by excluding trades marked as `Invalid` or containing discipline errors. This shows the trader what their performance *would* be if they followed their plan.

---

## 🔍 Code Review & Diagnostic Guidelines

When reviewing trading logic components, watch out for:

1.  **State Synchronization & Caching:**
    *   Offline-first rendering uses `idb-keyval` alongside Supabase. Ensure local modifications to trades or journals update both the IndexedDB cache and sync to the cloud database in the background.
    *   Avoid double-saving or duplicate keys when combining social feeds or account groups.

2.  **Date & Time Alignment:**
    *   Obtain entry dates using `getTradeEntryDate` rather than assuming exit timestamps.
    *   Be mindful of time zone translations (e.g., CET vs. EST/New York trading hours).

3.  **useEffect Dependencies in DailyJournal:**
    *   Never create infinite loops during auto-save. The auto-save triggers on specific content changes, so dependency arrays must be strictly controlled.
