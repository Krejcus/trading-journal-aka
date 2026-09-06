# Návrh aktivace backtest persistence a výzkumných dat

Stav 5. 9. 2026: **připraveno pouze lokálně, aktivace neschválená a neprovedená**. Návrh nyní zahrnuje pět konkrétních migrací. Souhlas s pokračováním lokální implementace není schválení exportu vzdálené DB ani produkčních změn. Před spuštěním se musí znovu zkontrolovat přesný diff, aktuální remote stav a záloha podle `AGENTS.md`.

## Přesný rozsah

| Pořadí | Soubor | Dopad |
|---|---|---|
| 1 | `20260905173116_backtest_review_atomic_patch.sql` | Owner/backtest review, edited-field CAS, atomický screenshot append. |
| 2 | `20260905190446_backtest_private_trade_note_history.sql` | Owner-only historie poznámek a private_v1 RPC v jedné transakci s review. |
| 3 | `20260905193801_trade_legacy_notes_privacy_and_owner_consent.sql` | B16: oddělení původních poznámek od veřejného JSON, backfill/recovery, bezpečná projekce, receiver consent a ochrana přijetí connections. |
| 4 | `20260905194508_backtest_tag_library_atomic_commit.sql` | F33: owner katalog, explicitní historický merge, CAS a atomické patche + retry receipts. |
| 5 | `20260905194812_backtest_research_rule_history_guard.sql` | F09: zachování prefixu pravidel a baseline v Labu, ochrana před starým full-JSON přepisem. |

Soubory jsou v `supabase/migrations/`. Checkout má i nesouvisející migrace; obecný `db push` přes celý seznam není tento návrh.

**Transakce:** třetí soubor už obsahuje vlastní `BEGIN/COMMIT`. Nesmí se bez úpravy schváleného deployment runneru vložit do širší transakce s předpokladem, že vnitřní COMMIT nic nepotvrdí. První dva soubory lze aktivovat společně; třetí používá svůj ověřený transakční obal; čtvrtý a pátý dostanou vlastní řízenou transakci. Případné sjednocení obalů nejdřív ověřit ve staging kopii. Cíleně zaznamenat migration history, nikoli jen provést SQL mimo evidenci.

## Samostatná záloha a preflight

1. Schváleným správcovským přístupem uložit export mimo git do neveřejné složky. Zahrnout schema/data/RLS/grants/owners/funkce a triggery dotčených `trades`, `connections`, `lab_experiments`, `chart_templates`, existujících privátních poznámek a případných tag tabulek. Zachovat vazby a aktuální definice `get_dashboard_data`, `get_public_trade`, review/consent funkcí. Nepředpokládat, že nová tabulka nebo schema ve vzdáleném systému ještě neexistují.
2. Uchovat kompletní seznam pending migrací, přesné SHA-256 souborů a jejich diff. Ověřit obsah archivu, exit codes a obnovitelnost v izolované kopii se skutečnými rolemi/policies. Snapshot tag polí před explicitním historickým merge je samostatný od schema zálohy.
3. Pro B16 použít pouze read-only [preflight SQL](../../../scripts/backtest/legacyNotePrivacyPreflight.sql) a postup v [B16_PRIVACY.md](B16_PRIVACY.md). Ověřit skutečnou velikost trades/backfill, lock timeout a rollback na stagingu.
4. Pro F33 **ověřit, že `alphatrade_private` není vystavené Data API ani GraphQL**. SECURITY INVOKER RPC potřebuje authenticated oprávnění na interní tabulky; přímé vystavení schematu by umožnilo obejít CAS. Podrobnosti v [F33_TAG_LIBRARY.md](F33_TAG_LIBRARY.md).
5. Ověřit skutečný stav existujícího `lab_experiments`, případnou nevalidní výzkumnou historii, návaznost a zdroj top-level rule/hypothesis. Připravený guard nemění staré záznamy backfillem. SHA hash ověřuje aplikace; není to důvěryhodný serverový čas registrace hypotézy.

## Ověření po cílené aktivaci

- Skutečný PostgREST/RPC přístup jako owner, jiný owner, accepted sender/receiver a anon. Neomezit se na render UI; zkontrolovat i syrovou table/JSON odpověď, reverse direction, public shareNotes zap/vyp, account scope, revokaci a owner-only historii.
- Dvě zařízení: disjunktní review edits, stejná pole, screenshot append, uncertainty retry, pozdější revize, auth switch a reálný reload. Missing capability musí zachovat draft a zastavit před uploadem.
- Tag knihovna: jeden později konfliktní obchod zruší celý batch; opakování stejné operation ID po pozdější změně vrací aktuální autoritativní hodnoty, nepřehraje starý patch. Ověřit 500 IDs, aliasy a zachování automatického původu.
- Pravidla: starý klient nesmí odstranit historii ani změnit baseline; v2 nezmění v1, metadata dokončení fungují, export/hydratace zachovají konkrétní run/trade vazbu.
- Security/performance advisory a kontrola všech zbývajících findings. Zde vzdálené advisories spuštěny nebyly. Frontend a MCP deployment jsou další konkrétní kroky vyžadující schválení, nikoli automatický důsledek SQL aktivace.

## Rollback a platné limity

Preferovat kompatibilní verzi funkcí při zachování nových privátních dat a revizí. Nedropovat tabulky za účelem frontend rollbacku; neobnovovat celý starý dump přes novější legitimní editace. Původní poznámky mají owner-only recovery fragmenty a cílený [recovery dotaz](../../../scripts/backtest/legacyNotePrivacyOwnerRecovery.sql). Historický tag merge nelze vrátit pouhým rollbackem schématu; potřebuje původní snapshot a nový podmíněný patch.

B16 je lokálně připravené řešení trade notes, nikoli vyřešení všech existujících profile/prep/review/account ACL. Jejich širší zjištěné expozice uvádí samostatný B16 report. F09 neaktivuje uzamčený neviděný vzorek; F10/F11 stále čekají. F33 wrapper/hlavní UI se ještě dokončuje.

Lokální ověření: [rule-robustness-validation.md](rule-robustness-validation.md), [B16_PRIVACY.md](B16_PRIVACY.md), [F33_TAG_LIBRARY.md](F33_TAG_LIBRARY.md). Odpovídá používání [Postgres triggerů](https://supabase.com/docs/guides/database/postgres/triggers) a [ochraně Data API](https://supabase.com/docs/guides/api/securing-your-api); tato dokumentace nenahrazuje skutečnou kontrolu nasazeného prostředí.
