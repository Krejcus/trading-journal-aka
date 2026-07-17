---
name: supabase-migrate
description: Aplikuje Supabase migraci na AlphaTrade DB a hned zkontroluje advisory (RLS výkon, indexy, security). Použij při jakékoli DDL změně schématu (tabulka, sloupec, index, RLS policy).
---

# Supabase migrace + advisor check

Projekt ID: `kopinlpdvjfgmvxydohk`. Argument = popis změny schématu.

## Kroky

1. **Aplikuj migraci** přes `apply_migration` (NE `execute_sql` pro DDL), `name` v snake_case.

2. **Při RLS policies POVINNĚ použij `(select auth.uid())`**, ne holé `auth.uid()` — jinak se vyhodnocuje per-row (5–10× pomalejší). Vzor:
   ```sql
   create policy x_select on public.x for select using ((select auth.uid()) = user_id);
   ```

3. **FK sloupce → index.** Postgres je neindexuje automaticky. Každý `references` sloupec potřebuje index (nebo ho pokrývá leading column nějakého composite/unique indexu).

4. **Po migraci spusť `get_advisors`** type `performance` A `security`. Oprav vše z TÉTO migrace:
   - `auth_rls_initplan` → přepiš policy na `(select auth.uid())`
   - chybějící FK index → `create index`
   - `unused_index` na NOVĚ přidaném indexu → pokud ho appka nikdy nedotazuje (filtruje se klientsky), zahoď ho
   - Pre-existující varování na cizích tabulkách neřeš (nejsou z této migrace).

5. **Typy:** pokud změna ovlivní TS typy v appce (nový sloupec ve known tabulce), zvaž update `types.ts`.

## Pozn.
- Data separace: backtest = účty `type: 'Backtest'`; nová tabulka navázaná na účty/usera dědí stejný RLS vzor (user_id = `(select auth.uid())`).
- Po `apply_migration` nelze rollback jednoduše — u rizikových změn napřed ověř na malém dotazu přes `execute_sql`.
