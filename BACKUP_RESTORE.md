# AlphaTrade — záloha a obnova

Tento dokument označuje bezpečný návratový bod aplikace AlphaTrade a rozšíření AlphaBridge před rozsáhlejšími úpravami.

## Bezpečný bod

- Vytvořeno: 19. 7. 2026 v 07:50 (Europe/Prague)
- Git větev: `main`
- Git commit: `38b1f0532616c765b934d96c0119c0baf43b5f07`
- Kompletní archiv: `/Users/filipkrejca/Documents/AlphaTrade-backups/alphatrade-complete-2026-07-19-0750.tar.gz`
- Git bundle: `/Users/filipkrejca/Documents/AlphaTrade-backups/alphatrade-git-2026-07-19-0750.bundle`

Archiv obsahuje zdrojové kódy aplikace, zdrojové kódy extensionu, sestavený `extension/dist`, konfiguraci, lock soubory a lokální Git repozitář. Neobsahuje `node_modules` ani dočasné build cache; ty jsou obnovitelné instalací závislostí.

## Ověřené kontrolní součty SHA-256

```text
30516e1ff3b577a8242f15b6ba4a6af0ac70d8c5109c215b8a966622b277aaad  alphatrade-complete-2026-07-19-0750.tar.gz
a1c60538912b2e69ed561f8764988f05079ab86aa4897602b8dc5ebe6b7b87e7  alphatrade-git-2026-07-19-0750.bundle
```

Git bundle byl při vytvoření ověřen příkazem `git bundle verify` a obsahuje kompletní historii všech tehdejších větví a referencí.

## Pravidlo pro budoucí úpravy

Před změnou databázového schématu, Supabase migrací/RLS/Storage, Vercel environment variables nebo jiné produkční konfigurace musí Codex uživatele výslovně upozornit. Současná souborová záloha tyto vzdálené systémy neobsahuje; před takovou změnou je potřeba vytvořit jejich samostatnou zálohu nebo export.

Při požadavku typu „vrať vše na backup“ se nejdříve musí potvrdit přesný cíl obnovy a zkontrolovat současné neuložené změny. Obnova přepíše novější práci, proto se nesmí spustit bez explicitního souhlasu uživatele.

## Postup obnovy

1. Zastavit vývojové servery a zkontrolovat současný stav pomocí `git status`.
2. Pokud existuje novější práce, nejdříve ji samostatně zazálohovat.
3. Ověřit SHA-256 archivu a Git bundle proti hodnotám výše.
4. Obnovit celý adresář `trading-journal-aka` z kompletního archivu, případně obnovit Git historii z bundle.
5. V kořeni aplikace i v `extension/` nainstalovat závislosti podle lock souborů.
6. Spustit testy a build hlavní aplikace i extensionu.
7. Ověřit localhost a načíst obnovený `extension/dist` v prohlížeči.

Tento dokument je provozní poznámka. Nemění runtime aplikace ani extensionu.

## Migrační bod pro nový Mac — 6. 8. 2026

Před smazáním původního Macu byl vytvořen nový lokální migrační bod z větve
`codex/tradecopia-shadow-sync` na commitu
`f060676bd4c8d819e56e9f5e583d08f3a5984936`.

Migrační soubory jsou v adresáři:

```text
/Users/filipkrejca/Documents/AlphaTrade-migration-2026-08-06
```

Obsah:

- `alphatrade-all-refs-2026-08-06.bundle` — kompletní Git historie a lokální větve.
- `alphatrade-source-and-extension-2026-08-06.tar.gz` — aktuální zdrojový strom bez secrets, závislostí a build cache.
- `alphabridge-dist-2026-08-06.tar.gz` — ověřený sestavený `extension/dist`.
- `PRIVATE-local-config-2026-08-06.tar.gz` — `.env.local`, `.env.vercel.txt`, `.mcp.json` a lokální Codex konfigurace.
- `PRIVATE-codex-continuity-2026-08-06.tar.gz` — lokální Codex tasky, paměti, skills, pravidla a stav aplikace bez `auth.json` a browser cookies.

Soukromé archivy mají oprávnění pouze pro vlastníka. Přenášejí se přímo mezi
Macy (například AirDrop nebo šifrovaný disk), nikdy přes GitHub ani nešifrované
sdílené úložiště. Přihlašovací údaje a browser relace se na novém Macu obnoví
novým přihlášením.

Kontrolní součty všech migračních souborů jsou uložené vedle archivů v
`SHA256SUMS.txt`.

Před smazáním starého Macu musí na novém projít:

1. Ověření uvedených SHA-256 a `git bundle verify`.
2. Obnova/klon repozitáře a checkout commitu `f060676`.
3. Bezpečné obnovení lokální konfigurace bez commitu secrets.
4. `npm ci`, TypeScript, testy a produkční build hlavní aplikace.
5. `npm ci` a build v `extension/`, následně načtení `extension/dist` v Chrome.
6. Přihlášení do Codexu, GitHubu, Supabase, Vercelu, TradingView a TradeCopie.
7. Ověření localhostu, MCP AlphaTrade, živého sběru dat a funkce AlphaBridge.

Při vytvoření tohoto bodu prošlo 54 testovacích souborů / 319 testů, TypeScript,
produkční build aplikace a produkční build AlphaBridge.
