-- Records only the EXACT provider-ID matches produced by
-- reconcileProviderEvidence() (see
-- src/server/services/b2c-provider-evidence-reconciliation.ts). A mismatch or
-- unmatched-evidence fact is never persisted here -- it stays a read-time
-- comparison (the existing pattern in
-- get_b2c_tap_statement_unmatched_ledger_rows) surfaced as a work-queue item.
-- This table never creates a payment and never changes a financial total; it
-- only records that one immutable evidence row and one local API payment
-- already agree on transaction ID, amount, currency, date, and status.
create table public.b2c_provider_evidence_payment_links (
  id uuid primary key default gen_random_uuid(),
  provider_evidence_id uuid not null unique references public.b2c_provider_evidence(id),
  payment_id uuid not null references public.b2c_payments(id),
  match_state text not null default 'exact_match' check (match_state = 'exact_match'),
  matched_during_import_id uuid references public.b2c_finance_imports(id),
  linked_by uuid references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now())
);

create index b2c_provider_evidence_payment_links_payment_id_idx
  on public.b2c_provider_evidence_payment_links (payment_id);

-- Every link records who ran the reconciling import; never client-supplied.
create or replace function public.assign_b2c_provider_evidence_link_actor()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Only an authenticated administrator can link B2C provider evidence';
  end if;
  new.linked_by := auth.uid();
  return new;
end;
$$;

create trigger assign_b2c_provider_evidence_link_actor
  before insert on public.b2c_provider_evidence_payment_links
  for each row execute procedure public.assign_b2c_provider_evidence_link_actor();

-- An evidence link is a permanent audit fact once written: it can be created
-- (including a repeated, idempotent no-op via the unique evidence-id
-- constraint) but never repointed or removed.
create trigger prevent_b2c_provider_evidence_payment_link_mutation
  before update or delete on public.b2c_provider_evidence_payment_links
  for each row execute procedure public.prevent_b2c_finance_lineage_mutation();

create trigger audit_b2c_provider_evidence_payment_links
  after insert or update or delete on public.b2c_provider_evidence_payment_links
  for each row execute procedure public.write_audit_event();

alter table public.b2c_provider_evidence_payment_links enable row level security;

create policy admin_read on public.b2c_provider_evidence_payment_links
  for select to authenticated using (public.is_admin());
create policy admin_insert on public.b2c_provider_evidence_payment_links
  for insert to authenticated with check (public.is_admin());

revoke all on public.b2c_provider_evidence_payment_links from public, anon, authenticated;
grant select, insert on public.b2c_provider_evidence_payment_links to authenticated;

revoke all on function public.assign_b2c_provider_evidence_link_actor() from public;
