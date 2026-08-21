-- Oprava CHECK constraintu widget_push_token: POSIX regex v Postgresu má
-- tvrdý limit opakování {n,m} s m <= 255. Původní '^[0-9a-f]{64,512}$'
-- prošel DDL (výraz se při CREATE nevaliduje), ale KAŽDÉ vyhodnocení při
-- zápisu řádku padalo s `2201B invalid repetition count(s)` — proto každý
-- POST /api/native-widget-push-subscription končil 500
-- widget-push-upsert-failed a widget_push_token zůstával prázdný.
-- Délku hlídá char_length, regex jen znakovou sadu.

begin;

do $$
declare c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_attribute att
      on att.attrelid = con.conrelid and att.attnum = any(con.conkey)
    where con.conrelid = 'public.native_widget_devices'::regclass
      and con.contype = 'c'
      and att.attname = 'widget_push_token'
      and cardinality(con.conkey) = 1
  loop
    execute format('alter table public.native_widget_devices drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.native_widget_devices
  add constraint native_widget_devices_widget_push_token_check
  check (
    widget_push_token is null
    or (
      char_length(widget_push_token) between 64 and 512
      and widget_push_token ~ '^[0-9a-f]+$'
    )
  );

commit;
