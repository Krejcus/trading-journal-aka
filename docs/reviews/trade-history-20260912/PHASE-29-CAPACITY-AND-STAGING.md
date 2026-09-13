# Fáze 29 — kapacita a obnovitelné publikování

Lokálně ověřeno 13. 9. 2026 v izolované pracovní kopii, před sloučením novější hlavní větve.

## Co se změnilo

Finanční projekce se již ukládala po maximálně 100 pozicích / 1 MB, ale všechny její bloky se odesílaly během jediného požadavku. `persistStagedJournalPositions` nyní potvrdí nejvýše osm nových bloků a mezi voláními kontroluje rozpočet pěti sekund. Potom vrátí `processing`; další požadavek používá stejný obsahový klíč a pokračuje pouze v blocích, které databáze dosud nepotvrdila. Teprve konečné atomické publikování nahradí viditelnou historii. Vyčerpání času po posledním zápisu může odložit samotné publikování do dalšího požadavku.

Pět sekund není timeout probíhajícího RPC ani záruka celkové délky HTTP požadavku. Platí pro plánování dalších staging operací; výpočet projekce, načtení snímku a jednotlivé SQL publikování mají samostatné náklady. `processing` nevrací počty jako nové potvrzené výsledky. App již tento stav obnovuje existujícím mechanismem z fáze 15.

## Měření

Opakovatelný lokální skript `scripts/verify-journal-capacity.ts` používá fiktivní plnění a poplatky pro 12 účtů. Kontroluje počty uzavřených epizod, nulové pending a přesné celkové vlastní P&L každého účtu; dále skutečný serializační/chunkovací kód. Naměřeno na tomto Macu:

| Pozice | Raw řádky | Raw JSON | Projekce JSON | Výpočet | Bloky |
|---:|---:|---:|---:|---:|---:|
| 2 400 | 12 013 | 4 794 537 B | 3 407 631 B | 121 ms | 24 |
| 12 000 | 60 013 | 24 073 737 B | 17 107 631 B | 762 ms | 120 |
| 24 000 | 120 013 | 48 360 751 B | 34 388 631 B | 2 236 ms | 240 |

To je důkaz výpočtu a dělení, nikoli vzdáleného síťového výkonu, PostgREST časů nebo neomezené historie. Test má jednoduché uzavřené epizody, nikoli extrémně dlouhé otevřené pozice se stovkami tisíc změn SL. Nadlimitní celek se nadále odmítá explicitně: kompaktní vstup 250 000 řádků/96 MB; replay opožděné entity 100 000/32 MB; projekce 50 000 pozic/96 MB; jedna pozice musí vejít do 1 MB bloku. Cesty nepředstírají dokončenou zkrácenou historii.

## Ověření

- 48 cílených testů: návrat processing po rozpočtu, stejné run key, žádné opakování potvrzených bloků, pomalý ACK, validace rozpočtů, stale generace a odmítnutý final ACK, existující API/sync hranice.
- Skutečný lokální SQL harness s osmi migracemi: 2 400 epizod/12 účtů, obnova po přerušení a opravě, stejná viditelná projection head během každého `processing`, finální součty, opravy poplatků, poznámky, vlastníci, RLS a omezené sdílení. Prošel.
- Celý balík 376 souborů/3 466 testů, TypeScript, scoped lint bez chyb/varování, Vite/PWA build (90 precache), diff check. Logy `/private/tmp/journal-phase29-{capacity,tests,full-tests,sql,types,lint,build}.log`.
- Nejde o grafickou změnu; browser ověření existujícího processing stavu je z fáze 15. Nebyl vzdálený zápis ani broker akce.

## Další krok

Dnešní read-only fetch potvrdil `origin/main=110aa0db5d9582348393babea9d1dda4c9657d81`. Obsahuje tři novější commity než původní základ e61ab59a. Je nutné je integrovat a ověřit v izolaci, aby doručení historie neztratilo novější opravy LIVE hodnot. Sdílená necommitnutá canonical pracovní kopie zůstává beze změn.

Reálný přihlášený tok, DEMO conformance a aktivace osmi databázových migrací / nového workeru nejsou tímto ověřené. Patří do konkrétního schváleného aktivačního kroku se samostatnou zálohou.
