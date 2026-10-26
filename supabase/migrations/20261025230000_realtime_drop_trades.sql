-- Realtime: appka od 25. 10. 2026 odebírá malé řádky sync_changes (delta sync),
-- celé řádky trades s blobem data už nikdo neposlouchá. Review 2a: Realtime
-- dekódoval každou změnu obchodu = ~40 % času DB.
-- Rollback: alter publication supabase_realtime add table public.trades;
alter publication supabase_realtime drop table public.trades;
