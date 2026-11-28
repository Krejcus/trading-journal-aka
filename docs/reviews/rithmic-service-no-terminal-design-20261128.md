# Služba Rithmicu bez terminálu (návrh v2, 28. 11. 2026)

Stav: **fáze 1 postavena 28. 11. (zjednodušená, viz níže); fáze 2 BLOKOVANÁ druhým kolem oponentury** (SIGTERM od launchd
se dnes bere jako čisté ukončení i s pozicí; trvalý stav služby leží vedle skriptu → připnuté vydání by mělo jiný
souhlas/záznam ochrany než lucid.sh). Fáze 2 vyžaduje nejdřív přesun trvalého stavu na pevnou cestu a ukončení
v obchodě bez flat = incident. Původně: **návrh v2** po oponentuře (copier-design-critic, 28. 11.: v1 BLOKUJE — přepínání režimu restartem s otevřenou
pozicí). Filip 28. 11.: „pusť se komplet“; rozhodnutí: **jen Touch ID** (bez opisování věty), **čtení běží vždy**.

## Dnes (krátce)

`lucid.sh` v terminálu: `obchod` (souhlas `grantLiveTrading.ts` + opsání věty při startu), `obnovit` (Touch ID +
předání běžící obchodní služby, jen bez pozice), `cteni`, `zavirani` (opsání `ZAVIRAT`). Souhlas = soubor, platnost
≤ 24 h, strop kusů, povinný SL, kontrola každých 10 s. Jedna instance (zámek před přihlášením). SIGTERM → `stop()`
nečeká na běžící příkaz (devTradeServer.ts:1067).

## Model hrozeb (poctivě)

Chráníme se proti **nechtěnému nebo automatickému zapnutí obchodu** (skript, agent, chybný restart, starý soubor),
ne proti škodlivému programu s právy Filipova účtu — ten umí přepsat kód služby i klíč, stejně jako dnes umí psát do
terminálu. Úroveň „obchod zapíná jen člověk u Macu“ zůstává; podpis ze Secure Enclave ji dokládá lépe než opsání
věty (to projde i skript s pseudoterminálem). Cesta přes terminál (`lucid.sh`) zůstává jako záloha se stejným
pravidlem jako dnes.

## Dotčená pravidla

INV-DEFAULT-01/03, INV-RECON-01/02, INV-OUTBOX-01, INV-UI-01/02, INV-RISK-01/04, INV-WORKER-02/04, INV-TRAD-05/09,
INV-ARM-03 a pravidla služby (obchod spouští člověk; zavírání dnes chce TTY + `ZAVIRAT`).

## Základní pravidla v2

1. **Obchodní služba se nikdy nerestartuje zvenku.** Nikdo (launchd, lišta, sync) nepošle SIGTERM procesu v režimu
   obchod nebo zavírání. Přechody **obchod → zavírání** jdou **uvnitř procesu** (odvolání souhlasu; dnes už blokuje
   nové vstupy, devTradeServer.ts:759–766). **Zavírání/obchod → čtení** jen předáním, které si služba udělá sama:
   rozšíření stávající cesty `maintenance` (kontrola flat, žádné čekající příkazy, žádný nejistý zápis, `canRestart`)
   o cíl „čtení“; pak služba skončí kódem „předáno“ a naběhne čtení.
2. **Žádný supervizor nad službou.** Služba je přímo launchd job `com.alphatrade.rithmic-service`
   (`KeepAlive` s brzdou, `AbandonProcessGroup`), takže pád pomocných částí ji nezabije. Režim při startu určuje
   služba sama z trvalých souborů v Application Support:
   - čerstvý **podepsaný požadavek na obchod** (viz níže) → obchod;
   - jinak, když předchozí běh skončil **pádem v obchodě/zavírání** (trvalý záznam běhu) → **zavírání** + trvalý
     incident; druhý pád v řadě → **čtení** + poplach (zavírání pak jde z `lucid.sh zavirani` jako dnes);
   - jinak **čtení**. `mode`/požadavek na obchod nikdy nepřežije restart (INV-DEFAULT-01, INV-RECON-01).
3. **Připnuté vydání.** launchd spouští kopii kódu v `~/Library/Application Support/AlphaTrade/rithmic-service/<commit>`
   (instalační skript, jako noční záloha), ne živý checkout — upravený kód sám nenaběhne.
4. **Lidský krok = podpis ze Secure Enclave.** Při instalaci se vytvoří klíč P-256 s `.userPresence` (ověřeno 28. 11.:
   jde i z programu přeloženého `swiftc`). Lišta vytvoří požadavek {systém, uživatel, účet, strop, SL, platnost,
   `grantedAt`, jednorázový `nonce`}, text systémového dialogu Touch ID obsahuje celé shrnutí, podpis až po Touch ID.
   Služba:
   - před přihlášením ověří podpis, stáří ≤ 2 min a že `nonce` není v **trvalém seznamu spotřebovaných** — a nonce
     tam zapíše dřív, než se přihlásí;
   - při každé kontrole (10 s) ověřuje podpis a **plnou shodu** se souhlasem ze startu; platnost počítá ze startu;
   - podepsaný požadavek nikdy neplatí pro restart (jen pro jeden start).
5. **Incident přežije restart.** Pád, odmítnutý start, vyčerpaný rozpočet → trvalý záznam, ukazuje lišta i appka,
   dokud ho Filip nepotvrdí (INV-DEFAULT-03). Automatické kontroly ho nemažou.
6. **Rozpočet Rithmicu.** Čtení si nesmí vzít rezervu obchodu: přihlášení čtení jen při ≤ 12 z 20 přihlášení za hodinu
   a mimo posledních 25 % týdenního stropu dotazů; brzda KeepAlive podle trvalého okna přihlášení.
7. **Zavírání automaticky** (jen po pádu): totéž, co dnes `lucid.sh zavirani` — rušení vlastních čekajících vstupů
   z flat je výslovně zapnuté (aby po pádu nezůstal čekat vstup bez dohledu), přikoupení zrušená (:640).
8. **Ovládání:** místní unix socket 0600 (ne mobilní port ani Tailscale) pro lištu a `lucid.sh`. Odvolání jde vždy
   i bez lišty: `grantLiveTrading.ts --revoke` / smazání souhlasu. Lišta bez odpovědi služby = „stav neznámý“.
9. **Stahování historie (orderflow-sync):** jen když služba běží **ve čtení**, v denní přestávce CME počítané
   z America/Chicago (16:00–17:00 CT) nebo o víkendu; tvrdý konec pauzy 16:55 CT (resp. neděle 16:55 CT), pak
   čtení vždy zpět. V obchodě/zavírání nikdy.
10. **`lucid.sh` dál funguje:** požádá službu ve čtení o uvolnění (socket), po skončení se čtení vrátí; při obchodě
    přes lištu `lucid.sh` jen ohlásí, že služba běží.

## Pořadí

| Fáze | Obsah | Hotovo, když |
|---|---|---|
| 1 | Čtení jako launchd job z připnutého vydání; trvalý záznam běhu a incidentů; rozpočet čtení; socket + `lucid.sh`; pauza pro sync z CT | po přihlášení běží čtení; `lucid.sh obchod` projde; sync stáhne jen v přestávce; testy rozpočtu a okna |
| 2a | Podpis ze Secure Enclave, požadavek s nonce, ověření ve službě (start + každých 10 s) | testy: nepodepsaný, starý, znovu použitý, změněný souhlas obchod nezapne |
| 2b | Předání obchod/zavírání → čtení uvnitř služby; start podle záznamu běhu (pád → zavírání → čtení) | testy: přepnutí během příkazu, pád v obchodě, `mode` při startu |
| 2c | Lišta (Swift) | přepnutí na Rithmic Test / DEMO; na Lucidu jen Filip |

Každá fáze: testy, critic na diff, Codex u fází 2a–2b (jádro služby).

## Fáze 1 — jak je postavená (28. 11.)

Zjednodušení proti v2 podle 2. kola oponentury: bez supervizoru, bez připnutého vydání (stejná složka `results` jako
lucid.sh), bez pauzy uvnitř procesu — uvolnění = odpojení launchd úlohy (KeepAlive ji pak nespouští).
- `install-rithmic-read.sh`: launchd `com.alphatrade.rithmic-read` (RunAtLoad, KeepAlive, ThrottleInterval 30) spouští
  `node --import tsx/loader devTradeServer.ts … --read-only --order-flow` přímo (žádný npx potomek). Odmítne instalaci,
  když běží jiná služba nebo checkout nezná rezervu rozpočtu.
- Služba ve čtení: limity účtu nečte vůbec; týdenní strop dotazů 300 ze 400, přihlášení 12 z 20 za hodinu
  (`RMS_READ_ONLY_*`); zbytek zůstává obchodu a zavírání (INV-TRAD-09).
- `lucid.sh`: před startem zapíše značku se svým PID a úlohu čtení odpojí; po skončení (i Ctrl+C) ji vrátí jen když
  značka pořád patří jemu. `exec` odstraněn, aby trap doběhl.
- orderflow-sync: pozastaví (bootout) jen úlohu čtení, jejíž PID drží zámek služby, jen v přestávce CME podle
  America/Chicago (`services/rithmic/cmeBreak.ts`, rezerva 10 min před otevřením), stahovač má tvrdý `--until`
  (−2 min), čtení vrací ve `finally`; jinak úlohu čtení obnoví jen když neběží nic jiného a neplatí značka lucid.sh.
