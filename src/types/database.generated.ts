/**
 * DATABASE TYPE SNAPSHOT
 *
 * Regenerate against a clean local Supabase database with:
 *   npm run supabase:types
 *
 * Do not use these raw rows in UI components. Map them through a repository or
 * domain type first. Regeneration will replace this Phase 2 checked-in snapshot.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

type Timestamp = string;
type Uuid = string;
type Decimal = string;

type Table<Row, Insert = Partial<Row>, Update = Partial<Insert>> = {
  Row: Row;
  Insert: Insert;
  Update: Update;
  Relationships: [];
};

type ProfileRow = {
  id: Uuid;
  email: string;
  display_name: string;
  avatar_url: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
};

type B2cPaymentRow = {
  id: Uuid;
  source_system: "stripe" | "tap" | "manual_bank_transfer";
  provider_transaction_id: string | null;
  provider_event_id: string | null;
  customer_id: Uuid | null;
  customer_email: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  product_mapping_id: Uuid | null;
  category_code: string;
  membership_tier: string | null;
  payment_status: "succeeded" | "failed" | "pending";
  original_amount: Decimal;
  original_currency: string;
  exchange_rate_to_usd: Decimal;
  amount_usd: Decimal;
  gross_amount_usd: Decimal;
  tax_amount_usd: Decimal | null;
  net_amount_usd: Decimal | null;
  occurred_at: Timestamp;
  occurred_on: string;
  imported_at: Timestamp;
  duplicate_fingerprint: string;
  reconciliation_source: string | null;
  source_metadata: Json;
  manual_entry_reason: string | null;
  entered_by: Uuid | null;
  created_at: Timestamp;
  updated_at: Timestamp;
};

type B2bDealRow = {
  id: Uuid;
  company_id: Uuid;
  source_system: "hubspot" | "manual_finance";
  external_deal_id: string | null;
  name: string;
  stage_code: string;
  financial_status: "complete" | "needs_review";
  duplicate_review_status: "clear" | "needs_review" | "include" | "exclude";
  local_record_status: "active" | "excluded";
  pipeline_original_amount: Decimal | null;
  original_currency: string | null;
  exchange_rate_to_usd: Decimal | null;
  pipeline_amount_usd: Decimal | null;
  hubspot_close_date: string | null;
  renewal_date: string | null;
  owner_name: string | null;
  manual_entry_reason: string | null;
  entered_by: Uuid | null;
  source_metadata: Json;
  imported_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
};

type B2bBookingRow = {
  id: Uuid;
  deal_id: Uuid;
  source_system: "hubspot" | "manual_finance";
  booking_date: string;
  original_amount: Decimal;
  original_currency: string;
  exchange_rate_to_usd: Decimal;
  booking_amount_usd: Decimal;
  source_reference: string | null;
  manual_entry_reason: string | null;
  entered_by: Uuid | null;
  created_at: Timestamp;
};

type RecognisedSaleRow = {
  id: Uuid;
  deal_id: Uuid;
  booking_id: Uuid | null;
  recognised_amount: Decimal;
  original_currency: string;
  exchange_rate_to_usd: Decimal;
  recognised_amount_usd: Decimal;
  recognition_date: string;
  reporting_period: string;
  reason_or_reference: string;
  entered_by: Uuid;
  entered_at: Timestamp;
  created_at: Timestamp;
};

export interface Database {
  public: {
    Tables: {
      profiles: Table<ProfileRow, Omit<ProfileRow, "created_at" | "updated_at">>;
      roles: Table<{ id: Uuid; code: Database["public"]["Enums"]["access_role"]; description: string; created_at: Timestamp }>;
      approved_users: Table<{
        id: Uuid; email: string; display_name: string; default_role_id: Uuid; enabled: boolean;
        approved_at: Timestamp; approved_by: Uuid | null; disabled_at: Timestamp | null; created_at: Timestamp; updated_at: Timestamp;
      }>;
      profile_roles: Table<{ profile_id: Uuid; role_id: Uuid; assigned_at: Timestamp; assigned_by: Uuid | null }>;
      customers: Table<{ id: Uuid; email: string; full_name: string | null; created_at: Timestamp; updated_at: Timestamp }>;
      products: Table<{ id: Uuid; internal_code: string; name: string; active: boolean; created_at: Timestamp; updated_at: Timestamp }>;
      product_mappings: Table<{
        id: Uuid; source_system: "stripe" | "tap"; external_product_id: string; product_id: Uuid; category_code: string;
        membership_tier: string | null; created_by: Uuid; updated_by: Uuid; created_at: Timestamp; updated_at: Timestamp;
      }>;
      b2c_payments: Table<B2cPaymentRow>;
      b2c_finance_imports: Table<{
        id: Uuid; source_kind: Database["public"]["Enums"]["b2c_finance_import_source_kind"]; source_file_name: string;
        source_file_sha256: string; source_storage_bucket: string; source_storage_path: string;
        import_status: Database["public"]["Enums"]["b2c_finance_import_status"]; safe_error_summary: string | null;
        imported_by: Uuid; completed_at: Timestamp | null; failed_at: Timestamp | null; created_at: Timestamp; updated_at: Timestamp;
      }>;
      b2c_finance_staging_rows: Table<{
        id: Uuid; import_id: Uuid; source_tab: "B2C" | "B2C Cons"; source_row_number: number; raw_payload: Json;
        reported_date_raw: string; declared_month_raw: string | null; declared_year_raw: string | null; amount_usd_raw: string | null;
        customer_name_raw: string | null; customer_email_raw: string | null; customer_phone_raw: string | null; category_raw: string | null;
        membership_type_raw: string | null; payment_method_raw: string | null; payment_status_raw: string | null; note_raw: string | null;
        occurred_on: string | null; amount_usd: Decimal | null; normalized_customer_name: string | null;
        normalized_customer_email: string | null; normalized_customer_phone: string | null;
        row_quality: Database["public"]["Enums"]["b2c_finance_row_quality"]; quality_issues: Json; created_at: Timestamp;
      }>;
      b2c_provider_evidence: Table<{
        id: Uuid; import_id: Uuid; provider: "tap" | "stripe"; source_row_number: number; provider_row_id: string | null;
        provider_payment_id: string | null; provider_refund_id: string | null;
        transaction_kind: Database["public"]["Enums"]["b2c_provider_evidence_kind"]; description_raw: string | null;
        occurred_at: Timestamp | null; occurred_at_raw: string | null; original_currency: string; credit_amount: Decimal | null;
        debit_amount: Decimal | null; raw_payload: Json; created_at: Timestamp;
      }>;
      b2c_reconciliation_groups: Table<{
        id: Uuid; reconciliation_state: Database["public"]["Enums"]["b2c_reconciliation_state"];
        canonical_finance_row_id: Uuid | null; decision_reason: string | null; decided_by: Uuid | null; decided_at: Timestamp | null;
        created_by: Uuid; created_at: Timestamp;
      }>;
      b2c_reconciliation_finance_rows: Table<{
        id: Uuid; reconciliation_group_id: Uuid; finance_row_id: Uuid; created_at: Timestamp;
      }>;
      b2c_reconciliation_provider_evidence: Table<{
        id: Uuid; reconciliation_group_id: Uuid; provider_evidence_id: Uuid; created_at: Timestamp;
      }>;
      b2c_reconciliation_decisions: Table<{
        id: Uuid; reconciliation_group_id: Uuid; decision_state: "canonical" | "excluded"; canonical_finance_row_id: Uuid | null;
        decision_reason: string; decided_by: Uuid; created_at: Timestamp;
      }>;
      b2c_payment_local_overrides: Table<{
        payment_id: Uuid; customer_name: string | null; customer_email: string | null; customer_phone: string | null;
        category_code: string | null; membership_tier: string | null; local_amount_usd: Decimal | null; local_occurred_on: string | null; created_by: Uuid; updated_by: Uuid;
        created_at: Timestamp; updated_at: Timestamp;
      }>;
      b2c_payment_finance_exception_decisions: Table<{
        id: Uuid; payment_id: Uuid; decision: "include" | "revoke"; reason: string;
        confirmed_provider_transaction: boolean; confirmed_no_known_duplicate: boolean;
        created_by: Uuid; created_at: Timestamp;
      }>;
      b2c_refunds: Table<{
        id: Uuid; payment_id: Uuid; source_system: B2cPaymentRow["source_system"]; provider_refund_id: string | null;
        original_amount: Decimal; original_currency: string; exchange_rate_to_usd: Decimal; amount_usd: Decimal;
        reason: string | null; occurred_at: Timestamp; imported_at: Timestamp; provider_metadata: Json; created_at: Timestamp;
      }>;
      b2b_deal_stages: Table<{ code: string; label: string; display_order: number; is_closed: boolean; is_won: boolean; created_at: Timestamp; updated_at: Timestamp }>;
      b2b_companies: Table<{ id: Uuid; source_system: "hubspot" | "manual_finance"; external_company_id: string | null; legal_name: string; domain: string | null; created_at: Timestamp; updated_at: Timestamp }>;
      b2b_deals: Table<B2bDealRow>;
      b2b_duplicate_groups: Table<{ id: Uuid; fingerprint: string; status: "open" | "resolved"; decision: "keep_both" | "keep_one" | null; resolution_note: string | null; resolved_by: Uuid | null; resolved_at: Timestamp | null; created_at: Timestamp }>;
      b2b_duplicate_group_members: Table<{ group_id: Uuid; deal_id: Uuid; decision: "pending" | "include" | "exclude"; created_at: Timestamp }>;
      b2b_deal_stage_history: Table<{ id: Uuid; deal_id: Uuid; stage_code: string; changed_at: Timestamp; source_system: "hubspot" | "manual_finance"; external_event_id: string | null; created_at: Timestamp }>;
      b2b_bookings: Table<B2bBookingRow>;
      b2b_invoices: Table<{ id: Uuid; deal_id: Uuid; booking_id: Uuid | null; source_system: "hubspot" | "manual_finance" | "accounting_system"; external_invoice_id: string | null; invoice_number: string | null; issued_on: string; due_on: string | null; original_amount: Decimal; original_currency: string; exchange_rate_to_usd: Decimal; invoiced_amount_usd: Decimal; created_at: Timestamp }>;
      b2b_receipts: Table<{ id: Uuid; invoice_id: Uuid; source_system: "manual_finance" | "accounting_system"; external_receipt_id: string | null; received_on: string; original_amount: Decimal; original_currency: string; exchange_rate_to_usd: Decimal; received_amount_usd: Decimal; created_at: Timestamp }>;
      b2b_recognised_sales: Table<RecognisedSaleRow>;
      financial_corrections: Table<{ id: Uuid; target_area: string; target_record_id: Uuid; correction_type: string; before_value: Json; after_value: Json; reason: string; effective_on: string; created_by: Uuid; created_at: Timestamp }>;
      expenses: Table<{ id: Uuid; expense_category: string; description: string; original_amount: Decimal; original_currency: string; exchange_rate_to_usd: Decimal; amount_usd: Decimal; incurred_on: string; source_reference: string | null; entered_by: Uuid; created_at: Timestamp }>;
      cash_position_snapshots: Table<{ id: Uuid; account_label: string; snapshot_on: string; original_amount: Decimal; original_currency: string; exchange_rate_to_usd: Decimal; amount_usd: Decimal; source_reference: string | null; entered_by: Uuid; created_at: Timestamp }>;
      financial_targets: Table<{ id: Uuid; target_lineage_id: Uuid; revision_number: number; metric_code: string; period_start: string; period_end: string; target_amount_usd: Decimal; notes: string | null; status: "draft" | "active" | "archived"; finance_reference: string; revision_reason: string; archived_at: Timestamp | null; created_by: Uuid; updated_by: Uuid; created_at: Timestamp; updated_at: Timestamp }>;
      operational_targets: Table<{ id: Uuid; target_lineage_id: Uuid; revision_number: number; display_name: string; value_kind: "money_usd" | "quantity"; target_value: Decimal; unit_label: string | null; period_start: string; period_end: string; status: "draft" | "active" | "archived"; finance_reference: string; revision_reason: string; archived_at: Timestamp | null; created_by: Uuid; updated_by: Uuid; created_at: Timestamp; updated_at: Timestamp }>;
      operational_target_progress_updates: Table<{ id: Uuid; target_id: Uuid; actual_value: Decimal; effective_on: string; evidence_note: string; entered_by: Uuid; created_at: Timestamp }>;
      exchange_rates: Table<{ id: Uuid; rate_date: string; base_currency: string; quote_currency: "USD"; rate: Decimal; source_system: "manual_finance" | "provider"; source_reference: string | null; entered_by: Uuid | null; created_at: Timestamp }>;
      summit_targets: Table<{ id: Uuid; metric_code: string; period_start: string; period_end: string; target_value: Decimal; value_currency: string | null; created_by: Uuid; updated_by: Uuid; created_at: Timestamp; updated_at: Timestamp }>;
      summit_updates: Table<{ id: Uuid; metric_code: string; update_date: string; value: Decimal; original_currency: string | null; exchange_rate_to_usd: Decimal | null; value_usd: Decimal | null; reason_or_reference: string; entered_by: Uuid; created_at: Timestamp }>;
      data_coverage: Table<{ id: Uuid; domain_area: string; source_system: string; period_start: string; period_end: string; coverage_status: Database["public"]["Enums"]["backfill_status"]; source_record_count: number | null; notes: string | null; recorded_by: Uuid | null; created_at: Timestamp; updated_at: Timestamp }>;
      review_flags: Table<{ id: Uuid; source_area: string; source_record_id: Uuid; flag_type: Database["public"]["Enums"]["review_flag_type"]; status: Database["public"]["Enums"]["review_flag_status"]; priority: number; reason: string; assigned_to: Uuid | null; created_by: Uuid | null; resolved_by: Uuid | null; resolved_at: Timestamp | null; created_at: Timestamp; updated_at: Timestamp }>;
      review_flag_resolutions: Table<{ id: Uuid; flag_id: Uuid; resolution_status: "resolved" | "dismissed"; resolution_note: string; created_by: Uuid; created_at: Timestamp }>;
      review_notes: Table<{ id: Uuid; flag_id: Uuid; note: string; created_by: Uuid; created_at: Timestamp }>;
      audit_events: Table<{ id: Uuid; actor_profile_id: Uuid | null; actor_email: string | null; area: string; record_id: Uuid | null; action: "insert" | "update" | "delete"; before_value: Json | null; after_value: Json | null; reason: string | null; request_context: Json; occurred_at: Timestamp }>;
      integration_sync_runs: Table<{ id: Uuid; provider: string; status: Database["public"]["Enums"]["integration_status"]; operation_type: "reconciliation" | "historical_backfill"; continuation_cursor: string | null; records_processed: number; records_failed: number; started_at: Timestamp | null; completed_at: Timestamp | null; failed_at: Timestamp | null; retry_count: number; safe_error_summary: string | null; requested_range_start: Timestamp | null; requested_range_end: Timestamp | null; created_at: Timestamp }>;
      integration_events: Table<{ id: Uuid; provider: string; external_event_id: string; event_type: string; status: Database["public"]["Enums"]["integration_status"]; processing_attempts: number; received_at: Timestamp; processed_at: Timestamp | null; safe_metadata: Json; sync_run_id: Uuid | null; created_at: Timestamp }>;
      integration_errors: Table<{ id: Uuid; provider: string; integration_event_id: Uuid | null; sync_run_id: Uuid | null; safe_error_summary: string; source_reference: string | null; occurred_at: Timestamp; resolved_at: Timestamp | null; resolved_by: Uuid | null; resolution_note: string | null; created_at: Timestamp }>;
      reconciliation_runs: Table<{ id: Uuid; provider: string; lookback_start: Timestamp; lookback_end: Timestamp; status: Database["public"]["Enums"]["integration_status"]; records_examined: number; records_inserted: number; duplicates_detected: number; safe_error_summary: string | null; started_at: Timestamp | null; completed_at: Timestamp | null; created_at: Timestamp }>;
      report_jobs: Table<{ id: Uuid; report_type: Database["public"]["Enums"]["report_type"]; period_start: string; period_end: string; status: Database["public"]["Enums"]["report_job_status"]; requested_by: Uuid | null; requested_at: Timestamp; started_at: Timestamp | null; completed_at: Timestamp | null; failed_at: Timestamp | null; retry_count: number; delivery_requested: boolean; generation_mode: "draft_fixture" | "financial"; safe_error_summary: string | null; created_at: Timestamp; updated_at: Timestamp }>;
      reports: Table<{ id: Uuid; job_id: Uuid; generated_at: Timestamp; summary_snapshot: Json; snapshot_version: string; readiness_status: "draft_fixture_only" | "financial_ready"; created_at: Timestamp }>;
      report_files: Table<{ id: Uuid; report_id: Uuid; file_kind: "pdf" | "csv_bundle"; storage_bucket: string; storage_path: string; created_at: Timestamp }>;
      report_delivery_attempts: Table<{ id: Uuid; report_id: Uuid; recipient_email: string; status: Database["public"]["Enums"]["integration_status"]; requested_at: Timestamp; sent_at: Timestamp | null; failed_at: Timestamp | null; safe_error_summary: string | null; created_at: Timestamp }>;
    };
    Views: {
      reportable_b2b_deals: {
        Row: B2bDealRow;
        Insert: never;
        Update: never;
        Relationships: [];
      };
    };
    Functions: {
      revise_financial_target: { Args: { p_target_id: Uuid; p_metric_code: string; p_period_start: string; p_period_end: string; p_target_amount_usd: Decimal; p_finance_reference: string; p_revision_reason: string }; Returns: Uuid };
      revise_operational_target: { Args: { p_target_id: Uuid; p_display_name: string; p_value_kind: "money_usd" | "quantity"; p_target_value: Decimal; p_unit_label: string | null; p_period_start: string; p_period_end: string; p_finance_reference: string; p_revision_reason: string }; Returns: Uuid };
      apply_hubspot_deal_financial_correction: {
        Args: { p_deal_id: Uuid; p_amount: Decimal; p_currency: string; p_exchange_rate_to_usd: Decimal; p_reason: string };
        Returns: undefined;
      };
      apply_hubspot_deal_close_date_correction: {
        Args: { p_deal_id: Uuid; p_close_date: string; p_reason: string };
        Returns: undefined;
      };
      apply_hubspot_deal_local_override: {
        Args: { p_deal_id: Uuid; p_name: string; p_owner_name: string | null; p_stage_code: string; p_amount: Decimal | null; p_currency: string | null; p_exchange_rate_to_usd: Decimal | null; p_close_date: string | null; p_renewal_date: string | null; p_reason: string };
        Returns: undefined;
      };
      exclude_hubspot_deal_locally: {
        Args: { p_deal_id: Uuid; p_reason: string };
        Returns: undefined;
      };
      create_manual_b2b_deal: {
        Args: { p_company_name: string; p_name: string; p_owner_name: string | null; p_stage_code: string; p_original_amount: Decimal; p_original_currency: string; p_exchange_rate_to_usd: Decimal; p_close_date: string | null; p_renewal_date: string | null; p_reason: string };
        Returns: Uuid;
      };
      resolve_hubspot_integration_error: {
        Args: { p_error_id: Uuid; p_resolution_note: string };
        Returns: undefined;
      };
      flag_hubspot_possible_duplicates: { Args: { p_deal_id: Uuid }; Returns: undefined };
      flag_manual_b2b_possible_duplicates: { Args: { p_deal_id: Uuid }; Returns: undefined };
      resolve_hubspot_duplicate_group: { Args: { p_group_id: Uuid; p_decision: string; p_keep_deal_id: Uuid | null; p_note: string }; Returns: undefined };
      apply_stripe_product_mapping: {
        Args: { p_external_product_id: string; p_internal_product_code: string; p_internal_product_name: string; p_category_code: string; p_membership_tier: string | null; p_reason: string };
        Returns: Uuid;
      };
      apply_b2c_product_mapping: {
        Args: { p_source_system: "stripe" | "tap"; p_external_product_id: string; p_internal_product_code: string; p_internal_product_name: string; p_category_code: string; p_membership_tier: string | null; p_reason: string };
        Returns: Uuid;
      };
      resolve_b2c_review_flag: { Args: { p_flag_id: Uuid; p_resolution_status: "resolved" | "dismissed"; p_resolution_note: string }; Returns: undefined };
      apply_b2c_payment_local_correction: {
        Args: { p_payment_id: Uuid; p_customer_name: string | null; p_customer_email: string | null; p_customer_phone: string | null; p_category_code: string | null; p_membership_tier: string | null; p_local_amount_usd: Decimal | null; p_local_occurred_on: string | null; p_reason: string };
        Returns: undefined;
      };
      include_b2c_payment_with_finance_exception: {
        Args: { p_payment_id: Uuid; p_reason: string; p_confirmed_provider_transaction: boolean; p_confirmed_no_known_duplicate: boolean };
        Returns: undefined;
      };
      finalize_b2c_finance_import: {
        Args: { p_source_file_name: string; p_source_file_sha256: string; p_source_storage_bucket: string; p_source_storage_path: string; p_rows: Json };
        Returns: Uuid;
      };
      finalize_tap_statement_import: {
        Args: { p_source_file_name: string; p_source_file_sha256: string; p_source_storage_bucket: string; p_source_storage_path: string; p_rows: Json };
        Returns: Uuid;
      };
      get_b2c_reconciliation_safe_summary: { Args: Record<string, never>; Returns: Json };
    };
    Enums: {
      access_role: "admin" | "viewer";
      review_flag_type: "refunded" | "failed" | "possible_duplicate" | "unmapped_product" | "needs_follow_up";
      review_flag_status: "open" | "resolved" | "dismissed";
      backfill_status: "not_started" | "partial" | "complete" | "unavailable";
      integration_status: "pending" | "processing" | "completed" | "failed" | "cancelled";
      report_type: "monthly" | "quarterly" | "annual" | "ad_hoc";
      report_job_status: "pending" | "processing" | "completed" | "failed" | "cancelled";
      b2c_finance_import_source_kind: "payment_tracker" | "tap_statement" | "stripe_charges";
      b2c_finance_import_status: "pending" | "processing" | "completed" | "failed";
      b2c_finance_row_quality: "valid" | "zero_value" | "needs_review" | "invalid";
      b2c_reconciliation_state: "unmatched" | "exact_duplicate_candidate" | "possible_duplicate" | "conflict" | "canonical" | "excluded";
      b2c_provider_evidence_kind: "sale" | "processing_fee" | "fee_vat" | "refund" | "transfer" | "opening_balance" | "needs_review";
    };
    CompositeTypes: Record<string, never>;
  };
}
