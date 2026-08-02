-- Query indexes match the dashboard, report, reconciliation, and review-queue paths.
create index b2c_payments_customer_email_idx on public.b2c_payments (customer_email);
create index b2c_payments_occurred_on_idx on public.b2c_payments (occurred_on desc);
create index b2c_payments_status_occurred_on_idx on public.b2c_payments (payment_status, occurred_on desc);
create index b2c_payments_fingerprint_occurred_at_idx on public.b2c_payments (duplicate_fingerprint, occurred_at desc);
create index b2c_refunds_payment_id_idx on public.b2c_refunds (payment_id);
create index b2b_deals_stage_close_date_idx on public.b2b_deals (stage_code, hubspot_close_date);
create index b2b_deals_renewal_date_idx on public.b2b_deals (renewal_date) where renewal_date is not null;
create index b2b_deal_stage_history_deal_changed_at_idx on public.b2b_deal_stage_history (deal_id, changed_at desc);
create index b2b_bookings_booking_date_idx on public.b2b_bookings (booking_date desc);
create index b2b_recognised_sales_period_idx on public.b2b_recognised_sales (reporting_period, recognition_date);
create index b2b_invoices_deal_issued_on_idx on public.b2b_invoices (deal_id, issued_on desc);
create index b2b_receipts_invoice_received_on_idx on public.b2b_receipts (invoice_id, received_on desc);
create index financial_targets_period_idx on public.financial_targets (period_start, period_end);
create index summit_updates_metric_date_idx on public.summit_updates (metric_code, update_date desc);
create index data_coverage_period_idx on public.data_coverage (domain_area, source_system, period_start, period_end);
create index review_flags_status_priority_idx on public.review_flags (status, priority, created_at desc);
create index review_flags_assigned_to_idx on public.review_flags (assigned_to, status) where assigned_to is not null;
create index audit_events_occurred_at_idx on public.audit_events (occurred_at desc);
create index audit_events_record_idx on public.audit_events (area, record_id, occurred_at desc);
create index integration_events_status_received_at_idx on public.integration_events (status, received_at desc);
create index integration_errors_provider_occurred_at_idx on public.integration_errors (provider, occurred_at desc);
create index report_jobs_period_status_idx on public.report_jobs (period_start, period_end, status);
create index report_delivery_attempts_report_idx on public.report_delivery_attempts (report_id, requested_at desc);

-- All audited tables now exist. Attach the append-only audit trigger only after
-- the integration and report foundations have been created.
do $$
declare
  audited_table text;
begin
  foreach audited_table in array array[
    'approved_users', 'profile_roles', 'customers', 'products', 'product_mappings',
    'b2c_payments', 'b2c_refunds', 'b2b_deal_stages', 'b2b_companies', 'b2b_deals',
    'b2b_deal_stage_history', 'b2b_bookings', 'b2b_invoices', 'b2b_receipts',
    'b2b_recognised_sales', 'financial_corrections', 'expenses', 'cash_position_snapshots',
    'financial_targets', 'exchange_rates', 'summit_targets', 'summit_updates',
    'data_coverage', 'review_flags', 'review_flag_resolutions', 'review_notes',
    'integration_sync_runs', 'integration_events', 'integration_errors', 'reconciliation_runs',
    'report_jobs', 'reports', 'report_files', 'report_delivery_attempts'
  ] loop
    execute format(
      'create trigger audit_%1$s after insert or update or delete on public.%1$I for each row execute procedure public.write_audit_event()',
      audited_table
    );
  end loop;
end;
$$;

-- Every application table has RLS. Service-role operations remain server-only and
-- must never be exposed through NEXT_PUBLIC environment variables.
do $$
declare
  secured_table text;
begin
  foreach secured_table in array array[
    'profiles', 'roles', 'approved_users', 'profile_roles',
    'customers', 'products', 'product_mappings', 'b2c_payments', 'b2c_refunds',
    'b2b_deal_stages', 'b2b_companies', 'b2b_deals', 'b2b_deal_stage_history',
    'b2b_bookings', 'b2b_invoices', 'b2b_receipts', 'b2b_recognised_sales',
    'financial_corrections', 'expenses', 'cash_position_snapshots', 'financial_targets',
    'exchange_rates', 'summit_targets', 'summit_updates', 'data_coverage',
    'review_flags', 'review_flag_resolutions', 'review_notes', 'audit_events',
    'integration_sync_runs', 'integration_events', 'integration_errors', 'reconciliation_runs',
    'report_jobs', 'reports', 'report_files', 'report_delivery_attempts'
  ] loop
    execute format('alter table public.%I enable row level security', secured_table);
  end loop;
end;
$$;

-- Approved viewers and admins can read dashboard records. Audit and operational
-- integration logs are intentionally limited to admins.
create policy profiles_read_approved on public.profiles for select to authenticated using (public.is_approved_user());
create policy roles_read_approved on public.roles for select to authenticated using (public.is_approved_user());
create policy profile_roles_read_own_or_admin on public.profile_roles for select to authenticated
  using (profile_id = auth.uid() or public.is_admin());
create policy approved_users_read_admin on public.approved_users for select to authenticated using (public.is_admin());

do $$
declare
  readable_table text;
begin
  foreach readable_table in array array[
    'customers', 'products', 'product_mappings', 'b2c_payments', 'b2c_refunds',
    'b2b_deal_stages', 'b2b_companies', 'b2b_deals', 'b2b_deal_stage_history',
    'b2b_bookings', 'b2b_invoices', 'b2b_receipts', 'b2b_recognised_sales',
    'financial_corrections', 'expenses', 'cash_position_snapshots', 'financial_targets',
    'exchange_rates', 'summit_targets', 'summit_updates', 'data_coverage',
    'review_flags', 'review_flag_resolutions', 'review_notes',
    'report_jobs', 'reports', 'report_files', 'report_delivery_attempts'
  ] loop
    execute format(
      'create policy approved_read on public.%I for select to authenticated using (public.is_approved_user())',
      readable_table
    );
  end loop;
end;
$$;

create policy audit_events_read_admin on public.audit_events for select to authenticated using (public.is_admin());

do $$
declare
  admin_log_table text;
begin
  foreach admin_log_table in array array[
    'integration_sync_runs', 'integration_events', 'integration_errors', 'reconciliation_runs'
  ] loop
    execute format(
      'create policy admin_read on public.%I for select to authenticated using (public.is_admin())',
      admin_log_table
    );
  end loop;
end;
$$;

-- Admin management writes. No policy is created for deletion of financial records.
create policy approved_users_insert_admin on public.approved_users for insert to authenticated with check (public.is_admin());
create policy approved_users_update_admin on public.approved_users for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy profile_roles_insert_admin on public.profile_roles for insert to authenticated with check (public.is_admin());
create policy profile_roles_update_admin on public.profile_roles for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy profile_roles_delete_admin on public.profile_roles for delete to authenticated using (public.is_admin());

do $$
declare
  insert_table text;
begin
  foreach insert_table in array array[
    'customers', 'products', 'product_mappings', 'b2c_payments', 'b2c_refunds',
    'b2b_deal_stages', 'b2b_companies', 'b2b_deals', 'b2b_deal_stage_history',
    'b2b_bookings', 'b2b_invoices', 'b2b_receipts', 'b2b_recognised_sales',
    'financial_corrections', 'expenses', 'cash_position_snapshots', 'financial_targets',
    'exchange_rates', 'summit_targets', 'summit_updates', 'data_coverage',
    'review_flags', 'review_flag_resolutions', 'review_notes',
    'integration_sync_runs', 'integration_events', 'integration_errors', 'reconciliation_runs',
    'report_jobs', 'reports', 'report_files', 'report_delivery_attempts'
  ] loop
    execute format(
      'create policy admin_insert on public.%I for insert to authenticated with check (public.is_admin())',
      insert_table
    );
  end loop;
end;
$$;

-- Updates are deliberately limited to mutable configuration/state rows. Corrections,
-- refunds, payments, bookings, receipts, recognised sales, and audit rows are append-only.
do $$
declare
  update_table text;
begin
  foreach update_table in array array[
    'customers', 'products', 'product_mappings', 'b2b_deal_stages', 'b2b_companies',
    'b2b_deals', 'b2b_deal_stage_history', 'financial_targets', 'summit_targets',
    'data_coverage', 'integration_sync_runs', 'integration_events', 'integration_errors',
    'reconciliation_runs', 'report_jobs', 'reports', 'report_files', 'report_delivery_attempts'
  ] loop
    execute format(
      'create policy admin_update on public.%I for update to authenticated using (public.is_admin()) with check (public.is_admin())',
      update_table
    );
  end loop;
end;
$$;

revoke all on all tables in schema public from anon;
revoke all on all tables in schema public from authenticated;
grant usage on schema public to authenticated;
grant select on all tables in schema public to authenticated;
grant insert on table
  public.approved_users, public.profile_roles,
  public.customers, public.products, public.product_mappings, public.b2c_payments, public.b2c_refunds,
  public.b2b_deal_stages, public.b2b_companies, public.b2b_deals, public.b2b_deal_stage_history,
  public.b2b_bookings, public.b2b_invoices, public.b2b_receipts, public.b2b_recognised_sales,
  public.financial_corrections, public.expenses, public.cash_position_snapshots, public.financial_targets,
  public.exchange_rates, public.summit_targets, public.summit_updates, public.data_coverage,
  public.review_flags, public.review_flag_resolutions, public.review_notes,
  public.integration_sync_runs, public.integration_events, public.integration_errors, public.reconciliation_runs,
  public.report_jobs, public.reports, public.report_files, public.report_delivery_attempts
to authenticated;
grant update on table
  public.approved_users, public.profile_roles,
  public.customers, public.products, public.product_mappings, public.b2b_deal_stages,
  public.b2b_companies, public.b2b_deals, public.b2b_deal_stage_history,
  public.financial_targets, public.summit_targets, public.data_coverage,
  public.integration_sync_runs, public.integration_events, public.integration_errors, public.reconciliation_runs,
  public.report_jobs, public.reports, public.report_files, public.report_delivery_attempts
to authenticated;
grant delete on table public.profile_roles to authenticated;

revoke all on function public.handle_new_auth_user() from public;
revoke all on function public.assign_manual_b2c_actor() from public;
revoke all on function public.prevent_refund_overage() from public;
revoke all on function public.assign_manual_b2b_actor() from public;
revoke all on function public.validate_recognised_sale() from public;
revoke all on function public.assign_finance_actor() from public;
revoke all on function public.apply_review_resolution() from public;
revoke all on function public.assign_review_note_actor() from public;
revoke all on function public.write_audit_event() from public;
grant execute on function public.current_profile_id(), public.is_approved_user(), public.is_admin() to authenticated;
