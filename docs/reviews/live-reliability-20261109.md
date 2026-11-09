# LIVE: kapacita a kontinuita správy obchodu — 9. 11. 2026

## Stav a zdroj

Lokální balík v `/private/tmp/at-live-reliability-20261109`, větev
`codex/live-reliability-20261109`, základ `cbce5d1b` včetně `2c6b588f`.
Žádný push, produkční DB změna, instalace workeru/iPhonu ani brokerový příkaz
během této opravy. Documents a Claudův request-budget checkout zůstávají zachované.
Tento report není potvrzení nasazení ani živého obchodního ověření.

## Oprava příčiny

1. Worker uchová skutečný důvod refusal včetně snapshotu. Lokální budget se
   nezmění na výpadek nebo broker429. Chybějící/malformed hard-refusal snapshot
   zastaví všechny dispatches do novějšího authority readu; starší in-flight read
   nesmí latch vymazat. Starší/equal snapshot nezvýší freshness ani nesníží counters.
2. Background1200/h a 40/min, risk2400/h a 80/min a read-only recovery240/h a 24/min mají
   oddělené limity pod jedním broker-principal DB zámkem a total4000 rezervací/h.
   Policy2 je explicitní. Skutečná penalizace blokuje každou kategorii.
   Management přijatého obchodu stále nemá novou kreditovou frontu. **Total není
   tvrdý celkový počet broker writes**; externí platformy mají vlastní spotřebu.
3. BG pool nejvýš 2, pouze pro již čekající práci. Priority permit přesně 1,
   jednorázový, ověřený znovu po token await. Návrat nevyužitých kreditů se nezavádí.
4. ARM/auto-resume i nové vstupy mají finální blocker aktuální sdílené kapacity.
   ARM, kill, day lock, outbox a ownership nepřebírá server ani display.
5. Bootstrap identity directory workeru čte jen account/list, bez25–40 nepoužitých
   finančních/history dotazů. Výsledek obsahuje pouze id/name; nenese ARM oprávnění.
   Sync/reconnect baseline a nutná metadata mají omezenou interní recovery cestu.
6. Souběžná čtení odděluje principal, host, socket/generace a účel. Urgentní
   správa se nepřipojí na dřívější blokovaný background fetch. Fresh order graph
   sdílí jen právě probíhající čtení, nikoli pozdější read po write.
7. Úplná display coverage vyžaduje validované Position+Order REST čtení.
   Pole sync ACK samo nic nedokazuje. Trade ingress invalidate proběhne před
   semantic awaits; malformed/unknown scope invaliduje vše. Pár se smí dokončit
   až při shodné session/host/generaci bez semantic backlogu. Provenance fyzické
   promise a per-part sequence brání rollbacku novějšího stavu opožděným
   background výsledkem nebo jeho pozdním joinerem. Na heartbeat se neomlazuje
   timestamp brokerových dat. Bez proof se ponechá řízený, pravdivý fallback.
8. UI rozliší budget/cooldown/captcha od ztraceného OAuth. Nepožaduje zbytečný
   reconnect a neoznačuje neověřená data za zdravá. Staré reauthorization hlášení
   smí odstranit až novější úspěšné čtení.

## Ověření

- 166/166 cílených testů v 16 sadách: governor/refusal/server/API, real broker
  adapter, dedup, complete coverage, reverse completion, same-clock+late joiner,
  reconnect, risk, ARM a zachování accepted cancel/Flatten scope; UI render.
- Skutečný dočasný lokální PostgreSQL 18: v1: 14/14, v2: 18/18. Dvě držené transakce
  pod stejným broker principalem, různí owners/aliases; minutové i hodinové lanes,
  actual penalty ve všech lanes, upgrade bez resetu rezervací/epoch/cooldown/ACL.
  Dočasný cluster je po testech zastavený. Živý Supabase se nepoužil.
- Deterministický hodinový replay actual broker/governor kódu,4 a 8 účtů, 2 routes,
  2 pokryté displeje, risk po 30 s/display po 30 s. Pro 8 účtů: 2162 risk + 480 BG = 2642
  fyzických čtení a stejný počet rezervací,0 zbytečných rezervací/odmítnutí.
  Pro 4 účty 1682 celkem. **Není to hodinový živý test**, nepokrývá libovolné počty
  full reloadů, externí Tradovate aplikaci, novou session ani všechny journal backfily.
- Worker bundle esbuild prošel. Cílený ESLint: 0 errors, 2 warningy v broker adaptéru.
- Po potvrzení OFF/flat proběhlo izolované npm ci (také extension dependency graph),
  plný tsc se 4GB heapem exit0, web i native build a podepsaný Xcode device build.
  Plná sada v prostředí s lokálními testovacími servery ještě běží. První průchod
  odhalil neúplný testovací fill fixture v journal observer; doplněn platný tvar
  a jeho samostatná sada 20/20 prošla. Produkce se tímto ověřením ještě nemění.
- Finální nezávislá oponentura: OK S VÝHRADAMI; bez zbývajícího blokujícího
  code nálezu, výhrady: plný typecheck/build a provozní/brokerové ověření.

## Co balík vědomě nemění

Sekvenční per-account IO v prepareGroupPositionManagement a eventTail zůstává;
read-only přípravu se nevyplatí v tomto incident balíku přepisovat bez dalšího
fencovaného návrhu a měření. Nikde se nečeká na aplikaci risk pollu zevnitř tailu.
Při skutečně starém riziku se jeho použití nadále odmítne. Nelze nyní slíbit,
že všechny posuny budou do konkrétního času nebo že broker nikdy data neomezí.
Více Maců/distribuovaný execution fencing ani úplný globální wire meter nejsou
součástí této opravy. Registry prvního OAuth aliasu po jeho odvolání je starší
samostatný limit. Oprava nesmí povolit živý obchod jako test těchto mezer.

## Dokončení a nasazení

1. Potvrdit aktuální flat/OFF a čerstvé broker positions/orders; bez tohoto
   důkazu nereinstalovat worker. Samotný starší log není aktuální broker proof.
2. V samostatném čistém release checkoutu izolovat dependencies; npm ci,
   typecheck s dostatečnou pamětí, plná sada, web/native a oba worker bundly.
3. Před produkční migrací samostatně exportovat funkci, grants/control metadata
   a oprávnění, zaznamenat checksum. Neexportovat tokeny do repa. Použít verzovanou
   `20261109162721_live_request_capacity_v2.sql`; nic nečistit ani neresetovat.
4. Migrace → kontrola policyVersion 2/per-lane counters/ACL a security+performance
   advisory → web/server → worker → native iPhone. Nový worker bez policy2 nemá
   ARM povolené; pořadí se nesmí obrátit. Po instalaci ověřit manifest/sha,
   DISARMED, route ownership, continuity coverage a nové request health.
5. Jen schválené DEMO8661118 / účet 61038658 / MNQ, nikoli Lucid/funded testy.
   Limit+cancel, Market+SL/TP+close, porovnat skutečné fáze/projekci na PC/telefonu,
   poté final fresh flat/no-working/OFF. Zvlášť výpadek proudu/reconnect, plnýBG
   se zdravou risk/recovery kapacitou, actual cooldown a dvě UI současně.
6. Ověřit skutečnou delší spotřebu, ne extrapolovat tento model na upstream SLA.

Diagnostické logy jsou mimo repo v `/private/tmp/at-reliability-*`.
