-- A mismatch is as much an audit fact as an exact match: the provider
-- transaction ID agrees, while an amount, currency, date, or status does not.
-- Persisting it makes the discrepancy reviewable without ever changing a
-- payment or a financial total.
alter table public.b2c_provider_evidence_payment_links
  drop constraint if exists b2c_provider_evidence_payment_links_match_state_check;

alter table public.b2c_provider_evidence_payment_links
  add constraint b2c_provider_evidence_payment_links_match_state_check
  check (match_state in ('exact_match', 'mismatch'));

alter table public.b2c_provider_evidence_payment_links
  add column if not exists mismatch_fields text[] not null default '{}';

alter table public.b2c_provider_evidence_payment_links
  add constraint b2c_provider_evidence_payment_links_mismatch_fields_check
  check (
    (match_state = 'exact_match' and cardinality(mismatch_fields) = 0)
    or (match_state = 'mismatch' and cardinality(mismatch_fields) > 0)
  );

alter table public.b2c_provider_evidence_payment_links
  add constraint b2c_provider_evidence_payment_links_mismatch_fields_values_check
  check (mismatch_fields <@ array['amount', 'currency', 'date', 'status']::text[]);

create index b2c_provider_evidence_payment_links_mismatch_idx
  on public.b2c_provider_evidence_payment_links (match_state)
  where match_state = 'mismatch';

-- An evidence/payment link is only an audit fact when both sides are from the
-- same provider. RLS allows an Admin to insert links, so this check belongs in
-- the database rather than relying on the application-side source filter.
create or replace function public.require_b2c_provider_evidence_payment_provider_match()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_evidence_provider text;
  v_payment_source_system text;
begin
  select evidence.provider, payment.source_system::text
    into v_evidence_provider, v_payment_source_system
    from public.b2c_provider_evidence evidence
    join public.b2c_payments payment on payment.id = new.payment_id
   where evidence.id = new.provider_evidence_id;

  if v_evidence_provider is distinct from v_payment_source_system then
    raise exception 'Provider evidence and local payment must use the same provider'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger require_b2c_provider_evidence_payment_provider_match
  before insert on public.b2c_provider_evidence_payment_links
  for each row execute procedure public.require_b2c_provider_evidence_payment_provider_match();

revoke all on function public.require_b2c_provider_evidence_payment_provider_match() from public;
