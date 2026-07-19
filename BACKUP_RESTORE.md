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
