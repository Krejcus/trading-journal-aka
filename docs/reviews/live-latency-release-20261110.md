# Nasazení vlny latence — postup (připraveno 10. 11. 2026, čeká na „nasaď“)

Větev `claude/live-latency-20261109`, worktree `~/alphatrade-worktrees/live-latency-20261109`.
Sedí přímo na `origin/main` (`cabb6b5a`), nasazení je fast-forward bez slučování.
Kód k nasazení: **poslední commit větve** (`git -C ~/alphatrade-worktrees/live-latency-20261109 log --oneline -1`).
Návrh, měření a výhrady: `docs/reviews/live-latency-20261109.md`.

## Co se nasazuje

- **Worker (Mac):** rychlejší fill a zavření, čtení pro přijatou expozici mimo zobrazovací rozpočet, brána
  nového rizika bez nasyceného zobrazovacího pruhu, cache klíče z Keychainu, obnova dokladu pokrytí streamem,
  předčtení verze příkazu při potvrzení zápisu.
- **Web (Vercel):** jen serverová část — odpověď 401 zahodí klíč v paměti workeru (bez účinku na klienta)
  a volitelné zpomalení minutové úlohy (výchozí vypnuto). **Žádná změna klienta → iPhone se nepřestavuje.**
- **Databáze, Edge Functions, proměnné prostředí:** beze změny.

Web a worker jsou na sobě nezávislé: nový worker funguje se starým webem i naopak.

## Dvě volby před nasazením

| Volba | Výchozí | Co přinese | Cena |
|---|---|---|---|
| Držené spojení k Tradovate (`--tradovate-keepalive on`) | vypnuto | ~80 ms na každý příkaz (měřeno na DEMO: vstup 334 → 248 ms) | Zápis na spojení, které broker mezitím zavřel, skončí jako nejistý výsledek; okno je 45 s místo dnešních ~4 s. Na DEMO v 15 vstupech nenastalo. Oba oponenti doporučují pro první ostrou session nechat vypnuté. |
| Zpomalení minutové úlohy v klidu (`ALPHATRADE_IDLE_BROKER_SNAPSHOT=on` ve Vercelu) | vypnuto | méně dotazů na brokera, když se nic neděje | Zámek účtu, který vznikne i zmizí do pěti minut v klidu, se neoznámí; změna na widgetu může přijít o čtyři minuty později. |

Doporučení: první ostrou session obojí vypnuté; držené spojení zapnout po jedné čisté session.

## Postup

Předpoklad: kopírka vypnutá, žádná pozice ani pracující příkaz, IB Gateway přihlášený.

1. **Web** — z worktree, až po zelených kontrolách (řetězit přes `&&`):

```bash
cd ~/alphatrade-worktrees/live-latency-20261109 && git status --short | wc -l && git push origin claude/live-latency-20261109:main
```

   Vercel nasadí sám; ověřit stav READY nasazení a že `https://alphatrade-mentor-15.vercel.app` vrací 200.

2. **Worker pro skupinu Ahojda** (leader 70771429, followeři 70423188, 70423265, 70423233; durable slot skupiny
   je zachovaný). Nejdřív brána: vypnuto, připojeno, zkontrolováno, flat, bez divergence, pracujících příkazů
   a visících operací. Potom z čistého worktree:

```bash
cd ~/alphatrade-worktrees/live-latency-20261109 && npm run copier:mac -- install --connections-manifest "$HOME/Library/Application Support/AlphaTrade/copier/connections.json" --leader 70771429 --follower 70423188 --followers 70423188@1,70423265@1,70423233@1 --port 3211 --adopt-durable-group --tv off --tv-stream on --price-source ibkr --price-alerts on --group-limits on --allow-full-dev-origins true
```

   (Parametry odpovídají poslední instalaci Ahojdy ze zálohy `20261109-live-speed-history-201417`.
   Pro držené spojení přidat `--tradovate-keepalive on`.)

3. **Po startu:** read-only kontrola pozic, potom ověřit ve stavu workeru `installation.gitSha` = commit větve,
   `armed=false`, `connected=true`, `groupFlat=true`, `reconciliationRequired=false`, `lastError=null`,
   správného leadera a tři followery.

```bash
cd ~/alphatrade-worktrees/live-latency-20261109 && npm run copier:mac -- reconcile
```

4. **První obchod:** jeden kontrakt, po něm „Zkontrolovat“.

## Co sledovat při první ostré session

- Log workeru (`~/Library/Application Support/AlphaTrade/copier/mac-agent.stderr.log`): `Priority read budget
  exhausted`, `socket-message-error`, `FAIL-CLOSED`, `tradovate-request-budget`, jakékoli 429.
- Stav: `controller.lastError`, `reconciliationRequired`, `lastDisarm`.
- Po vstupu leadera: pozice na všech třech followerech a SL i TP na každém účtu (12 příkazů OSO celkem).
- `BROKER SEMANTIC SLOW … handler=` v logu má být do ~300 ms (před opravou 700–1600 ms).
- Po zavření: všechny účty flat, žádný pracující příkaz, kontrola pozic čistá.

## Návrat zpět

- **Worker:** záloha instalace před touto prací není (běžel DEMO tvar); poslední ověřená ostrá instalace je
  `cd530285` — reinstall z `~/alphatrade-worktrees/live-reliability-20261109` stejným příkazem jako výše
  s `--allow-downgrade`. Záloha současného stavu (DEMO tvar, `125d40c4`):
  `~/AlphaTrade-backups/releases/20261110-live-latency-050509`.
- **Web:** ve Vercelu vrátit předchozí nasazení (`cabb6b5a`), nebo `git revert` rozsahu a push.

## Co nasazením nevyřeší

- Odmítnutí dotažení verze rozpočtem shodí WebSocket až po 2,5 s marného opakování (a práh je vyšší: 90/min místo 24/min).
- Skupina s followery nebyla s touto větví odzkoušená naživo (na DEMO je jeden účet) — jen testy.
- Denní strop se nasazením webu mění ze 100/100 na pojistku 500 vstupů a 2 000 příkazů správy za 24 hodin.
  Do nasazení webu platí starý strop; noční měření z něj 10. 11. ubralo 55 příkazů správy a ~36 vstupů.
- Volné místo na disku je ~8 GB (pod hranicí 11 GB, při které noční záloha Supabase odmítne běžet).
