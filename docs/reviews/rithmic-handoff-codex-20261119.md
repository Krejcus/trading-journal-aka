# Rithmic — předání pro Codex (19. 11. 2026)

Stav práce na obchodování přes Rithmic (náhrada zmrazeného obchodování z appky přes Tradovate). Psal Claude.

## Co je hotové

Místní služba na Macu (`scripts/rithmic/devTradeServer.ts`) drží jedno přihlášení k Rithmicu a obsluhuje appku na PC
(ws 127.0.0.1:3311 + token) i telefon (ws 127.0.0.1:3313, ven jen přes Tailscale Serve, párování klíčem zařízení).
Jádro příkazů je `services/rithmic/localExec.ts`, adaptér brokera `services/rithmic/rithmicBroker.ts`.

- **Lucid je stálá služba.** Skutečný účet LucidTrading `LFE025-7UG73SJ2-TEST001` běží na 3311 / 3313. Spouští ho
  JEN Filip v terminálu: `cd ~/alphatrade-worktrees/rithmic && scripts/rithmic/lucid.sh` (opíše větu dvakrát).
  Režimy `lucid.sh cteni` (jen čtení), `lucid.sh zavirani` (jen zavírání). `KS=` strop kusů (výchozí 3),
  `SL=povinny` vrátí povinný SL. Údaje účtu v `scripts/rithmic/results/lucid.env` (mimo git).
- **Rithmic Test** běží vedle na 3321 / 3323 jen na zkoušky. Pomocné skripty v `scripts/rithmic/results/` a
  `scripts/rithmic/nightSuite.ts` míří výchozí na 3321 a odmítnou cokoli, co není Rithmic Test.
- **Všechny funkce jsou na Lucidu zapnuté** v obchodním režimu (rozhodnutí Filipa 19. 11.): opakované přikoupení
  (až 20 částí), přikoupení Limitem (`pendingAdd`), „Zavřít 1 ks" (`entrySplit`), výměna SL/TP za pár
  (`multiPairSwap`), přikoupení i vstup bez SL/TP (jen se souhlasem `--allow-no-stop`, který `lucid.sh` dává výchozí).
- **Telefon** (Capacitor iOS): graf s Rithmicem, párování s Macem, obchodování. Build z této větve je v iPhonu.
- **Historie svíček**: LucidTrading pošle data, ale NEPOŠLE závěrečnou odpověď na šablonu 202 → čtení končí po 1,5 s
  ticha (`settleQuietMs`, jen pro zobrazení). Čte se po dnech. Ověřeno: 4 696–6 901 svíček od nedělního otevření.
- **Rozpočet dotazů**: Rithmic má tvrdý limit 2 000 dotazů „Get Accounts" na uživatele (18. 11. nás vypnul).
  `services/rithmic/rmsQueryBudget.ts`: vlastní strop 400/týden, 20 přihlášení/h, limity účtu se čtou po 6 h nebo
  na oznámení změny účtu (šablona 358). Žádné čtení ve smyčce.
- **Měření**: služba vypisuje zpoždění ceny burza → Mac (Lucid p50 30–44 ms), odezvu telefonu (Wi‑Fi p50 ~10–19 ms)
  a nově kroky otevření appky (`[měření] otevření iPhone: …`).

## Co je ověřené a co ne

- Proti brokerovi ověřený jen ZÁKLAD (na Rithmic Test 17. 11.): vstup se SL/TP, posun SL/TP, zavření.
- NEOVĚŘENO proti brokerovi: opakované přikoupení, bare add, rychlá řada kliků, přikoupení Limitem, „Zavřít 1 ks",
  výměna za pár, obchod z telefonu. Na Lucidu se zkouší poprvé naostro.
- Rithmic Test od středy 18. 11. 11:13 neposílá cenu a odmítá příkazy („odmítnuto (RMS)"), i mimo údržbu. Visí tam
  long 1 MNQZ6. Filip má poslat e‑mail podpoře Rithmicu (text připravil Claude). Sada `nightSuite.ts` S1–S16 nad
  novým kódem NEPROBĚHLA.

## Známé slabiny (z oponentury, platí i na Lucidu)

Podrobně v `docs/reviews/rithmic-live-account-runbook-20261117.md`:
- čekající přikoupení u brokera přežije uspaný Mac / spadlou službu → může otevřít nový obchod;
- výměna SL za pár: ~400 ms bez té nohy; neodeslaný pár = pozice bez ochrany (incident, nic se neopakuje);
- „Zavřít 1 ks": výpadek mezi zmenšením ochrany a Marketem nechá 1 ks bez ochrany; A1 — po 12 s neznámého výstupu
  brzda projde, pozdní plnění může pozici obrátit o 1 ks;
- telefonní UX, rychlá řada a lišta bez SL/TP (večer 18. 11.) oponenturou neprošly.

## Jak pokračovat

1. **Měření otevření appky** — studený start: ~1,5 s trvá start appky/stránky, než se začne připojovat; samotné
   spojení až po první cenu jen 282 ms (Tailscale 104 ms, Klíčenka 7 ms, ověření 9 ms). Historie přijde o ~1,8 s
   později (čte se z Rithmicu při připojení). NEZMĚŘENÝ je návrat z pozadí — Filip má zopakovat 3× plocha a zpět,
   2× zamknutí ≥ 1 min; výsledky jsou v terminálu se službou (`[měření] otevření iPhone`). Pak opravit největší
   kus: připojovat se už při startu appky (ne až v grafu), historii držet ve službě předem načtenou, při návratu
   ukázat poslední známou cenu označenou jako starou (jen zobrazení).
2. **Rithmic Test**: až znovu poteče cena, zavřít long 1 MNQZ6 (`scripts/rithmic/results/step.ts flatten`
   s `RITHMIC_PORT=3321`), pustit `npx tsx scripts/rithmic/nightSuite.ts` a vyzkoušet novinky.
3. **Odložené**: přikoupení se samostatným párem SL+TP (chce měření u brokera), společná kniha operací PC + telefon,
   nezávislá brzda, deník z Rithmicu, kopírka přes Rithmic, druhé kolo oponentury nad večerními změnami.

## Pravidla (neměnit bez Filipa)

- Na skutečném účtu (Lucid) agent SÁM žádné příkazy neposílá — jen čte. `--live-trading`, `--close-only`,
  `grantLiveTrading.ts` a `lucid.sh` spouští jen Filip v terminálu.
- Hesla jen z macOS Klíčenky (`alphatrade-rithmic-prop`, `alphatrade-rithmic-test`), nikdy z chatu.
- Nespouštět druhé přihlášení stejným uživatelem Rithmicu vedle běžící služby (vynucené odhlášení).
- Přihlášení a dotazy na Rithmic držet na minimu (tvrdý limit 2 000).
- Údržba Rithmic Test: středa 12:00–19:00 SEČ a denně 23:15–24:00 — tehdy nic neměřit.
- Tradovate worker a jádro kopírky se touto prací nemění; kopírka Tradovate zůstává, živé obchodování přes
  Tradovate z appky už nebude.
- iPhone build: `npm run ios:sync` + `xcodebuild … -derivedDataPath ~/alphatrade-build/ios-dd` +
  `xcrun devicectl device install app --device 00008160-000A7C613E900036 …/App.app` (jen s `.env.local`).
  Vercel deploy telefon NEaktualizuje — appka je bundlovaná.

## Doplnění 19. 11. — obnova s platným souhlasem

Na Macu lze po aktualizaci spustit `scripts/rithmic/lucid.sh obnovit` a potvrdit Touch ID. Při prvním přechodu ukonči původní verzi na výzvu pomocí Ctrl+C, až bude účet bez pozice a příkazů. Další předání mezi podporovanými verzemi provede služba sama po kontrole účtu. Vydání nového souhlasu po expiraci vyžaduje původní ruční postup.
