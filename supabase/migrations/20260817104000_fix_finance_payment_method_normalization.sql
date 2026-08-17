-- The Payment Tracker uses mixed-case values such as `Bank Transfer` and
-- `iOS`. Lowercase before removing non-alphanumeric characters so those exact
-- Finance source values are selected without changing the staged evidence.

create or replace function public.post_approved_b2c_finance_payments()
returns table (
  posted_payments integer,
  already_posted_payments integer,
  skipped_rows integer
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  supported_rows integer := 0;
  already_posted integer := 0;
  posted integer := 0;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Only an authenticated administrator can post approved B2C Finance payments';
  end if;

  with supported_rows as (
    select rows.id
    from public.b2c_finance_staging_rows rows
    join public.b2c_finance_imports imports on imports.id = rows.import_id
    where imports.source_kind = 'payment_tracker'
      and imports.import_status = 'completed'
      and trim(regexp_replace(lower(coalesce(rows.payment_method_raw, '')), '[^a-z0-9]+', ' ', 'g')) in ('bank transfer', 'ios')
  )
  select count(*) into supported_rows from supported_rows;

  with supported_rows as (
    select rows.id
    from public.b2c_finance_staging_rows rows
    join public.b2c_finance_imports imports on imports.id = rows.import_id
    where imports.source_kind = 'payment_tracker'
      and imports.import_status = 'completed'
      and trim(regexp_replace(lower(coalesce(rows.payment_method_raw, '')), '[^a-z0-9]+', ' ', 'g')) in ('bank transfer', 'ios')
  )
  select count(*) into already_posted
  from supported_rows rows
  join public.b2c_finance_ledger_posts posts on posts.finance_row_id = rows.id;

  with eligible_rows as (
    select
      rows.id,
      rows.import_id,
      rows.source_tab,
      rows.source_row_number,
      rows.occurred_on,
      rows.amount_usd,
      nullif(trim(rows.customer_name_raw), '') as customer_name,
      nullif(lower(trim(rows.customer_email_raw)), '') as customer_email,
      nullif(trim(rows.customer_phone_raw), '') as customer_phone,
      nullif(trim(rows.membership_type_raw), '') as membership_tier,
      nullif(trim(rows.category_raw), '') as category_raw,
      case trim(regexp_replace(lower(coalesce(rows.payment_method_raw, '')), '[^a-z0-9]+', ' ', 'g'))
        when 'bank transfer' then 'bank_transfer'
        when 'ios' then 'ios'
      end as finance_payment_method,
      regexp_replace(
        regexp_replace(lower(trim(coalesce(rows.category_raw, ''))), '[^a-z0-9]+', '-', 'g'),
        '(^-+|-+$)', '', 'g'
      ) as category_code
    from public.b2c_finance_staging_rows rows
    join public.b2c_finance_imports imports on imports.id = rows.import_id
    where imports.source_kind = 'payment_tracker'
      and imports.import_status = 'completed'
      and rows.row_quality = 'valid'
      and rows.amount_usd > 0
      and rows.occurred_on is not null
      and trim(regexp_replace(lower(coalesce(rows.payment_method_raw, '')), '[^a-z0-9]+', ' ', 'g')) in ('bank transfer', 'ios')
      and not exists (
        select 1
        from public.b2c_finance_ledger_posts posts
        where posts.finance_row_id = rows.id
      )
      and not exists (
        select 1
        from public.b2c_reconciliation_finance_rows group_rows
        join public.b2c_reconciliation_groups groups on groups.id = group_rows.reconciliation_group_id
        where group_rows.finance_row_id = rows.id
          and (groups.reconciliation_state <> 'canonical' or groups.canonical_finance_row_id <> rows.id)
      )
    for update of rows
  ),
  postable_rows as (
    select *
    from eligible_rows rows
    where rows.finance_payment_method is not null
      and rows.category_code <> ''
  ),
  inserted_payments as (
    insert into public.b2c_payments (
      source_system, provider_transaction_id, provider_event_id,
      customer_name, customer_email, customer_phone,
      category_code, membership_tier, payment_status,
      original_amount, original_currency, exchange_rate_to_usd,
      amount_usd, gross_amount_usd, tax_amount_usd, net_amount_usd,
      occurred_at, occurred_on, duplicate_fingerprint,
      reconciliation_source, source_metadata
    )
    select
      'finance_tracker', null, null,
      rows.customer_name, rows.customer_email, rows.customer_phone,
      rows.category_code, rows.membership_tier, 'succeeded',
      rows.amount_usd, 'USD', 1,
      rows.amount_usd, rows.amount_usd, null, null,
      rows.occurred_on::timestamp at time zone 'UTC', rows.occurred_on,
      encode(digest(rows.id::text, 'sha256'), 'hex'),
      'payment_tracker',
      jsonb_build_object(
        'finance_row_id', rows.id,
        'finance_import_id', rows.import_id,
        'source_tab', rows.source_tab,
        'source_row_number', rows.source_row_number,
        'finance_payment_method', rows.finance_payment_method,
        'raw_category', rows.category_raw,
        'membership_type', rows.membership_tier,
        'source_amount_basis', 'gross_excluding_vat'
      )
    from postable_rows rows
    returning id, source_metadata
  ),
  inserted_posts as (
    insert into public.b2c_finance_ledger_posts (
      finance_row_id, payment_id, finance_payment_method,
      source_amount_basis, posted_by
    )
    select
      (payments.source_metadata ->> 'finance_row_id')::uuid,
      payments.id,
      payments.source_metadata ->> 'finance_payment_method',
      'gross_excluding_vat',
      auth.uid()
    from inserted_payments payments
    returning finance_row_id
  )
  select count(*) into posted from inserted_posts;

  return query select posted, already_posted, greatest(supported_rows - posted - already_posted, 0);
end;
$$;

revoke all on function public.post_approved_b2c_finance_payments() from public;
grant execute on function public.post_approved_b2c_finance_payments() to authenticated;
