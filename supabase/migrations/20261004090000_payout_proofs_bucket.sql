-- Důkazy výplat (screenshoty certifikátů) v soukromém úložišti místo base64
-- v business_payouts.description. Řádek výplaty drží jen cestu (imagePath),
-- appka si bere krátkodobé podepsané odkazy. Každý uživatel smí pracovat jen
-- se svou složkou `<auth.uid()>/…`.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('payout-proofs', 'payout-proofs', false, 10485760, array['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists payout_proofs_select_own on storage.objects;
create policy payout_proofs_select_own on storage.objects
  for select to authenticated
  using (bucket_id = 'payout-proofs' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists payout_proofs_insert_own on storage.objects;
create policy payout_proofs_insert_own on storage.objects
  for insert to authenticated
  with check (bucket_id = 'payout-proofs' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists payout_proofs_update_own on storage.objects;
create policy payout_proofs_update_own on storage.objects
  for update to authenticated
  using (bucket_id = 'payout-proofs' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'payout-proofs' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists payout_proofs_delete_own on storage.objects;
create policy payout_proofs_delete_own on storage.objects
  for delete to authenticated
  using (bucket_id = 'payout-proofs' and (storage.foldername(name))[1] = (select auth.uid())::text);
