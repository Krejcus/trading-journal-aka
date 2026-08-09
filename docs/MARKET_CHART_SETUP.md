# Historický CME graf v detailu obchodu

Graf používá TradingView Lightweight Charts pouze jako renderer. OHLCV data poskytuje Databento (`GLBX.MDP3`) přes autentizovanou Supabase Edge Function `market-candles`: `ohlcv-1m` pro replay/exekuci a `ohlcv-1h` pro levnější HTF historii.

## Co je implementované

- výchozí MNQ graf, volitelný NQ přepínač;
- přesný kontrakt z importu (`MNQU6`), jinak volume continuous contract (`MNQ.v.0`);
- 1m, 5m, 15m a 30m z minutového zdroje; 1h, 4h a denní kontext z hodinového zdroje;
- entry/exit markery a risk/reward box z uloženého entry, původního SL a TP;
- session VWAP a volume-weighted 1 sigma odchylky;
- progresivní session high/low, daily/weekly open, PDH/PDL a PWH/PWL;
- třísvíčkové bullish/bearish FVG s ukončením při plné mitigaci;
- 1m CHoCH/BOS podle `tradingview/alphatrade-bos-choch-cz.pine`: pivot 1/1, potvrzení closem, vodorovná čára od proraženého pivotu k break baru; na vyšších timeframech se entry struktura záměrně nezobrazuje;
- screenshoty zůstávají ve vedlejší záložce jako původní evidence.
- minutová data se načítají dopředu po čtrnáctidenních segmentech; starší HTF historie se načte až při prvním HTF panelu a dál po ročních blocích při scrollu doleva;
- úspěšné odpovědi se na 30 dní ukládají do lokální IndexedDB cache a souběžné identické requesty se deduplikují;
- HTF provider svíčky překrývající začátek replaye se zahodí; od hranice replaye se 1h/4h/1d skládají pouze z již odhalených 1m svíček;
- obchodní příkaz před časem začátku backtest session odmítne exekuční vrstva, i když je starší HTF historie viditelná;
- před každým placeným stažením proběhne bezplatný `metadata.get_cost` preflight; výchozí serverový strop je `$1.00` za request a lze ho zpřísnit secretem `DATABENTO_MAX_REQUEST_COST_USD`.
- server zpracovává Databento JSONL po jednotlivých OHLCV záznamech a odmítne odpověď, která narazí na limit 25 000 svíček; neúplný graf se tedy nevykreslí jako kompletní.

Graf nikdy nenahrazuje chybějící CME data syntetickými daty. Obchod mladší než přibližně 24 hodin zobrazí čekací stav.

## Jednorázové serverové nastavení

Toto jsou produkční změny. Před nasazením udělej export/backup vzdáleného Supabase projektu podle `BACKUP_RESTORE.md`.

1. Založ Databento účet a vytvoř API key.
2. Klíč neposílej do chatu ani nedávej do `VITE_*` proměnné. Ulož ho jako Supabase Edge Function secret `DATABENTO_API_KEY`.
   Volitelně nastav také `DATABENTO_MAX_REQUEST_COST_USD=0.25` pro přísnější pojistku.
3. Nasaď pouze funkci `market-candles` s ověřováním JWT.
4. Otevři obchod starší než 24 hodin. Funkce povolí jen přihlášeného uživatele, symboly NQ/MNQ a schémata `ohlcv-1m`/`ohlcv-1h`. Minutové okno má limit 16 dní, hodinové 370 dní.

Příklad příkazů je záměrně pouze dokumentační; před spuštěním ověř aktuální syntaxi pomocí `supabase --help`:

```bash
supabase secrets set DATABENTO_API_KEY=...
supabase functions deploy market-candles
```

## Kontrola proti TradingView

Na jednom MNQ obchodu starším než 24 hodin porovnej:

1. přesný kontrakt a rollover datum;
2. timestamp a OHLC alespoň pěti 1m svíček včetně entry baru;
3. 5m, 15m a 1h agregaci;
4. session VWAP od 18:00 New York času a PDH/PDL;
5. entry/exit ceny a umístění markerů;
6. zda `stopLoss` v obchodu opravdu znamená původní SL. Pokud není uložený, graf risk box úmyslně nevykreslí.

Sdílená serverová candle cache zatím není součástí této změny. Pokud bude později potřeba cache mezi zařízeními/uživateli, vyžaduje samostatný návrh licencování, verzovanou migraci, RLS a Supabase advisories.
