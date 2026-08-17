-- Cover the OAuth connection foreign key for deletes and device lookups.
create index if not exists tradovate_copier_devices_connection_idx
  on public.tradovate_copier_devices (connection_id);
