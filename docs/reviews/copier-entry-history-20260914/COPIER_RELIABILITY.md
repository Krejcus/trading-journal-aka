# Kopírka — druhý incident 14. 9. 2026 a opravy

Tento dokument popisuje lokální opravu navazující na nasazený `33ea4271` a
dosud nenasazenou opravu screenshotů `86d72d2e`. Testy používají výhradně
paměťový broker. Nejde o potvrzení nového běhu na skutečných účtech.

## Co se stalo (Europe/Prague)

- 12:52:03: leader i všech šest followerů otevřeli short 1 MNQ za 28 931,50.
  Vstup se tedy zkopíroval na všechny účty.
- 12:52:31: leader přidal samostatný SL 28 941,25. Follower SL byly přijaty
  přibližně ve 12:52:33.
- 12:52:50: broker potvrdil posun leader SL na 28 930,50 (`Replaced`).
  Adaptér dál emitoval starou cenu. V execution auditu nebyly follower modify.
- 12:53:10: leader vystoupil, follower účty zůstaly short.
- 12:53:12: pojistka zjistila rozdíl, ale stojící follower Stop označila jako
  probíhající exit. Čekala opakovaně místo cíleného zavření.
- 12:53:25: operátor zadal Flatten skupiny; followeři vystoupili
  ve 12:53:27–28. Šlo o ruční Flatten, nikoli úspěšnou automatickou reakci.
- V tomto druhém testu se entry i exit screenshot úspěšně uložily.

Podklady: kopie lokálního durable snapshotu/outboxu, audit, journal se skutečnými
OrderVersion/ExecutionReport/Fill/Position, stav workeru a read-only záznam
relay příkazu Flatten. Soukromé podklady zůstávají mimo Git v
`/private/tmp/alphatrade-exit-incident-20260914`.

## Příčiny a provedené změny

1. **Potvrzené ceny.** Samostatná OrderVersion představuje požadavek.
   Adaptér ji nově uchová a do execution dat povýší přesně verzi potvrzenou
   `New`/`Replaced` přes `commandId`. Zvládá obě pořadí událostí, později
   doručenou verzi, opakování i několik rychlých změn. Chybějící potvrzená
   verze blokuje autoritativní kontrolu místo vrácení staré ceny jako aktuální.
2. **Obnova z REST.** Ani nejvyšší ID v `/orderVersion/list` není potvrzení.
   Při potřebě obnovit změnu se čte ExecutionReport. Novější požadavek bez
   potvrzení nebo zamítnutá změna nepřepíše platnou cenu. Čtení grafu dál sdílí
   souběžní volající; nové běžné streamové potvrzení nepotřebuje plošný REST refresh.
3. **Zamítnutí.** Zamítnutí Modify/Cancel se vztahuje ke konkrétnímu příkazu,
   nepřepisuje platný pracovní Stop na Rejected. Čekající volání dostane známé
   zamítnutí bez čekání na celý timeout. HTTP ACK ani shoda se starou cenou
   nestačí k potvrzení modify.
4. **Vazby a pořadí.** Neúplný ExecutionReport zachová parent/OCO vazby.
   Zpožděné Working nesmí obnovit již ukončený příkaz. Pozdní Replaced může
   doplnit cenu i za novějším terminálním reportem, ale nevrátí jeho stav zpět.
5. **Záložní zavření.** Potvrzený pracovní samostatný Stop/Limit patří mezi
   stojící ochranné příkazy. Po flat leadera neblokuje pojistku navždy.
   Unknown/sending a skutečný Market exit zůstávají chráněné před duplicitním
   odesláním. Automatické zavření dál vyžaduje uložený důkaz vlastnictví kopie,
   čerstvý stav a povolenou existující politiku. Použije nativní likvidaci
   konkrétního account/symbol, potvrdí flat a teprve pak uklízí příkazy.
6. **Prázdné pozice.** Úplný prázdný snapshot odstraní staré lokální pozice.
   Neukazuje se dál dřívější expozice jen proto, že broker flat řádek vynechal.
7. **Samostatný SL a čekání.** SL/TP snižující otevřenou pozici nečeká v OSO
   okně pro nový vstup. SL bez TP přidaný těsně po fillu může po krátkém okně
   pro rozpoznání páru pokračovat samostatně, pokud čerstvé čtení potvrdí
   stejnou otevřenou epochu, pracovní Stop a odpovídající množství. Použije se
   poslední potvrzená cena. Zrušení SL, DISARM a změna bezpečnostní generace
   zneplatní odložené odeslání. Neúplné nativní OSO před vyplněním vstupu ani
   nejednoznačné ochranné páry se touto výjimkou nepovolují.

Korelace příkazů odpovídá [oficiálnímu API Tradovate](https://api.tradovate.com/)
(`executionReport`, `command`, `orderVersion`) a konkrétním událostem tohoto
incidentu. Cena se neodhaduje z grafu, P&L ani výsledku jiného účtu.

## Rozsah ověření

| Oblast | Ověření |
| --- | --- |
| Skutečný adaptér → controller → follower požadavky | Nový in-memory HTTP/WebSocket harness; produkční Tradovate adaptér i controller |
| Fan-out | 1, 6 a 12 followerů; vstup, tři potvrzené posuny SL a guard zavření |
| Dílčí plnění | 12 on-fill followerů, 1 + 4 + 1; duplicity fillů bez dalšího POSTu |
| Výstupy | Částečný ruční výstup 2 a závěrečný 4; bez zbytečné další likvidace |
| Samostatný SL | Ihned po fillu, změna během čekání, následné modify, cancel a DISARM |
| Potvrzení změn | Obě pořadí, pozdní metadata, zamítnutí, pouze ACK, stejná cena, REST obnova, staré reporty |
| Native OSO/OCO | Stávající controller/runner/correlator regrese včetně partial fill a venue resize |
| Nejasný výsledek a restart | Chaos testy, durable outbox, lookup před rozhodnutím, žádný slepý resend |
| Výpadky spojení | Odpojení, reconnect, renewal, rate-limit breaker a DISARM/reconciliation |
| Safety | Kill switch, stale generation, cizí expozice, jiné symboly, limity, cooldown, časová pravidla |
| Historie a screenshoty | Celá stávající sada journal/import/snapshot včetně čekající opravy screenshotů |

Nové regresní soubory: `tradovateConfirmedOrderVersions.test.ts` a
`copierTradovateLifecycle.test.ts`; transportní fixture je
`tests/helpers/tradovateWireHarness.ts`. Dřívější ručně vytvořené fixture
OrderVersion v mapping testech byly upraveny na skutečnou vazbu ID a explicitní
ExecutionReport. Očekávání potvrzených cen nebo bezpečnostních zábran se
neoslabovala.

## Co testy nedokazují a co zbývá při aktivaci

- Paměťový transport neprokazuje latenci internetu, dostupnost OAuth, skutečné
  broker filly ani pořadí všech budoucích událostí. Změna odstraňuje konkrétní
  čekání v kódu; rychlost na reálných účtech se musí změřit zvlášť.
- Výpadek Macu či připojení nelze opravit lokálním testem. Brokerem již přijatý
  SL může fungovat dál, nové pokyny ale bez spojení odesílat nelze.
- Safety pojistka po zásahu zůstává DISARMED a vyžaduje explicitní kontrolu
  reality. Výsledek flat nemaže historii incidentu a sám nezapíná kopírování.
- Před aktivací zkontrolovat aktuální flat/no-working stav, zálohovat runtime,
  schváleně nasadit konkrétní web commit a stejný worker bundle. Po restartu
  ověřit hash, spojení, všechny účty a reconciliation; bez automatického ARM.
- Následný malý, výslovně povolený broker test musí potvrdit entry, SL/TP,
  několik změn a exit na každém účtu. Žádný takový obchod tento opravný běh
  neprovedl.

## Výsledky finální kontroly

- Celá sada: **397 souborů / 3 603 testů passed** (86 s, `maxWorkers=2`).
- `npm run typecheck`: exit 0. `npm run build`: exit 0.
- Lint dotčených souborů: 0 errors, 3 dřívější unused warnings v controlleru.
- Worker bundle: esbuild + `node --check` passed; SHA-256
  `22d09bf751a8ac2243e532a3fabc58cf6c1847d39d6372e75353c7f8ffd9217d`.
- Lokální bundle připraven, neinstalován. Produkční aplikace i worker
  nadále běží na dříve schválené ranní opravě.
