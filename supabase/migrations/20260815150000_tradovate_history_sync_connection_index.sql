-- Cover the nullable connection foreign key used when an OAuth connection is
-- disconnected or deleted. The historical identity remains account-based.
create index tradovate_history_syncs_connection_id_idx
  on public.tradovate_history_syncs (connection_id)
  where connection_id is not null;
