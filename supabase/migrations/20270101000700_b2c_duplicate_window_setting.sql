-- ---------------------------------------------------------------------------
-- B2C duplicate-detection window: make the fixed 48-hour window Admin-editable.
--
-- Every B2C "possible duplicate" check -- the manual-bank-transfer preview in
-- src/server/repositories/b2c-payments-repository.ts and the ledger's
-- protected constructor public.open_b2c_payment_duplicate_group (the live
-- version, redefined by 20270101000500_remove_b2c_category.sql) -- has always
-- compared payments using a fixed 48-hour window. This migration moves that
-- number into a tiny Admin-editable settings table so Finance can widen or
-- narrow the window without a code deploy, while every other matching rule
-- (effective customer email, USD amount, business date) is unchanged.
--
-- b2c_settings is a genuine singleton: `id boolean primary key default true`
-- with a check that id is always true makes a second row impossible, the same
-- shape commonly used for one-row configuration tables. The one row is
-- bootstrapped below at the documented historical default (48 hours) before
-- any trigger exists, so the bootstrap itself is not an audited "change" --
-- updated_by stays null until the first real Admin edit. Every subsequent
-- change goes through update_b2c_duplicate_detection_window: an Admin-only,
-- bounded, audited RPC modeled directly on revise_financial_target
-- (20270101000300_finance_targets_reports.sql) -- a plain (non-security-
-- definer) function that relies on the admin_update RLS policy below, with a
-- BEFORE UPDATE trigger stamping the actor and the shared write_audit_event()
-- trigger recording the before/after row, actor, and reason in audit_events.
-- ---------------------------------------------------------------------------

-- write_audit_event() (20270101000300_finance_targets_reports.sql) always
-- casts the audited row's "id" field to uuid to populate audit_events.
-- record_id. Every other audited table keys on a uuid, but b2c_settings below
-- is a genuine singleton keyed by a boolean ("true"), so that bare `::uuid`
-- cast raises 22P02 (invalid_text_representation) the moment b2c_settings is
-- written -- confirmed against supabase/tests/b2c_settings.test.sql before
-- this fix. safe_uuid_cast lets write_audit_event() degrade to a null
-- record_id (audit_events.record_id has no not-null constraint; the row
-- still carries the actor, before/after snapshot, and reason) instead of
-- failing the write outright. Every other table's uuid id still casts
-- successfully, so this changes nothing for the other 35 audited tables.
create or replace function public.safe_uuid_cast(value text)
returns uuid
language plpgsql
immutable
as $$
begin
  return value::uuid;
exception when invalid_text_representation then
  return null;
end;
$$;

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
    public.safe_uuid_cast(nullif(after_snapshot ->> 'id', '')),
    public.safe_uuid_cast(nullif(before_snapshot ->> 'id', '')),
    public.safe_uuid_cast(nullif(after_snapshot ->> 'profile_id', '')),
    public.safe_uuid_cast(nullif(before_snapshot ->> 'profile_id', ''))
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

revoke all on function public.safe_uuid_cast(text) from public;

create table public.b2c_settings (
  id boolean primary key default true,
  duplicate_detection_window_hours integer not null default 48
    -- Lower bound 1 hour: a zero or negative window would compare nothing,
    -- defeating the feature entirely.
    -- Upper bound 168 hours (7 days): beyond about a week, matching purely by
    -- content (effective email + USD amount + business date -- there is no
    -- shared provider ID) starts conflating unrelated repeat purchases from
    -- the same member instead of catching accidental double-entry/double-
    -- charge duplicates, which is what this feature exists to do.
    check (duplicate_detection_window_hours between 1 and 168),
  reason text,
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint b2c_settings_is_singleton check (id)
);

insert into public.b2c_settings (id, duplicate_detection_window_hours)
values (true, 48);

create or replace function public.assign_b2c_settings_actor()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'B2C settings changes require an authenticated administrator';
  end if;
  new.updated_by := auth.uid();
  new.updated_at := timezone('utc', now());
  return new;
end;
$$;

create trigger assign_b2c_settings_actor before update on public.b2c_settings
  for each row execute procedure public.assign_b2c_settings_actor();

create trigger audit_b2c_settings after insert or update or delete on public.b2c_settings
  for each row execute procedure public.write_audit_event();

alter table public.b2c_settings enable row level security;

create policy approved_read on public.b2c_settings for select to authenticated
  using (public.is_approved_user());

create policy admin_update on public.b2c_settings for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

revoke all on public.b2c_settings from public, anon;
grant select on public.b2c_settings to authenticated;
grant update on public.b2c_settings to authenticated;

-- Admin-only, bounded, audited write path. Not security definer: the write
-- itself is authorized by the admin_update RLS policy above (defense in
-- depth alongside the explicit is_admin() check here), exactly like
-- revise_financial_target.
create or replace function public.update_b2c_duplicate_detection_window(
  p_window_hours integer,
  p_reason text
)
returns void
language plpgsql
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Admin access is required';
  end if;
  if p_window_hours is null or p_window_hours not between 1 and 168 then
    raise exception 'The duplicate-detection window must be between 1 and 168 hours';
  end if;
  if char_length(trim(coalesce(p_reason, ''))) not between 3 and 1000 then
    raise exception 'A reason between 3 and 1000 characters is required';
  end if;

  update public.b2c_settings
  set duplicate_detection_window_hours = p_window_hours,
    reason = trim(p_reason)
  where id = true;
end;
$$;

revoke all on function public.update_b2c_duplicate_detection_window(integer, text) from public;
grant execute on function public.update_b2c_duplicate_detection_window(integer, text) to authenticated;

-- Duplicate-group constructor: reads the configured window instead of a fixed
-- 48 hours. Every other matching rule (effective email, USD amount, business
-- date) is unchanged from 20270101000500_remove_b2c_category.sql. A missing
-- settings row (should never happen; the row is bootstrapped above and never
-- deleted) falls back to the historical 48-hour default rather than failing
-- duplicate detection open or closed unpredictably.
create or replace function public.open_b2c_payment_duplicate_group(p_payment_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target record;
  candidate_ids uuid[];
  open_group_id uuid;
  existing_group_id uuid;
  latest_resolved_group_id uuid;
  latest_resolved_member_ids uuid[];
  window_hours integer;
  window_interval interval;
begin
  if coalesce(auth.role(), '') = 'service_role' then
    null;
  elsif auth.uid() is null and auth.role() is null then
    null;
  elsif auth.uid() is null or not public.is_admin() then
    raise exception 'Only an authenticated administrator or trusted database session can create B2C payment duplicate groups';
  end if;

  select coalesce(
    (select duplicate_detection_window_hours from public.b2c_settings where id = true),
    48
  ) into window_hours;
  window_interval := make_interval(hours => window_hours);

  -- One workflow mutex serializes all group/member/flag decisions. This
  -- constructor never explicitly locks source rows; writers that need a
  -- conflicting source FOR UPDATE take this mutex before that source lock.
  perform pg_advisory_xact_lock(hashtext('b2c_payment_duplicate_workflow'));

  -- Preserve the evidence set captured when this case opened even if a local
  -- correction changes the payment while Finance is reviewing it.
  select duplicate_group.id into existing_group_id
  from public.b2c_payment_duplicate_group_members member
  join public.b2c_payment_duplicate_groups duplicate_group on duplicate_group.id = member.group_id
  where member.payment_id = p_payment_id
    and duplicate_group.status = 'open'
  order by duplicate_group.created_at, duplicate_group.id
  limit 1;
  if found then
    return existing_group_id;
  end if;

  select * into target
  from public.get_effective_b2c_duplicate_facts(p_payment_id);
  if not found then
    return null;
  end if;

  with candidate_facts as (
    select facts.*
    from public.b2c_payments payment
    cross join lateral public.get_effective_b2c_duplicate_facts(payment.id) facts
  ), eligible_candidates as (
    select candidate.payment_id
    from candidate_facts candidate
    where candidate.customer_email = target.customer_email
      and candidate.comparison_amount = target.comparison_amount
      and candidate.occurred_on = target.occurred_on
      and candidate.occurred_at between target.occurred_at - window_interval and target.occurred_at + window_interval
      and not exists (
        select 1
        from public.b2c_payment_duplicate_group_members prior_member
        join public.b2c_payment_duplicate_groups prior_group on prior_group.id = prior_member.group_id
        where prior_member.payment_id = candidate.payment_id
          and prior_group.status = 'resolved'
          and prior_member.decision = 'exclude'
      )
  )
  select array_agg(payment_id order by payment_id) into candidate_ids
  from (select distinct payment_id from eligible_candidates) distinct_candidates;

  if coalesce(cardinality(candidate_ids), 0) < 2 then
    return null;
  end if;

  if exists (
    select 1
    from public.b2c_payment_duplicate_group_members member
    join public.b2c_payment_duplicate_groups duplicate_group on duplicate_group.id = member.group_id
    where member.payment_id = any(candidate_ids)
      and duplicate_group.status = 'open'
      and duplicate_group.fingerprint <> target.fingerprint
  ) then
    raise exception 'A payment cannot belong to more than one open B2C payment duplicate group';
  end if;

  select duplicate_group.id into open_group_id
  from public.b2c_payment_duplicate_groups duplicate_group
  where duplicate_group.fingerprint = target.fingerprint
    and duplicate_group.status = 'open'
  for update;

  if found then
    if exists (
      select 1
      from public.b2c_payment_duplicate_group_members member
      join public.b2c_payment_duplicate_groups other_group on other_group.id = member.group_id
      where member.payment_id = any(candidate_ids)
        and other_group.status = 'open'
        and other_group.id <> open_group_id
    ) then
      raise exception 'A payment cannot belong to more than one open B2C payment duplicate group';
    end if;

    insert into public.b2c_payment_duplicate_group_members (group_id, payment_id)
    select open_group_id, candidate_id
    from unnest(candidate_ids) candidate_id
    on conflict (group_id, payment_id) do nothing;

    insert into public.review_flags (
      source_area, source_record_id, flag_type, status, priority, reason, created_by
    )
    select
      'b2c_payment', candidate_id, 'possible_duplicate', 'open', 2,
      format('Another succeeded B2C payment has the same effective customer email, USD amount, and business date within %s hours. It is excluded from financial totals pending Admin review.', window_hours),
      auth.uid()
    from unnest(candidate_ids) candidate_id
    on conflict (source_area, source_record_id, flag_type, status) do update set
      priority = excluded.priority,
      reason = excluded.reason,
      updated_at = timezone('utc', now());

    return open_group_id;
  end if;

  select duplicate_group.id,
    array(
      select member.payment_id
      from public.b2c_payment_duplicate_group_members member
      where member.group_id = duplicate_group.id
      order by member.payment_id
    )
  into latest_resolved_group_id, latest_resolved_member_ids
  from public.b2c_payment_duplicate_groups duplicate_group
  where duplicate_group.fingerprint = target.fingerprint
    and duplicate_group.status = 'resolved'
  order by duplicate_group.resolved_at desc, duplicate_group.id desc
  limit 1;

  if found and latest_resolved_member_ids = candidate_ids then
    return null;
  end if;

  if exists (
    select 1
    from public.b2c_payment_duplicate_group_members member
    join public.b2c_payment_duplicate_groups duplicate_group on duplicate_group.id = member.group_id
    where member.payment_id = any(candidate_ids)
      and duplicate_group.status = 'open'
  ) then
    raise exception 'A payment cannot belong to more than one open B2C payment duplicate group';
  end if;

  insert into public.b2c_payment_duplicate_groups (fingerprint, detection_reason)
  values (
    target.fingerprint,
    format('Succeeded B2C payments share the same effective customer email, USD amount, and business date within %s hours.', window_hours)
  )
  returning id into open_group_id;

  insert into public.b2c_payment_duplicate_group_members (group_id, payment_id)
  select open_group_id, candidate_id
  from unnest(candidate_ids) candidate_id;

  insert into public.review_flags (
    source_area, source_record_id, flag_type, status, priority, reason, created_by
  )
  select
    'b2c_payment', candidate_id, 'possible_duplicate', 'open', 2,
    format('Another succeeded B2C payment has the same effective customer email, USD amount, and business date within %s hours. It is excluded from financial totals pending Admin review.', window_hours),
    auth.uid()
  from unnest(candidate_ids) candidate_id
  on conflict (source_area, source_record_id, flag_type, status) do update set
    priority = excluded.priority,
    reason = excluded.reason,
    updated_at = timezone('utc', now());

  return open_group_id;
end;
$$;

revoke all on function public.open_b2c_payment_duplicate_group(uuid) from public, anon;
grant execute on function public.open_b2c_payment_duplicate_group(uuid) to authenticated, service_role;
