-- Missing Finance source dates are review issues, not a reason to discard the
-- complete source file. The raw blank remains retained and non-reportable.
alter table public.b2c_finance_staging_rows
  drop constraint if exists b2c_finance_staging_rows_reported_date_raw_check;

alter table public.b2c_finance_staging_rows
  add constraint b2c_finance_staging_rows_reported_date_raw_check
  check (char_length(reported_date_raw) <= 100);

create or replace function public.finalize_b2c_finance_import(
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
  row_number_text text;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Only an authenticated administrator can finalize B2C Finance imports';
  end if;

  if char_length(trim(coalesce(p_source_file_name, ''))) not between 1 and 255
    or coalesce(p_source_file_sha256, '') !~ '^[0-9a-f]{64}$'
    or char_length(trim(coalesce(p_source_storage_bucket, ''))) not between 1 and 100
    or char_length(trim(coalesce(p_source_storage_path, ''))) not between 1 and 1000 then
    raise exception 'B2C Finance import provenance is invalid';
  end if;

  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 or jsonb_array_length(p_rows) > 20000 then
    raise exception 'B2C Finance imports require between 1 and 20000 staged rows';
  end if;

  for row_item in select value from jsonb_array_elements(p_rows)
  loop
    row_number_text := coalesce(row_item ->> 'sourceRowNumber', '');
    if coalesce(jsonb_typeof(row_item), '') <> 'object'
      or coalesce(row_item ->> 'sourceTab', '') not in ('B2C', 'B2C Cons')
      or row_number_text !~ '^[0-9]+$'
      or row_number_text::integer < 2
      or coalesce(jsonb_typeof(row_item -> 'rawPayload'), '') <> 'object'
      -- Empty source dates remain staged as needs_review; non-empty values stay bounded.
      or char_length(coalesce(row_item ->> 'reportedDateRaw', '')) > 100
      or coalesce(row_item ->> 'rowQuality', '') not in ('valid', 'zero_value', 'needs_review', 'invalid')
      or (nullif(row_item ->> 'amountUsd', '') is not null and row_item ->> 'amountUsd' !~ '^[0-9]+(?:\.[0-9]{1,6})?$')
      or (nullif(row_item ->> 'occurredOn', '') is not null and row_item ->> 'occurredOn' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
      or coalesce(jsonb_typeof(coalesce(row_item -> 'qualityIssues', '[]'::jsonb)), '') <> 'array' then
      raise exception 'B2C Finance staged row is invalid';
    end if;
  end loop;

  insert into public.b2c_finance_imports (
    source_kind, source_file_name, source_file_sha256, source_storage_bucket, source_storage_path, import_status
  ) values (
    'payment_tracker', trim(p_source_file_name), p_source_file_sha256, trim(p_source_storage_bucket), trim(p_source_storage_path), 'processing'
  ) returning id into import_id;

  insert into public.b2c_finance_staging_rows (
    import_id, source_tab, source_row_number, raw_payload, reported_date_raw, declared_month_raw, declared_year_raw,
    amount_usd_raw, customer_name_raw, customer_email_raw, customer_phone_raw, category_raw, membership_type_raw,
    payment_method_raw, payment_status_raw, note_raw, occurred_on, amount_usd, normalized_customer_name,
    normalized_customer_email, normalized_customer_phone, row_quality, quality_issues
  )
  select import_id, row_data."sourceTab", row_data."sourceRowNumber"::integer, row_data."rawPayload",
    row_data."reportedDateRaw", nullif(row_data."declaredMonthRaw", ''), nullif(row_data."declaredYearRaw", ''),
    nullif(row_data."amountUsdRaw", ''), nullif(row_data."customerNameRaw", ''), nullif(row_data."customerEmailRaw", ''),
    nullif(row_data."customerPhoneRaw", ''), nullif(row_data."categoryRaw", ''), nullif(row_data."membershipTypeRaw", ''),
    nullif(row_data."paymentMethodRaw", ''), nullif(row_data."paymentStatusRaw", ''), nullif(row_data."noteRaw", ''),
    nullif(row_data."occurredOn", '')::date, nullif(row_data."amountUsd", '')::numeric(20, 6),
    nullif(row_data."normalizedCustomerName", ''), nullif(row_data."normalizedCustomerEmail", '')::citext,
    nullif(row_data."normalizedCustomerPhone", ''), row_data."rowQuality"::public.b2c_finance_row_quality,
    coalesce(row_data."qualityIssues", '[]'::jsonb)
  from jsonb_to_recordset(p_rows) as row_data(
    "sourceTab" text, "sourceRowNumber" text, "rawPayload" jsonb, "reportedDateRaw" text,
    "declaredMonthRaw" text, "declaredYearRaw" text, "amountUsdRaw" text, "customerNameRaw" text,
    "customerEmailRaw" text, "customerPhoneRaw" text, "categoryRaw" text, "membershipTypeRaw" text,
    "paymentMethodRaw" text, "paymentStatusRaw" text, "noteRaw" text, "occurredOn" text,
    "amountUsd" text, "normalizedCustomerName" text, "normalizedCustomerEmail" text,
    "normalizedCustomerPhone" text, "rowQuality" text, "qualityIssues" jsonb
  );

  update public.b2c_finance_imports set import_status = 'completed' where id = import_id;
  return import_id;
end;
$$;

revoke all on function public.finalize_b2c_finance_import(text, text, text, text, jsonb) from public;
grant execute on function public.finalize_b2c_finance_import(text, text, text, text, jsonb) to authenticated;
