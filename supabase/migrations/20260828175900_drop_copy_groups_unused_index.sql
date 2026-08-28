-- Knihovna obsahuje nejvýše desítky profilů na uživatele a primární klíč už
-- pokrývá vlastnické filtrování. Tento index nepodporoval řazení podle
-- created_at a Supabase advisor jej proto správně označil jako zbytečný.
drop index if exists public.copy_groups_user_updated_idx;
