# Browser ověření — 5. 9. 2026

Reálný BacktestWorkspace + CandleKit + marketData loader/cache/aggregace. Testovací stránka `tests/qa/backtest.html`, localhost 4183; syntetické MNQ/NQ, lokální run/journal adaptéry, CSP blokuje externí spojení. Spuštění: `node tests/qa/start.mjs`.

Ověřené UI průchody:

1. BUY 2 @100,50; partial 1 při stejné ceně → pozice1, fills2, closed1, balance49998,89. Úplné zavření → closed2. Žádný pohyb kurzoru.
2. Nový buy limit99,50 uvnitř historického high/low zůstává pending po market BUY @100,50 a market CLOSE. Market SL100 nebyl zpětně zasažen starým low99,25. Výsledek: pozice0, fills2, closed1, balance49999,26 a stále pending limit99,50.
3. Go To na dostupný další čas provede pending fill; limit entry99,50 existuje ve výsledném runtime. Vzdálený datumový input se přes CUA fill nepodařilo změnit, proto celou vzdálenou Go To cestu prokazují deterministické helper/store testy, nikoli tento UI průchod.
4. Denní krok D přes segment: po záměrné chybě provideru zůstal cursor2026-08-05T14:59Z, viditelná chyba a tlačítko Zkusit znovu. Po retry a dalším D cursor2026-08-06T14:59Z; chyba zmizela.
5. Reopen saved zachoval cursor2026-08-06T14:59Z, balance50005,02, positions0, fills4, closedTrades2, journal2; žádné duplicitní řádky.

Během přípravy harnessu byly opraveny chybějící fake auth/run exporty a React Refresh transformace prebundled runtime. Finální cache je pod dočasným node_modules/.vite, vyloučená z React transformace; HMR vypnuto. Po posledním restartu nebyly zaznamenány nové runtime chyby; předchozí chyby zůstaly v historii konzole.

Hlavní projekt po přenosu: http://localhost:3001/ načetl přihlášený Dashboard a skutečná data. V konzoli zůstává dříve známé selhání externího currencyService.getRates; nejde o chybu replay/exekuce a neprohlašujeme celou aplikaci za bezchybnou. Backtest transakční průchody byly provedeny výše v odděleném QA.
