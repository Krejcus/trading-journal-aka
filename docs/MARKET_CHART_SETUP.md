# Historický CME graf v detailu obchodu

První verze používá TradingView Lightweight Charts pouze jako renderer. OHLCV data poskytuje Databento (`GLBX.MDP3`, `ohlcv-1m`) přes autentizovanou Supabase Edge Function `market-candles`.

## Co je implementované

- výchozí MNQ graf, volitelný NQ přepínač;
- přesný kontrakt z importu (`MNQU6`), jinak volume continuous contract (`MNQ.v.0`);
- 1m, 5m, 15m a 1h z jednoho 1minutového zdroje;
- entry/exit markery a risk/reward box z uloženého entry, původního SL a TP;
- session VWAP a volume-weighted 1 sigma odchylky;
- progresivní session high/low, daily/weekly open, PDH/PDL a PWH/PWL;
- třísvíčkové bullish/bearish FVG s ukončením při plné mitigaci;
- 1m CHoCH/BOS podle `tradingview/alphatrade-bos-choch-cz.pine`: pivot 1/1, potvrzení closem, vodorovná čára od proraženého pivotu k break baru; na vyšších timeframech se entry struktura záměrně nezobrazuje;
- screenshoty zůstávají ve vedlejší záložce jako původní evidence.
- obchody ze stejného UTC dne sdílejí jedno šestnáctidenní Databento okno a úspěšná odpověď se na sedm dní ukládá do lokální IndexedDB cache; překrývající kopie účtů proto zbytečně nevytvářejí další placené requesty.
- před každým placeným stažením proběhne bezplatný `metadata.get_cost` preflight; výchozí serverový strop je `$1.00` za request a lze ho zpřísnit secretem `DATABENTO_MAX_REQUEST_COST_USD`.
- server zpracovává Databento JSONL po jednotlivých OHLCV záznamech a odmítne odpověď, která narazí na limit 25 000 svíček; neúplný graf se tedy nevykreslí jako kompletní.

Graf nikdy nenahrazuje chybějící CME data syntetickými daty. Obchod mladší než přibližně 24 hodin zobrazí čekací stav.

## Jednorázové serverové nastavení

Toto jsou produkční změny. Před nasazením udělej export/backup vzdáleného Supabase projektu podle `BACKUP_RESTORE.md`.

1. Založ Databento účet a vytvoř API key.
2. Klíč neposílej do chatu ani nedávej do `VITE_*` proměnné. Ulož ho jako Supabase Edge Function secret `DATABENTO_API_KEY`.
   Volitelně nastav také `DATABENTO_MAX_REQUEST_COST_USD=0.25` pro přísnější pojistku.
3. Nasaď pouze funkci `market-candles` s ověřováním JWT.
4. Otevři obchod starší než 24 hodin. Funkce povolí jen přihlášeného uživatele, symboly NQ/MNQ a časové okno nejvýše 16 dní.

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

Teprve po této kontrole má smysl přidávat persistentní candle cache, replay a automatické vyhodnocování struktury. Persistenci bude nutné řešit verzovanou migrací, RLS/licencováním a Supabase advisories.
