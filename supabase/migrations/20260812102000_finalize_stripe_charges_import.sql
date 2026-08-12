-- Stripe Charges CSV evidence is private, Admin-only, and never a B2C revenue ledger.
-- One source row creates a primary entry and, only for a direct valid refund, a
-- linked refund entry. The export does not provide a separate Stripe refund ID.

alter table public.b2c_provider_evidence
  add column if not exists source_entry_key text not null default 'primary'
    check (source_entry_key in ('primary', 'refund')),
  add column if not exists customer_name text
    check (customer_name is null or char_length(trim(customer_name)) between 1 and 200),
  add column if not exists customer_email citext
    check (customer_email is null or customer_email ~* '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'),
  add column if not exists customer_phone text
    check (customer_phone is null or char_length(trim(customer_phone)) between 5 and 40);

alter table public.b2c_provider_evidence
  drop constraint if exists b2c_provider_evidence_import_id_source_row_number_key,
  drop constraint if exists b2c_provider_evidence_provider_provider_row_id_key;

alter table public.b2c_provider_evidence
  add constraint b2c_provider_evidence_import_source_entry_unique unique (import_id, source_row_number, source_entry_key),
  add constraint b2c_provider_evidence_provider_source_entry_unique unique (provider, provider_row_id, source_entry_key);

do $$
declare
  prior_refund_constraint text;
begin
  select conname into prior_refund_constraint
  from pg_constraint
  where conrelid = 'public.b2c_provider_evidence'::regclass
    and contype = 'c'
    and lower(pg_get_constraintdef(oid)) like '%transaction_kind <> ''refund''%provider_refund_id is not null%'
  limit 1;

  if prior_refund_constraint is not null then
    execute format('alter table public.b2c_provider_evidence drop constraint %I', prior_refund_constraint);
  end if;
end;
$$;

alter table public.b2c_provider_evidence
  add constraint b2c_provider_evidence_refund_reference_check
  check (transaction_kind <> 'refund' or provider_refund_id is not null or provider_payment_id is not null);

create or replace function public.finalize_stripe_charges_import(
  p_source_file_name text,
  p_source_file_sha256 text,
  p_source_storage_bucket text,
  p_source_storage_path text,
  p_rows jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  import_id uuid;
  row_item jsonb;
  source_entry_key text;
  charge_id text;
  evidence_kind text;
  customer_email_value text;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Only an authenticated administrator can finalize Stripe Charges imports';
  end if;

  if char_length(trim(coalesce(p_source_file_name, ''))) not between 1 and 255
    or coalesce(p_source_file_sha256, '') !~ '^[0-9a-f]{64}$'
    or char_length(trim(coalesce(p_source_storage_bucket, ''))) not between 1 and 100
    or char_length(trim(coalesce(p_source_storage_path, ''))) not between 1 and 1000 then
    raise exception 'Stripe Charges import provenance is invalid';
  end if;

  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 or jsonb_array_length(p_rows) > 40000 then
    raise exception 'Stripe Charges imports require between 1 and 40000 evidence entries';
  end if;

  for row_item in select value from jsonb_array_elements(p_rows)
  loop
    source_entry_key := coalesce(row_item ->> 'sourceEntryKey', '');
    charge_id := nullif(trim(coalesce(row_item ->> 'chargeId', '')), '');
    evidence_kind := coalesce(row_item ->> 'kind', '');
    customer_email_value := nullif(lower(trim(coalesce(row_item ->> 'customerEmail', ''))), '');

    if coalesce(jsonb_typeof(row_item), '') <> 'object'
      or coalesce(row_item ->> 'sourceRowNumber', '') !~ '^[0-9]+$'
      or (row_item ->> 'sourceRowNumber')::integer < 2
      or source_entry_key not in ('primary', 'refund')
      or evidence_kind not in ('sale', 'refund', 'needs_review')
      or (source_entry_key = 'refund' and evidence_kind <> 'refund')
      or (source_entry_key = 'primary' and evidence_kind = 'refund')
      or (evidence_kind in ('sale', 'refund') and charge_id is null)
      or coalesce(row_item ->> 'currency', '') !~ '^[A-Z]{3}$'
      or (nullif(row_item ->> 'credit', '') is not null and row_item ->> 'credit' !~ '^[0-9]+(?:\.[0-9]{1,6})?$')
      or (nullif(row_item ->> 'debit', '') is not null and row_item ->> 'debit' !~ '^[0-9]+(?:\.[0-9]{1,6})?$')
      or (evidence_kind = 'sale' and nullif(row_item ->> 'credit', '') is null)
      or (evidence_kind = 'refund' and nullif(row_item ->> 'debit', '') is null)
      or (nullif(row_item ->> 'occurredAt', '') is not null and row_item ->> 'occurredAt' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$')
      or (nullif(row_item ->> 'customerName', '') is not null and char_length(trim(row_item ->> 'customerName')) not between 1 and 200)
      or (customer_email_value is not null and customer_email_value !~* '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$')
      or (nullif(row_item ->> 'customerPhone', '') is not null and char_length(trim(row_item ->> 'customerPhone')) not between 5 and 40)
      or coalesce(jsonb_typeof(row_item -> 'rawPayload'), '') <> 'object' then
      raise exception 'Stripe Charges evidence entry is invalid';
    end if;
  end loop;

  insert into public.b2c_finance_imports (
    source_kind, source_file_name, source_file_sha256, source_storage_bucket, source_storage_path, import_status
  ) values (
    'stripe_charges', trim(p_source_file_name), p_source_file_sha256, trim(p_source_storage_bucket), trim(p_source_storage_path), 'processing'
  ) returning id into import_id;

  insert into public.b2c_provider_evidence (
    import_id, provider, source_row_number, source_entry_key, provider_row_id, provider_payment_id, provider_refund_id,
    transaction_kind, description_raw, occurred_at, occurred_at_raw, original_currency, credit_amount, debit_amount,
    customer_name, customer_email, customer_phone, raw_payload
  )
  select
    import_id,
    'stripe',
    row_data."sourceRowNumber"::integer,
    row_data."sourceEntryKey",
    nullif(row_data."chargeId", ''),
    nullif(row_data."chargeId", ''),
    null,
    row_data."kind"::public.b2c_provider_evidence_kind,
    nullif(row_data."description", ''),
    nullif(row_data."occurredAt", '')::timestamptz,
    nullif(row_data."occurredAtRaw", ''),
    row_data."currency",
    nullif(row_data."credit", '')::numeric(20, 6),
    nullif(row_data."debit", '')::numeric(20, 6),
    nullif(row_data."customerName", ''),
    nullif(lower(row_data."customerEmail"), '')::citext,
    nullif(row_data."customerPhone", ''),
    row_data."rawPayload"
  from jsonb_to_recordset(p_rows) as row_data(
    "sourceRowNumber" text, "sourceEntryKey" text, "chargeId" text, "kind" text,
    "description" text, "occurredAt" text, "occurredAtRaw" text, "currency" text,
    "credit" text, "debit" text, "customerName" text, "customerEmail" text,
    "customerPhone" text, "rawPayload" jsonb
  );

  update public.b2c_finance_imports
  set import_status = 'completed'
  where id = import_id;

  return import_id;
end;
$$;

revoke all on function public.finalize_stripe_charges_import(text, text, text, text, jsonb) from public;
grant execute on function public.finalize_stripe_charges_import(text, text, text, text, jsonb) to authenticated;
