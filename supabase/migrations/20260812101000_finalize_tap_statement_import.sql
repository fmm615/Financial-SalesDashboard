-- Complete Tap statements are private original-currency evidence, never B2C revenue.
update storage.buckets
set allowed_mime_types = array[
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv'
]
where id = 'b2c-finance-imports';

create or replace function public.finalize_tap_statement_import(
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
    raise exception 'Only an authenticated administrator can finalize Tap statement imports';
  end if;

  if char_length(trim(coalesce(p_source_file_name, ''))) not between 1 and 255
    or coalesce(p_source_file_sha256, '') !~ '^[0-9a-f]{64}$'
    or char_length(trim(coalesce(p_source_storage_bucket, ''))) not between 1 and 100
    or char_length(trim(coalesce(p_source_storage_path, ''))) not between 1 and 1000 then
    raise exception 'Tap statement import provenance is invalid';
  end if;

  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 or jsonb_array_length(p_rows) > 20000 then
    raise exception 'Tap statement imports require between 1 and 20000 evidence rows';
  end if;

  for row_item in select value from jsonb_array_elements(p_rows)
  loop
    row_number_text := coalesce(row_item ->> 'sourceRowNumber', '');
    if coalesce(jsonb_typeof(row_item), '') <> 'object'
      or row_number_text !~ '^[0-9]+$'
      or row_number_text::integer < 2
      or char_length(trim(coalesce(row_item ->> 'postingId', ''))) not between 1 and 255
      or coalesce(row_item ->> 'kind', '') not in ('sale', 'processing_fee', 'fee_vat', 'refund', 'transfer', 'opening_balance', 'needs_review')
      or coalesce(row_item ->> 'currency', '') !~ '^[A-Z]{3}$'
      or (nullif(row_item ->> 'credit', '') is not null and row_item ->> 'credit' !~ '^[0-9]+(?:\.[0-9]{1,6})?$')
      or (nullif(row_item ->> 'debit', '') is not null and row_item ->> 'debit' !~ '^[0-9]+(?:\.[0-9]{1,6})?$')
      or (nullif(row_item ->> 'occurredAt', '') is not null and row_item ->> 'occurredAt' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$')
      or coalesce(jsonb_typeof(row_item -> 'rawPayload'), '') <> 'object'
      or (coalesce(row_item ->> 'kind', '') = 'sale' and char_length(trim(coalesce(row_item ->> 'paymentId', ''))) = 0)
      or (coalesce(row_item ->> 'kind', '') = 'refund' and char_length(trim(coalesce(row_item ->> 'refundId', ''))) = 0) then
      raise exception 'Tap statement evidence row is invalid';
    end if;
  end loop;

  insert into public.b2c_finance_imports (
    source_kind, source_file_name, source_file_sha256, source_storage_bucket, source_storage_path, import_status
  ) values (
    'tap_statement', trim(p_source_file_name), p_source_file_sha256, trim(p_source_storage_bucket), trim(p_source_storage_path), 'processing'
  ) returning id into import_id;

  insert into public.b2c_provider_evidence (
    import_id, provider, source_row_number, provider_row_id, provider_payment_id, provider_refund_id,
    transaction_kind, description_raw, occurred_at, occurred_at_raw, original_currency, credit_amount,
    debit_amount, raw_payload
  )
  select import_id, 'tap', row_data."sourceRowNumber"::integer, row_data."postingId",
    nullif(row_data."paymentId", ''), nullif(row_data."refundId", ''),
    row_data."kind"::public.b2c_provider_evidence_kind, nullif(row_data."description", ''),
    nullif(row_data."occurredAt", '')::timestamptz, nullif(row_data."occurredAtRaw", ''),
    row_data."currency", nullif(row_data."credit", '')::numeric(20, 6),
    nullif(row_data."debit", '')::numeric(20, 6), row_data."rawPayload"
  from jsonb_to_recordset(p_rows) as row_data(
    "sourceRowNumber" text, "postingId" text, "paymentId" text, "refundId" text,
    "kind" text, "description" text, "occurredAt" text, "occurredAtRaw" text,
    "currency" text, "credit" text, "debit" text, "rawPayload" jsonb
  );

  update public.b2c_finance_imports set import_status = 'completed' where id = import_id;
  return import_id;
end;
$$;

revoke all on function public.finalize_tap_statement_import(text, text, text, text, jsonb) from public;
grant execute on function public.finalize_tap_statement_import(text, text, text, text, jsonb) to authenticated;
