# Ověření navazujícího bloku 5. 9. 2026

Tento dokument odděluje nový blok od předchozích 2 133 testů celé aplikace. Předchozí full-suite výsledek není ověřením pozdějších editací.

## Automatické kontroly

- Model rozhodovacího deníku: 40/40 testů, lint čistý. Skutečně odhalen a opraven sdílený mutable context mezi revizemi. Unknown/rewind, parent a opId, CAS, immutable kontext, limity, snapshot pouze jednou.
- Model a editor fázovaných poznámek: 29/29 testů, lint čistý. Retry, phase chronology, retained revisions, cleared text, missing horizon, rewind, caps a malformed-history preservation.
- Soukromí/storage/transport/Coach: 46 cílených testů prošlo, scoped lint 0 errors / 11 starších warnings.
- Lokální PostgreSQL WASM: 11 invariantů prošlo. Skript `scripts/backtest/verifyPrivateNotes.cjs`, syntetické role a řádky. Owner/anon/cizí uživatel, absence historie v public data, CAS, append-only, prefix retry po další revizi, transakční rollback, safe legacy wrapper, capability.
- Root kontrola diff whitespace čistá. Společný typecheck prošel (exit0). Finální cílený běh: **10 souborů / 156 testů passed** v13.31s; jde o překrývající se integrační běh, nesčítat s agentními počty. Root scoped lint:0errors /11 starších warningů. Produkční build prošel (exit0), oddělený výstup `/private/tmp/alphatrade-backtest-research-build-20260905`,81 precache entries /3999.47KiB. Žádný deploy.

## Browser QA (syntetický harness, port 4184)

Browser používá nahrazené data/storage služby; zmínka o cloudu v jeho UI je pouze syntetický test. Do skutečných trade řádků se nezapisovalo.

1. Na MNQ cursor 2026-08-03 14:00 UTC vytvořen skipped záznam se snapshotem. Revize 1 zachovala původní text a snapshot; revize 2 nový text, retrospective=true, bez další kopie obrázku. Balance 50 000, fills 0, closedTrades 0.
2. Vynucené selhání místního checkpointu neztratilo záznam; následný automatický retry a Reopen saved obnovily 2 rozhodnutí se 3 revizemi bez duplicit.
3. Po finální pause opravě Play → otevření deníku → další nezávislá kontrola po >10 s: kurzor stále přesně14:00. Neobnovilo se přehrávání během zápisu.
4. Rozepsaný text + Upravit jiný záznam vyvolalo explicitní hlášku, text zůstal zachovaný.
5. SnapshotA → zavření → krokB → otevření → save: odmítnut s hláškou, že screenshot pochází z jiného času.
6. Review fixture: vyplněny before+after, proveden Přepočítat, vynucena chyba save, retry uspěl. Původní notes zůstaly, vznikly právě2 revize se stejným operationId, obě closed-trade-review/retrospective. Reopen → další after text → save přidal revizi3, parent2, obě předchozí znění zůstala.

Prohlížeč a část CLI byly během ověření výrazně pomalé; jedna QA karta přestala odpovídat a byla zavřena. Finální uvedené testy proběhly v čerstvé kartě. Příčina systémového zpomalení není prokázaná; nelze ji prohlásit za vyřešenou produkční výkonnost.

## Co toto neprokazuje

- Migrace nejsou nasazené. Skutečné auth/realtime/concurrency přes dvě zařízení nebylo ověřeno.
- Klientské časy nejsou ověřené serverem; označení fáze je evidence aplikačního stavu, nikoli důkaz lidské neznalosti budoucnosti.
- Původní legacy poznámky mají samostatnou neopravenou mezeru ve sdílení (B16).
- Vzdálený MCP zatím novou privátní historii nenačítá. Import nového Trade s historií je explicitně nedostupný.
- Celá roadmapa 48 funkcí není dokončená.
