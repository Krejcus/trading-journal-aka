-- iOS 26 WidgetKit push tokens are separate from the normal application APNs
-- token. They are used only to ask WidgetKit for a fresh timeline; the widget
-- then authenticates its read-only snapshot request with the existing hashed
-- access token.

begin;

alter table public.native_widget_devices
  add column widget_push_token text
    check (widget_push_token is null or widget_push_token ~ '^[0-9a-f]{64,512}$'),
  add column widget_push_environment text
    check (widget_push_environment is null or widget_push_environment in ('development', 'production')),
  add column widget_push_bundle_id text
    check (widget_push_bundle_id is null or widget_push_bundle_id = 'app.alphatrade.native'),
  add column widget_push_enabled boolean not null default false,
  add column widget_kinds text[] not null default '{}',
  add column widget_push_last_seen_at timestamptz,
  add column widget_push_last_sent_at timestamptz,
  add column widget_push_last_payload_hash text
    check (widget_push_last_payload_hash is null or widget_push_last_payload_hash ~ '^[0-9a-f]{64}$'),
  add column widget_push_last_urgent_hash text
    check (widget_push_last_urgent_hash is null or widget_push_last_urgent_hash ~ '^[0-9a-f]{64}$'),
  add column widget_push_expired_at timestamptz,
  add column widget_push_last_error text;

create unique index native_widget_devices_widget_push_token_unique
  on public.native_widget_devices (widget_push_token, widget_push_environment, widget_push_bundle_id)
  where widget_push_token is not null;

create index native_widget_devices_widget_push_active_idx
  on public.native_widget_devices (user_id, widget_push_last_seen_at desc)
  where expired_at is null
    and widget_push_expired_at is null
    and widget_push_enabled
    and widget_push_token is not null;

comment on column public.native_widget_devices.widget_push_token is
  'Server-only iOS 26 WidgetKit APNs token. It cannot authorize snapshot reads or broker actions.';

commit;
