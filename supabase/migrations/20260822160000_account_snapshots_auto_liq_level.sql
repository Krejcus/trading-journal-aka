-- Skutečný broker floor pro offline fallback Kokpitu účtů.
-- Migrace je pouze připravená; před aplikací je nutný export/záloha produkce.

begin;

alter table public.copier_account_snapshots
  add column auto_liq_level double precision null;

alter table public.copier_account_snapshots
  add constraint copier_account_snapshots_auto_liq_level_finite check (
    auto_liq_level is null or auto_liq_level not in (
      'Infinity'::double precision,
      '-Infinity'::double precision,
      'NaN'::double precision
    )
  );

comment on column public.copier_account_snapshots.auto_liq_level is
  'Brokerem vrácený auto-liq floor účtu v okamžiku snapshotu.';

commit;
