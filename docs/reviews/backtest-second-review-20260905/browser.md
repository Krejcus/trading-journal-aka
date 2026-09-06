# Druhý browser průchod — 5. 9. 2026

Aktuální canonical komponenty; browser řízen přes CUA. Hlavní app na localhost:3001 pouze čtení/navigace. Obchody a review níže výhradně v izolovaném syntetickém harnessu na 127.0.0.1:4184. Supabase/run service nahrazené testovacími moduly, connect-src omezený na lokální server, žádné externí AI/DB/broker akce.

## Co prošlo

1. MNQ syntetický run začíná na $50 000, commission $0,37 za stranu, zero slippage.
2. Replay na 14:01 UTC, BUY 1 MNQ @100,75.
3. Krok na 14:02, cena101,25: open gross P&L $1.
4. Ruční uzavření: netto +$0,26 po $0,74 komisích, balance/equity $50 000,26, dvě fills a jeden uzavřený obchod.
5. Zavření workspace, lokální checkpoint, Reopen saved: odpovídající balance, žádná otevřená pozice, jeden journal trade.
6. Druhý BUY @101,25 ve 14:02 se SL99, další krok na14:03 @101,50 a ruční uzavření. Netto −$0,24; celkový účet $50 000,02; čtyři fills a dva uzavřené obchody. Zobrazení peněz správně zaokrouhleno; interní float má obvyklou reprezentaci 50000.01999999999.
7. Review fixture: přidána poznámka „Druhý audit: čekal jsem na potvrzení odrazu.“ a vlastní tag „QA druhý audit“. Uložení a opětovné otevření zachovalo obojí, původní tag Trpělivost a auto konfluence U VWAP / Odraz od PDL včetně `autoConfluence`.
8. Konzole QA před i po závěrečném review průchodu obsahovala pouze dvě Vite debug zprávy a React DevTools info, bez warning/error. Testovací tab a vlastní QA server byly po dokončení uzavřené; hlavní localhost zůstal otevřený na Lab.

## Nově potvrzená chyba B01

Po druhém uzavření bylo z viditelného testovacího DOM přečteno:

```json
{
  "replayCursor": "2026-08-03T14:03:00.000Z",
  "tradeEntry": "2026-08-03T14:02:00.000Z",
  "manualExit": "2026-08-03T14:03:00.000Z",
  "executionPathLastBar": "2026-08-03T14:28:00.000Z",
  "executionPathBars": 26,
  "executionPathComplete": true,
  "excursionMfePotentialR": 1.33,
  "excursionStopReason": "sl",
  "excursionTrailBars": 26
}
```

Journal tedy už obsahuje budoucí cestu a následný zásah stopu, ačkoliv replay odhalil jen čas do14:03. Nešlo o přímé volání mapperu; záznam vznikl skutečným ovládáním komponenty. Čtená JSON byla explicitně vykreslená QA evidence, nikoli neveřejný React stav.

Přímé otevření těchto metrik v produkčním trade detailu během otevřeného replaye nebylo ověřeno. Zdroj ukazuje spotřebitele `TradeExecutionIntel`, Lab a datové nástroje; prokázané je předčasné vytvoření a uložení budoucích analytických dat.

## Hlavní aplikace

Byly načteny Backtest Dashboard, Session list, formulář Nová session a Lab. Lab skutečně zobrazuje counterfactual, excursion a bias pokrytí, leaky a experimenty; tyto funkce proto roadmapa neoznačuje jako zcela nové. Formulář nové session obsahuje volbu vlastního uloženého layoutu. Rozpojení jejího storage kontraktu bylo potvrzeno samostatným kódovým repro, nikoli odvozeno jen z neaktivního tlačítka.

Stávající uživatelské replay runy nebyly otevřeny ani obchodovány, aby kontrola nevytvářela jejich autosave změny. Nebyl zadán nový reálný experiment ani spuštěna AI analýza.

## Omezení testovacího ovládání

Rozbalený diagnostický QA panel překrýval BUY; kliknutí dopadalo do panelu. Použil jsem aktivaci viditelného tlačítka klávesou Enter a panel sbalil. To je kolize testovacího harnessu, nikoli prokázaná chyba produktu. Některé AX názvy jsou vizuálně uppercase, zatímco DOM accessible name zachovává běžná písmena; po opravě selectoru ovládání fungovalo.

Pro tento druhý průchod nebyly znovu vytvořeny všechny dřívější kresby/indikátorové šablony ani simulována skutečná dvě cloudová zařízení. Audit těchto oblastí je kombinací dřívější browser evidence, nového čtení kontraktů a reprodukcí souběhu/importu.
