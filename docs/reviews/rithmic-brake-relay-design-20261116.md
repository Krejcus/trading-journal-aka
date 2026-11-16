# Brzdový relay pro Rithmic proces — návrh (16. 11. 2026)

> **Stav: návrh NEPROŠEL (copier-design-critic: „OPRAVIT", pro živý ARM
> BLOKUJE).** Směr (samostatný úzký relay) potvrzen jako správný. Závazné
> opravy jsou na konci v oddílu „Výsledek oponentury". Codex návrh neviděl.

Podmínka z oponentury přímého kanálu (v2, bod 5 a N5): bez funkční vzdálené
brzdové cesty nesmí Rithmic proces přijmout živý ARM, a přes relay se má
vydávat i krátkodobé oprávnění uživatele. **Jen návrh — žádný kód, žádná
migrace.** Změna produkční databáze vyžaduje výslovný souhlas Filipa.

## Rozhodnutí: vlastní, úzký relay vedle stávajícího

Stávající relay (`tradovate_copier_devices`, `tradovate_copier_commands`,
`tradovate_copier_device_runtime`, SQL admission, `api/tradovate/oauth/copier-relay`)
je svázaný s Tradovate OAuth připojením (`connection_id` not null → FK,
`environment = 'demo'`, výběr cíle podle nejčerstvějšího heartbeatu připojení).
Rithmic proces žádné takové připojení nemá.

Místo rozšiřování stávajícího relaye (riziko pro běžící Tradovate worker
a jeho admission) navrhuji **samostatné tabulky a samostatný endpoint**, které
umí jen úzký seznam příkazů. Stávající relay se nemění vůbec.

## Dotčené invarianty

INV-RELAY-01/02/03/04, INV-BRAKE-02/03/04, INV-UI-02, INV-WORKER-02/03,
INV-FRESH-02/03, INV-DIRECT-01 (návrh).

## Datový model (nové tabulky, jen server, RLS zapnuté, žádný přístup anon/authenticated)

- `rithmic_processes` — `id uuid`, `user_id`, `name`, `secret_hash`,
  `environment text check (in ('test','paper','live'))`, `created_at`,
  `revoked_at`. Jeden řádek = jedna instalace procesu.
- `rithmic_process_runtime` — `process_id` PK, `user_id`, `started_at`,
  `last_seen_at`, `status jsonb` (jen zobrazení), `brake_cursor bigint`
  (nejvyšší brzda, kterou proces potvrdil).
- `rithmic_process_commands` — `id bigserial` (pořadí = kurzor), `user_id`,
  `process_id`, `command_type text check (in (...úzký seznam...))`,
  `operation_id text`, `payload jsonb`, `created_at` (čas serveru),
  `expires_at`, `status`, `result jsonb`, `completed_at`;
  `unique (user_id, process_id, operation_id)`.

Úzký seznam `command_type` (vynucený CHECK i kódem):
`disarm`, `kill-switch`, `lock-until-session-end`, `flatten-account`,
`flatten-group`, `close-position`, `cancel-entry`, `issue-token`, `revoke-client-key`.
Nic, co zvyšuje riziko, do tabulky vložit nejde.

## Registrace procesu

Lokálně na Macu, přihlášeným uživatelem (stejný vzor jako dnešní párování
workeru): proces vygeneruje tajemství, server uloží jen jeho otisk. Odvolání
nastaví `revoked_at`. Žádná vazba na Tradovate připojení.

## Tok brzdy

1. Klient (přihlášený uživatel, libovolné zařízení, bez klíče klienta) pošle
   brzdu na nový endpoint s **výslovným `processId`** a `operationId`.
   Server ověří uživatele a vlastnictví procesu a vloží řádek (čas serveru).
2. Proces drží trvalý dlouhý dotaz „příkazy s `id > kurzor`". Odpověď nese
   příkazy, čas serveru a **`noPendingBrakeAsOf`** = okamžik, ke kterému server
   potvrzuje, že pro proces nečeká žádná nedoručená brzda.
3. Proces brzdu uplatní hned (mimo frontu), zapíše do knihy operací
   (deduplikace s brzdou, která přišla přímo, podle `operationId`), posune
   kurzor a potvrdí výsledek.
4. Klient vidí brzdu jako účinnou až po potvrzení procesem (ne po vložení).

Doručení je „aspoň jednou"; opakování řeší kniha operací. Brzda má platnost
10 min jako dnes; zámek dne nese obchodní den, takže přehrání nezamkne další den.

## Lease „žádná brzda nečeká"

- Proces smí přijmout třídu zvýšení rizika jen tehdy, když má
  `noPendingBrakeAsOf` mladší než **L** (cíl < 3 s). Stáří počítá od
  **odeslání** dotazu svými monotónními hodinami — zpoždění odpovědi tak lease
  zkracuje, nikdy neprodlužuje.
- Mrtvé nebo pomalé spojení se serverem = žádný vstup ani ARM (brzdy
  a snížení rizika dál fungují přímou cestou a lokálně).
- Server počítá `noPendingBrakeAsOf` v téže transakci jako čtení příkazů, aby
  brzda vložená těsně před odpovědí nemohla být „potvrzeně nepřítomná".

## Oprávnění uživatele (token) a odvolání klíče

- `issue-token`: klient (přihlášený) požádá přes relay; proces token podepíše
  (vázaný na klíč klienta, uživatele, `startedAt`, prostředí, rozsah, 10 min)
  a vrátí ho ve výsledku příkazu. Server token nevidí dřív než proces
  a nemůže ho vyrobit sám.
- `revoke-client-key`: proces klíč odstraní ze stavu a potvrdí; do potvrzení
  platí nejvýš zbytek tokenu.

## Dva procesy vedle sebe

Globální OFF/Kill v appce = dva nezávislé požadavky (stávající relay pro
Tradovate worker, nový pro Rithmic proces), každý s vlastním potvrzením;
UI ukáže stav obou. (Rozhodnutí Filipa č. 2.)

## Co se musí změřit / rozhodnout

1. Skutečné zpoždění dlouhého dotazu Vercel ↔ Supabase ↔ Mac (dnešní poll
   relaye ~750 ms) — dá se L < 3 s držet stabilně? Jinak proces často odmítne vstup.
2. Cena trvalého dlouhého dotazu (počet volání funkce za den).
3. Souhlas s migrací produkční DB (tři nové tabulky, žádná změna stávajících).
4. Kde endpoint žije (nová cesta `api/rithmic/relay`), sdílení pomocných
   funkcí se stávajícím relayem bez změny jeho chování.

## Testy před implementací

Brzda vložená těsně před odpovědí není „potvrzeně nepřítomná"; brzda pro jiný
proces nebo cizího uživatele se nedoručí; odvolaný proces nic nedostane;
příkaz mimo seznam nejde vložit (CHECK i kód); stejné `operationId` dvakrát =
jeden řádek; kurzor nikdy neklesá; lease se počítá od odeslání; výpadek
serveru = žádný vstup, brzdy přímo dál fungují; token nejde vydat bez procesu.

## Výsledek oponentury (copier-design-critic)

Samostatný úzký relay je správně. V této podobě ale brzda uložená na serveru
může zůstat nedoručená, zatímco lease vypadá čerstvě — a pak lease okno
neohraničuje.

**Blokující:**

1. **Kurzor nad `bigserial` ztrácí brzdy.** Transakce s nižším id může
   potvrdit až po vyšším; dotaz `id > kurzor` ji už nikdy nevrátí. Totéž po
   obnově DB ze zálohy. → Výdej i lease podle **stavu řádku** („žádná brzda
   pro proces není nevyřízená"), ne podle kurzoru od klienta; vložení brzdy
   a čtení lease pod stejným zámkem na proces.
2. **„Nečeká" musí znamenat „proces ji uplatnil"**, ne „odešla v odpovědi"
   (odpověď se může ztratit). Nedoručený `disarm` a `kill-switch` pro účely
   lease **neexpirují** — jinak po 11 min bez spojení brzda vyprší, lease je
   čerstvý a proces zůstane zapnutý, i když uživatel dal OFF.
3. **Druhá instance** (kopie stavu, druhý Mac se stejným tajemstvím): dotaz
   nese `startedAt` + jednorázové číslo instance, server drží jedinou
   aktuální; starší dostane 409 bez lease a musí se vypnout. Brzda je
   vyřízená až potvrzením aktuální instance.

**Rozhodnout před stavbou:**

4. **Dlouhý dotaz a L < 3 s se vylučují** (stáří se počítá od odeslání, takže
   dotaz držený 20 s vrátí lease starý 20 s). Buď krátký dotaz ~1× za sekundu
   (desítky tisíc volání denně), nebo proud s průběžnými potvrzeními
   („bez brzdy, uplynulo e ms od přijetí tvého požadavku"). Volba
   architektury, ne jen měření.

**Doplnit:**

5. Jedno RPC pod zámkem, ne dvě volání; čtení z primární DB; odpověď nese
   jednorázové číslo dotazu, `processId`, `startedAt` a `no-store`.
6. Co má dnešní relay a tady chybí: přednost brzd v dávce a smyčka dotazu,
   kterou nezdrží běžící Flatten ani podpis tokenu; zahájený příkaz se nikdy
   nespustí znovu (durable `sending` v knize); brzda zadaná před restartem se
   provede; slučování Flattenu stejného cíle (dvojklik = jeden Flatten);
   platnosti podle typu (zavření a `cancel-entry` v sekundách, Flatten
   nejvýš desítky sekund); otisk těla a typ při shodě `operationId`;
   obchodní den pro zámek dne počítá server při vložení, u hranice 17:00 CT
   odmítnout jako nejednoznačné.
7. Odvolaný proces nedostane ani brzdu → odvolání/401 musí proces brát jako
   důvod k místnímu vypnutí.
8. Flatten, zavření a `cancel-entry` musí v Rithmic procesu fungovat i po
   vypnutí a pod kill; žádný nesmí být blokován epochou brzdy.
9. **Identita cíle v těle příkazu:** Flatten — přesná identita účtu (neznámý
   účet = odmítnutí, nikdy „vše"); zavření — účet, přesný kontrakt, strana,
   identita obchodu nebo epocha pozice, nejvyšší množství („zavři nejvýš N");
   `cancel-entry` — vlastní vstup podle jeho operace a čísla příkazu u brokera,
   nikdy ochranná noha.
10. **`issue-token` není neutrální k riziku** — věta „nic, co zvyšuje riziko,
    vložit nejde" je s ním nepravdivá. Přijatelné jen jako pojmenovaná výjimka:
    každý požadavek s tokenem je zároveň podepsán neexportovatelným klíčem
    klienta, klíče se registrují jen lokálně, uživatele a rozsah bere proces ze
    své registrace (ne z řádku serveru), token nese `processId`, po vyzvednutí
    se maže, pod kill se nevydává, strop vydání.
11. **Odhlášení:** čekající nepotvrzené `revoke-client-key` zahrnout do lease
    jako brzdu → odhlášení zabere do L a rozhodnutí Filipa č. 1 (až 10 min)
    téměř odpadá.
12. **Globální OFF** jako dva požadavky klienta: pád mezi nimi zabrzdí jen
    jeden proces. → Rozešle to server v jednom požadavku (stávající enqueue se
    jen volá), nebo klient pošle oba nezávisle a selhání jednoho neskryje.
13. Vložení brzdy nesmí záviset na stavu procesu ani `last_seen_at`; krátký
    `lock_timeout`. `status jsonb` je jen zobrazení. Pravdivost lease stojí na
    serveru (kompromitovaný relay umí brzdy zadržet) — stejné riziko jako dnes,
    ale patří do INV-DIRECT-01 výslovně.

### Co z toho plyne pro rozhodnutí Filipa

- Č. 1 (odhlášení až 10 min) se s bodem 11 zkracuje na jednotky sekund —
  rozhodnutí nejspíš nebude potřeba.
- Č. 4 (brzda platí do L) zůstává; L závisí na volbě z bodu 4.
- Nové: souhlas s migrací produkční DB a s cenou trvalého spojení (bod 4).
