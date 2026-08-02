-- Audit rows are append-only and inserted only by a database trigger. The snapshots
-- intentionally retain before/after JSON so a later UI change cannot lose history.
create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_profile_id uuid references public.profiles(id),
  actor_email citext,
  area text not null,
  record_id uuid,
  action text not null check (action in ('insert', 'update', 'delete')),
  before_value jsonb,
  after_value jsonb,
  reason text,
  request_context jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default timezone('utc', now()),
  check (before_value is not null or after_value is not null)
);

create or replace function public.write_audit_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  before_snapshot jsonb := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
  after_snapshot jsonb := case when tg_op = 'DELETE' then null else to_jsonb(new) end;
  changed_record_id uuid;
  actor_email_snapshot citext;
begin
  changed_record_id := coalesce(
    nullif(after_snapshot ->> 'id', '')::uuid,
    nullif(before_snapshot ->> 'id', '')::uuid,
    nullif(after_snapshot ->> 'profile_id', '')::uuid,
    nullif(before_snapshot ->> 'profile_id', '')::uuid
  );

  select email into actor_email_snapshot from public.profiles where id = auth.uid();

  insert into public.audit_events (
    actor_profile_id, actor_email, area, record_id, action,
    before_value, after_value, reason
  ) values (
    auth.uid(), actor_email_snapshot, tg_table_name, changed_record_id, lower(tg_op),
    before_snapshot, after_snapshot,
    coalesce(after_snapshot ->> 'reason', after_snapshot ->> 'manual_entry_reason',
      after_snapshot ->> 'reason_or_reference', after_snapshot ->> 'resolution_note',
      before_snapshot ->> 'reason')
  );
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

-- Triggers are attached in the final migration, after integration and report tables
-- exist. Keeping the function here makes audit behaviour available to that step.
