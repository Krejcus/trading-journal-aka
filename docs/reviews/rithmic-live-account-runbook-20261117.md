# Rithmic — obchodování na skutečném účtu: jak se zapíná a první měření (17. 11. 2026)

Stav: přepínač je POSTAVENÝ a VYPNUTÝ. Zapnout ho umí jen člověk u terminálu. Claude ho nespouští a na skutečném
účtu neposílá žádné příkazy.

## Tři režimy služby na skutečném systému

| Režim | Spuštění | Co jde |
|---|---|---|
| jen čtení (dnes) | `--read-only` | graf, stav účtu; žádný příkaz neodejde (pojistka i na drátě) |
| jen zavírání | `--close-only` | zavřít pozici, zavřít část, zrušit vlastní příkaz, posun SL/TP; žádný vstup |
| obchodování | `--live-trading` + souhlas | vše, co na Rithmic Test, se stropem a povinným SL ze souhlasu |

`--close-only` a `--live-trading` chtějí interaktivní terminál a po přihlášení opsání věty s číslem účtu.

## Zapnutí obchodování (dělá Filip)

1. Souhlas (platí nejvýš 24 h, výchozí 12 h, strop 1 ks, SL povinný):
   ```bash
   cd ~/alphatrade-worktrees/rithmic && npx tsx scripts/rithmic/grantLiveTrading.ts --system "LucidTrading" --user "LT-8LMN4X45" --account "LFE025-7UG73SJ2-TEST001" --hours 4 --max-quantity 1
   ```
   Skript chce opsat větu `OBCHODOVAT <účet>`.
2. Zastavit službu běžící jen pro čtení (jedno přihlášení na uživatele) a spustit v TERMINÁLU:
   ```bash
   cd ~/alphatrade-worktrees/rithmic && RITHMIC_DEV_ORIGINS="http://localhost:5273" npx tsx scripts/rithmic/devTradeServer.ts --system "LucidTrading" --user "LT-8LMN4X45" --live-trading --contract MNQZ6
   ```
   Po přihlášení větu opsat ještě jednou. V appce je u názvu účtu „SKUTEČNÝ ÚČET".
3. Vypnutí: Ctrl+C ve službě. Okamžité zastavení nových vstupů bez vypnutí:
   ```bash
   cd ~/alphatrade-worktrees/rithmic && npx tsx scripts/rithmic/grantLiveTrading.ts --revoke
   ```

## Co služba na skutečném účtu hlídá navíc

- Bez platného souhlasu (chybí, vypršel, jiný systém/uživatel/účet, víc účtů, změněný od startu): žádný vstup,
  žádné přikoupení, žádný posun čekajícího vstupu. Souhlas se čte znovu těsně před zápisem.
- Zavření, částečné zavření, zrušení vlastního příkazu a správa SL/TP jdou vždy.
- Čekající vstupy po skončení souhlasu: incident „zruš je" (nic se neruší samo).
- Kontroly strany trhu berou cenu nejvýš 30 s starou ze živého spojení; bez ní se neodešle nic kromě zavření.
- Cizí příkazy (zadané jinde) služba neposouvá ani neruší; brzda „Zavřít pozici" ruší na kontraktu vše.
- Ochranu zadanou z appky ruš v appce; když pozici zavřeš jinde, zruš i její ochranu (jinak osiřelý SL — appka
  ho ohlásí incidentem, ale nezruší).

## První měření na účtu Lucidu (kliká Filip, 1 kontrakt, klidný trh)

Každý krok: počkat na čáru v grafu, opsat čas z měřicího štítku (klik → čára).

1. Limit daleko od trhu se SL/TP → čára vstupu + plánované SL/TP.
2. Posun Limitu tažením → nová cena, SL/TP se posunou s ním.
3. Zrušení × → čáry pryč.
4. Market se SL/TP → pozice + dvě nohy. Zkontrolovat v R Traderu: pozice, dva příkazy, správné ceny.
5. Posun SL tažením; BE.
6. Zavřít pozici brzdou → karta s výsledkem a důvodem „ručně"; v R Traderu nic nezbylo.
7. Stop vstup se SL/TP nad trhem → posun spouště → zrušení.
8. (Souhlas s `--allow-no-stop`) Market BEZ ochrany → čipem „+ SL" natáhnout SL → čipem „+ TP" natáhnout TP.
   Appka přitom SL na okamžik zruší a zadá SL+TP jako svázaný pár (na testu ~0,3 s, z toho ~0,1 s bez ochrany).
   V R Traderu mají být dva svázané příkazy (OCO). Posunout oba, pak zavřít brzdou.
9. (Volitelně, strop 2 ks v souhlasu) Market + přikoupení → „Zavřít 1 ks" → zbylá část má své SL/TP.

Po měření: Ctrl+C, `--revoke`, pustit zase `--read-only`.

Neověřeno před měřením na skutečném účtu: chování při částečném plnění (proto 1 ks), obnova po uspání Macu
uprostřed pozice, souběh s R Traderem, týden rollu.

## Doplněk 18. 11. — co se od prvního testu změnilo

- Strop kusů: souhlas bez `--max-quantity` = limit propky (RMS); `--max-quantity N` ho jen zmenší.
- Příkazy jsou DENNÍ. Na konci seance (23:00 SEČ, 22:00 v létě podle USA) burza zruší čekající vstupy i SL/TP a pozice
  zůstane bez ochrany — appka na to 15 minut předem upozorní a potom ohlásí incident. Po otevření trhu ochranu zadej znovu.
- Čekající přikoupení Limitem je zatím jen na Rithmic Test; na skutečném účtu služba přikoupí jen Marketem.
- Nové k vyzkoušení: šipky vstupu a výstupu v grafu, tažení čekajícího vstupu s víc kontrakty.
- VYPNUTO na skutečném účtu (zapíná jen spouštěč, zatím pouze Rithmic Test; rozhodne Filip po oponentuře):
  - „Zavřít 1 ks" z pozice otevřené JEDNÍM příkazem s víc kusy (`entrySplit`) — služba odmítne s vysvětlením,
    tlačítko se v grafu přesto ukáže. Zavření celé pozice a zavření kusu u pozice složené z víc vstupů funguje.
  - výměna samotného SL nebo TP za svázaný pár u víc kusů (`multiPairSwap`). U 1 ks a při zadání SL i TP najednou funguje.
- Otevřené nálezy oponentury (Codex, 4 kola; stav po `a11b0fba`), proč jsou ty dvě věci vypnuté:
  - A1: když výsledek výstupního Marketu 1 ks zůstane neznámý déle než 12 s, brzda „Zavřít" už projde — pozdě
    doručené plnění by pak mohlo pozici obrátit o 1 ks. Do 12 s brzda odmítá („zkus to za pár sekund").
  - A3: dělení se odmítá při blokaci a po zápisu SL/TP s neznámým výsledkem — opraveno, páté kolo oponentury neproběhlo.
  - B2: při výměně nohy za pár nejde z dat Rithmicu vyloučit pozdní dílčí plnění rušené nohy; výměna navíc nechá
    pozici ~400 ms bez té nohy.
  - Kompromis: během dělení je brzda až 2,5 s (čekání) + až 12 s (neznámý výstup) nedostupná.
- Sada `scripts/rithmic/nightSuite.ts` je JEN pro Rithmic Test (proti jinému systému se nespustí).
