# Opravy kompletního review backtestu — 5. 9. 2026

Opraveny všechny technické nálezy 1–17 i obě UI poznámky z [původního review](README.md). Původní review a repro výsledky popisují stav před opravou; nejsou výsledkem aktuálního enginu.

| Nález | Výsledné chování | Regresní důkaz |
|---|---|---|
| 1, 2 | SL/TP se řeší už po intrabar vstupu; market klik používá pouze známý close a nepřehrává cizí objednávky ani high/low | backtestExecutionCausality, backtestEngine |
| 3, 7, 8 | Go To/velký krok čeká na souvislá data; denní krok načítá další segmenty; reopen umí doplnit chybějící prefix session | backtestReplayData, backtestCandleStore, chartReplay |
| 4 | Trvalá fronta uzavřených obchodů, ACK jen po potvrzení serveru, automatická obnova a retry; insert-only chrání pozdější review | backtestTradeOutbox, storageBacktestPersistence |
| 5, 6, 9 | CAS konflikt nepřepisuje cloud; data a index jsou oddělené podle uživatele; atomický index neztrácí souběžné zápisy | backtestRunService |
| 10, 11 | Cloud chyba zůstává viditelná a opakuje se; potvrzený baseline přežije částečné selhání; ledger sleduje obsah, nejen replay čas | backtestRunService |
| 12 | MFE/MAE vylučují prokazatelný pohyb po exitu; neurčitelné extrémy jsou označené dolní meze a nevstupují do přesných distribucí Labu | backtestExecutionCausality, labAnalytics, storageBacktestPersistence |
| 13 | Monte Carlo ruin znamená absolutní equity <= 0 v kterémkoli bodě simulace | backtestMonteCarlo |
| 14, 16 | Scale-in/partial/final/reversal mají správnou identitu pozice; boxy končí až úplným uzavřením | backtestOrderJournal, backtestExecutionCausality |
| 15 | Přidání SL/TP z grafu zapisuje aktuální replay čas a journal event | BacktestWorkspace → updatePositionBracket; backtestOrderJournal |
| 17 | TP zachovává limitní cenu i při slippage; gap může poskytnout lepší limit fill | backtestExecutionCausality |
| UI | Backtest history nedostává LIVE copier importy/akce; VWAP sigma a MFE/MAE mají dvě desetinná místa; bracket formulář sleduje drag změny | App props, TradeConfluence, TradeExecutionIntel, BacktestWorkspace |

Doplněna kontrola čekajících triggerů mezi open a ochrannou cenou. Scale-in nebo dílčí exit se vyplní před vzdálenějším SL/TP; jeden order se nikdy nezapočte dvakrát. Protilehlé neznámé pořadí je výslovně označeno, engine nevymýšlí tickovou cestu.

Konflikt cloudové session lze řešit akcí „Uchovat lokální kopii a načíst cloud“. Archivované lokální kopie jsou exportovatelné ze seznamu Sessions. Chyby lokálního checkpointu a fronty deníku jsou viditelné; selhání lokálního checkpointu brání nebezpečnému zavření workspace.

## Ověření

- Kompletní sada s omezením na dva workery: **221 souborů / 1 834 testů passed** (78,90 s).
- Finální cílený běh po dokončení engine změn: **26 souborů / 330 testů passed** (2,06 s).
- `NODE_OPTIONS=--max-old-space-size=4096 npm run typecheck`: **exit 0**.
- Standardní `npm run build -- --outDir /private/tmp/alphatrade-backtest-build-20260905`: **exit 0**, včetně service workeru.
- ESLint změněného kódu: bez chyb; historické unused warnings Dashboardu zůstávají.
- Po přenosu do hlavního projektu: všech 46 přenesených souborů bajtově shodných s ověřeným snapshotem; cílené **330/330 passed**, typecheck **exit 0**, `git diff --check` **exit 0**. Hlavní Vite běží na http://localhost:3001/.
- Podrobnosti: [svíčky](candle-verification.md), [persistence](persistence-verification.md), [browser](browser-verification.md).

První široký testovací běh byl ukončen po chybách sandboxových localhost testů a nadměrném paralelismu. Opakování s povoleným loopbackem a dvěma workery prošlo celé. Experimentální Vite config runner nepodporoval stávající __dirname v configu; standardní build loader prošel.

## Rozsah

Žádný push, deployment, změna databázového schématu ani broker akce. Staré uložené chybné PnL/výsledky se samovolně nepřepisují. OHLC neurčuje úplné pořadí cen uvnitř minuty; označené konzervativní výsledky a dolní meze nejsou ticková exekuce. Browser QA používá syntetická data a lokální adaptéry; skutečnou Supabase persistenci pokrývají izolované regresní testy, nikoli zápis do uživatelova deníku.
