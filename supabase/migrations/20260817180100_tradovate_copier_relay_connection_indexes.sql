create index if not exists tradovate_copier_commands_connection_idx
  on public.tradovate_copier_commands (connection_id);

create index if not exists tradovate_copier_device_runtime_connection_idx
  on public.tradovate_copier_device_runtime (connection_id);
