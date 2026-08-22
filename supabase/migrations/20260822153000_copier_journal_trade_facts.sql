alter table public.tradovate_copier_trades
  add column exit_reason text null
    check (exit_reason in ('sl', 'tp', 'manual')),
  add column entry_price double precision null,
  add column exit_price double precision null;

grant select on table public.tradovate_copier_trades to authenticated;

create policy tradovate_copier_trades_select_own
  on public.tradovate_copier_trades
  for select
  to authenticated
  using (user_id = (select auth.uid()));
