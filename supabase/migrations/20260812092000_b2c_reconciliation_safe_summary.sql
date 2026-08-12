-- Approved users may see only safe B2C reconciliation coverage. This function
-- deliberately returns counts and source states, never customer, provider, or raw-row data.
create or replace function public.get_b2c_reconciliation_safe_summary()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not public.is_approved_user() then
    raise exception 'Approved access is required for the B2C reconciliation summary';
  end if;

  return jsonb_build_object(
    'publicationState', 'not_fully_loaded',
    'publicationMessage', 'B2C Finance revenue is withheld until the Payment Tracker, Tap statement, Stripe Charges export, reconciliation, and Finance approval are complete.',
    'sources', jsonb_build_array(
      jsonb_build_object(
        'key', 'payment_tracker',
        'label', 'Payment Tracker',
        'status', coalesce((select import_status::text from public.b2c_finance_imports where source_kind = 'payment_tracker' order by created_at desc limit 1), 'not_loaded')
      ),
      jsonb_build_object(
        'key', 'tap_statement',
        'label', 'Tap statement',
        'status', coalesce((select import_status::text from public.b2c_finance_imports where source_kind = 'tap_statement' order by created_at desc limit 1), 'not_loaded')
      ),
      jsonb_build_object(
        'key', 'stripe_charges',
        'label', 'Stripe Charges',
        'status', coalesce((select import_status::text from public.b2c_finance_imports where source_kind = 'stripe_charges' order by created_at desc limit 1), 'not_loaded')
      )
    ),
    'counts', jsonb_build_object(
      'stagedRows', (select count(*) from public.b2c_finance_staging_rows rows join public.b2c_finance_imports imports on imports.id = rows.import_id where imports.import_status = 'completed'),
      'validRows', (select count(*) from public.b2c_finance_staging_rows rows join public.b2c_finance_imports imports on imports.id = rows.import_id where imports.import_status = 'completed' and rows.row_quality = 'valid'),
      'needsReviewRows', (select count(*) from public.b2c_finance_staging_rows rows join public.b2c_finance_imports imports on imports.id = rows.import_id where imports.import_status = 'completed' and rows.row_quality = 'needs_review'),
      'zeroValueRows', (select count(*) from public.b2c_finance_staging_rows rows join public.b2c_finance_imports imports on imports.id = rows.import_id where imports.import_status = 'completed' and rows.row_quality = 'zero_value'),
      'invalidRows', (select count(*) from public.b2c_finance_staging_rows rows join public.b2c_finance_imports imports on imports.id = rows.import_id where imports.import_status = 'completed' and rows.row_quality = 'invalid'),
      'unresolvedGroups', (select count(*) from public.b2c_reconciliation_groups where reconciliation_state not in ('canonical', 'excluded'))
    )
  );
end;
$$;

revoke all on function public.get_b2c_reconciliation_safe_summary() from public;
grant execute on function public.get_b2c_reconciliation_safe_summary() to authenticated;
