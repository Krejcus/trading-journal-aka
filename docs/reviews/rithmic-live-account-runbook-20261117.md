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
8. (Volitelně, strop 2 ks v souhlasu) Market + přikoupení → „Zavřít 1 ks" → zbylá část má své SL/TP.

Po měření: Ctrl+C, `--revoke`, pustit zase `--read-only`.

Neověřeno před měřením na skutečném účtu: chování při částečném plnění (proto 1 ks), obnova po uspání Macu
uprostřed pozice, souběh s R Traderem, týden rollu.
