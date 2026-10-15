-- 14. 10. 2026: po návratu na 8 s timeout padlo čtení živého vstupu
-- (`canceling statement due to statement timeout`). PL/pgSQL po pěti voláních
-- přejde na obecný plán: pro `archived_epoch > $epoch` neví, že takových řádků
-- je nula, zvolí stránkovací index s filtrem a projde všech ~70k archivovaných
-- řádků (14,5 s). Plán pro konkrétní hodnoty jde přes epochový index (3–4 ms).
-- Stejný vzor mají začátek a úklid kontrolního bodu.

alter function public.read_journal_input_snapshot_latest(uuid,uuid,bigint,text,integer) set plan_cache_mode = force_custom_plan;
alter function public.begin_journal_checkpoint(uuid,uuid,bigint,bigint,bigint[],jsonb) set plan_cache_mode = force_custom_plan;
alter function public.cleanup_journal_checkpoints(uuid,uuid,bigint,integer) set plan_cache_mode = force_custom_plan;
