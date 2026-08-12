-- Original Finance Payment Tracker workbooks are immutable source evidence.
-- They remain private and are never a public report archive or B2C payment ledger.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'b2c-finance-imports',
  'b2c-finance-imports',
  false,
  10485760,
  array['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']
)
on conflict (id) do update set
  public = false,
  file_size_limit = 10485760,
  allowed_mime_types = array['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'];

create policy "admins can read B2C Finance import sources"
on storage.objects for select to authenticated
using (bucket_id = 'b2c-finance-imports' and public.is_admin());

create policy "admins can store B2C Finance import sources"
on storage.objects for insert to authenticated
with check (bucket_id = 'b2c-finance-imports' and public.is_admin());

create policy "admins can remove failed B2C Finance import sources"
on storage.objects for delete to authenticated
using (bucket_id = 'b2c-finance-imports' and public.is_admin());
