-- The baseline integrity migration introduced one optimized owner policy per
-- import table. Remove older equivalent policies so Postgres does not evaluate
-- several permissive policies for every row.

begin;

drop policy if exists import_tokens_select on public.import_tokens;
drop policy if exists import_tokens_delete on public.import_tokens;

drop policy if exists imported_trades_select on public.imported_trades;
drop policy if exists imported_trades_update on public.imported_trades;
drop policy if exists imported_trades_delete on public.imported_trades;

drop policy if exists imported_orders_select on public.imported_orders;
drop policy if exists imported_orders_delete on public.imported_orders;

drop policy if exists import_account_map_select on public.import_account_map;
drop policy if exists import_account_map_insert on public.import_account_map;
drop policy if exists import_account_map_update on public.import_account_map;
drop policy if exists import_account_map_delete on public.import_account_map;

commit;
