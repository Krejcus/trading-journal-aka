# Ultra review kopírky — 28. 9. 2026

Rozsah: 3 vlny, 18 reviewerů + adversariální ověření, nezávislá review Codex, živé testy v UI; jádro odpovídá produkci origin/main k 28. 9. odpoledne.

> **Doplněk z večera 28. 9. (oddíl 9):**
> - V 16:35 byli čtyři FundedNext followeři vyřazeni na drawdown flooru. Všech pět FN účtů je po breachi, stav leadera máme od Filipa.
> - V 16:36 se kopírka potřetí vypnula.
> - V 18:59 bylo FN připojení odpojeno. Codex skupinu „odpolko“ auditovaně vyřadil a reinstaloval worker z **necommitnutého** lokálního kódu.
> - Běží skupina „Hlavní“.
> - V12 (nezkopírovaný SL) a V13 (limit 1,5 s) jsou **stále otevřené**.

Časy jsou v pražském čase (SELČ, UTC+2), pokud není uvedeno UTC.

**Kdy se měřilo:**
- 1. a 2. vlna: dopoledne, zhruba do 11:30.
- 3. vlna: odpoledne do ~16:40. Worker byl tehdy ARMED nad skupinou „odpolko“ s účty FundedNext.

Po dopoledních živých testech (9:39–9:46) se na worker ani na brokera nesahalo. Neběžely žádné testy proti workeru, neposílaly se příkazy a nečetly se velké logy. Odborné pojmy vysvětluje slovníček na konci.

**Podklady:**
- 18 dílčích review ve třech vlnách:
  - **1.–2. vlna (12 review):** forenzní rozbor S1, S2, S3 a S5, latence kopírování, red team „ztráta peněz“, API controlleru, broker a OAuth, relay a lokální agent, UI LIVE, porovnání nasazení s repem, souběhy.
  - **3. vlna (6 review):** controller 4900–6200, 6200–7500 a 7500–8600, `copierRunner`, engine s outboxy a korelátory, bezpečnost relay a párování. Přinesla 44 nálezů: 19 potvrzeno adversariálně, 2 vyvráceny, 23 neověřeno.
- 3. vlna běžela v šetrném režimu, protože worker byl ARMED. Stav přečetla jedním dotazem na `/v1/status` a přes grep/tail logů.
- Nezávislá review od Codexe (dopoledne).
- Živé testy v UI (localhost:3000, 9:39–9:46, starší verze UI z Documents). Nebyly čistě pasivní:
  - ARM a DISARM ostrého workeru,
  - Flatten flat účtu 64503883,
  - přepnutí followera 64503883,
  - dočasná změna leadera na 65333277 a návrat. Po návratu se změnilo pořadí followerů ve skupině.
- Rešerše konkurence, pravidel prop firem a spolehlivosti copierů na Tradovate API.

**Verze kódu:** Jádro kopírky (controller, runner, broker, router, agent, relay) je v Documents shodné s origin/main. Liší se jen `components/LiveCopyTradeOverview.tsx`, který je na main novější. Řádky u tohoto souboru jsou podle origin/main.

**Stav ověření u nálezů:**
- **ověřeno adversariálně**: druhé, nezávislé ověření, často s reprodukcí ve scratchpadu, logu nebo DB. Ověřovatel mohl závažnost snížit, u nálezu je to pak uvedené.
- **neověřeno**: jen první review.
- **Codex**: ověřeno jen Codexem.

---

## 1. Shrnutí

- **Dnes odpoledne se kopírka při živém obchodování třikrát sama vypnula** (skupina „odpolko“, účty FundedNext). Pokaždé jsi ji znovu zapnul ručně.
  - **16:04:58 (14:04:58 UTC):**
    - Po výstupu worker kontroloval, že staré ochranné příkazy followerů už nepracují.
    - Jedno čtení u Tradovate trvalo ~4,8 s, pevný limit je 1,5 s.
    - Všichni už byli flat a nic se nezavíralo. Kopírka byla ~45 s vypnutá (V13).
  - **16:13:59 (14:13:59 UTC): tvůj SL se followerům nezkopíroval.**
    - U followerů ležela zkopírovaná čekající limitka (Sell Limit 8 @30618). Do pozice jsi vstoupil Marketem.
    - Worker čekající kopii limitky započítal jako rozpracovanou pozici. Proto falešně nahlásil „nevysvětlenou divergenci“ a kopírku vypnul.
    - 4 followeři × 8 MNQ byli **~34 s bez SL**.
    - Zavřel je až dozor po tvém výstupu (leader-flat guard), o 6,5 bodu hůř než tebe. To je ≈ 104 USD na účet a ≈ 416 USD celkem (V12).
  - **16:36:42 (14:36:42 UTC):** stejná hláška. Dozor za 2,3 s potvrdil, že jsou všichni flat. Příčina zatím nerozebraná.
  - U druhého a třetího vypnutí UI ukazuje „neznámý technický důvod“, i když je příčina známá (ST30).
- **Celkově:** Podle dostupných dat kopírka neposlala obchod špatným směrem ani dvakrát. Review ale našla místa, kde se při souhře okolností tiše vypne pojistka a follower zůstane bez SL nebo bez dozoru:
  - čekající kopie limitního příkazu (V12),
  - dozor po zavření obchodu leadera (V4),
  - SL followera po vypnutí kopírky (V5),
  - obměna spojení s Tradovate zhruba každých 50 minut (V6),
  - posun SL, který se při zahlcené frontě zahodí (V8),
  - follower zlikvidovaný propkou nebo zamčený denním limitem (V16),
  - vyřazení followera, které v dalším obchodu selže (V17, V18).

  **V12 se stal dnes naživo a stál peníze.** V8 se projevil 22. 9.: SL followerů byl 55–90 s pozadu a účet 66142377 se zavřel na starém SL. Ostatní body jsou potvrzené v kódu a reprodukcí, škodu v provozu zatím nezpůsobily.
- **Auto-close zavírá celé účty followerů.** Zavře pozice ve všech symbolech a zruší i pracovní příkazy. Týká se i ručně vypnutých followerů a ručních obchodů. V reprodukci se to stalo i při vypnuté kopírce (V9).
- **S1 (kopírka se sama vypne):**
  - Z 161 zapnutí přes relay (1. 9. až 28. 9. dopoledne) skončilo:
    - 44 % tvým vypnutím,
    - 20 % bezpečnostním zastavením,
    - 15 % výpadkem spojení,
    - 7 % úpravou skupiny.
  - Výpadek spojení je téměř vždy usnulý Mac (zavřené víko nebo vybitá baterie). Od 21. 9., kdy máme data o spánku Macu, to platí pro 262 z 264 incidentů.
  - Dnes v 8:50 kopírku vypnula neúspěšná úprava skupiny a zapsala to jako „vypnuto ručně“. Proto jsi neviděl důvod.
  - Odpoledne přibyla tři automatická zastavení popsaná výše.
- **S2 (změna nejde potvrdit):**
  - Dopoledne nebyly účty FundedNext v Mac workeru a hláška radila špatný krok. Odpoledne už FN ve workeru je.
  - Obecná příčina: kontrola „stav se změnil“ reaguje i na udržovací signál spojení. Kvůli tomu padá zhruba každá čtvrtá až třetí změna účtů (od 15. 9. 13 ze 46) a 22 % přepnutí followera.
- **S3 („Neověřeno“, chybí DLL):**
  - Telefon při jediném nepovedeném čtení zahodí celý stav kopírky.
  - Hotová komponenta, která drží poslední potvrzený stav, není zapojená.
  - DLL po chybě zůstane na „Načítám“ a samo se znovu nenačte.
  - Na produkčním webu už kompaktní řádek DLL ukazuje. Nativní iOS appka může mít starší web.
- **S4 (probliknutí):**
  - Každý návrat do okna na chvíli ukáže „Neověřeno“ (viděno živě).
  - Starší stav ze serveru může přepsat čerstvé potvrzení (ST13, jen podle kódu, neověřeno).
- **S5 (rychlost):**
  - Vypnutí přes relay trvá ~1,4 s (měřeno v databázi), na telefonu odhadem ~2 s. Mac z toho pracuje 12 ms.
  - Zbytek zabere cesta přes server v USA a databázi ve Švédsku.
  - Kopie vstupu doběhne v mediánu za 0,8 s, samostatný SL za 2,2–3,4 s.
- **Hned, bez kódu** (podrobně v oddílu 6):
  - Za zapnuté kopírky neobchoduj ručně na followerech, ani na vypnutých. Ruční obchody dělej jen na účtu mimo skupinu kopírky.
  - Po každém vypnutí kopírky uprostřed obchodu hned zkontroluj v Tradovate SL u followerů.
  - Dokud nebude opraven V12: čekající limitní příkaz zadaný z flat (třeba TP zadané dopředu) zruš dřív, než vstoupíš jiným příkazem nebo zadáš SL.
  - ARM vyprší nejpozději 8 h od posledního zapnutí. Ranní zapnutí vyprší uprostřed NY seance.
  - Mac nech na nabíječce a s otevřeným víkem.
  - Za zapnuté kopírky neupravuj skupinu, násobek ani pravidla.
  - Používej jen celé násobky a zatím nenastavuj denní cut followerů.
- **Plán:**
  1. Příprava nasazení (balíček 3).
  2. Oprava dnešních incidentů V12 a V13 a správný důvod vypnutí v UI (balíček 0).
  3. Follower nesmí zůstat bez SL (4A).
  4. Auto-close jen na vlastní kopie (4B).
  5. Odstranit falešná bezpečnostní zastavení (5B).

  UI balíčky dělá Claude souběžně. Reinstall workeru jen z čistého vypnutého stavu a mimo obchodování.

---

## 2. Tvoje symptomy S1–S5

### S1 — Kopírka se občas sama vypne

**Odpověď:** Vypnutí má tyto hlavní příčiny:
- úprava skupiny za běhu: worker kopírku vypne ještě před kontrolou a zapíše to jako ruční vypnutí (V1),
- usínající Mac (ST7),
- bezpečnostní zastavení, která zbytečně vypnou celou skupinu. Dnes odpoledne byla tři (V12, V13).

**Rozbor 161 zapnutí přes relay (1. 9. až 28. 9. dopoledne).** Worker přechody ARM→DISARM neloguje. Proto jsou rekonstruované z relay tabulky, časovaných řádků FAIL-CLOSED a auditu.

| Čím zapnutí skončilo | Počet | Podíl | Poslední výskyt |
|---|---|---|---|
| Tvoje ruční vypnutí přes relay | 71 | 44 % | 26. 9. 19:04 |
| Bezpečnostní zastavení (fail-closed) | 32 | 20 % | 25. 9. 16:01 |
| Výpadek spojení | 24 | 15 % | 21. 9. 17:50, 39 s po zavření víka |
| Změna konfigurace, i odmítnutá | 11 | 7 % | 28. 9. 8:50 (dnešní ranní incident) |
| Flatten All | 8 | 5 % | 25. 9. 12:39 |
| Ruční zámek dne | 2 | 1 % | 16. 9. |
| Restart workeru | 1 | < 1 % | – |
| Nezjištěno (vypnutí z desktopu se neloguje) | 12 | 7 % | 20. 9. |

Tabulka končí dopolednem 28. 9. Odpoledne proběhly přes relay tři ARMy (15:32, 16:05 a 16:15). Všechny tři skončily bezpečnostním zastavením (viz tabulka níže).

**Bezpečnostní zastavení (32) podle důvodu:**
- modify skončil jako filled: 6× (naposledy 24. 9. 15:53),
- nesoulad pozice followera: 4×,
- osamělá OSO noha: 3×, všechny 25. 9. během 2 minut,
- „cancel bezpředmětný“ a „OSO pending“: 4×, opraveno v 38365e3 a nasazeno 26. 9.,
- flat sweep: 2×,
- leader flat, nesoulad nebo guard: 4×,
- nezpůsobilý účet: 2×,
- ostatní: 7×.

V auditu je 929 událostí leadera, které se nezkopírovaly, protože byla kopírka vypnutá (17. 8.–25. 9., 74 shluků). Jde o příkazy a jejich změny, ne o obchody.

**Dnešní ranní incident** (ověřeno adversariálně, V1 a V2):
- 8:43:49 jsi znovu připojil FundedNext (OAuth 7cce8c5b). Přibylo pět účtů 67409592–67409626.
- 8:47:33 jsi zapnul kopírku přes relay.
- 8:50:03 jsi uložil skupinu s FN účty. Worker v 8:50:04 **nejdřív vypnul** kopírku. Pak zjistil, že účet 67409592 nevidí, změnu odmítl a zapsal „Uživatel vypnul kopírku ručně“. UI tento důvod záměrně nezobrazuje.
- Další 4 pokusy do 8:50:21 a 2 pokusy v 10:41 skončily stejně.
- V 11:07 byl ARM odmítnut. Followeři 65333277 a 65333343 měli −4 MNQZ6 a pracovní příkazy z tvého ručního obchodu v 10:47.
- Leader 66142378 v tom okně neobchodoval, zmeškaná kopie tedy nevznikla.

**Od nasazení 26. 9.:** Do dopoledne 28. 9. měla `disarmHistory` 9 záznamů, všechny „manual“. Z toho:
- 8:50:04 je ve skutečnosti odmítnutá úprava,
- 9:40 a 9:42 jsou testy Claude.

Odpoledne byl worker restartován a přibylo třetí připojení (FN). `disarmHistory` proto teď začíná v 16:04:58.

**Odpoledne 28. 9. přibyla tři automatická bezpečnostní zastavení za ARM:**

| Čas Praha (UTC) | Důvod | Co se stalo | Nález |
|---|---|---|---|
| 16:04:58 (14:04:58) | flat-sweep-deadline | Po výstupu všech se kontrolovalo, že staré ochranné nohy už nepracují. Čtení `/command/list` trvalo ~4,8 s, limit je 1,5 s. Všichni byli flat. Znovu jsi zapnul v 16:05:43. | V13 |
| 16:13:59 (14:13:59) | „nevysvětlená divergence“ 67409626, 67409612, 67409592, 67409600 | SL leadera se nezkopíroval nikomu. Followeři byli ~34 s bez SL a zavřeli se o 6,5 bodu hůř. Znovu jsi zapnul v 16:15:06. | V12 |
| 16:36:42 (14:36:42) | stejná hláška | Guard za 2,3 s potvrdil, že jsou všichni flat. Příčina nerozebraná, doporučen forenzní rozbor. | – |

UI u druhého a třetího zastavení ukazuje „neznámý technický důvod / výsledek kopií nepotvrzen“ (ST30). Záznam „auto-closed“ u prvního je zavádějící, nic se nezavíralo.

**Další ověřené spouštěče vypnutí:**
- **V3:** každé odmítnutí „stav se změnil“ na zapnuté skupině ji vypne (24. 9. 17:10–17:15).
- **V8:** 16. 9. 20:51:55 fail-closed „stale-heartbeat“ bez výpadku WS.
- **V12:** čekající zkopírovaný limitní příkaz spolu se synchronní pozicí vypne kopírku při každém SL nebo výstupu. Stalo se dnes naživo.
- **V13:** pevný limit 1,5 s na čtení při kontrole po flat. Ve stdout je 41× „deadline 1500 ms“ (17. 9. 28×), dnes 3×.
- **V16:** follower zlikvidovaný propkou nebo zamčený denním limitem vypne skupinu při exitu leadera. Reprodukováno, čistý produkční výskyt zatím není.
- **V17, V18:** vyřazení odmítnutého followera funguje jen u prvního obchodu na symbolu a záznam o vyřazení přežije do dalšího obchodu. Reprodukováno, zatím latentní.
- **V14:** strop ARM 8 h. Zatím 0×, protože ranní ARM vždy dřív ukončilo jiné vypnutí. Po opravě ostatních příčin se začne projevovat pravidelně.
- **V15:** cut proti klesající rezervě prop limitu. Latentní, skupina nemá cuty.
- **ST5 (P330):** 24. 9. 15:53:40 se SL jednoho followera vyplnil během posunu. Ostatní 4 zavřel auto-close a leader držel ještě ~76 s.
- **ST6:** 24. 9. 10:10:41 auto-close zavřel 6 pozic.
- **ST7 – spánek Macu:**
  - 262 z 264 transportních incidentů (21.–28. 9.) je v okně −120 s až +60 s od uspání nebo probuzení Macu,
  - 17× Clamshell Sleep (12× na baterii), 3× Low Power Sleep, dnes v 10:16:58 při 1 % baterie,
  - 91–95 % heartbeat timeoutů nastalo na obou spojeních současně.
- **ST21 (P313):** osamělá OSO noha, 25. 9. 12:48:06 za ARM.
- **ST26:** modify skončí jako filled u všech followerů v souladu s leaderem, kopírka ale přesto zůstane vypnutá. 55 záznamů v 6 dnech (13 epizod). Například 25. 9. 13:14 se ~5,7 min nekopírovalo.
- **ST27:** venue změní množství nativní OSO nohy (21. 9. 9:26, auto-close 6 pozic).
- **ST29:** leader-flat guard nemá fence ani opakování čtení. Rychlý nový vstup leadera nebo jedna chyba čtení vede k vypnutí. Reprodukováno, v logu zatím ne.
- **Latentní případy:**
  - V9: ruční obchod na followerovi, i vypnutém,
  - ST3: opakovaný ARM,
  - ST20: zlomkový násobek (24. 9. 9:08 hláška „−5, očekáváno −6 podle −13 × 0,5“).
- **Anti-revenge cooldown** chyba není, vypíná záměrně (P317 vyvrácen). Teď je cooldown vypnutý.

**Codexova hypotéza** (heartbeat čeká ve frontě zpráv) v kódu platí, hlavní příčinou ale není. Od 26. 9. připadá 162 ze 174 timeoutů do 120 s po probuzení Macu.

**Co s tím:** oddíl 6 a balíčky 0, 2, 4A, 5, 5B, 6 a 10.

### S2 — Změna leadera/followera nejde potvrdit

**Odpověď:** Dopoledne chybělo připojení FundedNext v Mac workeru, odpoledne už je. Obecně kontrola „stav se změnil“ padá na heartbeat a UI změnu skupiny samo nezopakuje.

**Čísla:**
- Změny skupiny přes relay za celou historii: 107 prošlo, 47 odmítnuto.
- Změny účtů od 15. 9.: 21 prošlo, 25 odmítnuto:
  - 13× „stav se změnil během kontroly“ (13 ze 46 změn; bez odmítnutí kvůli FN a outboxu 13 ze 34, tj. 38 %),
  - 7× „účet 67409592 není viditelný“ (všechny dnes),
  - 5× „nevyřešený durable outbox“ (22. a 24. 9.).
- 24. 9. 17:12:56–17:13:17 bylo odmítnuto 5× po sobě, prošel až šestý pokus.
- V 38 ze 41 oken odmítnutí není v journalu žádná obchodní událost.
- Přepnutí followera: 67 prošlo, 19 zablokováno (22 %). U zapínání selže první pokus v 37 % případů. V sobotu při zavřeném trhu 6 z 21.

**Příčiny:**
1. **FundedNext nebyl v Mac workeru (V2).**
   - Připojení 7cce8c5b bylo z manifestu odebráno 18. 9.
   - Editor nabízel webové OAuth účty a hláška posílala do Connections, kde je připojení zdravé. Jmenovala přitom jen první z pěti chybějících účtů.
   - V 10:42:50 vznikla skupina „odpolko“, která tehdy existovala jen v cloudu a nekopírovala.
   - Odpoledne už byla ARMED a kopírovala přes 7cce8c5b (viz V2).
2. **Heartbeat ve fenci (V3).**
   - Worker ani UI změnu skupiny neopakují.
   - Přepínač followera padá i na počítadle `pendingBrokerEvents`, do kterého se počítají heartbeaty. Během čtení drží frontu až ~5 s a zpozdí kopii vstupu (P37).
   - Fence při změně účtů ruší i rámce účtů mimo skupinu na stejném OAuth (P320). Obdobná read-only kontrola ale selhala jen 4× z 625, v klidu je to tedy vzácné.
3. **Nevyřešený outbox.** Hláška neříká, co udělat (P116).
4. **Zamčený přepínač followera (ST9).**
   - Přepínač je zamčený 5 min po ARM a po incidentu. Při měření měli zámek všichni followeři.
   - Na produkci už přepínač po ťuknutí vysvětlí, co ho blokuje. Zámek ale zůstává a UI nemá tlačítko Kontrola pozic.
5. **Starší UI na localhost:3000.**
   - Druhé přepnutí během prvního selže.
   - Na produkčním webu je to opravené frontou přepínačů (6b63b45), ale jen na webu.
   - Nativní iOS appka má vlastní zabalený web. Bundle v repu je z 20. 9. a přepínač followera vůbec nemá. Co je nainstalované v telefonu, jsme neověřovali.
6. **Neověřeno:**
   - částečný OAuth snímek (Codex),
   - uložení jen do cloudu při neznámém stavu (P113),
   - cloudový zápis bez časového limitu (P114, Codex).

**Co s tím:** oddíl 6 a balíčky 2 a 5.

### S3 — Po načtení „Neověřeno“ a chybí DLL, hlavně v telefonu

**Odpověď:** Telefon čte stav přes relay. Zahodí celý stav včetně ovládání, když jedno čtení selže nebo je signál workeru starší než 10 s. DLL závisí na úplném obnovení dat, které se po neúspěchu opakuje až za 10 minut.

**Čísla:**
- Relay hlásí worker jako připojený jen při signálu mladším než 10 s. Heartbeat workeru má timeout 20 s.
- Selhání heartbeatu podle dne: 17. 9. 585×, 18.–27. 9. 11–40× denně, 28. 9. dopoledne 4×.
- Asi 170 z ~250 selhání od 18. 9. připadá na současný výpadek obou spojení, typicky spící Mac. Tehdy je „Neověřeno“ pravda, chybí ale poslední stav a jeho stáří.
- Vercel za 7 dní: 95 855× odpověď 200, 5× 502.
- Živý test: 7× „Načítám DLL zbývá“ ještě minuty po načtení.

**Mechanismy:**
1. Relay větev zahodí stav (ST2, ověřeno) a s ním i přepínače followerů, pravidla a vypínání.
2. Retenční přepínač existuje a má testy, ale není zapojený. Je to v rozporu s rozhodnutím z 15. 9.
3. Každý návrat do appky stav zneplatní a druhá událost zahodí rozběhnuté čtení (ST14).
4. Studený start iOS: zálohy jen v sessionStorage a sonda 127.0.0.1 trvá až 1,5 s. Neověřeno na zařízení.
5. DLL:
   - jeden neúspěšný refresh ho skryje až na 10 min,
   - trvalé chyby vypadají jako „Načítám“ (ST12),
   - na produkčním webu už kompaktní řádek DLL ukazuje (6b63b45). V nativní iOS appce se starším webem být nemusí.
6. Peněžně citlivé:
   - „DLL zbývá“ je po částečném výstupu nadhodnocené (ST11),
   - mezi 0:00 a 2:00 hrozí falešný DLL zámek (ST10),
   - worker přitom posílá čerstvý accountRisk pro 7 účtů i přes relay a UI ho nepoužívá.

**Co s tím:** balíčky 1 a 8, spánek Macu v oddílu 6.

### S4 — Něco problikne

**Mechanismy:**
- „Neověřeno“ při návratu do okna (ST14, viděno živě).
- Starý stavový dotaz přepíše potvrzený DISARM, kill switch, zámek dne nebo přepnutí followera. Desetisekundová maska followera se po potvrzení hned zruší (ST13, jen podle kódu, neověřeno; Codex).
- Mizení přepínačů při ztrátě stavu (ST2).
- Přeskakování pozic kvůli prahům 8 s a 10 s (P241).
- Samovolný zámek přepínače po 5 minutách (ST9).

**Co s tím:** balíček 1.

### S5 — Pomalé přepínání

**Odpověď:** Na relay cestě zabírá čas síť a databáze mezi USA a Švédskem, ne práce Macu. Přepnutí followera navíc padá na heartbeat a opakuje se. Podrobnosti v oddílu 3.

---

## 3. Rychlost — naměřená čísla

### 3.1 Ovládání

Zdroj: 249 relay příkazů v2 (od 13. 9.), tabulka příkazů v Supabase (jen SELECT), živé testy.

| Akce | Přes relay: medián (p90) | Práce Macu | Lokální přímá cesta |
|---|---|---|---|
| DISARM | 1,36 s (1,6–1,9 s), 29/29 OK | 12 ms | pod 0,15 s |
| Přepnutí followera | 1,62–1,65 s (1,9 s), 22 % zablokováno | 150–480 ms | 0,5 s vypnutí / 1,33 s zapnutí |
| ARM | 2,6–2,8 s (3,0 s od 19. 9.; dříve p90 46 s, max 303 s) | ~1 s (od 20. 9. max 19 s) | ~1 s; 2,55 s s kontrolou pozic |
| Změna skupiny | 2,1–2,4 s (2,9–3,3 s); od 13. 9. odmítnuto 26 ze 49 | 0,5–1,3 s | ~0,9 s |
| Flatten skupiny | 2,9 s od 19. 9. (dříve 4,8 s, max 266 s) | 3,3 s | Flatten účtu ~0,9 s |

Odhad na telefonu (na iPhonu neměřeno):
- DISARM ~2 s,
- přepnutí followera ~2,2 s a dalších ~2,2 s za každé zablokování,
- ARM ~3,5–4 s.

Codex naměřil přepnutí s jedním zablokováním 4,6 s a se dvěma 7,95 s.

### 3.2 Kde se ztrácí čas

Stručně: čas zabírá server v USA a databáze ve Švédsku, ne Mac.

1. **Region.** Vercel funkce běží v iad1 (`fra1::iad1`), Supabase v eu-north-1.
   - vytvoření → kick: ~0,36–0,54 s,
   - kick → vyzvednutí: ~0,46–0,51 s,
   - ACK: ~0,6 s,
   - u DISARM to je odhadem ~1,3 s z ~2 s.
2. **Long-poll 2,2 s.** Vejde se do něj jen 12 % ARMů (15/123). Zbytek čeká na další kola a přidá se 0,4–0,8 s.
3. **Heartbeat ve fenci (V3).** Každé zablokování stojí ~1,6 s plus pauzu.
4. **Desktop přejde natrvalo na relay.** Stačí dvě neúspěšná lokální čtení. Pak ARM trvá 2,6 s místo ~1 s (ST15).
5. **Chybějící kick.** Bez kicku bylo 23 z 250 příkazů: fronta medián 1,33 s, p90 23,5 s. Nad 2 s čekalo 7 z 234 příkazů.
6. **Dlouhé ARMy.** Běžely 45–300 s a za nimi vypršelo 10 příkazů. DISARM ale nikdy (ST3).

### 3.3 Zrychlení relay

| Změna | Zisk | Poznámka |
|---|---|---|
| copier-relay do regionu u DB, sloučit autorizaci s claim/complete | −0,8 až −1,1 s na DISARM i přepnutí (odhad) | nejdřív změřit dopad na funkce volající Tradovate |
| Fence bez heartbeatu (V3) | přepnutí bez opakování | odstraní 22 % blokací |
| Long-poll podle typu (~6 s) nebo Realtime broadcast | ARM potvrzen o 0,4–0,8 s dřív | výsledek dál z DB |
| Desktop znovu zkoušet lokálního agenta | ARM ~1 s, DISARM < 0,15 s | jen web na Macu |
| Kratší nečinný poll (3–5 s) a přerušení kickem | méně čekání nad 2 s | claim je idempotentní |
| Okamžité odmítnutí ARM bez spojení; risk poll zrychlit, paralelizovat nebo vynutit jen pro staré snapshoty | odblokuje frontu | nikdy ARM bez čerstvého risku (ST19) |

### 3.4 Latence kopírování

Zdroj: audit 14.–28. 9. spárovaný s journalem (1,3 GB), měřeno na hodinách brokera.

| Typ | n | Medián | p90 | Max |
|---|---|---|---|---|
| Všechny nové | 980 | 802 ms | 2 550 ms | 3 347 ms |
| Market | 190 | 508 ms | 769 ms | 1 295 ms |
| OSO (od vstupu) | 531 | 837 ms | 1 029 ms | 1 761 ms |
| OCO bracket | 29 | 878 ms | – | 1 344 ms |
| **Samostatný Stop** | 167 | **2 620 ms** | 3 124 ms | 3 347 ms |
| Limit | 63 | 561 ms | 2 020 ms | – |
| Modify | 1 678 | 646 ms | 833 ms | 1 631 ms |
| Zrušení vstupu | 200 | 216 ms | 318 ms | – |

Další čísla:
- doručení WS rámce: medián 36 ms,
- rozptyl mezi followery: medián 73 ms, p90 275 ms,
- rozdíl ceny market fillu: medián 0,25 bodu, p90 1,5, max 5,75 (nenulový u 77 %),
- samostatný SL po marketu (13/13): followeři bez SL v mediánu 2,67 s, max 3,35 s.

**Kde se ztrácí čas a co zrychlit:**
1. **REST `/orderVersion/deps` u každého příkazu ve frontě (V11).**
   - Leader 243 ms, OSO ~571 ms z ~840 ms, fronta 0,6–2,9 s.
   - Fronta je společná pro leadera i followery na stejném spojení, takže zdrží i následný posun SL nebo exit.
   - Zrychlení: použít verzi ze stejného rámce.
2. **Samostatný SL (ST6).** Okno se počítá od zpracování a REST běží ve frontě. Měřit od příchodu a ověřovat mimo frontu, úspora ~0,5–1 s.
3. **Posun SL/TP (ST25).**
   - Před každým posunem se čte plný order graf (292 + 325 ms).
   - Vynechat jen cap lookup v `exposureCappedBroker`, když `maxContracts == null` (P142), úspora ~0,3–0,6 s.
   - Kontrolu množství v runneru (`copierRunner.ts:1597–1631`) ponechat a jen zlevnit (P334).
4. **Souběžnost odesílání (ST25).** Zamrzne při startu a přidaní followeři jdou ve vlnách (+150–275 ms). Počítat ji z aktuální skupiny.
5. **VPS v Chicagu** ušetří jen ~0,15–0,3 s. Se Supabase úložištěm by zápis stavu před kopií (`copierRunner.ts:628`) šel přes Atlantik. Probrat s Codexem.

---

## 4. Nálezy

Závažnost:
- **Vysoké:** peníze, nebo opakované doložené vypínání či blokace.
- **Střední:** zbytečná vypnutí, zavádějící údaje, pomalost, úzké peněžní okno.
- **Nízké:** drobnosti.

Štítky [S1]–[S5] odkazují na symptomy, [peníze] na riziko ztráty. Nové nálezy 3. vlny jsou V12–V18 a ST26–ST35. Nejnaléhavější jsou V12 a V13, dnešní incidenty.

### Vysoké

#### V1 — Úprava skupiny vypne kopírku před kontrolou; odmítnutí ji nechá vypnutou a zapíše „ručně“ [S1] [S2] [peníze]
- **Pro tebe:** Uložení změny za zapnuté kopírky ji vypne, i když se změna nepovede. UI ti neřekne proč.
- **Kde:**
  - `server/localCopierExecutionAgent.ts:270`: `disarm()` běží před kontrolami 271–276 a před `prepareAccounts` 283–284,
  - `services/copierRuntimeController.ts:8949–8958`: důvod vždy „manual“,
  - `reconfigureGroup` (≈9199) a `updateGroup` (9344–9346) nastaví `armed=false` před `assertTightenOnly`,
  - `components/LiveCopyTradeOverview.tsx:1861/1973`: důvod „manual“ se nezobrazuje,
  - desktopový dialog násobku 2003–2012 a text editoru 5169,
  - relay předkontrola tighten-only vynechává `set-multiplier`, `set-replication` a `set-follower-enabled` (P340). Zvýšení násobku tak dojde až k workeru, který nejdřív vypne a teprve pak odmítne.
- **Scénář:**
  - Za ARM uložíš změnu účtů, násobku, pravidel, šablony nebo replikace.
  - Worker kopírku vypne a teprve pak kontroluje.
  - Při odmítnutí zůstane vypnutá s důvodem „ručně“.
  - I úspěšná změna účtů kopírku záměrně vypne a UI o tom neřekne.
- **Důkaz:**
  - dnes: ARM 8:47:33, odmítnutí 8:50:03, záznam 8:50:04.293 „manual“, bez příkazu DISARM,
  - 24. 9.: ARM 17:10:33, 5 odmítnutí, nový ARM 17:15:14,
  - 11 ze 161 zapnutí ukončila změna konfigurace,
  - chování drží test `tests/localCopierExecutionAgent.test.ts:380`.
- **Dopad:**
  - Uprostřed obchodu se nekopírují posuny SL, částečné výstupy ani nové SL/TP (`copierRiskGate.ts:136`).
  - Znovu zapnout jde až ve flat stavu bez příkazů.
  - Auto-close se nespustí. Zbývá jen dozor po zavření obchodu, který může vypadnout (V4).
  - Vypnutí se vždy zapíše jako „manual“ a příkazy z loopbacku se nelogují. S1 proto nejde přiřadit konkrétnímu tabu ani akci (P341; souvisí s ST8).
- **Oprava:**
  1. Před vypnutím jen kontroly bez vedlejších efektů: sanitize, tighten-only, limity, **dry-run routingu bez `router.replaceRoutes`**, blokery. Dnešní `prepareAccounts` použít nejde, za ARM by přepnul routing.
  2. Pak DISARM s důvodem „config-change“ a autoritativní kontrola. Při selhání zůstane kopírka vypnutá bez auto-ARM, ale se správným důvodem.
  3. Metadata měnit mimo `controller.updateGroup`, který sám nastavuje armed:false (9338–9339).
  4. UI:
     - mobilní list násobku už varuje („Změna násobku kopírku vypne“, main 3524),
     - doplnit varování do desktopového dialogu násobku (2003–2012) a do editoru skupiny, kde dnes mate text „Uložením se kopírka nezapíná“ (5169), a sjednotit s mobilem,
     - dál zámek násobku a účtů při otevřené pozici a toast „Kopírka je VYPNUTÁ“.
  5. Relay: zvýšení násobku odmítnout už na relay odpovědí 409, ne až ve workeru po vypnutí (P340).
  6. Upravit testy :380, :342–375, :659–677.
- **Pozn. z ověření:** Když kontrola odmítne změnu až po vypnutí, kopírka vypnutá zůstane i po opravě pořadí. Pomůže správný důvod a oprava V3.
- **Stav:** ověřeno adversariálně + Codex 1; P340 a P341 neověřeno.
- **ID:** P10, P110, P20, P225, P243, P255, P148, P340, P341; Codex 1.

#### V2 — Editor nabízí účty, které Mac worker nemá; hláška radí špatný krok [S2] [S1]
- **Pro tebe:** Editor ti nabídne i účty, které Mac worker nevidí. Uložení selže, za ARM kopírku vypne a hláška tě pošle do Connections, kde vypadá vše v pořádku.
- **Kde:**
  - `services/dynamicBrokerRouting.ts:82` a 74–83,
  - `LiveCopyTradeOverview.tsx:2058/2083, 1384`,
  - `TradovateLiveDesk.tsx:364–367, 395–399`,
  - `lib/copierArmPreparation.ts:91–110`: stejná kontrola, ale jen pro ARM.
- **Scénář:** Worker routuje jen připojení z manifestu. Dopoledne to byla jen 53157614 a 754e4b5b. Editor nabízel i účty z FN 7cce8c5b a hláška radila Connections.
- **Důkaz:**
  - 7 odmítnutí dopoledne,
  - manifest měl 2 připojení, záloha z 18. 9. měla 3,
  - `status.devices` jen 2,
  - cloudová skupina „odpolko“ z 10:42:50,
  - stejný vzor 1. 9. (9×).
- **Stav k odpoledni:**
  - Věta „odpolko existuje jen v cloudu a nekopíruje“ už neplatí.
  - Odpoledne byla skupina ARMED a kopírovala přes 7cce8c5b (dispatche 16:07–16:34). Leader 67409620, followeři 67409592, 67409600, 67409612 a 67409626.
  - Worker měl tři připojení.
  - Kdy a jak se FN do manifestu vrátilo (reinstall?), v PROJECT_LOG zapsané není, je potřeba to doplnit.
  - Mechanismus V2 u editoru platí dál.
- **Dopad:** Změna nejde uložit, první pokus za ARM kopírku vypne (V1) a vznikají nekopírující skupiny.
- **Oprava:**
  - tři stavy účtu: „routovatelný“, „není v Mac workeru“, „nelze ověřit“. Druhý zablokovat před odesláním, u třetího jen upozornit,
  - hláška se všemi chybějícími účty a správným krokem,
  - odznak v Connections,
  - připojení za běhu nepřidávat.
- **Provozně:** `add-connection` bez `--lease` neprojde.
- **Stav:** ověřeno adversariálně (P228 zvýšen na vysokou).
- **ID:** P111, P22, P228, P242.

#### V3 — Fence „stav se změnil během kontroly“ reaguje na udržovací signál spojení [S2] [S5] [S1]
- **Pro tebe:** Kontrola bere signál „jsem naživu“ od Tradovate jako změnu stavu. Proto se změny skupiny a přepnutí followera zbytečně odmítají a za ARM kopírku vypnou.
- **Kde:**
  - `services/tradovateBroker.ts:1233–1234`,
  - `copierRuntimeController.ts:8815`, 8550 a 8672–8676,
  - 9244 a 9270–9279 (včetně `pendingBrokerEvents > 0`),
  - 5780/5835.
- **Důkaz:**
  - reprodukce,
  - 38 ze 41 oken odmítnutí bez obchodní události,
  - 13/46 změn účtů,
  - 22 % přepnutí,
  - sobota 6/21.
- **Doplněk z 3. vlny (neověřeno):**
  - Přepínač padá i na počítadle `pendingBrokerEvents`, které počítá heartbeaty. Během dvou kol čtení drží `eventTail` až ~5 s. Vstup leadera zadaný hned po kliknutí se proto zkopíruje pozdě (P37).
  - Fence při změně účtů ruší každý rámec obou OAuth socketů, i u účtů mimo skupinu (P320).
  - Obdobná read-only fence selhala jen 4× z 625.
- **Dopad:** Změny nejdou potvrdit, přepínač je pomalý a za ARM každé odmítnutí změny skupiny kopírku vypne.
- **Oprava:** Samotný přechod na `tradeBoundaryObservationVersion` nestačí: oslabil by zachycení datového rámce a zůstal by `pendingBrokerEvents`. Správně:
  1. odlišit keepalive `h` od datových rámců,
  2. fence reaguje jen na datové rámce, order/fill/position, connection a error,
  3. počítadlo nevyřízených událostí jen z obchodních událostí dotčených účtů, bez keepalive,
  4. REST čtení přepínače provádět mimo `eventTail`,
  5. worker sám zopakuje read-only kontrolu nejvýš 3×, nikdy zápis ani obchod,
  6. testy.

  Oprávněné odmítnutí (15. 9., skutečný výpadek) musí zůstat.
- **Stav:** ověřeno adversariálně (P21, P226, P251, P112; P112 snížen). Ostatní neověřeno. Codex 6.
- **ID:** P21, P226, P251, P112, P14, P134, P219, P246, P252, P37, P320.

#### V4 — Dozor nad pozicí followera po zavření leadera tiše vypadne [peníze]
- **Pro tebe:** Když se v prvních ~2 s po zavření obchodu kopírka vypne, upraví nebo znovu připojí, nikdo už nezkontroluje, že followeři jsou opravdu flat.
- **Kde:** `copierRuntimeController.ts:2199–2214`, 5159–5163, 5182–5186, 5260, 5671.
- **Scénář:**
  - DISARM, úprava skupiny, ARM, fail-closed nebo reconnect během 2s okna tiše zruší kontrolu followerů. Nic ji znovu nenaplánuje.
  - Stejně to dopadne ve vypnutém stavu, když se po Position=0 zablokuje zrušení sesterské OCO nohy. Toto pořadí je v reálném journalu z 24. 9.
- **Důkaz:**
  - 3 reprodukce: follower 5 MNQ zůstal, bez chyby a bez divergence,
  - 17. 9. ~27× přes noc „nedokončená epocha“,
  - komentář v `disarm()` i PROJECT_LOG z 31. 8. slibují opak.
- **Dopad:** Follower drží pozici bez dozoru, případně i bez SL. Přes konec session hrozí ztráta prop účtu.
- **Oprava:**
  1. Přeplánovat s aktuální generací, omezit počet pokusů, pak fail-closed bez auto-close.
  2. Watchdog pro osiřelé epochy.
  3. Obnova i v nečisté recovery.
  4. Testy.
- **Stav:** ověřeno adversariálně, 2 ověřovatelé (kritická/vysoká).
- **ID:** P147, P250.

#### V5 — Samostatný SL followera se po vypnutí nebo pod kill switchem zruší [peníze]
- **Pro tebe:** Po vypnutí kopírky nebo pod kill switchem může follower přijít o svůj samostatný SL.
- **Kde:** `copierRunner.ts:1381–1392`, `copierRiskGate.ts:150–164`, `copierRuntimeController.ts:1302–1308, 6038–6060, 7705`.
- **Scénář:** Po DISARM nebo kill switchi leader zruší samostatný SL. Zrušení se zkopíruje, SL followera zmizí a nový SL i exit se zablokují.
- **Důkaz:** reprodukce přes wire harness (follower −1 bez SL). Samostatné SL používáš často: 167 odeslání, 21 zrušení za ARM.
- **Dopad:** Při DISARM je follower bez SL až do flat leadera. Pod kill switchem bez ochrany na neurčito.
- **Oprava:**
  1. Trvalý příznak ochranné nohy.
  2. Zrušení projde plnou bránou s výjimkou flat followera, vyhodnocenou po účtech.
  3. Rozšířit úklid ochranných noh.
  4. Testy.
- **Stav:** ověřeno adversariálně (z kritické na vysokou).
- **ID:** P146.

#### V6 — Obměna spojení: události z mezery se ztratí a controller se to nedozví [peníze] [S1]
- **Pro tebe:** Při výměně spojení s Tradovate (zhruba každých 50 min) může kopírka přehlédnout obchod, který proběhl právě v té mezeře.
- **Kde:** `brokerRouter.ts:200–211, 296–303`, `tradovateBroker.ts:1195, 984`.
- **Důkaz:**
  - simulace: 0 předaných událostí, follower −2, kopírka zapnutá, bez divergence,
  - 24. 9. 18:00:48 cancel v mezeře,
  - 24. 9. 10:10:42 filly jen ve snímku,
  - 50–69 obměn denně.
- **Doplněk z 3. vlny (ověřeno):**
  - Router zahazuje `resynced` už od 23. 8. (9b43132), ne až od 18. 9. Scratch skript nad `createBrokerRouter` vrátil 0 událostí po resync. Nasazený bundle má stejnou logiku.
  - Pojistka v controlleru (6962–6988) je proto mrtvá. Kdyby se `resynced` beze změny controlleru propustil, kopírka by se tiše vypínala při každé obměně bez `recordDisarm`.
  - Mezera při obměně existuje: ~0,8–1,2 s plus ~0,4 s autorizace. Varianta „prokázat bez mezery“ neplatí.
  - 24. 9. 10:10:41,488 proběhla obměna 38 ms po fail-closed, uprostřed auto-close 6 pozic. Brána obměny (`pilot.ts:1117–1119`) bere `armed=false` po fail-closed jako „mimo obchod“.
- **Dopad:** Pravděpodobnost ~0,05–0,1 % na vstup, výsledkem je opačná nebo nahá pozice.
- **Oprava:** Fill z mezery **nikdy** nepřehrávat, byl by to dohánějící obchod. Samotné propuštění `resynced` by vypínalo kopírku každých 50 min. Správně:
  1. resync s daty (neviděné filly, pozice), router předává `resynced` pro každé připojení zvlášť,
  2. signál „route-gap“ pro spojení followerů,
  3. controller ARM neruší. Udělá read-only porovnání: při shodě drží, při neshodě `failClosed` s důvodem, bez pozdržování vstupů,
  4. leader příkaz poprvé viděný až jako filled = explicitní fail-closed s důvodem,
  5. obměnu neprovádět za běžícího auto-close, recovery, rozpracovaného outboxu ani OSO okna,
  6. obměna bez backoffu a rozložená v čase,
  7. rozhodnutí zapsat do PROJECT_LOG.
- **Stav:** ověřeno adversariálně.
- **ID:** P213, P216, P35, P312.

#### V7 — REST čtení „spolkne“ WS Fill [peníze] [S1 latentně]
- **Pro tebe:** Fill, který worker uvidí nejdřív přes REST, se ve streamu „ztratí“. Kopii to nezmešká, ale denní zámek a dozor ho nevidí.
- **Kde:** `tradovateBroker.ts:736–741, 984, 1100–1108`.
- **Důkaz:** simulace. REST v produkci viděl fill dřív než WS o 152–587 ms.
- **Dopad:**
  - Followeři jsou on-submit, takže zmeškaná kopie je latentní.
  - Obchod ale obejde denní zámek, guard nepozná exit a chybí odvození bracketu.
- **Oprava:**
  - Tři množiny: započteno / baseline / doručeno.
  - Naivní „REST nic neoznačuje“ je nebezpečné, protože Tradovate posílá Updated i pro staré filly (16. 9. 23:34).
  - Uvolňování cutů omezit na heartbeat.
- **Stav:** ověřeno adversariálně.
- **ID:** P214.

#### V8 — Ochranný posun SL se při zahlcené frontě tiše zahodí [peníze] [S1]
- **Pro tebe:** Když je fronta zahlcená, posun SL se followerům tiše nepošle a jejich SL zůstane na staré ceně.
- **Kde:** `copierRuntimeController.ts:6926–6928, 1307–1312`, `copierRiskGate.ts:139`, `copierRunner.ts:1642–1653`.
- **Důkaz:**
  - 22. 9. 16:54 byl SL followerů ~55–90 s pozadu a 66142377 se v 16:57:56 zavřel na starém SL,
  - 16. 9. 20:51:55 zablokováno 11 cancelů a DISARM,
  - v obou oknech bez výpadku spojení.
- **Dopad:** V provozu už se projevil (22. 9.).
- **Oprava:**
  1. Živost spojení zapisovat při příjmu.
  2. Stáří události hlídat jen u operací zvyšujících expozici.
  3. Prokazatelně neodeslaný ochranný posun znovu prosadit po čerstvém lookupu.
  4. Lookupy číst mimo frontu s rozpočtem 6–8 s. Timeout znamená „neznámo“ a nové čtení, fail-closed až po vyčerpání rozpočtu. Pevný limit 1,5–3 s nestačí, dnes `/command/list` trval ~4,8 s (V13).
- **Stav:** ověřeno adversariálně.
- **ID:** P12.

#### V9 — Ruční obchod na followerovi, i vypnutém: auto-close zavírá celé účty včetně ručních pozic [S1] [peníze]
- **Pro tebe:** Při bezpečnostním vypnutí, expiraci ARM nebo reconnectu může kopírka zavřít i tvé ruční obchody na followerech, i na vypnutých a i v jiném symbolu.
- **Kde:**
  - `copierRuntimeController.ts:5380–5405` (`autoFlattenCopies`), 7355–7384, 2991–3051, 8869–8883, 8410,
  - `copierManualActions.ts:164, 339, 488` (rozsah „celý účet“),
  - `copierLeaderFlatGuard.ts:612–617`.
- **Mechanismus:**
  - `autoFlattenCopies` bere **všechny** followery skupiny včetně vypnutých a volá Flatten s rozsahem „celý účet“.
  - Zavře pozice ve **všech symbolech** a zruší **všechny** pracovní příkazy.
  - Porušuje to vlastní princip kódu „bez copier lineage nikdy nelikvidujeme ruční expozici“ (4545–4553, recovery 5680–5697, leader-flat guard).
- **Vadou je auto-close (P30), ne samotný DISARM.** Vypnutí kvůli ruční pozici na vypnutém followerovi je záměr specifikace přepínače (P34 vyvrácen).
- **Varianty z reprodukcí** (ověřeno adversariálně, 2 ověřovatelé, mock broker):
  - (a) **Za ARM:** ruční pozice na vypnutém followerovi ve stejném symbolu jako otevřený leader. Kopírka ji tiše toleruje a při expiraci ARM, fail-closed nebo reconnectu ji zavře.
  - (b) **Reconnect:** ruční pozice na vypnutém followerovi přepne obnovu z „synchronní → držet“ na auto-close. **Zavře se i zdravá kopie ostatních followerů.**
  - (c) **Za DISARMED:** ruční obchod na kterémkoli followerovi skončí flat v pomalé chvíli čtení. `failSweep` pak spustí auto-close bez ohledu na ARM a zavře ruční pozice vypnutých followerů, i v jiném symbolu.
  - (d) Ruční pracovní limit v jiném symbolu na zapnutém followerovi auto-close zruší.
- **Co neplatí:**
  - Ruční pozice v jiném symbolu při flat leaderovi za ARM vede jen k DISARM bez zavření.
  - Dnes v 16:04:58 se nic nezavíralo, štítek „auto-closed“ je zavádějící.
  - 11 epizod 17.–25. 9. zavíralo kopie, ne ruční obchody.
  - Živý incident zavření ručního obchodu zatím není. Odpovídá ale tvému postupu (dnes ráno ruční obchody přímo na followerech).
- **Oprava (bezpečná verze, Codex):**
  1. Z auto-close a z `hasExposure` vyřadit **jen** followery s `enabled === false`. Followery vyřazené přes eligibility nebo cut **ponechat**, mohou držet skutečné kopie (incident 20. 8.).
  2. Recovery „synchronní → držet“ počítat jen z participujících followerů. Expozice vypnutého followera = jen audit a notifikace, bez obchodu.
  3. Sweep bez copier ochranné nohy = žádné volání brokera a žádný `failSweep`.
  4. Volitelně cílit na symboly se stopou kopírky. Když stopa není známá, vrátit se k rozsahu celého účtu.
  5. `copiesOutcome` „auto-closed“ zapsat jen po skutečné akci, jinak „flat“.
  6. Regresní testy: fail-closed, expirace, reconnect, sweep za DISARMED.

  Původní návrh „omezit na lineage a vyřadit eligibility“ **nepoužít**. Oslabil by poslední brzdu u kopií s neúplnou lineage.
- **Rozhodnutí na tobě:** ruční obchody na followerech zakázat, nebo je izolovat (fail-closed jen při příkazu kopírky na vypnutém účtu).
- **Stav:** ověřeno adversariálně. P30 potvrdili 2 ověřovatelé s reprodukcí, snížen z kritické na vysokou. P149 snížen na střední, část je záměr z 26. 9.
- **ID:** P24, P149, P30.

#### V10 — „Flatten followera do konce obchodu“ blokuje frontu a nemá limit [S5] [peníze]
- **Pro tebe:** Flatten followera do konce obchodu může zablokovat kopírování dalších událostí leadera, včetně jeho exitu.
- **Kde:** `copierRuntimeController.ts:4694, 4754, 3743–3755`, `copierManualActions.ts:185, 301–326`.
- **Důkaz:** reprodukce, exit leadera čekal a smyčka proběhla 5 260×. V provozu zatím nepoužito. Stejný vzor má DLL cut.
- **Oprava:**
  1. Deadline 60–120 s.
  2. Potvrzování mimo frontu.
  3. Přednost pro DISARM a kill switch.
- **Stav:** ověřeno adversariálně.
- **ID:** P254.

#### V11 — REST hydratace každého příkazu ucpává frontu [S5] [peníze]
- **Pro tebe:** Každý nový příkaz čeká na dotaz k serveru Tradovate. Fronta spojení se tím ucpe na 0,6–2,9 s a zdrží i následný posun SL, zrušení nebo výstup na stejném spojení.
- **Kde:** `tradovateBroker.ts:1032, 1079–1087, 1459`.
- **Vazba na SL:** Fronta je společná pro leadera i followery na jednom OAuth spojení (např. 754e4b5b). Zpoždění SL tak plyne z mechanismu. Přímo změřené zpoždění SL kvůli této frontě ale nemáme. Chybný obchod to nezpůsobí.
- **Oprava:** Brát verzi příkazu z rámce, REST jen jako zálohu pro všechny příkazy. Testy s produkčním tvarem dat.
- **Stav:** ověřeno adversariálně.
- **ID:** P141.

#### V12 — Čekající kopie limitního příkazu = falešná „nevysvětlená divergence“; SL leadera se nezkopíruje nikomu [S1] [peníze] — DNEŠNÍ INCIDENT
- **Pro tebe:** Když u followerů leží zkopírovaný čekající limitní příkaz a ty vstoupíš jiným příkazem, tvůj SL nebo výstup se followerům nezkopíruje a kopírka se vypne. Stalo se dnes v 16:13:59.
- **Kde:**
  - `services/copierRuntimeController.ts:6699–6718`: výjimka `exactCurrentPendingExposure` vyžaduje `followerNet !== expectedPreNet` (6703),
  - `6483–6529`: čekající kopie se ukládá i pro čekající limity zadané z flat,
  - `6563–6620`: záznam se maže jen při filled, canceled nebo rejected,
  - `6622`: `currentRuntimePendingNet`, místo opravy,
  - `8051–8064`: `failClosed(autoClose:false)`,
  - stejnou cestou jde samostatný SL (6055) a OSO (6118, 7785, 7891).
- **Scénář:**
  1. Leader má čekající limitní příkaz zadaný z flat, dnes Sell Limit 8 @30618. Může to být zamýšlený TP i short vstup, na chybě to nic nemění.
  2. Kopírka ho zkopíruje followerům a kopie čekají.
  3. Do pozice leader vstoupí jiným příkazem (Market Buy 8). Followeři mají pozici přesně jako leader.
  4. Worker ale čekající kopii limitu počítá jako „rozpracovanou expozici“ a sedící pozici prohlásí za divergenci.
  5. Při prvním SL nebo výstupu leadera kopírku vypne a SL ani exit nepošle nikomu.

  Stejně dopadne čekající přikupovací limit (Buy Limit + Market + exit).
- **Dnešní průběh (Praha / UTC):**
  - 16:05:43 / 14:05:43 ARM.
  - 16:07:36 / 14:07:36 Sell Limit 8 @30618 zkopírován 4 followerům.
  - 16:13:17 / 14:13:17 Market Buy 8, followeři +8.
  - **16:13:59,9 / 14:13:59,9** Stop Sell 8 @30516,25 zablokován („unexplained-position-divergence“) → DISARM.
  - 16:14:25 / 14:14:25 zablokován i posun SL.
  - 16:14:27,3 / 14:14:27,3 SL leadera vyplněn @30516.
  - 16:14:32,3 / 14:14:32,3 guard zavřel followery @30509,5. V auditu je to 16:14:33,8, tj. 6,35 s po výstupu leadera.
  - 16:15:06 / 14:15:06 jsi kopírku znovu zapnul.
- **Důkaz:**
  - audit a stdout 18036–18047,
  - `snapshot.json`: outbox[32..35] Sell Limit 8 acknowledged, [36..39] Buy Market 8,
  - journal 7cce8c5b: followeři mají netPos 8 od 14:13:17,65, kopie limitu je ještě v 14:14:29 Working,
  - deterministická reprodukce proti nezměněnému kódu: Stop se nepošle, `armed=false`,
  - test na tento sled chybí (P322).
- **Dopad:**
  - 4 × 8 MNQ ~34 s bez SL, výstup o 6,5 bodu horší ≈ 416 USD,
  - kopírka vypnutá 67 s,
  - kdyby leader nevystoupil celý (částečný výstup nebo jen posun SL), followeři by drželi plnou pozici bez SL a bez správy.
- **Oprava (Codex):**
  1. Opravit centrálně v `currentRuntimePendingNet`. Čekající kopii **nezapočítat jen tehdy**, když je prokazatelně nevyplněným zrcadlem stále otevřeného příkazu leadera. Musí platit současně:
     - leaderův příkaz je otevřený v `liveOrdersByAccount`,
     - není to Market,
     - stejná strana a symbol,
     - leader filledQuantity a `leaderCumQty` jsou 0,
     - kopie má reportedFilled 0.

     Vše ostatní (zpoždění, částečný fill, neznámý leaderův příkaz) zůstává fail-closed.
  2. Prototyp je ověřený ve scratch kopii:
     - sled z 28. 9. zkopíruje SL a zůstane ARMED,
     - test `copierRuntimeController.test.ts:1119` dál končí fail-closed,
     - 113/113 testů controlleru a 143 copier testů prošlo.
  3. Regresní testy:
     - (a) přesný sled 28. 9.,
     - (b) přikupovací limit,
     - (c) částečný fill leaderova limitu → musí zůstat fail-closed,
     - (d) test 1119 beze změny.
  4. Hygiena: vyčistit čekající záznamy v `reconfigureLeaderEpoch` a v `runReconciliation` je prořezat podle autoritativního `listOrders`.
  5. **Nepoužít návrh z P316** („čekající kopie smí jen vysvětlit“). Rozbije test 1119: ruční pozice followera zamaskovaná čekající kopií by prošla a fail-closed by se oslabil.
- **Stav:** ověřeno adversariálně, 2 × 2 ověřovatelé, reprodukce. Sníženo z kritické na vysokou, protože nevznikl chybný obchod a guard nakonec pozice srovnal.
- **ID:** P38, P316; testy P322.

#### V13 — Kontrola po flat: jedno pomalé čtení (limit 1,5 s) vypne celou skupinu a zdrží frontu událostí [S1] — DNEŠNÍ INCIDENT
- **Pro tebe:** Jedno pomalé čtení u Tradovate po výstupu vypne celou kopírku, i když je vše flat. Stalo se dnes v 16:04:58.
- **Kde:**
  - `copierRuntimeController.ts:1523` (`SWEEP_CALL_DEADLINE_MS = 1500`),
  - `1566–1629` (sweep; `failSweep` 1604–1615 = `failClosed` + `scheduleAutoClose`),
  - `7303–7338` (volá se s `await` uvnitř `eventTail`),
  - `6853–6862` (exit-only sweep: DISARM bez auto-close),
  - `tradovateBroker.ts:861–868` (sdílené čtení order grafu), `955–963` (globální `/command/list`), `1784–1797` (stav příkazu ze streamu bez REST).
- **Scénář:**
  - Po flat followera worker ověřuje, že jeho staré ochranné nohy nepracují.
  - Čte celý order graf s pevným limitem 1,5 s, a to účty jeden po druhém uvnitř fronty událostí.
  - Jeden pomalý dotaz = DISARM celé skupiny, i když je vše flat.
- **Dnešní průběh (Praha / UTC):**
  - 16:04:56,8 / 14:04:56,8 leader flat.
  - Timeouty u 67409626 (56,8), 67409592 (58,4) a 67409612 (59,9), po 1,5 s za sebou.
  - **DISARM 16:04:58,4 / 14:04:58,4** (`flat-sweep-deadline`).
  - `/command/list` dorazil až 16:05:01,7 (~4,8 s), ostatní části za ~0,2 s. Všechny tři sweepy čekaly na tentýž dotaz.
  - Událost pozice leadera se zpracovala o ~4,5 s později.
  - 16:05:03,6 guard potvrdil, že je vše flat.
  - 16:05:43 jsi kopírku znovu zapnul.
- **Klíčové:**
  - Jedinými kandidáty byly OSO nohy 676817960005/006, které byly terminální už od 15:51:42 (13:51:42 UTC). Výstup šel přes kopírovaný standardní Stop.
  - DISARM tedy způsobilo čtení, které mělo dokázat něco, co stream už věděl.
  - „auto-closed“ v historii je zavádějící. Auto-close nad flat účtem nic neudělá.
- **Důkaz:**
  - stdout 18026–18034,
  - stderr FAIL-CLOSED 14:04:58,369 / 59,882 / 05:01,383,
  - v září 41× „deadline 1500 ms“ (29× flat sweep, 7× výběr nohou, 5× postkontrola),
  - testy tuto cestu nepokrývají. Injektují `wait`, a tím deadline vypnou.
- **Oprava (Codex):**
  1. Kandidáty filtrovat podle terminálního stavu ze streamu (`findOrderStatusById` při `syncReady`, bez REST). Zbylá ID číst přes `/order/item`. Globální graf sweep nepotřebuje. Dnes by se tak neposlalo nic a DISARM by nenastal.
  2. Postkontrola přes `listPositions` a stav jednotlivých ID.
  3. Ověřovací úloha pro každý účet a symbol mimo `eventTail`:
     - rozpočet 6–8 s,
     - fencing přes `safetyGeneration`,
     - po dobu ověření blokovat nové vstupy jen pro dotčený účet a symbol.
  4. Po vyčerpání rozpočtu `failClosed` jako dnes a trvalé opakování sweepu.
  5. Regresní test se skutečným deadlinem.

  Opakuje se jen čtení, nikdy obchod, takže nejde o blind retry. **Nepoužít** „okamžitý cancel lokálně známých nohou“ z původního návrhu:
  - durable historie má desítky terminálních noh,
  - hrozí Tradovate 429 s hodinovým breakerem, který zablokuje i nouzový Flatten (rozhodnutí 26. 8.).
- **Stav:** ověřeno adversariálně (oba nálezy, log + kód).
- **ID:** P311, P324.

#### V14 — ARM má skrytý strop 8 h; při expiraci zavře followery uprostřed obchodu [S1] [peníze] (latentní)
- **Pro tebe:** Ranní ARM vyprší po 8 h uprostřed NY seance a zavře followery, zatímco leader zůstane v obchodě. UI přitom slibuje konec v 00:00.
- **Kde:**
  - `copierRiskGate.ts:108` (armTtlMs 8 h),
  - `scripts/copier/pilot.ts:773, 1477` (bez `risk`, tedy default),
  - `copierRuntimeController.ts:797, 8897–8900` (min(session, 8 h) od `gate.armedAt` posledního ARM),
  - `5999–6022` (`maybeHandleArmExpiry` nekontroluje otevřenou pozici), `5384` (auto-close podle `armExpiryFlatten='followers'`),
  - `LiveDayRulesCard.tsx:998, 1017` („V 00:00 (17:00 Chicago) se copier sám vypne“),
  - `nativeCopierNotificationPlan.ts:125, 145` (push až při expiraci).
- **Scénář:**
  - ARM v 8:47 vyprší v 16:47 (10:47 ET), uprostřed NY seance.
  - Kopírka se vypne a zavře followery, leader zůstane v obchodě.
  - Prodloužit uprostřed obchodu nejde, nový ARM vyžaduje flat.
  - Při `armExpiryFlatten='off'` se kopírka jen vypne.
- **Důkaz:**
  - kód a test expirace 4/4 (zavře se jen follower),
  - v logu 0 událostí arm-expiry, protože ranní ARM vždy dřív ukončilo jiné vypnutí,
  - dnes vyhrál konec session: poslední ARM v 16:15, vyprší ve 24:00.
- **Oprava (tvoje rozhodnutí + Codex):**
  - Strop nerušit, jinak ARM po 17:00 CT dostane ~24 h.
  - Místo toho měkká 8h expirace:
    - ve flat stavu prostý DISARM,
    - v obchodě blokovat nové vstupy (jako pause/management-only, exity a SL se kopírují dál), DISARM až po flat leadera.
  - Tvrdý konec session beze změny.
  - UI: skutečný `armExpiresAt` místo „V 00:00“ a push T−15 min s upozorněním, že prodloužit jde jen novým ARM ve flat stavu.
- **Stav:** ověřeno adversariálně. Příklad „dnes by vypršelo 14:47Z“ je vyvrácen, mechanismus platí.
- **ID:** P31.

#### V15 — Kontrola „cut ≤ 95 % prop limitu“ proti klesající rezervě vypne celou skupinu a po restartu nenaběhne worker [S1] [peníze] (latentní)
- **Pro tebe:** Denní cut followera by při ztrátě vypnul celou skupinu dřív, než by sám vystřelil. Po restartu by pak worker nenaběhl.
- **Kde:**
  - `copierRuntimeController.ts:3954–3956` (propLimitUsd = dailyLossAutoLiq ?? equity − minNetLiq),
  - `1985–1998` (kontrola přes všechny followery bez filtru),
  - `4922–4934` (risk poll každých 30 s a po každém fillu followera → `failClosed`),
  - `766–783` (accountRisk ze snapshotu bez filtru session),
  - `8804` (bootstrap volá kontrolu mimo try), `8837` (ARM), `9344–9346` (updateGroup),
  - `lib/copierDisarmReason.ts:163–202` (chybí vzor, důvod tedy „unknown“).
- **Scénář:**
  - Follower má denní cut a propka nemá statický DLL. Živě je `dailyLossAutoLiq=null` u všech FN účtů.
  - Rezerva k likvidačnímu prahu se se ztrátou zmenšuje, takže kontrola započítá ztrátu dvakrát.
  - Po ztrátě zhruba poloviny cutu vypne celou skupinu dřív, než cut vystřelí. Platí to i pro vypnutého followera.
  - Stane se to uprostřed obchodu a bez auto-close.
  - Po restartu worker nenaběhne (launchd smyčka), dokud někdo ručně neupraví `group.json` nebo snapshot. Z UI to opravit nejde, agent startuje až po bootstrapu.
- **Důkaz:**
  - reprodukce: rezerva 300, cut 200, ztráta −100 → `armed=false` a cut se nespustil. Druhý bootstrap spadne.
  - živě rezervy 118,8–242,8 USD, později 413 / −22 / −48 / −58 / −58 USD. Jakýkoli kladný cut by byl okamžitě neplatný.
  - zatím latentní, `group.json` nemá `dailyLossCutUsd`.
- **Oprava (Codex):**
  - Porovnávat zbývající prostor (cut − dnešní ztráta) s 0,95 × aktuální rezerva.
  - Jen čerstvé snapshoty. Vynechat vypnuté a cutnuté followery a režim off.
  - Periodický poll nikdy nevypíná celou skupinu. Místo toho cut na účtu se zdrojem `prop-reserve` podle spec §3.3.
  - Bootstrap nesmí padat na hodnotě z brokera: worker nastartuje v DISARMED s důvodem.
  - Kód důvodu v `copierDisarmReason`.
  - Testy.
  - **Nepoužít** „validovat jen proti statickému DLL“. U Lucid a Tradeify je jediný známý limit trailing floor a ochrana by zmizela.
- **Stav:** ověřeno adversariálně, reprodukce.
- **ID:** P32.

#### V16 — Propkou zlikvidovaný nebo DLL-zamčený follower zablokuje exit zdravým a vypne skupinu [S1] [peníze] (povýšení části ST18)
- **Pro tebe:** Když propka jednoho followera zlikviduje nebo ho zamkne denní limit, další exit, nový SL nebo částečný TP leadera nedostanou ani ostatní followeři.
- **Kde:**
  - `copierRuntimeController.ts:6688` (kontrola divergence vynechá jen vypnuté a close-copy cut, ne nezpůsobilé účty),
  - `6730–6758`,
  - `3118–3170` (`isolateBreachedFollower` nezakládá suppression, na rozdíl od sideline 3205),
  - `6356–6361` (suppression nezpůsobilé účty vynechává),
  - `8395–8410` (reconcile počítá breached jako očekávaných 0, nekonzistence),
  - volající 6055, 6118, 7785, 7891, 8051.
- **Scénář:**
  - Propka jednoho followera zlikviduje, nebo je DLL-zamčený a vstup mu byl přeskočen. Worker ho správně izoluje a slíbí „kopírka pokračuje pro ostatní“.
  - Při dalším exitu, novém samostatném SL nebo částečném TP leadera ho ale vidí jako divergenci (0 vs N). Vypne skupinu a exit nepošle ani zdravým.
  - Plný exit dožene guard za ~2 s. Částečný exit a nový SL ne, zdraví followeři zůstanou přeexponovaní.
  - Totéž nastane u asynchronního DLL rejectu vstupu.
- **Důkaz:**
  - dvě reprodukce (breach i DLL): `armed=false`, zdravý follower bez Sell,
  - doklad z logu 17. 9. 8:40:08 uvedený v nálezu je chybný, skupina už byla vypnutá,
  - předpoklad nastal 17. 9. 10:52:12 (4 falešně breached přeskočeni, 7 v pozici). Exit tehdy šel přes nativní OCO.
- **Oprava (Codex):**
  - V `cutAwareDispatchFor` mode off bez unsafe divergence jen pro followera `breached`/`dll-locked`, který splňuje všechno:
    - je autoritativně flat,
    - nemá čekající záznam ani exit-only rezervaci,
    - nemá pracovní příkaz na symbolu.
  - `unverifiable` nikdy. Nenulová pozice dál fail-closed.
  - Alternativně suppression `allowedNet:0` při izolaci a v async DLL rejectu.
  - Testy: breach, DLL, částečný exit, nový SL, negativní případ.
  - Samostatně: `verifyFollowerMagnitude` nekontroluje `gate.armed`, takže izoluje i za DISARMED.
- **Stav:** ověřeno adversariálně, 2 ověřovatelé, reprodukce, sníženo z kritické.
- **ID:** P39, P151 (část „auto-liq propky“).

#### V17 — Vyřazení odmítnutého followera (rozhodnutí 17. 9.) funguje jen u prvního obchodu na symbolu [S1] [peníze]
- **Pro tebe:** Když propka jednomu followerovi odmítne vstup (třeba kvůli limitu pozice) a ten den už proběhl obchod, nevyřadí se jen ten účet. Vypne se celá skupina.
- **Kde:**
  - `copierRuntimeController.ts:3374–3379` (sync) a `3176–3183` (async): jakákoli `acknowledged` položka na účtu a symbolu znamená „rozpracováno“ → null,
  - outbox se čistí jen při změně topologie (8717), `acknowledged` je konečný stav (`copierOutbox.ts:24–35`),
  - async větev `failClosed(autoClose:false)` (3303).
- **Scénář:**
  - Po prvním obchodu dne zůstanou v outboxu staré potvrzené položky.
  - Když propka později odmítne vstup jednomu followerovi (limit pozice), sideline neproběhne.
  - Synchronní varianta vypne skupinu a auto-close zavře i správně otevřené ostatní followery.
  - Asynchronní varianta vypne skupinu a ostatní nechá v obchodě bez správy exitu. Je to stejný typ jako incident 17. 9.
- **Důkaz:**
  - živý snapshot: každý ze 4 followerů má 15× `acknowledged` na MNQZ6 (15:50–16:34 Praha, 13:50–14:34 UTC),
  - reprodukce obou variant, kontrola s jiným symbolem prošla,
  - rejecty kvůli limitu pozice nastaly v produkci 17. 9. a 25. 9., čistý výskyt přesně tohoto typu nenalezen.
- **Oprava (Codex):**
  - planned/sending/unknown blokují vždy.
  - `acknowledged` starší než otevření aktuální epochy neblokuje, ale jen když autoritativní čtení ukáže net 0 a žádný pracovní příkaz.
  - Sideline převést na async s tímto čtením. Chyba čtení = fail-closed jako dnes.
  - **Outbox nemazat ani nearchivovat.** Je to evidence proti dvojímu odeslání po restartu.
  - Zvážit, že OSO rejecty sideline vůbec nepokrývá.
  - **Nepoužít** původní filtr unknown/sending podle epochy, oslabil by model.
- **Stav:** ověřeno adversariálně, reprodukce.
- **ID:** P331.

#### V18 — Záznam „follower vynechán z epizody“ přežije do dalšího obchodu → exit se nepošle nikomu a kopírka se vypne [S1] [peníze] (latentní)
- **Pro tebe:** Po jednom zablokovaném vstupu (pauza, obchodní okno) kopírka při exitu dalšího normálního obchodu nepošle exit nikomu a vypne se. Opakuje se to i po novém zapnutí.
- **Kde:**
  - `copierRuntimeController.ts:3205`, `6356–6376`: suppression `allowedNet 0` při sideline, pauze, day-lock-pending, management-only, obchodním okně a fillu blokovaného vstupu,
  - mazání jen v 6734–6743 a 1975, 8741, 9694,
  - vstup suppression nekontroluje (6656–6663),
  - `6761` → unsafe → `failClosed` (8051, 7785, 6118; samostatný SL 6055),
  - maskování skutečné divergence 3285, 7431, 8425, 9529,
  - audit vždy „unexplained-position-divergence“ (8061).
- **Scénář:**
  - Blokovaný vstup (třeba pauza z pravidel dne) skončí flat.
  - Další normální obchod se zkopíruje. Jeho exit nebo nový SL ale narazí na starý záznam, vypne skupinu a nepošle se nikomu.
  - **Opakuje se i po Kontrole pozic a novém ARM**, až do nové session nebo restartu workeru.
  - Starý záznam zároveň může zamaskovat skutečný stav „follower 0, leader otevřený“.
- **Důkaz:**
  - reprodukce (`p310.test.ts`): exit ve 2. epizodě = 0 Sell, `armed=false`, ve 3. epizodě po re-ARM znovu,
  - předpoklad nastal 9. 9. (pauza losing-trades), leader už ten den neobchodoval,
  - dnes jsou pauzy i okno vypnuté.
- **Oprava (Codex):**
  - Úklid na konci epizody, jen když je follower autoritativně = allowedNet = 0 a nic nečeká.
  - Úklid při novém vstupu z flat.
  - Vazba na epochId/leaderOrderId, starý záznam přepsat.
  - V auditu skutečný důvod.
  - **Nikdy nemazat při nesouladu** s leaderem.
  - Testy: sideline, pauza, management-only, okno, částečný exit, 3. epizoda, negativní test.
- **Stav:** ověřeno adversariálně, reprodukce, povýšeno z „likely“.
- **ID:** P310.

### Střední

- **ST1 — DISARM a kill switch nejdou poslat při „Neověřeno“** [S3] [S5]
  - Kde: `LiveCopyTradeOverview.tsx:1122, 2525, 3633`, `liveCopierIsland.ts:159–164`.
  - Oprava: samostatná akce „Vypnout (neověřeno)“ jen s DISARM a nikdy přes přepínač; kill switch podle transportu.
  - Stav: ověřeno (sníženo). ID: P132, P224, P234.
- **ST2 — Telefon zahodí stav; retenční přepínač není zapojený** [S3] [S4]
  - Kde: `TradovateLiveDesk.tsx:720–736`, nepoužité `CopierConnectionSwitch.tsx`, `useCopierPowerDisplay.ts`, `copierPowerDisplay.ts`. Na main je stále inline přepínač bez retence (2525).
  - Oprava: držet snapshot se stářím, zapojit komponentu, číst nejdřív známé připojení, tři stavy. Nikdy pro ARM.
  - Stav: ověřeno (P118, P235, P120, P128), P121 neověřeno; Codex.
- **ST3 — Brzdy čekají za dlouhým příkazem; ARM bez horní meze; opakovaný ARM vypne** [S5] [S1]
  - Kde: `localCopierExecutionAgent.ts:612, 663, 446, 460`, `recoverableCopierDelivery.ts:30–79`, `tradovateCopierCommandRelay.ts:421`.
  - Důkaz: 10 propadlých příkazů; 13. 9. ARM po hlášce UI.
  - Oprava:
    - okamžité odmítnutí ARM bez spojení,
    - přednostní linka pro DISARM, kill switch a zámek,
    - epocha ručního vypnutí, nahrazené ARMy,
    - deadline ze serveru, idempotentní ARM,
    - TTL neprodlužovat.
  - Stav: ověřeno (P130, P222, P253, P131, P223), neověřeno (P16, P26).
- **ST4 — Kontrola pozic přepíše novější stav, ARM nad otevřenou pozicí leadera** [peníze]
  - Kde: `copierRuntimeController.ts:8146–8160, 8255–8296, 8870–8883`.
  - Mechanismus: `reconcile()` běží mimo `eventTail` bez fence na události brokera.
  - Důkaz (P318): v reprodukci vstoupil leader během čtení a ARM prošel nad starým stavem. Follower skončil **−2 proti flat leaderovi, ARMED, `lastError=null`**. Na produkci nepozorováno, okno odpovídá délce čtení (~1 s).
  - Oprava:
    - zachytit `tradeBoundaryObservationVersion`; když se změní, výsledek nebrat jako čistý (ARM odmítnout, čtení zopakovat),
    - kontrola verze skupiny před zápisem (ne ve frontě, hrozí deadlock),
    - ARM odmítnout při rozpracovaném lifecycle,
    - test.
  - Stav: ověřeno (P249 úzké okno; P318 sníženo na střední). ID: P249, P318.
- **ST5 — SL vyplněný u jednoho followera během posunu vypne skupinu a zavře ostatní** [S1]
  - Důkaz (24. 9. 15:53:40, P330):
    - leader SL neutahoval, ale **odsunul** (30574,5 → 30584),
    - Stop followera 65333343 se vyplnil na staré úrovni a ostatní 4 zavřel auto-close,
    - leader držel ještě ~76 s a vystoupil ~24 bodů lépe.
  - Oprava: follower vyřadit do konce epizody, jen když broker potvrdí filled ochrannou nohu a sweep flat; ostatní nechat. Je to uvolnění fail-closed, potřebuje tvůj souhlas (balíček 10).
  - Stav: ověřeno (sníženo). ID: P13, P330.
- **ST6 — Samostatný SL: followeři 2,2–3,4 s bez SL; chyba odloženého SL zavřela 6 pozic** [S5] [S1]
  - Důkaz: 24. 9. 10:10:41.
  - Oprava:
    1. okno počítat od příchodu,
    2. REST mimo frontu,
    3. stav v UI.

    Ne 2,5s limit s fail-closed.
  - Tvoje rozhodnutí: „chyby odloženého SL bez auto-close“ je uvolnění ochrany. Follower bez SL by zůstal otevřený, jako dnes 34 s. Jen s tvým souhlasem, zápisem do PROJECT_LOG a pod podmínkou, že běží guard a push.
  - Stav: ověřeno. ID: P140.
- **ST7 — Spánek Macu hlášený jako výpadek brokera** [S1] [S3]
  - Oprava:
    - detekce spánku (nástěnné vs. monotónní hodiny) a příčina „host-sleep“,
    - napájení ve statusu, „Mac neodpovídá od…“, rozšířit push,
    - patří sem i heartbeat za frontou (Codex, P217, P19) a termín obměny (P218).
  - Stav: P11 a P215 ověřeno (sníženo), ostatní neověřeno.
- **ST8 — Vypnutí se nezaznamenávají; odmítnutí se loguje jako FAIL-CLOSED** [S1]
  - Doplněk:
    - loopback příkazy se nelogují a každé vypnutí je „manual“ (P341),
    - `npm run copier:mac -- reconcile` za ARM nastaví `armed=false` bez záznamu důvodu, přestože se tváří jako read-only (P321, podle kódu 8460).
  - Oprava: jeden helper, nové důvody, trvalá historie, audit.
  - Stav: neověřeno. ID: P17, P25, P115, P211, P341, P321.
- **ST9 — Přepínač followera zamčený 5 min po ARM a po incidentu, chybí Kontrola pozic** [S2] [S5] [S4]
  - Na produkci přepínač po ťuknutí vysvětlí, co ho blokuje. 5min zámek ale zůstává a UI nikde nenabízí Kontrolu pozic (reconcile).
  - Oprava: zrušit časovou blokaci, povolit vypínání, přidat tlačítko.
  - Stav: P23 ověřeno, P29 neověřeno.
- **ST10 — Denní P&L podle UTC → falešný DLL zámek (Po–Čt 0:00–2:00)** [S3]
  - Oprava: `tradovateDisplayTradeDate`, odvozování jen pro aktuální den, datum u výjimky. Výjimky nedělat jen upozorněním.
  - Stav: ověřeno. ID: P236, P129.
- **ST11 — DLL zbývá nadhodnocené po částečném výstupu; dva zdroje** [S3] [peníze]
  - Pro tebe: „DLL zbývá“ může ukázat 800 místo 100 USD (Codex 3). Po částečném výstupu ověř DLL v Tradovate.
  - Oprava: Daily i DLL počítat z jednoho ověřeného realizovaného vstupu z workeru; nespouštět plný refresh při každé změně.
  - Stav: ověřeno + Codex 3. ID: P123.
- **ST12 — DLL v telefonu: věčné „Načítám“, žádný retry, 429 → 1 h** [S3]
  - Chybějící DLL v kompaktním řádku je na produkčním webu opravené (6b63b45).
  - Stav: neověřeno; Codex 4. ID: P122, P124, P125, P126, P127, P240.
- **ST13 — Starý stav přepíše potvrzené vypnutí nebo přepnutí** [S4]
  - Oprava: přijímat jen novější `startedAt` a `controller.revision`.
  - Stav: neověřeno (jen podle kódu); Codex 7. ID: P135, P237.
- **ST14 — Návrat do okna zneplatní stav a zahodí čtení** [S3] [S4]
  - Stav: neověřeno, živě viděno. ID: P119.
- **ST15 — Desktop natrvalo na relay po restartu workeru** [S5]
  - Stav: neověřeno. ID: P229, P239.
- **ST16 — Relay pomalý kvůli regionu, 20s limity** [S5] [S3]
  - Stav: neověřeno, měřeno. ID: P133, P227, P230.
- **ST17 — „Jen zpřísnit“ jde obejít** [peníze]
  - Živý test: +1 follower prošel.
  - Doplněk (P339): pravidlo jde obejít i přepnutím na jinou uloženou skupinu s jinými followery nebo vyššími násobky (Switch & ARM, activate-group). Nepomůže ani baseline podle accountId.
  - Oprava: baseline session z prvního ARM, včetně množiny účtů, leadera a součtu násobků.
  - Stav: neověřeno. ID: P150, P117, P339.
- **ST18 — Skutečná divergence jednoho followera (ručně zavřený) zablokuje exit zdravým** [peníze]
  - Část „auto-liq propky“ je nově V16. ST18 zůstává jen pro skutečnou divergenci, kdy jsi followera ručně zavřel. Jde o politiku a rozhodnutí je na tobě.
  - Stav: neověřeno. ID: P151.
- **ST19 — ARM nevyžaduje ověřený risk** [S3] [S1]
  - Stav: neověřeno. ID: P152.
- **ST20 — Zlomkový násobek → falešná divergence** [S1]
  - Doplněk (P333):
    - UI dovoluje krok 0,25,
    - zaokrouhlení dolů po příkazech vs. oříznutí čisté pozice vede k falešné divergenci i při přikupování (1 + 1 → 0 + 0, očekáváno 1),
    - follower s nulovým množstvím nemá link a posun SL pak spustí unmapped guard.
  - Dočasně: ARM s necelým násobkem blokovat, editor s krokem 1.
  - Stav: neověřeno. ID: P15, P333.
- **ST21 — Osamělá OSO noha vypne skupinu** [S1]
  - Doplněk (P313): 25. 9. 12:48:06 (10:48:06 UTC) „oso-lone-leg“ za ARM, v auditu 4×.
  - Návrh: vstup bez druhé nohy nezkopírovat (blokovaný vstup + notifikace „zadej SL i TP společně“) a skupinu nechat ARMED. Skutečná nejednoznačnost dál vypíná.
  - Stav: neověřeno, rozhodnutí na tobě. ID: P18, P313.
- **ST22 — Riziko downgrade workeru a nedohledatelná verze**
  - Documents je 16 commitů za origin/main a jeho HEAD je 38365e3. Build z něj by neznal pole `enabled` (přepínač followera).
  - Instalátor vypisuje HEAD, nasazenou verzi nejde spolehlivě dohledat.
  - Dopoledne byla ověřena parita s 49a2cf9. Worker byl odpoledne restartován s třetím připojením, paritu je třeba ověřit znovu.
  - Stav: P244 ověřeno, P247 neověřeno.
- **ST23 — Uložení skupiny: cloud bez limitu, uložení jen do cloudu při neznámém stavu, neúplný seznam účtů** [S2]
  - Stav: neověřeno; Codex 8 a 9. ID: P113, P114.
- **ST24 — Vypnutý follower, který zmizí z OAuth, zablokuje start workeru**
  - Týká se jen skupiny, ve které je follower uložený jako vypnutý.
  - Kde: `liveCopyTrading.ts:511`, `pilot.ts:460`.
  - Stav: Codex.
- **ST25 — Zbytečný lookup před modify a zamrzlá souběžnost** [S5]
  - Doplněk (P334): lookup před každým modify stahuje globální `/command/list`, často i `/executionReport/list`, a čtení nesdílí. Prodlužuje okno závodu SL (ST5) a při 45s timeoutu vede k fail-closed; 22. 9. 10:32 auto-close 6 pozic.
  - Oprava:
    - cap lookup vynechat jen při `maxContracts == null` (P142),
    - kontrolu množství v runneru ponechat a zlevnit přes `/…/deps`.
  - Stav: neověřeno, měřeno. ID: P142, P143, P334.
- **ST26 — Modify skončí jako filled v souladu s leaderem → DISARM a kopírka zůstane vypnutá** [S1]
  - Kde: `copierCancelOutbox.ts:107–115`, `copierRunner.ts:1686–1703`, `copierRuntimeController.ts:106–113, 3595–3644, 2911–2965`. Test 3212–3251 toto chování fixuje.
  - Důkaz:
    - 55 záznamů v 6 dnech (13 epizod),
    - z 10 reconciliací po terminálním fillu jen 6 „recovered“,
    - 25. 9. 13:14:14 exit všech 4 followerů konzistentní a reconciliation čistá, přesto vypnuto do 13:19:56,
    - protipříklad 24. 9. (ST5) je skutečná divergence.
  - Oprava: úzká, autoritativně ověřená větev (follower filled ≤ očekávané a leaderův příkaz autoritativně filled). Závod v časování z 25. 9. návrh nepokryje, potřebuje zpřesnit. Je to uvolnění fail-closed → tvoje rozhodnutí.
  - Stav: ověřeno (sníženo z vysoké). ID: P323.
- **ST27 — Nativní OSO: venue po částečném fillu zvedne množství nohy → „cizí navýšení“ → fail-closed** [S1]
  - Kde: `copierRunner.ts:548–555, 1604–1618`, `copierEngine.ts:489–500`. Výjimka `venueManagedCoverage` je jen ve stream cestě controlleru (7188–7252).
  - Důkaz: 21. 9. 9:26 (7:26 UTC): 15 > 13 u 3 účtů, druhá polovina „modifyOrder rejected: Unsupported“, auto-close 6 pozic.
  - Dnes:
    - target varianta končí v management-only (42749e4),
    - **stop varianta (posun SL během částečného fillu) pořád vede k plnému fail-closed a auto-close**,
    - příčina: `link.quantity` zaostává za venue oběma směry.
  - Stav: ověřeno (sníženo). ID: P325.
- **ST28 — Falešný „unmapped-leader-replace“: posun SL po sideline nebo u followera s nulovým množstvím; posun záměrně nezkopírovaného příkazu** [S1]
  - Kde: `copierRunner.ts:1339–1370` (all-or-none), `copierRuntimeController.ts:6642–6650, 8001–8020`.
  - Důkaz: reprodukce P332 (auto-close zdravého followera a přepsaný `lastError`). Reálné Lucid rejecty byly async, tam se guard nespustí.
  - P319 (neověřeno): posun blokovaného vstupu během pauzy nebo mimo okno vypne kopírku. Latentní, pravidla jsou vypnutá.
  - Oprava: ze „očekávaných“ vyřadit doložené záměrné nezkopírování (suppression allowedNet 0 a flat, nulové množství, blokovaný vstup). Ostatní dál fail-closed.
  - Stav: P332 ověřeno (střední), P319 neověřeno.
- **ST29 — Leader-flat guard bez fence, opakování a deadlinu** [S1]
  - Kde: `copierRuntimeController.ts:5169–5186, 5268–5278, 2208–2212`, `copierLeaderFlatGuard.ts`.
  - Scénář:
    - nový vstup leadera během čtení nebo jedna chyba čtení vede k DISARM,
    - visící REST (45 s) drží frontu,
    - hláška tvrdí „leader je flat, kopie zůstala otevřená“, i když leader flat není nebo čtení selhalo,
    - cache ze snapshotu vyřadí nový vstup z denního počítadla.
  - Důkaz: reprodukce A i B; v logu zatím ne.
  - Oprava: fence verzí → jen přeplánovat; omezené opakování čtení; deadline.
  - Stav: ověřeno (sníženo). ID: P33.
- **ST30 — Po známém a vyřešeném vypnutí UI ukazuje „neznámý důvod / výsledek kopií nepotvrzen“** [S1] [S4]
  - Kde: `lib/copierDisarmReason.ts:159–203` (chybí vzory „nevysvětlená divergence“ a „prop limitu“), `copierRuntimeController.ts:5279–5282, 5228–5242` (výsledek se aktualizuje jen pro dva kódy).
  - Důkaz: živě 16:13:59 i 16:36:42 „unknown/unknown“ (červený panel), přestože guard potvrdil flat.
  - P315 (neověřeno): kontrola divergence za DISARMED přepíše `lastError` falešnou příčinou (21. 9., 22. 9., 25. 9.).
  - Oprava: výsledek vázat na epizodu, nové kódy, za DISARMED jen audit.
  - Stav: P36 ověřeno, P315 neověřeno.
- **ST31 — Exit-only fill po události Position se započte dvakrát** [peníze]
  - Cache followera je pak špatně a další redukce je poddimenzovaná, nebo vznikne falešný fail-closed.
  - Nastává jen s let-run cutem nebo suppression.
  - Kde: `copierRuntimeController.ts:7042, 6870`.
  - Stav: neověřeno. ID: P314.
- **ST32 — Selhání zápisu store po write-ahead rozsynchronizuje procesor až do restartu**
  - Každý další zápis včetně Flatten a ARM skončí konfliktem.
  - Kde: `copierRunner.ts:2371–2375`.
  - V logu 0×, latentní.
  - Stav: neověřeno. ID: P326.
- **ST33 — Lokální agent věří vývojovým originům** [bezpečnost]
  - Allowlist `localhost:3000`, `127.0.0.1:3000` a `127.0.0.1:3011` platí i v běžícím bundlu.
  - Z těchto originů agent přijme plnou sadu příkazů, širší než relay: arm-live s cizí skupinou až 100×, flatten-group, resolve-stuck-operation, reconcile, device-paired.
  - Dev server z worktree jiné AI session tak může poslat ARM nebo Flatten ostrému workeru.
  - Kde: `localCopierExecutionAgent.ts:26–31, 400–611`.
  - Stav: neověřeno. ID: P336.
- **ST34 — `pilot-lease` vydá Tradovate access token komukoli se Supabase session** [bezpečnost]
  - Token je zapečetěný na klíč volajícího a obchází DISARM, kill switch i DLL.
  - Worker používá jen Device auth. JWT větev je legacy tlačítko.
  - Kde: `api/tradovate/oauth/pilot-lease.ts:31–81`.
  - Stav: neověřeno. ID: P337.
- **ST35 — Relay směruje na naposledy použité zařízení; párování přepíše secret a zruší revokaci** [bezpečnost] [peníze]
  - Druhé nebo testovací zařízení převezme DISARM nebo Flatten a vrátí „hotovo“. Telefon ukáže VYPNUTO, skutečný worker zůstane ARMED.
  - Párování přes `#copier-pair=` není svázané s lokálním workerem a dialog zamlčí vydání tokenu (P342). Souvisí s P232.
  - Kde: `tradovateCopierCommandRelay.ts:386–397, 575–580`, `tradovateCopierDevice.ts:66–88`, `TradovateLiveDesk.tsx:764–796`.
  - Stav: neověřeno. ID: P338, P342.

### Nízké

- Starší localhost UI: druhé přepnutí během prvního selže (P238, P245).
  - Na produkčním webu je to opravené frontou přepínačů (6b63b45).
  - Nativní iOS appka má vlastní zabalený web (bundle v repu z 20. 9. bez přepínače followera), tam oprava není.
- Prahy 8 s a 10 s rozhazují pozice na telefonu (P241).
- Long-poll 2,2 s, visící poll 20 s, zátěž pollu 750 ms s fsync (P136, P137, P233).
- ARM čeká na risk poll, hypotéza (P27).
- Přepnutí followera za ARM drží frontu až ~5 s (P138, P28; viz P37).
- „Outcome unknown“ po restartu i u známého výsledku (P231).
- Log „EXECUTED“ i u odmítnutých příkazů, bez podtypu (P139, P248).
- OSO okno 1 500 ms není kalibrované (P144).
- Chybí metriky latence (P145).
- Souběh ve `verifyAccountEligibility` (P210).
- Usage metr bez journal backfillu (P221).
- Cancel/modify bez potvrzení při pádu socketu (P220).
- Hlášky s kódy a ID místo jmen (P116).
- UI precheck ARM ignoruje vypnuté followery (Codex 11): částečně řešeno. Produkce před ARM s vypnutými followery žádá potvrzení (main 1213). Zobrazený násobek ověřit.
- Za DISARMED zavádějící „leader-replace-unmapped … chybí link pro všechny“ (174 řádků auditu) a zbytečné zneplatnění reconciliation (P327, P335).
- Replace-guard v runneru nekontroluje `enabled` přímo, jen přes `ineligibleAccounts` (P328).
- OSO cesta vynechá vypnutého followera bez auditu (P329).
- `verifyFollowerMagnitude` izoluje breach i za DISARMED (vedlejší zjištění P39).
- Cooldown: text „blokuje nový vstup … ne zámek“ je zavádějící a panel zmizí 10 s po konci (zbytek P317).
- Tooltip přepínače neříká, že vypnutý follower musí za ARM zůstat flat (zbytek P34).
- Info: nonce lokálního agenta se přes výsledek příkazu ukládá do Supabase (P343).
- Info: nepodepsané příkazy, nerevokovaná zařízení 816ffbe6 a c8b90c47 (P232).
- Info: chybějící testy (P212). Chybí i testy dispatch/divergence cesty s čekajícím vstupem, souběhu reconcile s událostí a posunu blokovaného vstupu (P322).
- Živé testy UI (pozorováno na starším UI z Documents, na produkci ověřit):
  - text dialogu Flatten o „DEMO runtime“ (na produkci platí dál, main 6176),
  - skrytá čekající kontrola pozic po Flattenu,
  - tabulka přetéká při 1440 px,
  - lepkavá hlavička překrývá tabulku,
  - Flatten All vedle ARM na 375 px (produkce už potvrzuje Flatten All spodním listem s výčtem),
  - modal „Ranní příprava“ při načtení,
  - červený banner na localhost,
  - kompaktní karta bez DLL a přepínačů followerů (na produkci vyřešeno).

### Vyvrácené a zpřesněné (nezaměňovat)

**Vyvráceno:**
- **P34** „Ruční pozice na vypnutém followerovi vyvolá DISARM při každém exitu leadera“:
  - vypnutí je záměr (specifikace přepínače, kritérium 10),
  - nemůže se opakovat, protože ARM zůstane blokovaný, dokud pozice existuje,
  - zbývá UX (tooltip, srozumitelná hláška),
  - neplést s V9 (P24, P149, P30), to platí: vadou je auto-close, ne DISARM.
- **P317** „Entry cooldown tiše vypne kopírku bez důvodu“:
  - jde o zdokumentované anti-revenge rozhodnutí s testem,
  - důvod je vidět v panelu, v push notifikaci i v chybě ARM,
  - zbývají texty; cooldown je teď 0.

**Vyvrácené části potvrzených nálezů:**
- P30: „dnes v 16:04:58 proběhl auto-close“. Nic se nezavřelo, štítek je zavádějící.
- P39: doklad 17. 9. 8:40:08 je chybný. Skupina už byla vypnutá a blokace jmenovala všech 11 účtů.
- P31: „dnešní ARM by vypršel v 16:47“. TTL běží od posledního ARM, dnes vyhrál konec session.
- P36: tvrzení o textu na ř. 6120 neplatí.
- P311: „cancel lokálně známých nohou“ je v rozporu s rozhodnutím z 26. 8. (429).
- P316: navržená oprava je nebezpečná (test 1119).
- P323: reconciliation potvrdí čistý stav jen asi v polovině případů.
- P325: 21. 9. šlo o target modify, primárně „Unsupported“.
- P330: nešlo o trailing, SL se odsouval.
- P332: reálné rejecty byly async.
- P35: větev je mrtvá od 23. 8. a mezera při obměně existuje.

---

## 5. Doporučený plán oprav

UI dělá Claude, worker Codex (dělba práce z 25. 9.).

Reinstall workeru jen z čistého stavu: vypnuto, flat, reconciled, bez `lastError`. O víkendu automaticky, v obchodní dny na „nasaď“. iOS appka má web uvnitř, takže UI změny potřebují nový iOS build.

**Pořadí provedení:** 3 → **0 → 4A → 4B** → 5B → 5 → 6 → 9 → 7 → 11. UI balíčky 1, 2 a 8 souběžně (Claude). Rozhodnutí z balíčku 10 hned.

Přednost mají věci, kde follower zůstane bez SL (0, 4A) nebo kde auto-close zavře ruční či cizí pozici (4B). Oba dnešní incidenty (16:04:58 a 16:13:59) řeší balíček 0.

**Naivní opravy, které Codex nesmí použít** (oslabily by bezpečnostní model):
- P316 „čekající kopie smí jen vysvětlit“ (rozbije test 1119),
- P32 „validovat cut jen proti statickému DLL“ (ztratí ochranu trailing floor),
- P311 slepý cancel lokálně známých nohou (429 a hodinový breaker blokující i Flatten),
- P35 „router jen propustí `resynced`“ (DISARM každých 50 min),
- P31 „zrušit 8h strop“ (ARM po 17:00 CT by dostal ~24 h),
- P30 „auto-close jen podle lineage a bez eligibility“,
- P331 filtr unknown/sending podle epochy nebo mazání outboxu.

0. **NOVÝ — Oprava dnešních incidentů** (V12, V13, worker část ST30)
   - Obsah:
     - V12 podle ověřeného prototypu v `currentRuntimePendingNet`,
     - V13: kandidáty filtrovat ze streamu, číst mimo frontu s rozpočtem 6–8 s, bez slepého cancelu,
     - ST30: kódy „nevysvětlená divergence“ a „prop limit“, výsledek kopií vázaný na epizodu.
   - Regresní testy přesně podle sledů z 28. 9. (16:04:58 a 16:13:59), test 1119 beze změny.
   - Každá změna jen zpřesňuje klasifikaci nebo opakuje čtení. Skutečná divergence zůstává fail-closed.
   - Riziko: vysoké (jádro rozhodování), nutné testy a DEMO. Nasadit po „nasaď“ z čistého stavu.
   - Codex: celé, zápis do PROJECT_LOG.
1. **UI: stav v telefonu a vypnutí vždy po ruce** (ST1, ST2, ST13, ST14, ST15, P241)
   - Riziko: nízké až střední. Retence nesmí povolit ARM, vypnutí nesmí vést přes přepínač.
   - Codex: revize cesty DISARM.
2. **UI: editor, varování a hlášky**
   - Obsah:
     - UI část V1 a V2, P116, tlačítko Kontrola pozic, ST23,
     - varování o vypnutí kopírky v desktopovém dialogu násobku a v editoru (sjednotit s mobilem),
     - skutečný čas expirace ARM místo „V 00:00“ a varování T−15 min (UI část V14),
     - editor násobků s krokem 1 (dočasně, ST20),
     - tooltip vypnutého followera (P34),
     - texty cooldownu (P317),
     - UI část ST30.
   - Riziko: nízké.
   - Codex: texty hlášek workeru.
3. **Příprava nasazení** (ST22, P248)
   - Obsah: sha buildu, ochrana proti starší verzi, `schemaVersion`, srovnání Documents, nové ověření parity po odpoledním restartu.
   - Riziko: nízké. Předpoklad každého reinstallu.
4. Worker:
   - **4A. Follower nesmí zůstat bez SL ani bez exitu** (V16, V17, V18, V5, V8 bod 3, ST28, ST31)
     - Pořadí: V16 → V17 + V18 (sdílí úklid epizody) → V5 → V8 → ST28 → ST31.
     - Každá změna jen zpřesňuje klasifikaci. Skutečná divergence zůstává fail-closed a nic se neopravuje obchodem.
     - Riziko: vysoké. Regresní testy mají základ ve scratchpadu (p310, p331, p39). Nutné DEMO.
     - Codex: celé, zápis do PROJECT_LOG.
   - **4B. Auto-close jen na vlastní kopie a dozor** (V9 včetně P30, V4, V10, ST4 včetně P318, ST32)
     - Obsah:
       - auto-close bez vypnutých followerů (eligibility a cut ponechat),
       - recovery „synchronní → držet“ jen z participujících,
       - sweep bez copier nohy bez volání brokera,
       - štítek „auto-closed“ jen po skutečné akci,
       - přeplánování guardu (V4), deadline (V10),
       - fence reconcile (ST4),
       - rozsynchronizovaný store (ST32).
     - Riziko: vysoké, testy + DEMO. Codex.
5. **Worker: úpravy bez zbytečných vypnutí** (V1 včetně P340 a P341, V3 včetně P37 a P320, ST8, ST9, idempotentní ARM)
   - Riziko: střední, nutné přepsat testy.
   - Codex: dry-run routingu, keepalive.
   - **5B. NOVÝ — Falešná bezpečnostní zastavení** (V15, ST29, ST26, ST27, ST21, ST20; V14 po rozhodnutí)
     - Pořadí: V15 (boot nesmí padat) → ST29 → zbytek.
     - Opakovat se smí jen čtení (s rozpočtem a fencingem). Zápisy dál bez blind retry.
     - Riziko: střední až vysoké. Codex.
6. **Worker/broker: obměna, ztracené události, spánek** (V6 včetně P35 a P312, V7, ST7, ST24, `shutdown`, brána obměny v `pilot.ts`)
   - Riziko: vysoké. Codex, rozhodnutí do PROJECT_LOG.
7. **Relay: přednost brzd a rychlost** (ST3, ST16, předkontrola tighten-only pro set-multiplier z P340)
   - Riziko: střední, migrace DB, region nejdřív změřit. Codex.
8. **UI: DLL a denní P&L** (ST10, ST11, ST12)
   - Riziko: nízké. Výjimky při ARM nechat jako brány.
   - Codex: pole data u výjimky.
9. **Rychlost kopírování** (V11, ST25 včetně P142 a P334, ST6 body 1–2, metriky)
   - Riziko: střední. Codex.
10. **Tvoje rozhodnutí** (hned)
    - V9: ruční obchody na followerech zakázat, nebo izolovat.
    - ST5 (včetně P330), ST18 (jen ruční zavření), ST21, ST17 (včetně P339), ST19, politika mezi firmami.
    - V14: měkká 8h expirace (bez nových vstupů, DISARM po flat), nebo jiný strop.
    - ST26: modify → filled v souladu s leaderem nechat vypínat, nebo nevypínat.
    - ST20: necelé násobky zakázat, nebo implementovat cílovou pozici.
    - ST6 bod 3: chyby odloženého SL bez auto-close, jen pokud běží guard a push.
    - Každé uvolnění fail-closed potřebuje tvůj souhlas a zápis do PROJECT_LOG.
11. **NOVÝ — Bezpečnost párování a lokálního agenta** (ST33, ST34, ST35, P343)
    - Obsah:
      - allowlist originů z instalace (dev jen pro status a příkazy snižující riziko),
      - vypnout JWT větev `pilot-lease`,
      - směrování relay na ověřené zařízení,
      - párování bez přepsání secretu a s notifikací,
      - revokace nepoužívaných zařízení,
      - nonce z výsledků příkazů pryč.
    - Riziko: nízké až střední. Pro S1 neurgentní, před komerčním použitím nutné. Codex.

---

## 6. Provozní doporučení hned

**Nejdůležitější**

1. **Při zapnuté kopírce neobchoduj ručně na followerech, ani na vypnutých.**
   - Auto-close při bezpečnostním vypnutí, expiraci ARM nebo reconnectu zavírá **celý účet**: všechny symboly, a ruší i tvé pracovní příkazy. Týká se i ručně vypnutých followerů (V9).
   - V reprodukci to nastalo i při vypnuté kopírce. Ruční obchod na jednom followerovi, který v pomalé chvíli skončí flat, může zavřít ruční pozice na ostatních followerech.
   - Ruční obchody dělej jen na účtu, který **není v aktivní skupině**. Účet odeber ze skupiny ve vypnutém a flat stavu. Vypnutý přepínač followera ani vypnutá kopírka nestačí.
   - Vypnutý follower, který zmizí z OAuth, zablokuje start workeru (ST24). Týká se jen skupiny, kde je uložený jako vypnutý.
2. **Když se kopírka vypne uprostřed obchodu (z jakéhokoli důvodu), hned v Tradovate zkontroluj SL u každého followera.**
   - Dnes v 16:13:59 zůstali 4 followeři × 8 MNQ ~34 s bez SL (V12).
   - Když SL chybí, followera zavři (Flatten účtu) nebo mu SL zadej ručně.
   - Znovu zapni až ve flat stavu, ARM to jinak ani nedovolí.
   - Důvod v UI může být „neznámý“ (ST30).
3. **ARM platí nejvýš 8 h od posledního zapnutí.**
   - Kontroluj „ARM do HH:MM“ u přepínače. Text „V 00:00 (17:00 Chicago)“ v pravidlech dne platí, jen když jsi zapnul po 16:00.
   - Ranní zapnutí vyprší uprostřed NY seance (např. 8:47 → 16:47). Zapínej až před seancí, nebo kopírku před otevřením NY ve flat stavu vypni a znovu zapni.
   - Uprostřed obchodu prodloužit nejde. Při expiraci se followeři zavřou a leader zůstane otevřený (V14).
4. **Čekající limitní příkazy — dokud nebude opraven V12:**
   - Nezadávej dopředu limitní příkaz z flat (např. Sell Limit jako budoucí TP) a pak nevstupuj jiným příkazem.
   - Když už zkopírovaný čekající limitní vstup nebo přikupovací limit leží a jsi v pozici, nejdřív ho zruš a teprve pak zadej SL nebo vystup. Jinak se SL nezkopíruje a kopírka se vypne (dnes v 16:13).
   - SL a TP zadávej až po vstupu. Pokud je dáváš rovnou se vstupem jako OSO bracket, zadej **oba najednou**. OSO vstup jen s jednou nohou a druhá doplněná po víc než 1,5 s vypne skupinu (ST21).

**Mac a provoz**

5. **Mac při zapnuté kopírce na nabíječce a s otevřeným víkem.**
   - Zavřené víko na baterii vždy vedlo k výpadku. Na síti 4/4 bez výpadku, ale 5 ze 17 clamshell spánků proběhlo i na síti.
   - 21.–25. 9. Mac spal během americké seance (15:30–22:00): 238 / 24 / 153 / 26 / 51 min.
   - Dnes v 10:16:58 usnul na 1 % baterie.
   - `pmset disablesleep` jen jako tvoje rozhodnutí kvůli teplu.
6. **Automatické aktualizace macOS:** vypni automatickou instalaci a restart a aktualizuj ručně o víkendu. Úplné vypnutí aktualizací by oslabilo zabezpečení Macu, na kterém leží tokeny. Pokud jde, použij Ethernet.
7. **Za ARM neupravuj skupinu, násobek, pravidla ani šablony**, hlavně ne v obchodě. Upravuj ve vypnutém a flat stavu, pak zapni.
8. **Při „stav se změnil“ uložení zopakuj** po pár sekundách ve vypnutém stavu. Je to bezpečné.
9. **Po zavření obchodu leadera nevypínej kopírku hned.**
   - Počkej, až UI nebo Tradovate ukáže followery flat (5–10 s).
   - Dozor followerů startuje 2 s po flatu leadera a pak čte REST bez deadlinu. Dnes followery zavřel až po 5–6,4 s.
   - Vypnutí během jeho čtení dozor zruší a ve vypnutém stavu už nedoběhne (V4).
   - Pokud byla kopírka během obchodu vypnutá, followery zkontroluj vždy.
10. **Kill switch vypíná i auto-close** a SL se pod ním může zrušit (V5). Na zavření followerů použij Flatten All a pak followery zkontroluj v Tradovate.
11. **„Neověřeno“ v telefonu většinou znamená spící Mac.** Vypnout z telefonu v tu chvíli nejde. Nezávislý kanál je Tradovate appka.
    - Pokud v telefonu používáš nativní appku, má vlastní zabalený web (bundle v repu z 20. 9.) bez novějších oprav, včetně přepínače followera.
    - Ověř, jestli používáš Safari/PWA, nebo nativní appku.
12. **Po „Zapnutí není potvrzené“ neklikej ARM znovu.** Pozdní ARM může ještě doběhnout.
13. **Nereinstaluj z Documents**, dokud nebude srovnaný na origin/main. Worker byl odpoledne restartován, paritu s repem je potřeba ověřit znovu (ST22).
14. **Kontrolu pozic spouštěj zatím jen příkazem** `npm run copier:mac -- reconcile`, **jen při vypnuté kopírce** a přes Claude nebo Codex.
    - Není čistě read-only: podle kódu kopírku vždy vypne bez záznamu důvodu (P321).
    - Může zrušit osiřelé ochranné nohy kopírky nad flat followerem. Když to selže, následuje bezpečnostní zastavení s auto-close.

**Nastavení skupiny a účty**

15. **Jen celé násobky** (1, 2, 3…), ne 0,25, 0,5 ani 1,5 (ST20).
16. **Denní cut followerů v záložce Risk zatím nenastavuj** (V15). Při ztrátě by kopírka vypnula celou skupinu dřív, než cut vystřelí, a po restartu by worker nenaběhl.
17. **Pauzy z pravidel dne a obchodní okno nech zatím vypnuté** (dnes vypnuté jsou). Po zablokovaném vstupu by další exit kopírku vypnul a nepřišel by nikomu (V18, ST28).
18. **Velikost followerů drž pod limitem pozice propky.** Odmítnutý vstup po prvním obchodu dne vypne skupinu. Ostatní followery pak buď zavře, nebo nechá v obchodě bez správy (V17).
19. **FundedNext:**
    - Dopoledne FN ve workeru chybělo, odpoledne bylo přidáno. Skupina „odpolko“ s pěti FN účty pak kopírovala přes 7cce8c5b.
    - Jak se připojení do workeru vrátilo, ať Claude nebo Codex zapíše do PROJECT_LOG.
    - Nové účty přidávej jen ve vypnutém a flat stavu a jen tehdy, když je jejich připojení ve workeru. Editor to zatím nerozliší (V2).
20. **Zkontroluj FN účty přímo ve FundedNext nebo Tradovate.**
    - Podle statusu workeru měly odpoledne dnešní realizovanou ztrátu −1 257 až −1 381 USD na účet.
    - Rezerva k prahu, který worker bere jako likvidační (hotovost − minNetLiq), byla nejdřív 118,8–242,8 USD, později 413 / −22 / −48 / −58 / −58 USD (netLiq null).
    - Ověř stav účtů (trailing drawdown, liquidation-only), než je znovu zapneš do kopírky.
21. **Po částečném výstupu ověř DLL v Tradovate.** „DLL zbývá“ v appce může být nadhodnocené, v příkladu 800 místo 100 USD (ST11).

**Pravidla a čas**

22. **Pravidla prop firem ověř písemně.**
    - Podle rešerše smlouva Tradeify (§6.6–6.7) povoluje zrcadlení jen mezi vlastními Tradeify účty. Týká se to skupiny s leaderem u Lucid a followery u Tradeify.
    - V repu je to jen otevřený bod „policy-blocked“ v PROJECT_LOG, kód takovou skupinu neblokuje.
    - Skupina „odpolko“ je čistě FN. FundedNext kopírování mezi účty na stejné jméno podle rešerše povoluje, i napříč firmami.
    - Je to rešerše, ne právní posouzení.
23. **Konec obchodování a posun času:**
    - FundedNext končí v 15:10 CT = 22:10 Praha a pozice zavírá sám.
    - Tradeify a Lucid končí v 16:45 ET = 22:45 Praha.
    - **25. 10.–1. 11. 2026** je rozdíl jen 5 h: FN 21:10, Tradeify/Lucid 21:45.
    - Zkontroluj obchodní okno, pokud ho zapneš. UI ho zadává jen v pražském čase.

---

## 7. Nové funkce

Nestavět: automatické opravné obchody, opakované odesílání odmítnutých příkazů, stealth ani náhodné zpoždění.

| # | Funkce | Přínos | Náročnost | Zdroj | Stav v repu |
|---|---|---|---|---|---|
| 1 | Hlídání opačných pozic napříč účty a firmami (blokace před obchodem, alarm po něm, bez obchodu) | hedging = ztráta účtů | L | prop firmy, konkurence | `preventHedging` jen v konfiguraci a UI |
| 2 | Read-only invarianty: stop kryje pozici, flat bez příkazů, followeři ne proti sobě | chytí typ V4–V7 a V12 | M | rešerše spolehlivosti, FIA 2024 | `positionReconciler` nepoužit |
| 3 | Detekce spánku a kontrola zdraví před ARM + push | 15 % konců ARM | S | rešerše spolehlivosti, ST7 | watchdog už posílá push při worker-offline, fail-closed, divergenci, auto-close a konci ARM (`server/copierIncidentWatchdog.ts`); chybí detekce spánku a kontrola před ARM |
| 4 | Latence kopií v UI | regrese hned vidět | S | TradeDupe, QuantCrawler | stáří dat UI už značí (`lib/liveReadFreshness.ts`); chybí latence kopií |
| 5 | Push při selhání jednotlivé kopie | tichý skip SL (V8) | S | SyncFutures, BackTrader | push při fail-closed a auto-close existuje; chybí push při tiché ztrátě jedné kopie |
| 6 | Konec obchodování podle firmy v čase burzy | Apex: držení přes close zakázáno; posun času | S–M | prop firmy, CrossTrade | okno už má pole `timeZone` (`services/liveCopyTrading.ts:54`), UI nabízí jen Prahu |
| 7 | Kontrola pravidel mezi firmami při ARM | smlouva Tradeify | S | prop firmy, PROPSHIELD review | nic |
| 8 | Vzdálenost k drawdownu a „vejde se riziko obchodu“ | porušení DD je trvalé | M | TradeCopia, prop firmy | „Rezerva DD“ už je (sloupec, mobilní řádek, ostrůvek); chybí „vejde se riziko“ |
| 9 | Kalendář zpráv | LucidDaily, Topstep | M | prop firmy | nic |
| 10 | Upozornění na neaktivitu followerů | Tradeify ≥ 1 obchod týdně; FN 30 dní | S | prop firmy | nic |
| 11 | Dead-man ping watchdogu | tichý pád cronu | S | rešerše spolehlivosti | nic |
| 12 | Logovat `shutdown` a reasonCode | rozliší limit, údržbu, síť | S | rešerše spolehlivosti | nic |
| 13 | Časová pauza followera | bezpečnější ruční obchody, až po opravě V9 | S–M | QuantCrawler | ruční vypnutí přepínačem existuje; chybí časovač |

Take Profit Trader povoluje jen vyjmenované copiery. Týká se tě to jen s účty TPT.

---

## 8. Co review nepokrylo a omezení důkazů

**Nově pokryto 3. vlnou:**
- Controller 4900–8600:
  - risk poll a cuty,
  - leader-flat guard,
  - auto-close, connection recovery, expirace ARM,
  - klasifikace a dispatch,
  - čekající expozice a exit-only,
  - `handleBrokerEvent`, reconciliation, `reconfigureLeaderEpoch`.
- `copierRunner` celý (staged lifecycle, bracket a OSO pár, serial processor).
- Engine, outboxy, korelátory, `copierOsoModifyCascade`, `copierLeaderFlatGuard`, `copierLeaderEventSource`.
- Bezpečnost relay a párování: lokální agent (Origin, nonce, CORS a PNA, běžící bundle), relay whitelist a idempotence, doručení v2 po restartu, `pilot-lease`, companion, RLS a granty z migrací, grep tokenů ve stdout.
- **Ověřeno v pořádku:**
  - CSRF z cizí stránky je blokovaný (Origin, vynucený preflight), DNS rebinding neprojde,
  - tabulky příkazů, runtime a zařízení mají REVOKE ALL pro anon i authenticated, claim RPC jen pro service_role,
  - doručení v2 brání přehrání příkazu po restartu,
  - relay whitelist platí při zařazení i převzetí,
  - ve stdout logu žádný vzor tokenu,
  - stavový adresář má práva 0700, soubory 0600.

**Zbývá:**
- **Controller 1–2300:** bootstrap, obnova ze snapshotu, gate, session roll, plánování risk pollu. Nepokryto, jen volané helpery.
- **Controller 2300–4900:** jen části volané z nálezů (`failClosed`, `scheduleAutoClose`, sweep, `verifyPendingFollowerTransition`, izolace a sideline, cut akce).
- **Controller 8600–9700** (arm, updateGroup, reconfigureGroup, setFollowerEnabled, status) jen částečně.
- Dispatch za ~7760 (OSO entry a timery, session limit, notifikace) jen okrajově. Vnitřek korelátorů, `recoverOutbox` (1989–2340) a `processOsoPair` jen částečně.
- **Manual actions a stores:** `copierManualActions` mimo cestu auto-close, `copierStore` a `fileCopierStore` (CAS, fsync, schéma snapshotu). Jen P326.
- **UI editor a karty podrobně:** dialogy, štítek „jen zpřísnit“, přepínače, záložka Risk, šablony. Nepokryto.
- **Testy:**
  - plná sada neběžela,
  - 1.–2. vlna spustila jen cílené soubory (125 + 18 + 169 testů). Všechny prošly, přestože nalezené chyby existují,
  - 3. vlna testy nespouštěla,
  - ověřovatelé spustili ve scratch kopii jen cílené sady: controller 113/113 a 143 copier testů na prototypu opravy V12, guard 21/21, router 18/18, cooldown 3/3, expirace ARM 4/4,
  - chybí testy sledu 28. 9., souběhu reconcile s událostí a posunu blokovaného vstupu (P322).
- **Pravidla a čas:** pauzy, day-lock, cooldown, obchodní okno, session roll, DST (25. 10.–1. 11.), TTL ARM. Jen v rozsahu V14, V18, ST28 a P317.
- **Restart a persistence:** accountRisk ze snapshotu bez filtru session (V15), outbox se nikdy nečistí (V17), selhání store (ST32), `recoverOutbox` při startu bez sítě. Jen částečně.
- **Sémantika Tradovate na venue neověřena:**
  - množství OSO nohou po částečném fillu (ST27),
  - pořadí Position/Fill (ST31),
  - modify nad filled příkazem,
  - latence `/command/list`: dnes 4,8 s, příčina (rate limit, penalizace, souběžné risk polly) nedohledána,
  - 429 breaker,
  - monotonie `sourceVersion` při reconnectu (hypotéza runneru).
- **Neobjasněno:**
  - příčina třetího vypnutí 16:36:42 (14:36:42 UTC) a zda followeři vystoupili za stejnou cenu jako leader,
  - běhy ARM 45 s a 300 s.
- **Mimo kód:**
  - stderr (79 MB) a úplný journal 3. vlna nečetla. Ověřovatelé četli jen cíleně journal 7cce8c5b a 754e4b5b. Únik tokenů v nich je neověřený.
  - stav zařízení v Supabase a produkční RLS známe jen z migrací,
  - Vercel logy nečteny,
  - verze UI v telefonu: lokální Capacitor bundle v repu je z 20. 9. a přepínač followera (`set-follower-enabled`) nemá. Co je nainstalované na iPhonu, neověřeno.

**Omezení důkazů:**
- Nic se neověřovalo na iPhonu, časy na telefonu jsou odhad.
- S1 pokrývá jen zapnutí přes relay, desktop se neloguje. `disarmHistory` je krátká a restartem se ztrácí.
- Data pmset jsou až od 21. 9.
- Reprodukce běžely proti mocku nebo wire harnessu, ne na DEMO. Část ST4 byla artefakt mocku.
- Reprodukce 3. vlny běžely proti mock brokeru ve scratchpadu. Prototyp opravy V12 existuje jen ve scratch kopii, repo je beze změny.
- 3. vlna běžela při ARMED workeru v šetrném režimu: 1× `/v1/status`, grep/tail logů, žádné testy proti workeru ani brokeru.
- Souběhy v UI nejsou vizuálně reprodukované.
- Čísla se mezi reviewery mírně liší podle okna.
- Nálezy „neověřeno“ neprošly pokusem o vyvrácení.
- Parita workeru s repem byla ověřena dopoledne (49a2cf9). Worker byl odpoledne restartován s třetím připojením, paritu je třeba ověřit znovu. iOS binárka neověřena.
- Živé testy UI běžely na starší verzi z Documents. Novější LiveCopyTradeOverview na main je porovnaný jen čtením kódu.
- Dopad změny regionu a příčina 20s timeoutů nejsou změřené.
- Stav workeru: 1.–2. vlna měřila dopoledne, 3. vlna odpoledne do ~16:40 (ARMED, skupina „odpolko“, FN účty).

---

## 9. Doplněk — večer 28. 9. (po uzavření review)

Zdroj: Filipův souhrn a Codexovy zápisy v `docs/PROJECT_LOG.md` z 28. 9. Claude ověřil jen stav workeru (21:03) a otisk bundlu. Forenzně jsme nové události neprocházeli.

**Časová osa (Praha):**

| Čas | Co se stalo | Stav důkazu |
|---|---|---|
| 16:04 | DISARM z limitu 1,5 s při kontrole po výstupu | V13, ověřeno |
| 16:13–16:14 | SL nezkopírován, 4 × 8 MNQ ~34 s bez SL, ≈ 416 USD | V12, ověřeno |
| 16:35 | Kopírka vyřadila všechny 4 FN followery na drawdown flooru. Equity 48 442–48 478 USD proti flooru 48 500 USD. | Podle záznamů workeru (Codex). Nevíme, jaký podíl na breachi měl incident 16:13. |
| 16:36 | Třetí DISARM („divergence“ 4 followerů), dozor za 2,3 s potvrdil flat | Příčina **nedořešena**. Časově navazuje na vyřazení followerů, ale to samo příčinu nedokazuje. |
| 18:59 | Filip odpojil FundedNext OAuth (16:59:52 UTC). Worker pět starých účtů přestal vidět. | Cloudový záznam |
| večer | Stará skupina „odpolko“ nešla smazat ani přepnout: aktivní skupina, leader mimo OAuth, startup validace zastavila worker. | Codex |
| 19:46–19:47 | Worker reinstalován (bundle 19:46, start 19:47:10), auditované vyřazení „odpolko“, „Hlavní“ prošla čerstvým flat preflightem | Codex, SHA-256 `3cb70fe9…` (Claude otisk ověřil) |
| 19:48:35 | „Hlavní“ zapnuta z aplikace (arm-live přes relay) | Codex |

**Stav ve 21:03 (Claude, `/v1/status`):**
- skupina „Hlavní“, leader 66142378, ARMED, connected;
- flat, bez divergence, bez pracovních příkazů a bez `lastError`;
- followeři 65333343, 64503883 a 65333277 mají ručně vypnutou účast, zbylí tři kopírují;
- ARM vyprší 22:00 (konec session).

**Co to mění na reportu:**
1. **Worker už neběží z produkčního kódu.** Codex ho reinstaloval z lokálního necommitnutého stromu v Documents. Ten je 16 commitů za origin/main a obsahuje Codexovu výjimku `retireMissingOldGroup` / `--retire-missing-group-id`: copierRuntimeController +51 řádků, localCopierExecutionAgent +43, copierPilotGroup +16, pilot/mac-install/protocol.
   - Dokud se to necommitne, jiná session to může přepsat.
   - Další reinstall z origin/main by výjimku tiše vrátil.
   - Doporučení: Codexovu změnu izolovaně commitnout (worktree nad origin/main, patch jen těchto souborů) a zapsat SHA bundlu (souvisí s balíčkem 3 a ST22).
2. **V12 a V13 zůstávají v kódu beze změny.** Zapnutá kopírka není důkaz, že se incident z 16:13 nemůže zopakovat. Pořadí oprav z oddílu 5 platí, balíček 0 má nejvyšší prioritu.
3. **Nový otevřený bod:**
   - Nechybí jen bezpečná cesta k vyřazení skupiny, jejíž účty zmizely z OAuth (dnes ji Codex doplnil úzce pro jedno ID).
   - Chybí i doložení, že účty zmizelé po breachi nemají osiřelé pozice a příkazy. Vyřazení „odpolko“ bylo operátorské prohlášení, nikoli brokerový důkaz flat.
   - Návrh: obecný auditovaný postup „vyřadit skupinu mimo OAuth“ v aplikaci (DISARMED, výslovné převzetí odpovědnosti, záznam do auditu) místo ruční výjimky v plistu.
4. **Třetí vypnutí 16:36** přidat do forenzní fronty: kontrola divergence při vyřazování followerů na flooru. Může souviset s V16 (propkou zlikvidovaný follower vypne skupinu), neověřeno.
5. **Oddíl 6, body 19–20 (FundedNext) jsou překonané:** FN účty jsou po breachi a odpojené.
6. **Pro Filipa (bez kódu):** Dokud nebude oprava V12 nasazená, platí hlavně bod 4 oddílu 6: čekající limitku zruš dřív, než vstoupíš jiným příkazem nebo zadáš SL. Platí i bod 2: po každém vypnutí uprostřed obchodu hned zkontroluj SL followerů.

---

## 10. Oponentura Codexe (28. 9. večer) a co se tím mění

Celé znění je v [copier-ultra-review-20260928-codex-response.md](copier-ultra-review-20260928-codex-response.md). Codex četl kód a malý stdout log. Testy nespouštěl a stav workera nezjistil (prázdná odpověď), proto pracoval jen čtením.

**Verdikty k V1–V18:**
- **Souhlasí (12):** V1, V3, V4, V5, V7, V9, V10, V12, V13, V16, V17, V18.
  - Závažnost zvýšil na **kritickou** u V4 (dozor po flat leadera zmizí při DISARM), V9 (auto-close zavírá celé účty), V12 (nezkopírovaný SL) a V16 (breached follower vypne skupinu).
  - Snížil na **střední** u V3 a V7.
- **Zpřesnit (5):** V2, V6, V8, V11, V15. Mechanismus platí, dopad je menší nebo podmíněný.
- **Nesouhlasí (1): V14.** 8h strop ARM je výslovná bezpečnostní politika (`copierRiskGate.ts:105`, PROJECT_LOG), ne skrytá chyba. Chyba je jen v UI, které skutečný čas expirace neukazuje. **Přijímáme:** V14 přeřazujeme na střední problém UI a změna politiky je rozhodnutí pro Filipa.

**Co mění na návrzích oprav:**
- **V12:** Nestačí upravit výpočet `currentRuntimePendingNet`. Záznam čekající kopie musí nést:
  - leader order ID a follower order ID,
  - typ, symbol, stranu, množství a fill,
  - epochu a generaci spojení.

  Odečíst ho jde, jen když čerstvý snapshot potvrdí, že oba příkazy jsou otevřené, odpovídají si a mají nulový fill. Seznam povinných testů je delší (partial fill, reconnect, víc čekajících příkazů).
- **V13:** Sweep mimo frontu ano, ale s návratovou bariérou před jakýmkoli zápisem. 6–8 s je celkový rozpočet, ne limit na účet. Nejistý cancel jde jen přes outbox a lookup.
- **Balíček 0 rozšířit o ST4.** Reconcile může skončit followerem −2 proti flat leaderovi a nechat worker ARMED bez chyby. Codex ho hodnotí jako kritický.
- **4B (auto-close) je v našem návrhu nedostatečný.** Filtr `enabled=false` nechrání ruční pozici na aktivním followerovi ani jiný symbol.
  - Auto-close smí zavírat jen doložené vlastnictví kopie: účet, symbol, epizoda, max. množství a ID příkazů.
  - Žádný fallback na celý účet.
  - Když vlastnictví nejde doložit: zastavit, upozornit, žádný zápis k brokerovi.
- **4A rozdělit na samostatné kroky:** V16 → V5 → V8 → V17/V18 → ST28/ST31. `unverifiable` se nesmí brát jako „izolovaný follower“.

**Zpřesnění a opravy reportu:**
- **Třetí DISARM 16:36 má pravděpodobnou příčinu V16.** Stdout ukazuje čtyři přeskočení kvůli breachi a o minutu později divergenci těchže účtů. Tím se zpřesňuje oddíl 9, bod 4.
- **Codex neověřoval** částky 4 × 8, ≈ 416 USD ani přesných 4,8 s. Stdout potvrzuje jen sled událostí.
- **Závažnost ST nálezů:**
  - Zvýšit na vysokou: ST1, ST3, ST5, ST6, ST17, ST31, ST32, ST33, ST35.
  - ST4 zvýšit na kritickou.
  - ST34 je nadsazený: vlastník získá jen svůj vlastní token, nejde o únik mezi uživateli.
  - Návrh u ST9 (jen odstranit 5min zámek) je špatně; nahradit ho autoritativní bariérou.
- **Chybí:** formální stavové automaty (pending order, vlastnictví kopie, suppression, sweep) a manifest buildu workeru se základním commitem a digestem lokálního patche, ne jen SHA souboru.

**Večerní změna (vyřazení „odpolko“):**
- Patří k ní přesně 9 souborů: protocol, mac-install, pilot, agent, copierPilotGroup, controller a 3 testy.
- Commitnout ji jde jen v čistém worktree nad origin/main přenesením přesného diffu, ne přes `git add` v Documents.
- Commit nevyžaduje reinstall.
- Předtím opravit pořadí: audit `manual-group-retirement` vzniká před durable zápisem. Přidat test, že jiná „missing leader route“ zůstane fatální.

**Codexovo doporučené pořadí** (nahrazuje pořadí v oddílu 5, dokud Filip nerozhodne jinak):
1. Provozní omezení (oddíl 6).
2. Izolovaně zachovat večerní změnu, bez reinstallu.
3. UI: nouzový DISARM a kill i při neznámém stavu, zobrazení skutečné expirace ARM. Bez reinstallu workeru.
4. V12 + V13 + ST4, oddělené commity a jeden release. Reinstall.
5. V16. Reinstall.
6. V5, V8, pak V17, V18, ST28, ST31. Reinstall.
7. V9 + V4: auto-close podle vlastnictví, guard přežije DISARM. Reinstall.
8. V10 + ST32: práce na pozadí s bariérou a samostatná nouzová cesta. Reinstall.
9. V1 + V3: validace před DISARM, fence jen na obchodní události. Reinstall.
10. V6 + V7. Reinstall.
11. Politická rozhodnutí: V15, ST5, ST21, ST26, V14.
12. V11, ST25 a hardening ST33–ST35.

**Kde Claude s Codexem souhlasí:** Ve všech bodech kromě jednoho. Zvýšení závažnosti ST1 a ST3 (nouzová brzda) a doplnění ST4 do balíčku 0 jsou oprávněné. Přesnější specifikace V12 a 4B snižuje riziko, že oprava zamaskuje skutečnou divergenci.

**Otevřené:** Codex ST4 nereprodukoval, opírá se o náš scratch důkaz. Před zařazením do release ho ověřit testem.

---

## Slovníček

- **ARM / DISARM:** zapnutí / vypnutí kopírky. Worker kopíruje jen ve stavu ARMED.
- **fail-closed:** při nejistotě se kopírka raději vypne, než aby poslala možná chybný obchod.
- **auto-close:** automatické zavření pozic followerů po bezpečnostním vypnutí, expiraci ARM nebo reconnectu.
- **guard (leader-flat guard):** dozor, který ~2 s po zavření obchodu leadera ověří, že jsou flat i followeři, a případně je zavře.
- **divergence:** nesoulad pozice followera s tím, co by měl mít podle leadera.
- **fence:** pojistka „stav se nesměl změnit během kontroly“. Když se mezi dvěma čteními něco změní, akce se odmítne.
- **heartbeat:** udržovací signál „jsem naživu“, který Tradovate posílá ve spojení.
- **fronta (eventTail):** pořadník, ve kterém worker zpracovává události jednu po druhé. Co v ní visí, zdrží všechno za tím.
- **outbox:** trvalý záznam odeslaných kopií. Brání dvojímu odeslání po restartu.
- **lineage:** doložený původ pozice, tedy že ji otevřela kopírka.
- **sideline:** vyřazení jednoho followera do konce obchodu bez vypnutí celé skupiny.
- **sweep:** úklid ochranných příkazů followera poté, co je flat.
- **epizoda:** jeden obchod leadera od vstupu po flat.
- **relay:** cesta příkazů z telefonu přes server (Vercel) a databázi (Supabase) do Macu.
- **long-poll:** dotaz, který na odpověď čeká až ~2,2 s, než se vrátí.
- **kick:** signál, který Mac upozorní, aby hned vyzvedl nový příkaz.
- **manifest:** seznam Tradovate připojení, která Mac worker načítá.
- **lease:** dočasné zapůjčení přístupového tokenu Tradovate workeru.
- **OSO / OCO:** OSO = vstup s navázanými SL/TP, které se aktivují po vstupu. OCO = dva příkazy, kde vyplnění jednoho zruší druhý.
- **reconcile (Kontrola pozic):** porovnání pozic a příkazů leadera a followerů přímo u brokera.
- **DLL:** denní limit ztráty u propky.