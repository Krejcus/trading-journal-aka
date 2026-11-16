# Přímý kanál telefon/PC → exekuční proces — návrh (16. 11. 2026)

> **Stav: návrh NEPROŠEL (Codex gpt-6-astra: „OPRAVIT", body 1–3 blokují
> zapojení).** Text níže je první verze; závazné opravy jsou v oddílu
> „Výsledek oponentury" na konci. Kód neexistuje.

Krok 3 plánu `docs/reviews/rithmic-work-plan-20261116.md`. **Jen návrh k
oponentuře — žádný kód.** Týká se výhradně nového Rithmic procesu; stávající
Tradovate worker, relay ani jejich brány se nemění.

## Proč

Dnes jde ruční příkaz z appky: web/telefon → Vercel → Supabase fronta →
long-poll workeru → broker → stav zpět dotazováním. Server (relay + SQL)
přitom dělá část pojistek: přihlášení uživatele, párování zařízení,
idempotenci, rozestup 3 s, denní strop, TTL a zneplatnění brzdou. Worker proto
ruční vstup a správu z jiné cesty než z relaye odmítá
(`server/localCopierExecutionAgent.ts:973, 993`, `manual-entry-relay-only`).

Cíl: klik → potvrzení řádově ~150–200 ms. To nejde, dokud je v cestě fronta.

## Dotčené invarianty

INV-MANUAL-01, INV-RELAY-01/02/03/04, INV-BRAKE-02/03, INV-FRESH-01/03,
INV-OUTBOX-01, INV-WORKER-01/02/03, INV-UI-01/02, INV-DEFAULT-01.

## Návrh

### Cesta

```
telefon / PC ──HTTPS (Tailscale Serve, jen tailnet)──▶ 127.0.0.1:<port> Rithmic procesu
```

- Proces poslouchá jen na loopbacku. Do tailnetu ho vystaví `tailscale serve`
  (TLS, žádný veřejný přístup; Funnel se nepoužije nikdy).
- Příkazy: `POST /v1/command`. Stav: `GET /v1/status` (zpočátku dotaz po
  příkazu a krátké dotazování; push přes SSE až jako druhý krok).
- Relay zůstává jako druhá, pomalá cesta — hlavně pro brzdy, když přímý kanál
  není dosažitelný (telefon mimo tailnet).

### Jedna vstupní brána pro obě cesty

Pojistky, které dnes dělá server, se přesunou do procesu a platí stejně pro
přímý kanál i relay (jediná autorita = proces, který zapisuje k brokerovi):

1. **Kdo volá.** Tři nezávislé podmínky, všechny nutné:
   - síť: požadavek přišel z loopbacku od `tailscale serve` (proces jinde
     neposlouchá);
   - `Origin` z výslovného seznamu (web produkce, nativní shell) — jako dnes;
   - podpis požadavku klíčem zařízení. Klíč se zřídí jednou přes stávající
     ověřenou cestu (přihlášený uživatel + relay), nikdy přes přímý kanál.
     Podepisuje se: metoda, cesta, tělo, `operationId`, čas klienta a
     jednorázové číslo. Proces drží veřejné klíče povolených zařízení
     v durable stavu; odvolání klíče = příkaz přes relay nebo lokálně.
   - Hlavičky identity z Tailscale jsou jen doplňkový audit, ne autorizace.
2. **Idempotence.** Každý měnící příkaz nese `operationId` a proces si ukládá
   `operationId → otisk těla + výsledek` (durable, před provedením). Stejné
   `operationId` se stejným otiskem vrátí uložený výsledek (z jakékoli cesty);
   s jiným otiskem je odmítnuto. Tím je bezpečné zopakovat **stejný** požadavek
   po nejisté odpovědi, i druhou cestou. Klient nikdy negeneruje nové
   `operationId` pro tentýž záměr.
3. **Platnost.** Proces počítá lhůtu od vlastního příjmu (krátká, např. 5 s pro
   vstup). Čas klienta slouží jen k odmítnutí zjevně starého požadavku
   (stáří nad limit nebo z budoucnosti = odmítnuto); nikdy lhůtu neprodlužuje.
4. **Rozestup a denní strop.** Počítá proces z vlastního durable stavu
   (provedené vstupy bez ohledu na cestu). Bez načteného stavu = odmítnuto.
5. **Brzdy mají přednost.** DISARM, kill, day lock jdou mimo frontu příkazů
   (jako dnes) a přijímají se z obou cest; stačí jim platný podpis zařízení,
   nepotřebují čerstvý status. Vstup přijatý před brzdou, ale ještě
   neprovedený, se zneplatní podle pořadí příjmu v procesu (jedny hodiny —
   přísnější než dnešní porovnání času relaye s rezervou na posun hodin).
6. **Potvrzení přenosu není potvrzení obchodu.** Odpověď HTTP nese výsledek
   brány a přijetí příkazu; stav příkazu u brokera jde jen ze stavu procesu.
7. **Čerstvost v UI** beze změny: běžný příkaz jen s čerstvým statusem
   (≤ 15 s), brzdy vždy dosažitelné.

### Co klient dělá při nejistotě

- Přímý požadavek bez odpovědi → stejný `operationId` zopakovat přímo nebo
  přes relay; nikdy nový. Bez odpovědi z obou cest = zobrazit „neznámý stav",
  nabídnout brzdy.
- Přímý kanál nedosažitelný → běžné příkazy přes relay (pomalé, ale se stejnou
  bránou); UI ukáže, kterou cestou jede.

## Záměrně mimo rozsah

- Push stavu a ticků (SSE) — až po prokázání příkazové cesty.
- Jakákoli změna Tradovate workeru a jeho pravidla `manual-entry-relay-only`.
- VPS; víc než jeden exekuční proces; veřejný přístup.

## Otevřené body k oponentuře

1. Stačí podpis zařízení + loopback + Origin, nebo je potřeba i krátkodobý
   token uživatele (odhlášení v appce má přímý kanál zavřít hned)?
2. Kde přesně žije durable tabulka `operationId` a čítače, aby platilo
   INV-WORKER-01 (CAS) a restart nic nezapomněl ani nepřehrál.
3. Souběh: tentýž `operationId` dorazí oběma cestami zároveň.
4. Smí relay zůstat pro Rithmic proces vůbec cestou běžných příkazů, nebo jen
   brzd (méně kombinací = méně chyb)?
5. Capacitor/WKWebView: dosažitelnost `*.ts.net` z nativního shellu, chování
   po uspání a při přechodu Wi-Fi/LTE (změřit na iPhonu, potřebuje Tailscale).

## Výsledek oponentury

### Codex (gpt-6-astra) — OPRAVIT

Směr drží, tyto věci se musí do návrhu doplnit, než vznikne kód:

1. **Pořadí podle příjmu nestačí.** Starý ARM může pomalou cestou dorazit až
   po DISARM a tvářit se jako nový; opožděný vstup může projít po novém ARM.
   → Každý záměr ponese **epochu brzdy/procesu platnou při svém vzniku**
   (podepsanou); brána ji ověří při přijetí i těsně před zápisem. Po brzdě
   musí nový ARM nést aktuální epochu.
2. **Idempotence potřebuje stavy, ne jen mapu.** Jedna lokální transakční
   databáze (např. SQLite) pro obě cesty: atomické vložení (unique/CAS),
   stavy `accepted → sending → terminal | unknown`. `sending` se uloží před
   zápisem k brokerovi; po pádu jen dohledání, nikdy nové provedení. Stejný
   pokus vrací aktuální stav, jiný otisk = konflikt bez zápisu. Otisk zahrnuje
   typ, cílové účty, prostředí a konfiguraci; klíč není oddělený podle zařízení.
3. **Podpis zařízení neřeší oprávnění uživatele.** Trvale povolený klíč
   přežije odhlášení i nedoručené odvolání. → Podpis **plus krátkodobé
   oprávnění** vázané na klíč, uživatele, proces, prostředí a rozsah. Krátký
   token nezaručí okamžité vzdálené odhlášení při výpadku — tento kompromis
   musí být v návrhu výslovně a Filip ho musí odsouhlasit.
4. **Loopback a Origin nejsou identita.** Lokální program Origin napodobí,
   loopback nedokazuje původ ze Serve, kompromitovaný WebView si o podpis
   řekne. → Vlastní klíč každého zařízení, párování s důkazem držení klíče,
   úzký podpisový most, výslovné odvolání; podepisovat i cílový proces
   a protokol; jednorázová čísla evidovat přes restart. Přehrání smí jen
   dohledat tutéž operaci. Určit autentizaci `/status` a jak relay předá
   původní podpis.
5. **Lhůta od příjmu omlazuje starý záměr.** → Neměnná konečná platnost
   záměru (z jeho vzniku) + místní časový rozpočet jako další omezení; pokus
   znovu ji neprodlužuje. Brzdy mají vlastní delší platnost, zámek dne vazbu
   na konkrétní session.
6. **Čítač „provedených vstupů" je slabší než dnešní admission.** → Kapacitu
   rezervovat už při přijetí; počítat i rozpracované a nejasné operace;
   oddělené stropy pro vstupy a správu; klouzavých 24 h; výjimky pro
   snižování rizika.
7. **Chybí matice příkazů.** Vyjmenovat ARM, správu, Flatten, vlastní
   `cancel-entry`, brzdy: co je jen-zpřísnění, konfliktní ARM, reconciliation,
   závěrečná kontrola generace, jednosměrný kill. Zámek brány ani ověřování
   podpisů nesmí brzdy zdržet.
8. **Invarianty.** INV-RELAY-04 přímé HTTPS nezakazuje, ale INV-MANUAL-01
   výslovně požaduje relay. → Nový invariant pro Rithmic (společná admission,
   neměnná identita záměru, jediná zapisující instance); výjimku pro Tradovate
   nerozšiřovat. „Víc procesů mimo rozsah" nenahrazuje vynucený singleton.
9. **První verze: relay jen pro nouzové akce** (brzdy + nutné risk-reducing
   operace vč. Flatten). Běžný fallback až po prokázání společné idempotence,
   expirace a epochy. Deduplikace nouzových akcí mezi cestami od začátku.
10. **Test na skutečném iPhonu je podmínka:** HTTPS/CORS, uspání při
    odesílání, Wi-Fi/LTE, vypnutý Tailscale, odhlášení/odvolání, ztracená
    odpověď. Stav řadit podle instance a revize; `/status` nesmí omladit starý stav.

### copier-design-critic — OPRAVIT (jako kód by nález 1 byl BLOKUJE)

Shoduje se s Codexem a přidává:

1. **Brzda přes relay × vstup přímo je slabší než dnes.** Dnes brzda platí od
   zápisu na serveru (zneplatní čekající vstupy v téže transakci, okno 500 ms).
   Přímý vstup server nevidí: telefon mimo tailnet dá OFF přes relay, PC
   v tailnetu pošle vstup přímo o 200 ms později a proces ho provede, protože
   o brzdě ještě neví. → Každý nebrzdový příkaz nese v podepsaném těle plot
   `{startedAt procesu, brakeEpoch, revize statusu}`; neshoda = odmítnuto,
   znovu ověřit těsně před zápisem. Pořadí = monotónní čítač přidělený
   synchronně při příchodu, ne `Date.now()`. Tvrzení „přísnější než dnes"
   z návrhu vypustit.
2. **Brzdy nesmí potřebovat klíč zařízení.** Jinak nový nebo přeinstalovaný
   telefon nezabrzdí žádnou cestou. Brzdy přes relay autorizuje přihlášení
   uživatele jako dnes; klíč je povinný jen pro příkazy zvyšující riziko.
3. **Brzdy bez kontroly času klienta** (telefon s rozhozenými hodinami musí
   zabrzdit); konec session pro zámek dne z hodin procesu; podpis zámku dne
   vázat na `startedAt`, aby jeho přehrání nezamklo další den.
4. **Relay se „nemění" neplatí.** Se dvěma živými procesy (Tradovate worker
   + Rithmic proces) může brzda skončit u nesprávného; výběr cíle a SQL
   admission stojí na Tradovate připojení. → Výslovné adresování cílového
   procesu a rozhodnutí, zda globální OFF/Kill míří na oba.
5. **Restart mezi „uloženo" a „provedeno"** = `unknown`, blokuje ARM, nikdy se
   neprovede znovu (shodně s Codexem, bod 2).
6. **Lhůty se mezi cestami sčítají** (ztracený přímý požadavek + 15 s ve frontě
   + 5 s v procesu = Market až ~20 s po kliku). → Tvrdý podepsaný čas vzniku
   s limitem rovným lhůtě vstupu; po jejím uplynutí klient už jen čte stav.
7. **`GET /v1/status` musí být podepsaný** — přes Tailscale Serve by jinak
   pozice a účty četl každý uzel tailnetu. Podpisy vázat na `startedAt`
   (restart zneplatní vše rozeslané). Klíč neexportovatelný (iOS Keychain /
   Secure Enclave přes nativní plugin). Registraci klíče povolit jen při
   vypnuté kopírce a flat, s auditem a stropem počtu.
8. **Seznam povolených příkazů pro přímý kanál** (v1 bez změn konfigurace,
   odemčení dne, řešení zaseknutých operací, registrace klíče); zachovat
   slučování ARM a Flatten, zámek „jeden nevyřízený" globálně v procesu,
   výjimky z brzdy pro `cancel-entry` / `attach-brackets` / přidání SL.
9. Záznamy `operationId` držet nejméně 24 h, nevyřízené nikdy neořezávat.
10. Singleton procesu: výlučný zámek souboru a portu před načtením stavu.

**Doporučení k otevřeným bodům (oba recenzenti se shodují):** krátkodobý
token ano (10–15 min, vydává proces přes ověřenou cestu); tabulka operací ve
stejném durable stavu a commitu jako `sending`; souběh přes synchronní
rezervaci; **relay jen pro snižování rizika** (brzdy, Flatten, zrušení
vlastního vstupu, zavření, odvolání klíče, čtení stavu) — vstup, ARM a posuny
jen přímo; chování v nativním shellu změřit na iPhonu.

Potřeba nový invariant (pracovně INV-DIRECT-01) a omezit věty „poll relaye je
jediná cesta příkazů" a „jen přes relay" (INV-MANUAL-01) výslovně na Tradovate
worker. Další dotčená pravidla: INV-ARM-01/03, INV-BRAKE-04, INV-RECON-04,
INV-OUTBOX-02, INV-FRESH-02, INV-UI-03, INV-WORKER-04.

### Rozhodnutí potřebná od Filipa (až se kanál začne stavět)

- Odhlášení na dálku nezabere okamžitě, když je výpadek spojení (token doběhne
  do 10–15 min). Přijatelné?
- Má globální OFF/Kill v appce mířit na oba procesy (Tradovate i Rithmic)?
- Běžné příkazy (vstup, zapnutí, posuny) jen přes přímý kanál, tedy jen
  s Tailscale na telefonu; bez něj zůstanou jen brzdy a zavření. Přijatelné?
