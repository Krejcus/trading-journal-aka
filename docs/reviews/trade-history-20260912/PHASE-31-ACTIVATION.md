# Fáze 31 — schválená produkční aktivace, 13. 9. 2026

Uživatel výslovně schválil aktivační plán v `ACTIVATION-REVIEW.md`. Samostatně po vysvětlení schválil i aktualizaci weekly-report včetně jeho stávajícího přenosu obchodních dat do Anthropic. Nebyl proveden ARM, Flatten ani testovací broker příkaz.

## Záloha a nasazení
- Soukromá záloha: `/Users/filipkrejca/Documents/AlphaTrade-backups/2026-09-13-history-activation`, adresář 0700, soubory 0600.
- Supabase eviduje 7 dokončených denních fyzických záloh, poslední 12. 9. 22:15 UTC; PITR není aktivní.
- Čerstvý export: schema.sql 625331 B a data.dump 70611497 B (public, auth, storage, supabase_migrations). pg_restore přečetl seznam i dekódoval celý archiv. To není provedená obnova živého projektu. Šest dotčených Edge Functions má zálohu zdrojů; zachovaný původní worker, LaunchAgent a produkční ukazatel. Kontrolní součty v checksums.json.
- Metadata Storage jsou v DB archivu. Čtyři HEAD kontroly (2 z každého bucketu) vrátily 200 a odpovídající délku. Objekty samotné nebyly zálohované; hromadný export automatická kontrola odmítla jako rozšíření plánu.
- Původní produkce: main 110aa0db5d9582348393babea9d1dda4c9657d81, dpl_AbkLYgFH5FuZAZ3iCK9ewoAtzfKp. Main byl před aktivací znovu načten a nezměnil se.
- Všech osm plánovaných migrací aplikováno úspěšně přes Supabase apply_migration. Nástroj přiděluje vzdálené migrační verze; lokální soubory zůstávají původní.
- Aplikační commit 26efeada72aca233983e401b951d67aee5a7121c, Vercel dpl_4DwVJPEjSheiE7wjiGeFCbtFFbWW READY. Nejprve sestaveno bez hlavní veřejné adresy, potom promote. Hlavní alias HTTP 200, index-Bhvwu6EG.js.
- Edge Functions ACTIVE: daily-start-brief v9, loss-day-debrief v8, morning-affirmation v9, morning-brief v11, proactive-greeting v15, weekly-report v6. JWT nastavení zachováno; weekly-report má stávající vlastní cron autentizaci.

## Skutečné ověření
- Přihlášený browser: vlastní dashboard, historie, LIVE a sdílený feed Nikola se načítají. LIVE potvrzuje zpracování uložených záznamů a ukazuje kombinované/individuální zobrazení.
- Skutečné databázové role/claims: povolený divák obdržel 83 řádků, pending divák 0. Anon nemůže spustit nové shared RPC, authenticated nemůže append evidence. Tyto SQL kontroly nejsou vydávané za samostatné nové přihlášení druhého uživatele ani za test skutečného odebrání souhlasu přes UI.
- Autoritativní reconcile před i po instalaci: authoritativelyClean=true, missingAccounts=[], divergentAccounts=[], workingOrderAccounts=[], groupFlat=true. Worker connected, DISARMED, bez stuck outbox/operací a lastError.
- Worker bundle SHA256: 1908cbabdf4bedd14d7284bfc61258e71814c43bd781b7eea11d592e0452b0c7. Stávající párování a skupina zachovány.
- Skutečný tok: 66 + 72 událostí ze dvou DEMO připojení. Lokální JSONL upload cursory odpovídají plné velikosti souborů (32520 a 35389 B). SHA256 seřazených event IDs souhlasí přesně s DB pro obě připojení:
  - 53157614…: 015309513b8776e40a91e2da4e7b985213a25a545adc3c2ad6a340a85e3f7043
  - 754e4b5b…: 49107895391bb5f9afb7e9c8612c81b24d88b35ce40f826b763222e5106660f4
- Upload i přihlášené importy vracejí 200. Input through/target a completed_revision se shodují (138 pro první připojení, 72 pro druhé; globální ingest IDs nejsou počty řádků).
- Žádné potvrzené uzavřené nové pozice nebyly vytvořeny. Broker v tomto nedělním načtení vrátil prázdné seznamy fill/order/orderVersion. Evidence obsahuje 107 cashBalanceLog, 7 positionSnapshot, 4 connection a 20 výsledků dočítání. Scházející staré posuny nelze domyslet.
- Runtime scan: journal endpointy 200; pozorovaná deprecation warning url.parse v existujícím cronu, bez doložené journal chyby. Build má stávající dependency/chunk warnings.

## Zbývající ověření a omezení
- Kompletní nový DEMO obchod s entry, opakovanými SL/TP posuny a exit na více účtech stále potřebuje skutečné uživatelské plnění. Samotná nedělní data tento scénář nepotvrzují. Úloha proto není vydávána za úplnou broker conformance.
- Skutečné odebrání sdílecího souhlasu a následný požadavek již přihlášeného diváka nebyly provedeny v produkčním UI.
- Historické syntetické/nepodložené copier řádky se nezahrnují do potvrzených statistik; dřívější hodnoty proto mohou z hlavního přehledu zmizet a patří do oddělené kontroly/archivu. Nejde o důkaz, že broker nevykonal původní obchod.
- Security/performance advisors proběhly. Nové interní staging tabulky mají záměrně RLS bez client policy. Doporučení na FK indexy connection_id/device_id u evidence zůstává informativní; existující vector/public definer/Auth a legacy policy varování nejsou vyřešena tímto nasazením. Viz https://supabase.com/docs/guides/database/database-linter .
- LIVE dále ukazuje dřívější CDP nedostupnost snímků a 4 účty bez dokončeného plánu. Tyto konfigurace se neměnily.
- Weekly reporty existují: 9 řádků, poslední 6. 9. 2026 17:01 UTC. Stávající kód je ukládá do weekly_reports a AI paměti; služba coachTools je čte pro Coach. Automatické e-mailové/push doručení nebylo nalezeno ani přidáno.

