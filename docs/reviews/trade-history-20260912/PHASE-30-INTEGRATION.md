# Fáze 30 — integrace aktuální hlavní větve

13. 9. 2026. Lokální historie fází 1–29 je uložená jako `0163c891` ve větvi `codex/history-evidence-20260913`. Do ní je izolovaně sloučen aktuálně načtený main `110aa0db5d9582348393babea9d1dda4c9657d81`. Žádný push nebyl proveden.

## Vyřešené vazby

Konflikty byly v importech workeru, nastavení společného broker sync požadavku a deníku projektu. Zachované jsou oba datové toky: journal entityTypes a volitelný cashBalance pro nový display feed; dokončení sync oznámí spojení jak historii, tak display pozorovateli. Worker importuje a zapojuje oba stávající moduly, nevzniká druhý socket na účet. PROJECT_LOG zachovává záznamy obou větví. Další změny LIVE display z main se sloučily automaticky.

Přidaný regresní test ověřuje jediný sync request, současné odběry cashBalance/orderVersion/fillFee/fillPair/cashBalanceLog bez duplicit, resync obou pozorovatelů a přijetí cash + nové journal verze. Historická verze se nadále nesmí vydávat za nový potvrzený execution order.

Dvě starší testovací očekávání z hlavní větve byla aktualizována podle jejího skutečného současného kontraktu: Currency se identifikuje `name: USD`, zatímco symbol je `$`; sdílený LiveRiskValue v legacy větvi již nemá původní inline tooltip. Kontrola aritmetiky DLL i vykreslené hodnoty 1 000 zůstala zachovaná. Nezměnilo se pravidlo rizika. Scoped lint dále vyžadoval zachování příčiny chyb existujícího runtime locku; původní chyby jsou připojené jako cause, logika zámku zůstala stejná. Odstraněný nepoužitý typový import a zbytečná inicializace pid.

## Ověření sloučené verze

- Celý balík: 386 souborů / 3 515 testů prošlo. Cílená integrace 59 testů, poslední opravené render/observer cesty 51 testů v pěti souborech.
- TypeScript aplikační a worker závislostní větve a historie testů prošel. Scoped ESLint merge souborů/testů bez chyb/varování. Nejde o tvrzení, že všechny staré komponenty repozitáře mají nulová lint varování.
- Vite/PWA build, 90 precache položek. Worker byl samostatně zabalen přes stejný esbuild režim jako installer do `/private/tmp/history-pilot-validation.mjs`, poté ověřen `node --check`; nebyl spuštěn, instalován ani restartován.
- Browser hlavního náhledu 4189: 12 účtů s plněním, screenshoty výchozí; CandleKit graf a rozbalené tři potvrzené změny SL 15:34:04.125, 15:34:04.635 a 15:34:44.400. Fiktivní data, žádný tvrzený přihlášený/broker E2E.
- SQL ani jeho migrace se během merge neměnily; jejich důkaz zůstává z fáze 29. `git diff --check` bez chyb.
- Logy `/private/tmp/journal-phase30-{tests,full-tests,types,lint,build,worker-build}.log`. Lokální main ref byl ověřen read-only fetch, canonical pracovní soubory se neupravovaly.

## Hranice předání

Konkrétní požadavky, současné důkazy, limity a navržený postup jsou v `ACTIVATION-REVIEW.md`. Přesný seznam lokálních změn proti main je v `ACTIVATION-FILES.txt` (190 cest včetně dokumentace/testů).

Zbývající reálný sběr/import/UI a DEMO conformance závisí na aktivaci: samostatná záloha, schválená změna databáze/app/Edge Functions, worker pouze při doloženém DISARMED/flat stavu. Není udělen souhlas k automatickým broker příkazům, ARM ani Flatten. Celkový cíl zatím není označen hotový; lokální provedení a jeho limity jsou připravené k řízenému zprovoznění.
