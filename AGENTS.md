# AlphaTrade / AlphaBridge — pokyny pro Codex

## Struktura projektu

- Kořen repozitáře obsahuje React/Vite aplikaci AlphaTrade.
- `extension/` obsahuje Chrome extension AlphaBridge.
- `extension/dist/` je sestavený výstup extensionu a negeneruje se ruční editací.

## Ověření změn

Před předáním změn spusť podle rozsahu:

```bash
npm ci
npx tsc --noEmit
npm test -- --run
npm run build
```

Při změně AlphaBridge navíc:

```bash
cd extension
npm ci
npm run build
```

## Bezpečnost a produkce

- `main` je napojený na produkční Vercel. Push na `main` nedělej bez výslovného souhlasu uživatele.
- Před změnou Supabase schématu, RLS, Storage, Edge Functions, Vercel environment variables nebo jiné produkční konfigurace uživatele výslovně upozorni a nejdřív navrhni samostatnou zálohu/export vzdáleného systému.
- Nikdy necommituj `.env*`, `.mcp.json`, `.codex/` ani jiné tokeny a secrets.
- Pro databázové změny používej verzovanou migraci a po změně spusť Supabase security/performance advisory.

## Návratový bod

Bezpečný lokální návratový bod a postup obnovy jsou popsány v `BACKUP_RESTORE.md`. Souborová záloha neobsahuje pozdější změny živého Supabase ani Vercel konfigurace.

## Cloudové omezení

Cloudový Codex může pracovat s kódem dostupným na GitHubu i při vypnutém Macu. Nemůže ale ovládat lokální Chrome, TradingView, načtený `extension/dist`, localhost ani soubory/commity, které nebyly pushnuté na GitHub.
