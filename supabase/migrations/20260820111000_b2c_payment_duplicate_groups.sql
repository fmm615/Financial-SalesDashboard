-- Payment duplicate review is database-owned and auditable. Provider and
-- Finance source payments remain immutable; only group, member, flag, and
-- resolution history is written by the protected workflow below.
create table public.b2c_payment_duplicate_groups (
  id uuid primary key default gen_random_uuid(),
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  status text not null default 'open' check (status in ('open', 'resolved')),
  decision text check (decision in ('keep_all', 'keep_one')),
  canonical_payment_id uuid references public.b2c_payments(id),
  detection_reason text not null check (char_length(trim(detection_reason)) between 3 and 1000),
  resolution_reason text,
  resolved_by uuid references public.profiles(id),
  resolved_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  check (
    (status = 'open' and decision is null and canonical_payment_id is null and resolution_reason is null and resolved_by is null and resolved_at is null)
    or
    (status = 'resolved' and decision = 'keep_all' and canonical_payment_id is null and char_length(trim(resolution_reason)) between 3 and 1000 and resolved_by is not null and resolved_at is not null)
    or
    (status = 'resolved' and decision = 'keep_one' and canonical_payment_id is not null and char_length(trim(resolution_reason)) between 3 and 1000 and resolved_by is not null and resolved_at is not null)
  )
);

create unique index b2c_payment_duplicate_groups_one_open_fingerprint_idx
  on public.b2c_payment_duplicate_groups (fingerprint)
  where status = 'open';

create table public.b2c_payment_duplicate_group_members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.b2c_payment_duplicate_groups(id),
  payment_id uuid not null references public.b2c_payments(id),
  decision text not null default 'pending' check (decision in ('pending', 'include', 'exclude')),
  created_at timestamptz not null default timezone('utc', now()),
  unique (group_id, payment_id)
);

create index b2c_payment_duplicate_group_members_payment_idx
  on public.b2c_payment_duplicate_group_members (payment_id, group_id);

alter table public.b2c_payment_duplicate_groups enable row level security;
alter table public.b2c_payment_duplicate_group_members enable row level security;

create policy admin_select on public.b2c_payment_duplicate_groups
  for select to authenticated using (public.is_admin());
create policy admin_select on public.b2c_payment_duplicate_group_members
  for select to authenticated using (public.is_admin());

revoke all on public.b2c_payment_duplicate_groups from public, anon, authenticated;
revoke all on public.b2c_payment_duplicate_group_members from public, anon, authenticated;
grant select on public.b2c_payment_duplicate_groups to authenticated;
grant select on public.b2c_payment_duplicate_group_members to authenticated;

create trigger audit_b2c_payment_duplicate_groups
  after insert or update or delete on public.b2c_payment_duplicate_groups
  for each row execute procedure public.write_audit_event();
create trigger audit_b2c_payment_duplicate_group_members
  after insert or update or delete on public.b2c_payment_duplicate_group_members
  for each row execute procedure public.write_audit_event();

create or replace function public.enforce_one_open_b2c_duplicate_group_per_payment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1
    from public.b2c_payment_duplicate_groups target_group
    where target_group.id = new.group_id
      and target_group.status = 'open'
  ) and exists (
    select 1
    from public.b2c_payment_duplicate_group_members existing_member
    join public.b2c_payment_duplicate_groups existing_group on existing_group.id = existing_member.group_id
    where existing_member.payment_id = new.payment_id
      and existing_member.group_id <> new.group_id
      and existing_group.status = 'open'
  ) then
    raise exception 'A payment cannot belong to more than one open B2C payment duplicate group';
  end if;
  return new;
end;
$$;

create trigger enforce_one_open_b2c_duplicate_group_per_payment
  before insert or update of group_id, payment_id on public.b2c_payment_duplicate_group_members
  for each row execute procedure public.enforce_one_open_b2c_duplicate_group_per_payment();

revoke all on function public.enforce_one_open_b2c_duplicate_group_per_payment() from public;

create or replace function public.get_effective_b2c_duplicate_facts(p_payment_id uuid)
returns table (
  payment_id uuid,
  customer_email text,
  comparison_amount numeric(20, 6),
  category_code text,
  occurred_at timestamptz,
  occurred_on date,
  fingerprint text
)
language sql
security definer
set search_path = public
stable
as $$
  select p.id,
    lower(trim(coalesce(o.customer_email, p.customer_email)::text)),
    coalesce(o.local_amount_usd, p.amount_usd),
    lower(trim(coalesce(o.category_code, p.category_code))),
    p.occurred_at,
    coalesce(o.local_occurred_on, p.occurred_on),
    encode(extensions.digest(
      lower(trim(coalesce(o.customer_email, p.customer_email)::text)) || '|' ||
      'USD|' ||
      coalesce(o.local_amount_usd, p.amount_usd)::numeric(20, 6)::text || '|' ||
      lower(trim(coalesce(o.category_code, p.category_code))) || '|' ||
      coalesce(o.local_occurred_on, p.occurred_on)::text,
      'sha256'
    ), 'hex')
  from public.b2c_payments p
  left join public.b2c_payment_local_overrides o on o.payment_id = p.id
  where p.id = p_payment_id
    and p.payment_status = 'succeeded'
    and coalesce(o.customer_email, p.customer_email) is not null
    and coalesce(o.local_amount_usd, p.amount_usd) is not null
    and coalesce(o.category_code, p.category_code) is not null
    and coalesce(o.local_occurred_on, p.occurred_on) is not null;
$$;

revoke all on function public.get_effective_b2c_duplicate_facts(uuid) from public, anon, authenticated;

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
begin
  if coalesce(auth.role(), '') = 'service_role' then
    null;
  elsif auth.uid() is null and auth.role() is null then
    null;
  elsif auth.uid() is null or not public.is_admin() then
    raise exception 'Only an authenticated administrator or trusted database session can create B2C payment duplicate groups';
  end if;

  -- One workflow mutex serializes all group/member/flag decisions. Payment and
  -- override AFTER triggers may already own their source row, so code holding
  -- this mutex must never request a source payment or override row lock.
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
      and candidate.category_code = target.category_code
      and candidate.occurred_on = target.occurred_on
      and candidate.occurred_at between target.occurred_at - interval '48 hours' and target.occurred_at + interval '48 hours'
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
      'Another succeeded B2C payment has the same effective customer email, USD amount, category, and business date within 48 hours. It is excluded from financial totals pending Admin review.',
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
    'Succeeded B2C payments share the same effective customer email, USD amount, category, and business date within 48 hours.'
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
    'Another succeeded B2C payment has the same effective customer email, USD amount, category, and business date within 48 hours. It is excluded from financial totals pending Admin review.',
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

create or replace function public.resolve_b2c_payment_duplicate_group(
  p_group_id uuid,
  p_decision text,
  p_canonical_payment_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target_group public.b2c_payment_duplicate_groups%rowtype;
  member_record record;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Only an authenticated administrator can resolve B2C payment duplicate groups';
  end if;

  if p_decision is null or p_decision not in ('keep_all', 'keep_one') then
    raise exception 'Duplicate decisions must be keep_all or keep_one';
  end if;

  if char_length(trim(coalesce(p_reason, ''))) not between 3 and 1000
    or lower(trim(p_reason)) in ('n/a', 'na')
    or trim(p_reason) ~ '^[-—]+$' then
    raise exception 'A meaningful duplicate decision reason between 3 and 1000 characters is required';
  end if;

  if p_decision = 'keep_all' and p_canonical_payment_id is not null then
    raise exception 'A keep-all decision cannot select a canonical payment';
  end if;

  if p_decision = 'keep_one' and p_canonical_payment_id is null then
    raise exception 'A keep-one decision requires a canonical payment from this duplicate group';
  end if;

  -- The shared workflow mutex precedes every group/member/flag lock. Nested
  -- constructor calls are transaction-lock reentrant and request no source rows.
  perform pg_advisory_xact_lock(hashtext('b2c_payment_duplicate_workflow'));

  select * into target_group
  from public.b2c_payment_duplicate_groups duplicate_group
  where duplicate_group.id = p_group_id
  for update;

  if not found or target_group.status <> 'open' then
    raise exception 'This duplicate group is unavailable or already resolved';
  end if;

  perform 1
  from public.b2c_payment_duplicate_group_members member
  where member.group_id = p_group_id
  order by member.payment_id
  for update;

  if p_decision = 'keep_one' and not exists (
    select 1
    from public.b2c_payment_duplicate_group_members member
    where member.group_id = p_group_id
      and member.payment_id = p_canonical_payment_id
  ) then
    raise exception 'The selected canonical payment must belong to this duplicate group';
  end if;

  update public.b2c_payment_duplicate_group_members
  set decision = case
    when p_decision = 'keep_all' or payment_id = p_canonical_payment_id then 'include'
    else 'exclude'
  end
  where group_id = p_group_id and decision = 'pending';

  update public.b2c_payment_duplicate_groups
  set status = 'resolved',
      decision = p_decision,
      canonical_payment_id = case when p_decision = 'keep_one' then p_canonical_payment_id else null end,
      resolution_reason = trim(p_reason),
      resolved_by = auth.uid(),
      resolved_at = timezone('utc', now())
  where id = p_group_id and status = 'open';

  for member_record in
    select member.payment_id, member.decision
    from public.b2c_payment_duplicate_group_members member
    where member.group_id = p_group_id
    order by member.payment_id
  loop
    if not exists (
      select 1
      from public.b2c_payment_duplicate_group_members other_member
      join public.b2c_payment_duplicate_groups other_group on other_group.id = other_member.group_id
      where other_member.payment_id = member_record.payment_id
        and other_group.status = 'open'
    ) then
      insert into public.review_flag_resolutions (flag_id, resolution_status, resolution_note)
      select flag.id, 'resolved', trim(p_reason)
      from public.review_flags flag
      where flag.source_area = 'b2c_payment'
        and flag.source_record_id = member_record.payment_id
        and flag.flag_type = 'possible_duplicate'
        and flag.status = 'open'
      on conflict (flag_id) do nothing;
    end if;
  end loop;

  for member_record in
    select member.payment_id
    from public.b2c_payment_duplicate_group_members member
    where member.group_id = p_group_id
      and member.decision = 'include'
    order by member.payment_id
  loop
    perform public.open_b2c_payment_duplicate_group(member_record.payment_id);
  end loop;
end;
$$;

revoke all on function public.resolve_b2c_payment_duplicate_group(uuid, text, uuid, text) from public, anon;
grant execute on function public.resolve_b2c_payment_duplicate_group(uuid, text, uuid, text) to authenticated;

create or replace function public.dismiss_stale_b2c_possible_duplicate_flag(
  p_flag_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target_flag public.review_flags%rowtype;
  current_group_id uuid;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Only an authenticated administrator can dismiss a stale B2C possible-duplicate flag';
  end if;

  if char_length(trim(coalesce(p_reason, ''))) not between 3 and 1000
    or lower(trim(p_reason)) in ('n/a', 'na')
    or trim(p_reason) ~ '^[-—]+$' then
    raise exception 'A meaningful duplicate decision reason between 3 and 1000 characters is required';
  end if;

  -- Serialize before locking the flag; constructors use the same mutex before
  -- any group/member/flag write and never wait for trigger-owned source rows.
  perform pg_advisory_xact_lock(hashtext('b2c_payment_duplicate_workflow'));

  select * into target_flag
  from public.review_flags flag
  where flag.id = p_flag_id
    and flag.source_area = 'b2c_payment'
    and flag.flag_type = 'possible_duplicate'
    and flag.status = 'open'
  for update;

  if not found then
    raise exception 'The open B2C possible-duplicate flag is unavailable';
  end if;

  if exists (
    select 1
    from public.b2c_payment_duplicate_group_members member
    join public.b2c_payment_duplicate_groups duplicate_group on duplicate_group.id = member.group_id
    where member.payment_id = target_flag.source_record_id
      and duplicate_group.status = 'open'
  ) then
    raise exception 'This possible duplicate still has a current duplicate group';
  end if;

  current_group_id := public.open_b2c_payment_duplicate_group(target_flag.source_record_id);
  if current_group_id is not null then
    raise exception 'This possible duplicate still has a current duplicate group';
  end if;

  insert into public.review_flag_resolutions (flag_id, resolution_status, resolution_note)
  values (target_flag.id, 'dismissed', trim(p_reason));
end;
$$;

revoke all on function public.dismiss_stale_b2c_possible_duplicate_flag(uuid, text) from public, anon;
grant execute on function public.dismiss_stale_b2c_possible_duplicate_flag(uuid, text) to authenticated;

create or replace function public.get_b2c_payment_duplicate_reporting_states()
returns table (
  payment_id uuid,
  has_open_duplicate boolean,
  has_duplicate_exclusion boolean
)
language sql
security definer
set search_path = public
stable
as $$
  select member.payment_id,
    bool_or(duplicate_group.status = 'open') as has_open_duplicate,
    bool_or(duplicate_group.status = 'resolved' and member.decision = 'exclude') as has_duplicate_exclusion
  from public.b2c_payment_duplicate_group_members member
  join public.b2c_payment_duplicate_groups duplicate_group on duplicate_group.id = member.group_id
  where auth.uid() is not null
    and public.is_approved_user()
  group by member.payment_id;
$$;

revoke all on function public.get_b2c_payment_duplicate_reporting_states() from public, anon;
grant execute on function public.get_b2c_payment_duplicate_reporting_states() to authenticated;

create or replace function public.open_b2c_payment_duplicate_group_after_payment_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.open_b2c_payment_duplicate_group(new.id);
  return new;
end;
$$;

create or replace function public.open_b2c_payment_duplicate_group_after_override_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.open_b2c_payment_duplicate_group(new.payment_id);
  return new;
end;
$$;

revoke all on function public.open_b2c_payment_duplicate_group_after_payment_write() from public;
revoke all on function public.open_b2c_payment_duplicate_group_after_override_write() from public;

create trigger open_b2c_payment_duplicate_group_after_payment_write
  after insert or update of payment_status, customer_email, category_code, amount_usd, occurred_at, occurred_on
  on public.b2c_payments
  for each row execute procedure public.open_b2c_payment_duplicate_group_after_payment_write();

create trigger open_b2c_payment_duplicate_group_after_override_write
  after insert or update of customer_email, category_code, local_amount_usd, local_occurred_on
  on public.b2c_payment_local_overrides
  for each row execute procedure public.open_b2c_payment_duplicate_group_after_override_write();

-- Preserve the latest manual-entry boundary exactly, removing only its legacy
-- pre-insert possible-match query and direct review-flag insert. The payment
-- trigger above now owns duplicate construction in the same transaction.
create or replace function public.record_b2c_manual_bank_transfer(
  p_bank_reference text, p_customer_email text, p_customer_name text,
  p_category_code text, p_membership_tier text, p_amount_usd_text text,
  p_received_at_raw text, p_reason text, p_expected_input_sha256 text
)
returns public.b2c_payments
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  actor uuid;
  computed_hash text;
  transfer_occurred_at timestamptz;
  transfer_occurred_on date;
  canonical_name text;
  finance_identity text;
  duplicate_fp text;
  found_lineage_id uuid;
  found_represented_payment_id uuid;
  new_payment public.b2c_payments%rowtype;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Only an authenticated administrator can record a manual bank transfer';
  end if;
  actor := auth.uid();

  if char_length(trim(coalesce(p_bank_reference, ''))) not between 1 and 200 then
    raise exception 'A bank reference between 1 and 200 characters is required';
  end if;
  if char_length(trim(coalesce(p_customer_name, ''))) not between 1 and 200 then
    raise exception 'A customer name is required';
  end if;
  if p_customer_email is null or trim(p_customer_email) !~* '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' then
    raise exception 'A verified customer email is required';
  end if;
  if char_length(trim(coalesce(p_category_code, ''))) < 1 then
    raise exception 'A category is required';
  end if;
  if p_amount_usd_text is null or p_amount_usd_text !~ '^[0-9]+\.[0-9]{6}$' or p_amount_usd_text::numeric <= 0 then
    raise exception 'A positive USD amount with six decimal places is required';
  end if;
  if char_length(trim(coalesce(p_reason, ''))) not between 3 and 1000 then
    raise exception 'A reason is required';
  end if;
  if coalesce(p_expected_input_sha256, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'Preview the entered details before recording them';
  end if;

  begin
    transfer_occurred_at := p_received_at_raw::timestamptz;
  exception when others then
    raise exception 'A valid bank transfer date/time with an explicit offset is required';
  end;
  transfer_occurred_on := (transfer_occurred_at at time zone 'Asia/Bahrain')::date;

  computed_hash := encode(digest(
    trim(p_bank_reference) || '|' || lower(trim(p_customer_email)) || '|' || trim(p_customer_name) || '|' ||
    trim(p_category_code) || '|' || coalesce(trim(p_membership_tier), '') || '|' ||
    p_amount_usd_text || '|' || trim(p_received_at_raw) || '|' || trim(p_reason),
    'sha256'
  ), 'hex');
  if computed_hash <> p_expected_input_sha256 then
    raise exception 'The reviewed bank transfer details changed since preview. Start again.';
  end if;

  perform pg_advisory_xact_lock(hashtext('b2c_manual_bank_transfer:' || lower(trim(p_bank_reference))));
  if exists (
    select 1 from public.b2c_payments
    where source_system = 'manual_bank_transfer' and provider_transaction_id = trim(p_bank_reference)
  ) then
    raise exception 'A manual bank transfer with this reference already exists';
  end if;

  canonical_name := public.b2c_canonical_identity_text(p_customer_name);
  finance_identity := encode(digest(
    canonical_name || ' ' || to_char(transfer_occurred_on, 'YYYY-MM-DD') || ' ' || p_amount_usd_text || ' bank transfer',
    'sha256'
  ), 'hex');

  select lineage.id, lineage.represented_payment_id into found_lineage_id, found_represented_payment_id
  from public.b2c_finance_record_lineages lineage
  where lineage.source_identity = finance_identity;
  if found then
    raise exception 'This transfer matches an existing Payment Tracker bank-transfer record. Link the evidence instead of recording it again.';
  end if;

  if exists (
    select 1 from public.b2c_finance_import_version_candidates candidate
    where candidate.source_identity = finance_identity
      and not exists (
        select 1 from public.b2c_finance_import_version_decisions decision
        where decision.candidate_id = candidate.id
      )
  ) then
    raise exception 'This transfer matches an unresolved Payment Tracker row awaiting review. Resolve that import version decision instead.';
  end if;

  duplicate_fp := encode(digest(
    lower(trim(p_customer_email)) || '|USD|' || p_amount_usd_text || '|' || lower(trim(p_category_code)) || '|' ||
    to_char(transfer_occurred_on, 'YYYY-MM-DD'),
    'sha256'
  ), 'hex');

  begin
    insert into public.b2c_payments (
      source_system, provider_transaction_id, customer_name, customer_email,
      category_code, membership_tier, payment_status,
      original_amount, original_currency, exchange_rate_to_usd,
      amount_usd, gross_amount_usd, occurred_at, occurred_on,
      duplicate_fingerprint, manual_entry_reason, entered_by
    ) values (
      'manual_bank_transfer', trim(p_bank_reference), trim(p_customer_name), lower(trim(p_customer_email)),
      trim(p_category_code), nullif(trim(p_membership_tier), ''), 'succeeded',
      p_amount_usd_text::numeric(20, 6), 'USD', 1,
      p_amount_usd_text::numeric(20, 6), p_amount_usd_text::numeric(20, 6), transfer_occurred_at, transfer_occurred_on,
      duplicate_fp, trim(p_reason), actor
    ) returning * into new_payment;
  exception when unique_violation then
    raise exception 'A manual bank transfer with this reference already exists';
  end;

  return new_payment;
end;
$$;

revoke all on function public.record_b2c_manual_bank_transfer(text, text, text, text, text, text, text, text, text) from public;
grant execute on function public.record_b2c_manual_bank_transfer(text, text, text, text, text, text, text, text, text) to authenticated;

-- Preserve the latest local-correction validation, effective overlay,
-- financial-correction audit, and missing-data resolution behavior. The
-- override trigger above replaces only the legacy candidate loop.
create or replace function public.apply_b2c_payment_local_correction(
  p_payment_id uuid,
  p_customer_name text,
  p_customer_email text,
  p_customer_phone text,
  p_category_code text,
  p_membership_tier text,
  p_local_amount_usd numeric(20, 6),
  p_local_occurred_on date,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target_payment public.b2c_payments%rowtype;
  prior_override public.b2c_payment_local_overrides%rowtype;
  effective_customer_name text;
  effective_customer_email citext;
  effective_customer_phone text;
  effective_category_code text;
  effective_membership_tier text;
  effective_amount_usd numeric(20, 6);
  effective_occurred_on date;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Only an authenticated administrator can record a local B2C correction';
  end if;

  if char_length(trim(coalesce(p_reason, ''))) not between 3 and 1000 then
    raise exception 'A correction reason must be between 3 and 1000 characters';
  end if;
  if p_customer_name is null and p_customer_email is null and p_customer_phone is null
    and p_category_code is null and p_membership_tier is null
    and p_local_amount_usd is null and p_local_occurred_on is null then
    raise exception 'Enter at least one verified local correction';
  end if;
  if p_customer_name is not null and char_length(trim(p_customer_name)) not between 1 and 200 then
    raise exception 'Customer name must be between 1 and 200 characters';
  end if;
  if p_customer_email is not null and trim(p_customer_email) !~* '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' then
    raise exception 'Enter a valid customer email';
  end if;
  if p_customer_phone is not null and char_length(trim(p_customer_phone)) not between 5 and 40 then
    raise exception 'Customer mobile must be between 5 and 40 characters';
  end if;
  if p_category_code is not null and lower(trim(p_category_code)) !~ '^[a-z0-9][a-z0-9_-]*$' then
    raise exception 'Category must use lowercase letters, numbers, hyphens, or underscores';
  end if;
  if p_membership_tier is not null and char_length(trim(p_membership_tier)) not between 1 and 100 then
    raise exception 'Membership tier must be between 1 and 100 characters';
  end if;
  if p_local_amount_usd is not null and p_local_amount_usd <= 0 then
    raise exception 'Local USD amount must be greater than zero';
  end if;

  select * into target_payment
  from public.b2c_payments
  where id = p_payment_id
  for update;
  if not found then
    raise exception 'The B2C payment is unavailable';
  end if;

  select * into prior_override
  from public.b2c_payment_local_overrides
  where payment_id = p_payment_id
  for update;

  effective_customer_name := coalesce(nullif(trim(p_customer_name), ''), prior_override.customer_name, target_payment.customer_name);
  effective_customer_email := coalesce(nullif(lower(trim(p_customer_email)), ''), prior_override.customer_email, target_payment.customer_email);
  effective_customer_phone := coalesce(nullif(trim(p_customer_phone), ''), prior_override.customer_phone, target_payment.customer_phone);
  effective_category_code := coalesce(nullif(lower(trim(p_category_code)), ''), prior_override.category_code, target_payment.category_code);
  effective_membership_tier := coalesce(nullif(trim(p_membership_tier), ''), prior_override.membership_tier, target_payment.membership_tier);
  effective_amount_usd := coalesce(p_local_amount_usd, prior_override.local_amount_usd, target_payment.amount_usd);
  effective_occurred_on := coalesce(p_local_occurred_on, prior_override.local_occurred_on, target_payment.occurred_on);

  if effective_customer_name is not distinct from coalesce(prior_override.customer_name, target_payment.customer_name)
    and effective_customer_email is not distinct from coalesce(prior_override.customer_email, target_payment.customer_email)
    and effective_customer_phone is not distinct from coalesce(prior_override.customer_phone, target_payment.customer_phone)
    and effective_category_code is not distinct from coalesce(prior_override.category_code, target_payment.category_code)
    and effective_membership_tier is not distinct from coalesce(prior_override.membership_tier, target_payment.membership_tier)
    and effective_amount_usd is not distinct from coalesce(prior_override.local_amount_usd, target_payment.amount_usd)
    and effective_occurred_on is not distinct from coalesce(prior_override.local_occurred_on, target_payment.occurred_on) then
    raise exception 'The submitted values do not change this payment';
  end if;

  insert into public.b2c_payment_local_overrides (
    payment_id, customer_name, customer_email, customer_phone, category_code,
    membership_tier, local_amount_usd, local_occurred_on, created_by, updated_by
  ) values (
    p_payment_id,
    case when p_customer_name is null then prior_override.customer_name else effective_customer_name end,
    case when p_customer_email is null then prior_override.customer_email else effective_customer_email end,
    case when p_customer_phone is null then prior_override.customer_phone else effective_customer_phone end,
    case when p_category_code is null then prior_override.category_code else effective_category_code end,
    case when p_membership_tier is null then prior_override.membership_tier else effective_membership_tier end,
    case when p_local_amount_usd is null then prior_override.local_amount_usd else effective_amount_usd end,
    case when p_local_occurred_on is null then prior_override.local_occurred_on else effective_occurred_on end,
    auth.uid(), auth.uid()
  ) on conflict (payment_id) do update set
    customer_name = excluded.customer_name,
    customer_email = excluded.customer_email,
    customer_phone = excluded.customer_phone,
    category_code = excluded.category_code,
    membership_tier = excluded.membership_tier,
    local_amount_usd = excluded.local_amount_usd,
    local_occurred_on = excluded.local_occurred_on,
    updated_by = auth.uid();

  insert into public.financial_corrections (
    target_area, target_record_id, correction_type, before_value, after_value, reason, effective_on
  ) values (
    'b2c_payment', p_payment_id, 'other',
    jsonb_build_object(
      'customer_name', coalesce(prior_override.customer_name, target_payment.customer_name),
      'customer_email', coalesce(prior_override.customer_email, target_payment.customer_email),
      'customer_phone', coalesce(prior_override.customer_phone, target_payment.customer_phone),
      'category_code', coalesce(prior_override.category_code, target_payment.category_code),
      'membership_tier', coalesce(prior_override.membership_tier, target_payment.membership_tier),
      'amount_usd', coalesce(prior_override.local_amount_usd, target_payment.amount_usd),
      'occurred_on', coalesce(prior_override.local_occurred_on, target_payment.occurred_on)
    ),
    jsonb_build_object(
      'customer_name', effective_customer_name,
      'customer_email', effective_customer_email,
      'customer_phone', effective_customer_phone,
      'category_code', effective_category_code,
      'membership_tier', effective_membership_tier,
      'amount_usd', effective_amount_usd,
      'occurred_on', effective_occurred_on
    ),
    trim(p_reason), effective_occurred_on
  );

  if p_customer_email is not null then
    insert into public.review_flag_resolutions (flag_id, resolution_status, resolution_note)
    select id, 'resolved', trim(p_reason)
    from public.review_flags
    where source_area = 'b2c_payment'
      and source_record_id = p_payment_id
      and flag_type = 'needs_follow_up'
      and status = 'open'
      and reason ~* 'missing a valid customer email'
    on conflict (flag_id) do nothing;
  end if;

  if p_category_code is not null then
    insert into public.review_flag_resolutions (flag_id, resolution_status, resolution_note)
    select id, 'resolved', trim(p_reason)
    from public.review_flags
    where source_area = 'b2c_payment'
      and source_record_id = p_payment_id
      and flag_type = 'unmapped_product'
      and status = 'open'
    on conflict (flag_id) do nothing;
  end if;
end;
$$;

revoke all on function public.apply_b2c_payment_local_correction(uuid, text, text, text, text, text, numeric, date, text) from public;
grant execute on function public.apply_b2c_payment_local_correction(uuid, text, text, text, text, text, numeric, date, text) to authenticated;

-- Fail closed: historical flags that no longer have provable current facts
-- remain open and are counted for a production handoff instead of guessed.
do $$
declare
  flagged_payment_id uuid;
  ungrouped_flag_count integer;
begin
  perform set_config('request.jwt.claim.role', 'service_role', true);
  for flagged_payment_id in
    select distinct source_record_id
    from public.review_flags
    where source_area = 'b2c_payment'
      and flag_type = 'possible_duplicate'
      and status = 'open'
    order by source_record_id
  loop
    perform public.open_b2c_payment_duplicate_group(flagged_payment_id);
  end loop;

  select count(*) into ungrouped_flag_count
  from public.review_flags flag
  where flag.source_area = 'b2c_payment'
    and flag.flag_type = 'possible_duplicate'
    and flag.status = 'open'
    and not exists (
      select 1
      from public.b2c_payment_duplicate_group_members member
      join public.b2c_payment_duplicate_groups duplicate_group on duplicate_group.id = member.group_id
      where member.payment_id = flag.source_record_id
        and duplicate_group.status = 'open'
    );
  raise notice 'Ungrouped open B2C possible_duplicate flags retained for manual review: %', ungrouped_flag_count;
end;
$$;
