# LIVE rychlost: co je maximum, jednou provždy (2. 11. 2026)

> Průzkum: workflow 13 agentů (7 oblastí + měření sítě z Macu, syntéza, 3 oponentury: realističnost čísel, `copier-design-critic`, náklady/licence/provoz). Ověřeno ručně po doběhnutí: výpadek API propek (paměť `tradovate-oauth-integration`, 2. 11. live-pnl pro Lucid = `display-read-unavailable`), lokální agent (`place-leader-entry` a `manage-leader-order` jsou jen přes relay; status vydává nonce → zbytek příkazů z loopbacku je k zpevnění).

**Značky:** **[M]** změřeno · **[D]** oficiální dokumentace, kód nebo PROJECT_LOG · **[D2]** oficiální text převyprávěný třetí stranou nebo komunitou · **[O]** odhad, většinou spočtený z naměřených úseků.

Časy jsou mediány. „ACK“ znamená, že broker potvrdil přijetí příkazu. Během průzkumu nešel k brokerovi žádný příkaz, nic se neARMovalo a nic se nezapisovalo.

---

## 1) Krátká odpověď

**Nejdřív to, co je důležitější než jakákoli rychlost: API Tradovate pro tvoje propky teď nejede.**
- Od pátku 30. 10. 22:42Z vrací WS authorize chybu 421 a `/auth/me` vrací 404, naposledy 2. 11. v 04:24Z [D, PROJECT_LOG a paměť].
- Pravděpodobná příčina: equity živého účtu klesla na 950 USD, tedy pod hranici 1 000 USD.
- K 2. 11. 04:36Z je equity 1 004,20 USD, ale vklad 62 USD je pořád „InTransit“. Rezerva nad hranicí jsou 4 USD.
- Tradovate strhává ~60 USD měsíčně: API 25 USD a 35 USD za nečinnost, když 30 dní neproběhne žádný živý obchod. Další okno končí ~13. 11. [D, support.tradovate.com „Account & Exchange Fees“].
- Dnešní měření běžela jen na DEMO8661118. Dokud přístup k API nebude spolehlivý natrvalo, na rychlosti nezáleží.

**Kde broker fyzicky je.** Tradovate API běží v Google Cloud v Iowě (Council Bluffs), ne v Chicagu [M]. Platí to pro demo i live, tedy pro Lucid i Tradeify. Cesta Praha↔Iowa a zpět trvá 133–149 ms [M]. Tuhle cestu zaplatí každý tvůj klik z Prahy, ať worker běží kdekoli.

| | Dnes | **Realistické maximum (T1)** | Krajní varianta (T2) | Fyzikální podlaha |
|---|---|---|---|---|
| PC klik → broker přijal | 0,70 s [M] | **0,36–0,52 s** | 0,28–0,42 s | – |
| PC klik → vidíš „přijato“ | 0,95–1,06 s [M]* | **0,42–0,62 s** | 0,30–0,45 s | ~0,15–0,21 s |
| PC klik → pozice v grafu | 1,0–1,2 s [M]* | **0,45–0,65 s** | 0,33–0,50 s | ~0,18–0,25 s |
| Telefon LTE → „přijato“ | ~1,0–1,15 s | **0,45–0,70 s** | 0,35–0,50 s | podlaha + 10–60 ms |
| Telefon LTE → pozice | ~1,2–3,5 s, často 2–3 s | **0,55–0,85 s** | 0,37–0,55 s | podlaha + 10–60 ms |

Všechny hodnoty mimo sloupec „Dnes“ jsou [O]. Telefonní hodnoty „Dnes“ jsou také [O], protože iPhone zatím změřený nebyl.

\* Hodnoty z UI v noční conformance mohl nafouknout skrytý panel: Chrome ve skrytém okně škrtí časovače až o ~1 s. Je potřeba je přeměřit ve viditelném okně. Jestli byly nafouknuté, je dnešek ve skutečnosti o něco lepší a zlepšení vyjde menší.

**Co z toho plyne:**
- **0,3 s od kliku po ACK jde jen na hraně a jen s přímou linkou (T2).** T2 dělá z workeru druhou autoritu přijetí příkazů. Bezpečnostní oponentura ji v navržené podobě blokuje. V bezpečné verzi (povinná kontrola brzd před odesláním) ušetří proti T1 jen ~0,05–0,1 s. **Realisticky tedy ~0,4 s.**
- **~0,5 s do pozice v grafu** se na PC dá dosáhnout vyladěním dnešní cesty (T1). Telefon vyjde na ~0,55–0,85 s.
- **Pod ~0,15 s se z Prahy nedostane nic, ani web Tradovate** (ten má ~0,15–0,19 s [O]). Po T1 budeš za webem Tradovate o ~0,25–0,45 s. Bude to pořád znatelné „ťuk… a teď“, ale do půl sekundy.
- **Největší rozdíl, který pocítíš, je telefon.** Graf na telefonu dnes ignoruje průběžné zprávy o pozici (push) a stav čte jen každé 2 s. Ověřeno v `TradovateLiveDesk.tsx:377, 523, 1548` [D]. Pozice proto často naskočí až za 2–3 s [O]. Je to nejlevnější oprava celé práce.
- **Rithmic ani jiný zdroj dat klik podstatně nezrychlí.** Proti teplému spojení k Tradovate je Rithmic z Prahy rychlejší jen o ~25–60 ms [O]. Zdroj dat mění jen to, jak moc cena v grafu zaostává.
- **VPS v USA klik nezrychlí,** protože cestu přes Atlantik klik zaplatí tak jako tak. Pomohl by jen u kopírování na followery a u zavírání. Tam ale nejspíš narazí na pravidla Tradeify (viz bod 4).

---

## 2) Úrovně T1–T4

### Rychlost (vše [O] mimo sloupec „Dnes“)

| | Dnes | **T1a** levné ladění | **T1** = T1a + T1b (jádro) | **T2** přímá linka, Mac | **T3a** worker ve Stockholmu | **T3b** worker v Iowě |
|---|---|---|---|---|---|---|
| PC klik→ACK | 0,70 [M] | 0,55–0,65 | 0,36–0,52 | 0,28–0,42 | 0,30–0,45 | klik ≈ T2 |
| PC „přijato“ vidět | 0,95–1,06 [M]* | 0,80–1,0 | 0,42–0,62 (bez F1c 0,6–0,85) | 0,30–0,45 | 0,35–0,50 | ≈ T2 |
| PC pozice v grafu | 1,0–1,2 [M]* | 0,65–0,80 | 0,45–0,65 | 0,33–0,50 | 0,40–0,60 | ≈ T2 |
| Telefon LTE: přijato / pozice | ~1,0–1,15 / 1,2–3,5 | 0,85–1,1 / 0,7–0,9 | 0,45–0,70 / 0,55–0,85 | 0,35–0,50 / 0,37–0,55 | 0,4–0,6 / 0,45–0,65 | ≈ T2 |
| Posun SL/TP → potvrzeno | 0,6–0,9 [M] | 0,55–0,8 | ~0,4–0,6 | ~0,3–0,45 | ~0,35–0,5 | ≈ T2 |
| Zavření × (worker) | 1,07–1,14 [M] | 0,8–0,95 | 0,45–0,75 | 0,45–0,75 | 0,45–0,75 | 0,10–0,30 |
| Kopie: fill leadera → ACK followera | ~0,47–0,65 (z auditů změřitelné) | 0,40–0,58 | 0,26–0,37 | 0,26–0,37 | 0,26–0,37 | 0,05–0,20 |

Poznámky k tabulce:
- V T1a uvidíš pozici v grafu dřív než toast „přijato“. Pozice jde přímým pushem z workeru, kdežto „přijato“ jde přes databázi.
- U zavření v T1 rozhoduje, jestli projde zavření bez předčtení pozic. Bez předčtení 0,45, s předčtením ~0,6–0,75.
- **T4** (Rithmic + VPS v Chicagu) je proti T3b rychlejší jen o ~40–60 ms. To nepoznáš.

### Co se mění, cena, práce, rizika a co pocítíš

| Úroveň | Co se změní | Cena/měs. | Práce [O] | Rizika a bezpečnost | Co pocítíš |
|---|---|---|---|---|---|
| **T1a** | Oprava telefonu: povolit push pozice a budíček, pravidelné čtení stavu nechat aspoň po 1 s. Tlačítko „Odesílám…“ hned po ťuknutí. Teplé spojení k Tradovate. Pozice z rámce brokera rovnou do grafu, jen pro zobrazení. Push pozice hned, ne až po 150ms rozestupu. Teplé HTTP spojení relaye k databázi. | +0 USD | ~3–5 dní | Teplé spojení: příkaz odeslaný po mrtvém socketu má neznámý výsledek. U Marketu to znamená incident a DISARM, nikdy se neposílá znovu. Rychlejší telefon znamená víc čtení přes relay, takže to musí schválit critic. | Telefon přestane zaostávat o sekundy. Na PC naskočí pozice o ~0,3–0,4 s dřív. Toast „přijato“ se moc nezmění. |
| **T1b** | Příkaz se přidělí workerovi už v transakci přijetí a hned se mu pošle. Podepsaný výsledek jen pro zobrazení (F1c). Verze příkazu ze streamu místo dočítání přes REST. Zavření × bez předčtení pozic, jako nová metoda jen pro ×; Flatten beze změny. | +0 USD | ~7–10 dní + critic | Přidělení v transakci přijetí ruší posledních ~100 ms, kdy brzda ještě zastaví čekající vstup. Review z 2. 11. to kvůli úspoře ~60 ms odmítlo, takže rozhoduješ ty a je potřeba souhlas s migrací. F1c byl odložen už 30. 10., protože čára v grafu skočila do starého stavu. U verze ze streamu hrozí zaseknutí sériové fronty. | „Přijato“ pod ~0,5–0,6 s a pozice prakticky zároveň. Proti webu Tradovate pořád znatelné „ťuk… a teď“. |
| **T2** | Prohlížeč i telefon posílají příkaz přímo workeru (loopback, Tailscale) a worker se stává autoritou přijetí s vlastním deníkem příkazů. | 0–5 USD | +12–20 dní | **BLOKUJE (oponentura):** brzda z telefonu může prohrát s klikem z PC. Záloha po nejasné chybě sítě může vytvořit druhý obchod. Vznikají dvě autority ve dvou procesech. Grant od serveru by při výpadku cloudu zablokoval DISARM. Bezpečná verze s kontrolou brzd ušetří proti T1 jen ~0,05–0,1 s. | O chlup svižnější klik než T1. Rozdíl nestojí za tu práci a riziko. |
| **T3a** | Worker na VPS v AWS Stockholm, vedle Supabase. | +20–40 USD s druhým IBKR username, nebo +220–240 USD s Databento | 7–11 dní | **BLOKUJE implementaci,** dokud nebude: zapojená a otestovaná lease (INV-WORKER-02, ST34), vyřešené N6 a možnost odvolat Mac jako execution zařízení. Výpadek Supabase by znamenal výpadek úložiště i jediné cesty brzd. Potřeba písemné OK od Tradeify k VPS. Budou dva stroje na údržbu, protože Mac kvůli snímkům z TV zůstává. | Rychlost skoro žádná. Spolehlivost ano: Mac může spát a brzdy nezávisí na domácí Wi-Fi. |
| **T3b** | Worker v GCP v Iowě, přímá linka, lokální deník příkazů. | +215–235 USD | T2 + 15–25 dní | **BLOKUJE:** lokální deník porušuje INV-WORKER-01. Zombie instanci by hlídaly jen hodiny. Lease přes Atlantik by dávala falešné DISARMy uprostřed obchodu a výstup leadera by nikdo nezrcadlil. Pravidla Tradeify navíc pravděpodobně zakazují kopírovat z Lucid na Tradeify, takže jediný důvod pro T3b padá. | Klik stejný. Zavírání a skluz followerů výrazně lepší, ovšem jen pokud by kopírování bylo povolené. |
| **T4** | Rithmic + Databento + VPS v Chicagu. | +300 USD a víc, plus nové prop účty | 5–8 týdnů + 1–2 týdny conformance | Conformance je povinná [D]. R\|Protocol nejde na paper demu s živými daty [D2], takže vlastní aplikace na prop evaluacích možná nepůjde vůbec. Přihlášení heslem bez OAuth a jen jedna session [D]. Přepsání všech INV-TRAD. | Proti T3b o ~40–60 ms rychlejší. Nepoznáš. |

---

## 3) Doporučení „jednou provždy“

### Cílový stav

- **Worker zůstává na Macu. Jedinou autoritou přijetí příkazů zůstává Postgres** (atomická admission). Varianta s workerem jako autoritou (T2) z cíle vypadává.
- **Vercel arn1 a Supabase eu-north-1 zůstávají, nestěhovat.**
  - Přesun Supabase do Frankfurtu by ušetřil 40–80 ms za cenu nového projektu, klíčů a přihlášení.
  - Přesun do USA by deníku přidal 70–100 ms na každý dotaz. Relay v iad1 už jednou vyšel hůř: 0,76 s proti 0,19 s [M].
- **Broker:** teplé spojení, verze příkazu ze streamu a zavření × bez předčtení, pokud ho DEMO prokáže jako bezpečné.
- **Telefon:** push pozice a budíček, pravidelné čtení stavu jen jako záloha, aspoň po 1 s.
- **Data:** zatím IBKR. Databento jako hlavní zdroj grafu až po písemných odpovědích k licenci a po zkušebním měsíci. IBKR pak jako záloha a křížová kontrola. TV CDP jen jako označená záloha, nebo pryč.
- **VPS:** jen T3a, jen kvůli spolehlivosti a až po splnění předpokladů. T2, T3b ani T4 ne.
- **Výsledek [O]:**
  - PC: „přijato“ za ~0,42–0,62 s, pozice za ~0,45–0,65 s.
  - Telefon: 0,45–0,70 s a 0,55–0,85 s.
  - Zhruba 2× rychlejší než dnes, telefon 3–4×.
- **Cena:**
  - Dnes ~90–135 USD/měs.: Vercel ~40 [M], Supabase Pro ≥25 [D], Tradovate 25–60 [D], IBKR ~1,6 [D2].
  - S T1 a Databento: +199 USD a Realtime +20–50 USD (posílat jen ve chvíli, kdy je graf otevřený), celkem **~320–390 USD/měs.** (~7–8,5 tis. Kč při kurzu 22 Kč/USD).
  - Bez Databento ~110–190 USD/měs.

### Pořadí kroků a brány (go / no-go)

**Krok 0: teď, 1–3 dny, 0 USD. Většinu děláš ty.**
1. **Přístup k Tradovate:**
   - zvaž rezervu equity +150–200 USD nad 1 000 USD;
   - watchdog ať hlídá equity pod 1 050 USD a stav doplňku API;
   - hlídat okno poplatku za nečinnost (~13. 11.), jak ho řešit, je na tobě;
   - písemně se zeptat Tradovate, co přesně znamená 421 „older version of an app … no longer supported by your organization“ a jestli tvoje osobní OAuth aplikace (CID 16009) na prop organizacích přežije politiku NinjaTrader Ecosystem (od července 2026 vydávají OAuth jen schváleným členům [D2]);
   - po obnově znovu připojit Lucid. Připojení 754e4b5b je odpojené a archivované a worker nové připojení sám nepřevezme, takže to znamená reinstall podle deploy politiky.
2. **Písemné dotazy na propky:**
   - Tradeify: smí se automaticky kopírovat z Lucid na Tradeify? Smí worker přistupovat z cloudové IP?
   - Lucid: jaká má pravidla k VPS?
   - Odpověď podmiňuje celou kopírku, ne jen VPS.
3. **IB Gateway:** zapnout Auto restart (nebo IBC). 1.→2. 11. ve 23:45 se Gateway sám odhlásil a Market i Stop pak byly zablokované [D, PROJECT_LOG]. Nastavit připomínku nedělní 2FA.
4. **Hodiny Macu:** chrony/NTP. Offset je dnes +46 ms [M] a kazí měření.
5. **Bezpečnostní díra v lokálním agentovi** (nesouvisí s rychlostí, opravit tak jako tak):
   - Libovolný proces na Macu si přečte nonce z `GET /v1/status` a s podvrženou hlavičkou Origin pak může poslat `arm-live`, `set-multiplier`, `update-group`, `resolve-stuck-operation`, `reconcile` (ten maže incident) nebo `unlock-day` [D, kód]. Brány controlleru u `unlock-day` jsem neověřil.
   - Oprava: z produkčního originu přes loopback povolit jen status, brzdy a Flatten, všechno ostatní jen přes relay.
   - Dnes jde i ARM přes loopback (log 09:41:26Z), takže přesun ARM na relay musí projít criticem.
6. **Výchozí měření:**
   - DEMO n≥30 po jednotlivých úsecích, p50/p95, ve viditelném okně;
   - iPhone na LTE n≥20;
   - skluz followerů z auditů workeru (`leaderReceivedAt/queueMs/brokerMs/totalMs`).

**Brána G0:** API je stabilní aspoň týden a měření dnešní čísla potvrdí, nebo opraví. Jinak nejdřív přístup, rychlost potom.

**Krok 1: T1a, ~3–5 dní.** Oprava telefonu, „Odesílám…“, teplé spojení, pozice z rámce do grafu, push pozice bez rozestupu, teplé HTTP relaye k databázi. U relaye nejdřív změřit, jestli rozdíl mezi 30–190 ms (admission RPC viděná z relaye) a 14,7 ms v databázi nedělá studené spojení.
- **Měřit:**
  - telefon klik→pozice p50 ≤0,9 s, p95 ≤1,5 s;
  - placeOSO 150–180 ms místo dnešních 204–253 ms;
  - podíl neznámých výsledků = 0.
- **Go:** žádný nový neznámý výsledek a telefon je viditelně lepší.
- **No-go:** jakýkoli neznámý výsledek kvůli mrtvému socketu → teplé spojení vypnout a přepracovat.

**Krok 2: T1b, ~7–10 dní.** Změny jednu po druhé, každou přes `copier-design-critic`:
1. F1c vázaný na operationId: jen ukončí stav „odesílám“, nikdy nezmění stav účtu.
2. Verze příkazu ze streamu. Napřed DEMO test pořadí rámců.
3. Zavření × bez předčtení. Napřed DEMO důkaz, že liquidate na plochém účtu nevytvoří žádný příkaz.
4. Přidělení příkazu v transakci přijetí. Jen pokud po předchozích krocích pořád chybí rychlost, s tvým výslovným rozhodnutím o okně brzdy a se souhlasem s migrací.
5. Pooled pg úplně nakonec, jen se samostatnou DB rolí, která smí pouze EXECUTE.

- **Měřit:** klik→start workeru ≤150 ms, ACK→„přijato“ ≤80 ms, rámec→pozice ≤10 ms, zavření celkem.
- **Brána G1 (doporučený konec):** PC klik→ACK p50 ≤0,45 s (0,4 s je optimistický okraj), pozice p50 ≤0,65 s, telefon ≤0,85 s. Pokud jsi spokojený, **tady skončit.**

**Krok 3: data, souběžně s kroky 1–2.**
- **D0:**
  - kotace do workeru hned při změně, sloučená na nejnovější hodnotu a nejvýš 10–20/s;
  - IBKR tick-by-tick místo snímků;
  - do grafu 10–20 zpráv/s, ale jen když je graf otevřený;
  - zkontrolovat spotřebu Realtime v dashboardu.
- **D1 Databento:** nejdřív písemně tři otázky z bodu 4, pak zkušební měsíc a změřit zpoždění čtyř zdrojů stejně jako 28. 10.
- **Go:** graf zaostává za webem Tradovate nejvýš o +100 ms a licence je písemně v pořádku. Teprve potom se pro risk mění INV-UI-04, přes critica.

**Krok 4: jen když G1 nestačí.** T2 jako úplně nový návrh:
- synchronní kontrola brzd pod stejným zámkem jako admission;
- u příkazů zvyšujících riziko žádná automatická záloha;
- `flock` na deník příkazů;
- brzdy fungují bez grantu.

Pokračovat jen při změřeném zisku aspoň 0,1 s a s OK od critica.

**Krok 5: jen kvůli spolehlivosti.** T3a, až budou splněné všechny předpoklady:
- lease zapojená a otestovaná (ST34);
- N6 vyřešené;
- Mac jde odvolat jako execution zařízení;
- cesta brzd funguje i při výpadku Supabase;
- Tradeify písemně souhlasí.

Nasazovat o víkendu.

**Nedělat:**
- stěhovat Supabase nebo Vercel;
- VPS „u CME“ pro Tradovate;
- Vercel WebSockets jako hub;
- Tailscale Funnel nebo exit node (Tradeify zakazuje přihlášení přes VPN [D2]);
- listener na LAN;
- WS objednávky bez A/B měření;
- T3b;
- T4.

---

## 4) Co blokuje a co je neověřené

**Přístup a pravidla (můžou zastavit úplně všechno):**
- **Tradovate API:** výpadek, equity těsně nad limitem a měsíční poplatky. Popsáno v bodě 1 [D, ověřeno v PROJECT_LOG a paměti].
- **Tradeify** [D2, oficiální FAQ vrací 403, obsah je z převyprávění]:
  - přihlášení přes VPN nebo VPS je zakázané; obchodování z VPS po normálním přihlášení je na vlastní riziko;
  - bot musí být výhradně tvůj a Tradeify může chtít video, jak ho spouštíš na vlastním PC;
  - **bot se nesmí používat u více firem**;
  - kopírovat se smí jen mezi vlastními účty u Tradeify.
  - Leader Lucid → followeři Tradeify je pravděpodobně mimo povolení, ať je latence jakákoli. **Potřeba písemná odpověď.**
- **Lucid** [D2]:
  - automatické systémy a kopírování jsou povolené;
  - zakázané je HFT a mikroskalpování (víc než 50 % zisku z obchodů do 5 s);
  - zakázaný je hedging napříč účty i firmami, včetně korelovaných trhů (long ES / short NQ);
  - pravidlo k VPS jsem nenašel.

**Licence dat:**
- **IBKR pro risk.** Worker z kotace IBKR počítá Market jako limit +2 ticky a podle ní pouští nebo blokuje příkazy. Podle CME je to „non-display use“ [D2]. Jestli to kryje osobní non-pro předplatné IBKR, je **neověřené**. Přímá licence CME „User Non-Display Category A“ stojí ~457 USD [D2, výtah z ceníku leden 2026, období účtování neověřeno]. Zeptat se IBKR písemně.
- **Databento Standard** stojí 199 USD/měs. [D] a pro osobní použití zahrnuje licenci CME pro 2 zařízení včetně non-display [D]. Tři otázky písemně:
  1. **Počet zařízení:** VPS + Mac + iPhone jsou 3 zařízení, limit jsou 2. Worker a prohlížeč na Macu jsou pravděpodobně jedno zařízení.
  2. **Osobní vs. komerční použití:** AlphaTrade jsi Databento popsal jako komerční aplikaci (`docs/databento-market-data-license-draft.md`). Osobní předplatné proto musí běžet na samostatném osobním účtu a živá data se nesmí ukládat do sdílených tabulek produktu.
  3. **Profesionální status u prop účtů**, zejména funded a živých (LucidLive). Pokud by to byl profesionální status, osobní Standard nestačí. Stejná otázka se možná týká i IBKR, neověřeno.
- **Market data od Tradovate:** podle fóra by stálo ~290–500 USD (CME sub-vendor) [D2, neověřeno] a prop OAuth tokeny data stejně nevidí [M, srpen]. Ne.

**Provoz:**
- **IBKR:** týdenní plná 2FA (první spuštění po neděli 01:00 ET), jinak denní automatický restart [D]. Při zůstatku pod 500 USD IBKR předplatné dat ukončí [D2]. Data se platí za každého uživatele, CME L1 non-pro ~1,55 USD/měs. [D2].
- **Realtime:** dnešních ~1,5 zprávy/s už dělá ~4,6 M zpráv měsíčně, a kvóta Pro je 5 M [O z D]. Při 20 zprávách/s bez omezení na otevřený graf by to bylo ~100–140 USD/měs. navíc [O].
- **Mac:** domácí Wi-Fi a spánek zůstávají v cestě. Už byly dva fail-close z přetížení a mikrovýpadky „fetch failed ×22“ [D].

**Bezpečnost (invarianty):**
- **Verdikty oponentury:**

  | Úroveň | Verdikt |
  |---|---|
  | T1 | OPRAVIT |
  | T2 | BLOKUJE |
  | T3a | BLOKUJE implementaci, směr OK |
  | T3b | BLOKUJE |
  | T4 | OK jako „nedělat“ |
  | D0 | OPRAVIT (drobnost) |
  | D1 | OK pro graf; pro risk BLOKUJE, dokud se nezmění INV-UI-04 |

  Každý krok, který sahá do jádra, půjde před implementací znovu přes `copier-design-critic` (CLAUDE.md bod 4).
- **Pravidla, na kterých to stojí:**
  - **INV-RELAY-03 a INV-BRAKE-03:** brzda vždy vyhraje. Kvůli nim padá T2 s horizontem ~1 s a hraniční je přidělení v transakci přijetí.
  - **INV-OUTBOX-01 a INV-TRAD-04:** nejasný výsledek POSTu je „neznámý“ a nikdy se neposílá znovu. Týká se teplého spojení a zálohy v T2.
  - **INV-TRAD-02 a INV-FRESH-01:** verze příkazu ze streamu.
  - **INV-MODE-02 a INV-MANUAL-01:** zavření ×.
  - **INV-WORKER-01/02/03:** VPS a dvě instance workeru.
  - **INV-UI-01..04:** nic zobrazovacího nikdy neautorizuje příkaz.
  - **INV-WORKER-04:** kotace nesmí zahltit hlavní smyčku workeru.

**Neověřená měření (bez nich zůstávají odhady jen odhady):**
- autentizované DEMO z us-central1;
- WS proti teplému REST;
- pořadí rámců s verzí příkazu;
- liquidate na plochém účtu;
- `apiHosts` pro loginy Lucid a Tradeify;
- iPhone na LTE;
- přesný idle timeout hrany Tradovate. Server drží spojení aspoň 75 s [M], GFE podle dokumentace 610 s [D], undici ho zavírá po 4 s [D];
- chování undici při resetu POSTu;
- skluz followerů z auditů;
- jestli dnešní UI čísla nenafoukl skrytý panel.

---

## 5) Data a zdroje

### Zdroje ceny

| Zdroj | Zpoždění a chování | Cena | Na co smí | Licence |
|---|---|---|---|---|
| IBKR Gateway (dnes) | dávky ~0,5 s (odstup p50 515 ms [M]); graf ~+300 ms za webem Tradovate [O] (+450 ms [M] bylo změřeno ještě před okamžitým odesíláním); po D0 ~+250 ms [O] | ~1,55 USD/měs. [D2] | graf a risk ručního vstupu | non-display pro risk neověřen |
| TradingView Desktop CDP | ~1,1 změny/s, ~750 ms zpoždění [M] | 0 | jen označená záloha zobrazení | šedá zóna ToS |
| Databento Standard | do Prahy ~60 ms po události na CME [O]; replay 24 h [D]; graf ~0 až +100 ms za webem Tradovate [O]; nezávisí na místě, odemyká VPS bez IB Gateway | 199 USD/měs. [D] | graf; risk až po licenci a změně INV-UI-04 | osobní, 2 zařízení vč. non-display [D]; tři otevřené otázky |
| Tradovate market data | – | ~290–500 USD [D2, neověřeno] | – | prop tokeny je nevidí [M] |

### Fyzika (spočteno)

| Trasa | Po hlavní kružnici | RTT ve vlákně | Změřeno RTT |
|---|---|---|---|
| Praha–Council Bluffs (Tradovate) | 7 808 km | 76,5 ms | 133–149 ms [M] |
| Praha–Chicago | 7 301 km | 71,6 ms | 109–129 ms [M] |
| Praha–Stockholm | 1 054 km | ~10 ms | – |

Reálné trasy jsou ~1,8× delší, protože vedou přes Londýn a východ USA. Podlaha pro „přijato“ viditelné v Praze je RTT + zpracování u Tradovate (10–50 ms) + naše minimum (5–10 ms), tedy ~0,15–0,21 s. LTE přidá 10–20 ms v klidu a až 50–60 ms pod zátěží. Ookla uvádí pro ČR medián pod zátěží 77–81 ms [D2].

### Zdroje (URL)

- **Síť, spojení:**
  - GCP keepalive 610 s: https://docs.cloud.google.com/load-balancing/docs/https/request-distribution
  - undici keepAliveTimeout 4 s: https://raw.githubusercontent.com/nodejs/undici/main/docs/docs/api/Client.md
  - WebKit preflight cache 600 s: https://webkit.googlesource.com/WebKit/+/master/Source/WebCore/loader/CrossOriginPreflightResultCache.cpp
  - MDN Access-Control-Max-Age: https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Access-Control-Max-Age
  - Latence mobilů ve střední a východní Evropě: https://www.statista.com/statistics/1093459/cee_-ping-speed-of-mobile-internet/
- **Supabase Realtime:**
  - https://supabase.com/docs/guides/platform/manage-your-usage/realtime-messages
  - https://supabase.com/docs/guides/realtime/limits
  - https://supabase.com/docs/guides/realtime/pricing
- **Databento:**
  - https://databento.com/pricing
  - https://databento.com/docs/portal/live-data
  - https://databento.com/blog/updates-to-subscription-pricing
- **CME:**
  - https://www.cmegroup.com/market-data/files/january-2026-market-data-fee-list.pdf (přímé stažení bylo zablokované, údaje jsou z výtahu)
  - https://thortradecopier.com/blog/cme-market-data-fees-non-display-redistribution
- **Tradovate:**
  - support.tradovate.com „Account & Exchange Fees“ (aktualizace 9/2/2026)
  - https://community.tradovate.com/t/api-access-for-3rd-party-app-development/11941
  - https://community.tradovate.com/t/api-access/12819
  - https://community.tradovate.com/t/is-cme-sub-vendor-requirement-for-api-access-is-290-per-month/6215
- **Propky:**
  - https://help.tradeify.co/en/articles/12268494-common-faqs
  - https://proptradingvibes.com/blog/tradeify-trading-rules-overview
  - https://phidiaspropfirm.com/education/tradeify-copy-trading
  - https://phidiaspropfirm.com/education/lucid-trading-copy-trading
- **Rithmic:** https://pickmytrade.io/help/rithmic/rithmic-api-overview/
- **IBKR:**
  - https://www.interactivebrokers.com/docs/tws-api/doc/tws-settings/daily-weekly-reauthentication
  - https://ibkb.interactivebrokers.com/fr/node/2840
- **Ostatní:**
  - https://tailscale.com/docs/reference/faq/pricing (Personal plán zdarma jen pro nekomerční použití)
  - https://agentdeals.dev/gcp-free-tier-2026

### Interní podklady a ověřený kód

V tomto kole jsem si znovu ověřil stav přístupu k Tradovate (paměť), incident IB Gateway (PROJECT_LOG), podmínku grafu na telefonu, 150ms rozestup push pozice, interval čtení risku 30/60 s a kontrolu Origin a nonce v lokálním agentovi.

- `/Users/filipkrejca/alphatrade-worktrees/live-phone-20261101/components/TradovateLiveDesk.tsx:377, 523, 1548`
- `/Users/filipkrejca/alphatrade-worktrees/live-phone-20261101/server/localCopierExecutionAgent.ts:418, 932, 952, 1418-1424, 1451`
- `/Users/filipkrejca/alphatrade-worktrees/live-phone-20261101/server/macCopierCommandRelay.ts:259, 308`
- `/Users/filipkrejca/alphatrade-worktrees/live-phone-20261101/services/copierRuntimeController.ts:1972-1974`
- `/Users/filipkrejca/alphatrade-worktrees/live-phone-20261101/services/tradovateBroker.ts:820-826, 2121-2132`
- `/Users/filipkrejca/alphatrade-worktrees/live-phone-20261101/docs/LIVE_HOT_PATH_PLAN.md`
- `/Users/filipkrejca/alphatrade-worktrees/live-phone-20261101/docs/reviews/hot-path-f1b2-fees-close-20261102.md`
- `/Users/filipkrejca/alphatrade-worktrees/live-phone-20261101/docs/COPIER_VPS_PLAN.md`
- `/Users/filipkrejca/alphatrade-worktrees/live-phone-20261101/docs/COPIER_INVARIANTS.md`
- `/Users/filipkrejca/alphatrade-worktrees/live-phone-20261101/docs/PROJECT_LOG.md`
- `/Users/filipkrejca/Documents/trading-journal-aka/docs/reviews/live-quality-verdict-20261030.md`
- `/Users/filipkrejca/Documents/trading-journal-aka/docs/reviews/latency-cost-review-20261030.md`
- `/Users/filipkrejca/.claude/projects/-Users-filipkrejca-Documents-trading-journal-aka/memory/tradovate-oauth-integration.md`