# LIVE studený start: kostra → úplná data bez probliknutí (2026-10-08)

Autor: Claude · Zadání Filip: zrychlit cestu kostra → data na PC i iPhonu, bez probliknutí,
bez vlivu na správnost dat. Průběžné odhalování dat (Codexova verze z rána) Filip zamítl.

## Měření (produkce, PC Chrome, reload `?page=live`, ms od navigace)
| čas | co |
|---|---|
| 212–1 050 | 3× bootstrap preflight (paralelně) |
| 316–979, 460–1 589 | 2× `oauth/status` (LIVE + journal sync) |
| 449 | obsah: karty deníku pod kostrou („Zpracovávám uložené obchodní záznamy…“) |
| **1 034–1 349** | **prázdná plocha (315 ms)**, pak přehled |
| 1 085–1 800 | 2. kolo: 3× full preflight („Ověřuji“ u DLL/P&L) |
| 317–7 175 | `get_dashboard_data_light_v1` (6,9 s), pak ~70 sériových dotazů deníku |

Dnes jen 1 živý účet (FundedNext spálené, 2 ze 3 připojení prázdná), takže broker
část je podhodnocená. Čísla pro iPhone jsou odhady, dokud se neměří na zařízení.

## Příčiny (rozbor 5 čtenářů kódu, workflow `live-cold-start-analysis`)
1. `LiveJournalHistory` byl `React.lazy` a vykreslil se poprvé až s přehledem. Bez vlastní
   Suspense hranice suspendoval stránkovou hranici (App) a React 19 drží její fallback
   ≥ 300 ms (`FALLBACK_THROTTLE_MS`).
2. Studený start četl bootstrap a teprve po něm full. Full navíc čekal na probe report
   hostu (timeout až 8 s).
3. Bez session shellu (iPhone po ukončení, nový tab) preflight čekal na OAuth status.
4. Mezistavy:
   - „Žádné kopírovací skupiny“ během načítání knihovny;
   - banner „nemá plán“ před načtením plánů;
   - karty deníku pod kostrou.
5. iPhone:
   - LIVE je v menu Více a přednačtení (hover) tam neexistovalo;
   - zámek soukromí problikl při každém spuštění.
6. Relay status: 3 nezávislé DB dotazy šly za sebou.
7. Mimo rychlost: auto-save účtů po každém startu zapisoval účty z mezipaměti (riziko
   přepsání archivace / OAuth vazeb starší mezipamětí).

## Co je ve větvi `claude/live-cold-start-20261008`
| # | změna | přínos |
|---|---|---|
| 1 | Statické importy historie a karet deníku; přednačtený LiveDesk bez Suspense | konec prázdné plochy, ~0,3 s dřív |
| 2 | Karty deníku uvnitř LIVE až s daty | nic neskáče pod kostrou |
| 3 | „Žádné skupiny“ až po načtení knihovny (jinak kostra řádků) | žádný falešný prázdný stav |
| 4 | Banner „nemá plán“ až s `profilesLoaded` | žádný výskok banneru |
| 5 | Studený start = jeden full preflight (`historicalProbe: false`) + probe na pozadí (`mode: 'historical-probe'`) | PC ~0,7 s, iPhone ~1–1,5 s, víc s více účty |
| 6 | Trvalá nápověda ID připojení (`alphatrade_tradovate_live_hint_v1_<userId>`, jen ID) | iPhone po ukončení / nový tab ~0,6–1,2 s |
| 7 | Relay resolver: 3 dotazy souběžně, vyhodnocení ve stejném pořadí | ~0,2–0,35 s na každé čtení stavu přes relay |
| 8 | iPhone: menu Více přednačte LIVE (`bridge.prepare('live')`, Swift) | čas výběru v menu se využije na čtení |
| 9 | iPhone: zámek soukromí před prvním čtením jen neutrální kryt | žádný záblesk „AlphaTrade je uzamčený“ |
| 10 | Auto-save účtů jen po úpravě v aplikaci | oprava dat |

## Zamítnuto (oponentura 2 skeptiky na změnu)
- Jedna brána „vše hotovo“: posouvá okamžik zobrazení, data nezrychlí.
- Restart polleru stavu workeru: na studeném startu se skoro neuplatní.
- CORS Max-Age, zrcadlo Keychain session, dvojí čtení IndexedDB: zisk zanedbatelný nebo
  nejdřív měřit.
- Dashboard RPC v2 a paralelní hydratace deníku: LIVE na ně nečeká; samostatný úkol
  pro deník.

## Bezpečnost
- Žádná změna nemění, co se zobrazí jako ověřené.
- Nápověda připojení jen dřív spustí read-only čtení. Výsledek se zveřejní až po potvrzení
  ID čerstvým statusem (stávající `statusRef` filtry).
- Probe mění jen `historicalSync` (záložka Připojení).
- Kombinace verzí jsou bezpečné:
  - starý klient s novým serverem: beze změny;
  - nový klient se starým serverem: server flag ignoruje a probe přibalí, `not-checked`
    nevznikne a samostatný probe se nevolá.

## Zbývá změřit
- fyzický iPhone (produkční `dist-native`): studený start po ukončení → Více → LIVE;
- více účtů na připojení (bootstrap vs full při 10–20 účtech).

## Oponentura diffu (workflow `review-live-cold-start`, 4 oblasti, každý nález ověřen skeptikem)
Potvrzeno 9 nálezů (1× P2, 8× P3), vyvráceno 4 (mj. „nový uživatel bez uloženého
výchozího účtu“ — výchozí účet se uloží s prvním obchodem / úpravou).
Všechny potvrzené opraveny:
- **P2:** neutrální kryt soukromí byl v Auroře průsvitný (`--bg-page` 38–45 %), takže by
  prosvítala finanční data. Opraveno na neprůhledné `--aurora-base`.
- Přednačtení při hoveru a v menu Více nespouští úplná čtení účtů. Zahřeje jen
  OAuth status a profily, plné čtení až při vstupu na LIVE. Menu Více navíc
  nenastavuje `liveIntentPending`.
- Server: čtení bez probe převezme čerstvé/běžící `full` s probe (jedna dávka na
  login), opačně ne. Probe má vlastní coalescing.
- Probe historie:
  - respektuje Tradovate backoff připojení a 429 zapíše;
  - po chybě se zkusí jednou znovu;
  - text je „zatím neověřeno“ (nikdy „ověřuji“ bez běžícího dotazu).
- Karty deníku na LIVE:
  - jsou na jednom místě ve stromu;
  - jsou vidět všude kromě kostry, i bez připojení a při chybě (s tlačítkem Zkusit znovu).
- Příznak úprav účtů nese vlastníka. Odhlášení i přímé přepnutí uživatele ho zahodí,
  takže úprava A se nikdy neuloží pod B.
- Studený start počká jeden mikrotask, než spustí čtení. Odpojení (StrictMode, odchod
  z LIVE) tak neodešle osiřelé čtení u brokera.

## Druhé kolo (oponent commitu cfe904bf) — opraveno v 855b6f14
- Měření ukázalo další mezistav: přehled se odkryl po prvním připojení a účty druhého
  připojení ~0,3 s svítily „nedostupný“. Kostra proto čeká, až doběhne první úplné
  čtení všech připojení (strop 2,5 s od prvních dat, návrat s daty nečeká nikdy).
- Při zapnuté kopírce se kostra nedrží vůbec, aby OFF/kill nebyly ani o chvíli dál.
  Hláška po DISARM se pod kostrou neschová.
- Server sdílí jen hotové `full` (běžící čeká i na probe); bootstrap nikdy nejde
  cestou bez probe.
- Navigace nepředává React event jako volby záměru LIVE.
- Localhost po opravách: kostra 1,04 s → kompletní přehled 1,65 s v jednom kroku.
  Testy: 4988/4988, tsc bez nových chyb, iOS build prošel.
