-- Private durable storage for generated report artifacts. Financial report data is
-- intentionally not introduced by this migration.
insert into storage.buckets (id, name, public)
values ('report-archives', 'report-archives', false)
on conflict (id) do update set public = false;

create policy "approved users can read report archives"
on storage.objects for select to authenticated
using (bucket_id = 'report-archives' and public.is_approved_user());

create policy "admins can archive reports"
on storage.objects for insert to authenticated
with check (bucket_id = 'report-archives' and public.is_admin());

create policy "admins can replace report archives"
on storage.objects for update to authenticated
using (bucket_id = 'report-archives' and public.is_admin())
with check (bucket_id = 'report-archives' and public.is_admin());
