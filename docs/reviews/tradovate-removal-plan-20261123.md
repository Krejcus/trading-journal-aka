# Odstranění Tradovate, TradingView a IBKR — plán a stav (23. 11. 2026)

Rozhodnutí Filipa: appka jde čistě na Rithmic (+ starší Databento). Pryč: Tradovate (kopírka, OAuth,
import deníku, LIVE), ceny a svíčky z TradingView a IBKR, ruční Tradovate CSV import, mechanismus
screenshotů kopírky. Zůstává: všechny obchody v deníku včetně existujících screenshotů, Pine
indikátory ve složce `tradingview/`, jádro LIVE grafu, které používá Rithmic.

Větev `claude/remove-tradovate-20261123`, worktree `~/alphatrade-worktrees/remove-tradovate`.
Archiv: tag `archive/tradovate-final-20261123`.

## Hotovo

| Fáze | Stav |
|---|---|
| 0 Záloha kódu | tag (pushnut) + bundle `~/AlphaTrade-backups/code/` |
| 0 Záloha DB | cílený pg_dump `~/AlphaTrade-backups/supabase/manual-tradovate-20261123/` (bez OAuth tokenů) |
| 1 Worker | odinstalován + zakázán, stav v `~/AlphaTrade-backups/copier-final-20261123/` (NESPOUŠTĚT) |
| 1 Zařízení, OAuth | 4 zařízení odvolána, 2 připojení odpojena (tokeny smazány) |
| 2 Zmrazení obchodů | migrace `20261123100000_freeze_tradovate_journal` APLIKOVÁNA: 1 550 historií v `trade_execution_history`, 1 016 obchodům vazby screenshotů v `trades.data.copierSnapshots`, značka `journalFrozenAt` |
| 2 Čtení deníku | `services/journalTradeHydration.ts` čte jen `trades` + `trade_execution_history`; `journalSnapshotHydration` smazán |

## Vlny mazání kódu (každá: tsc, celé testy, build, kontrola Rithmic LIVE)

1. **Izolované serverové části:** `api/tradovate/**`, `api/tradingview/**`, `api/tradecopia-events.ts`,
   `api/cron/journal-import.ts` (+ cron ve `vercel.json`), `api/mac-companion/**`, `api/price-alerts/**`,
   `scripts/copier/**`, `scripts/market-data/tvPriceFeedProbe.ts`, `server/tradovate*`, `server/*copier*`,
   `server/tvPrice*`, `supabase/functions/tradecopia-shadow-ingest`, `sample-tradovate-export.csv`,
   `services/tradovateImport.ts` (CSV), `macos/AlphaTradeStatus`.
2. **UI nad Tradovate:** záložka kopírky a připojení (`LiveCopyTradeOverview`, `TradovateLiveDesk`,
   `AccountsManager` připojení, `MacCompanionSettings`), přepínače v `App.tsx`.
3. **Sdílený LIVE kód:** Rithmic dnes přes `LiveTradingScreen`, `useLiveChartData`, `leaderEntryPlace`
   atd. tranzitivně dosahuje ~35 modulů s Tradovate/TV v názvu. Tradovate větve vyříznout, obecné
   moduly se zavádějícím názvem (obchodní den CME, výběr barev, katalog prop plánů) přejmenovat.
4. **DB:** jedna migrace DROP Tradovate/kopírkových/TV tabulek a funkcí. Předtím přepsat triggery na
   `trades` (`sync_journal_trade_projection_root`, `protect_journal_trade_identity`), které Tradovate
   tabulky čtou — ochrana čísel zmrazených obchodů má zůstat. Podmínka: čerstvá úplná záloha.
5. **Úklid:** staré worktree a větve, `docs`, paměť, iOS build (widgety / Live Activity).

## Průběh vln

- **Vlna 1 (commit 87bb5bf2, WIP — zatím se nebuildí):** smazáno 176 souborů / ~45 500 řádků:
  `api/tradovate`, `api/tradingview`, `api/mac-companion`, `api/price-alerts`, `api/native-widget-*`,
  `api/native-live-activity-*`, `api/native-snapshot-test`, cron `journal-import`, `scripts/copier`,
  `server/tradovate*`, `server/*copier*`, `server/native(LiveActivity|Widget|Snapshot…)*`,
  `server/priceAlert*`, `server/tvAlert*`, `macos/AlphaTradeStatus`, TradeCopia funkce.
  `api/cron/send-alerts` ponechává jen plánovaná upozornění; `server/notificationDelivery` bez kopírky.
- **Zbývá z vlny 1:** klientská strana importu deníku v `App.tsx` (`runCopierJournalSync`,
  `JournalImportStatus`, `JournalSourceStatus`, `journalSourceConnections`), `nativeCopierNotifications`
  v `TradovateLiveDesk` a `nativeSessionCleanup`, smazání testů mazaných modulů.
- **Vlna 2 — LIVE:** Rithmic dnes žije uvnitř `components/TradovateLiveDesk.tsx` (3 074 ř.): záložky
  Graf (`RithmicLiveChart` / `RithmicPhoneChart`) a Kopírka (`RithmicCopierTab`), přehled = Tradovate
  `LiveCopyTradeOverview` (7 677 ř.). Cíl: nový štíhlý LIVE desk jen pro Rithmic, Tradovate desk smazat.
- **Nové zjištění:** `tradovate_journal_untaken_orders` = 141 nevzatých příkazů (karty v Hodnotit),
  2 s hodnocením — před DROP rozhodnout, zda zmrazit.

## Otevřené otázky na Filipa

- Rozšíření prohlížeče `extension/` („Alpha Bridge v2", TradingView/FX Replay → appka, naposledy
  měněno 23. 7.) — smazat?
- Obchody z importu se cizím (sdílení, propojení) dál neukazují, stejně jako před zmrazením.
