-- A narrow, read-only projection for approved users. The private Tap statement
-- source tables and their raw payloads remain Admin-only under RLS.
create or replace function public.get_b2c_tap_statement_unmatched_ledger_rows()
returns table (
  evidence_id uuid,
  provider_payment_id text,
  description_raw text,
  occurred_at timestamptz,
  original_currency text,
  original_amount numeric
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not public.is_approved_user() then
    raise exception 'Approved user access is required';
  end if;

  return query
  with latest_completed_statement as (
    select imports.id
    from public.b2c_finance_imports imports
    where imports.source_kind = 'tap_statement'
      and imports.import_status = 'completed'
    order by imports.created_at desc
    limit 1
  )
  select
    evidence.id,
    evidence.provider_payment_id,
    evidence.description_raw,
    evidence.occurred_at,
    evidence.original_currency,
    coalesce(evidence.credit_amount, evidence.debit_amount)
  from public.b2c_provider_evidence evidence
  join latest_completed_statement statement on statement.id = evidence.import_id
  where evidence.provider = 'tap'
    and evidence.transaction_kind = 'sale'
    and evidence.provider_payment_id is not null
    and coalesce(evidence.credit_amount, evidence.debit_amount) is not null
    and not exists (
      select 1
      from public.b2c_payments payment
      where payment.source_system = 'tap'
        and payment.provider_transaction_id = evidence.provider_payment_id
    );
end;
$$;

revoke all on function public.get_b2c_tap_statement_unmatched_ledger_rows() from public;
grant execute on function public.get_b2c_tap_statement_unmatched_ledger_rows() to authenticated;
