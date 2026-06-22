---
name: deploy-check
description: Pre-deploy kontrola AlphaTrade před pushem na Vercel (TypeScript, preview ověření, bezpečný git push). Použij když chce uživatel nasadit / pushnout změny do produkce.
---

# Deploy check (před pushem na Vercel)

Vercel: `main` = produkce (auto-deploy), push větve = preview deploy. Cíl: nepushnout rozbitou produkci.

## Kroky

1. **TypeScript:** `npx tsc --noEmit`. Porovnej proti `.claude/tsc-baseline.txt` — projdou jen pokud nejsou NOVÉ chyby (pre-existující baseline chyby jsou OK). Pokud přibyla chyba, oprav ji a nepokračuj.

2. **Build sanity (volitelně u větších změn):** `npm run build` musí projít (Vite). U malých UI změn stačí tsc + preview.

3. **Preview ověření:** pokud je změna pozorovatelná v browseru, ověř přes Claude Preview (console bez nových errorů, screenshot klíčové obrazovky). Nikdy nenech uživatele ověřovat ručně.

4. **Git — bezpečně:**
   - Zjisti větev (`git branch --show-current`). **Pokud jsi na `main` a jde o netriviální/riskantní změnu, napřed založ větev** (push větve = jen preview deploy, ne produkce) a řekni to uživateli.
   - Commit jen když to uživatel chce. Zpráva končí:
     ```
     Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
     ```
   - Push až po explicitním souhlasu (push na `main` = živá produkce).

5. **Po deployi:** můžeš zkontrolovat build status / logy přes Vercel MCP nebo Supabase `get_logs`, jestli něco nespadlo.

## Pozn.
- iOS PWA: vzhled netestuj přes PWA na ploše z dev serveru (cache) — použij Safari nebo Vercel preview build.
- Nepushuj automaticky. Produkce = `main`; vždy potvrď s uživatelem před pushem na main.
