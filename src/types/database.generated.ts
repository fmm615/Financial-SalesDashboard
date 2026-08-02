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
  customer_email: string;
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
  pipeline_original_amount: Decimal;
  original_currency: string;
  exchange_rate_to_usd: Decimal;
  pipeline_amount_usd: Decimal;
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
      b2c_refunds: Table<{
        id: Uuid; payment_id: Uuid; source_system: B2cPaymentRow["source_system"]; provider_refund_id: string | null;
        original_amount: Decimal; original_currency: string; exchange_rate_to_usd: Decimal; amount_usd: Decimal;
        reason: string | null; occurred_at: Timestamp; imported_at: Timestamp; provider_metadata: Json; created_at: Timestamp;
      }>;
      b2b_deal_stages: Table<{ code: string; label: string; display_order: number; is_closed: boolean; is_won: boolean; created_at: Timestamp; updated_at: Timestamp }>;
      b2b_companies: Table<{ id: Uuid; source_system: "hubspot" | "manual_finance"; external_company_id: string | null; legal_name: string; domain: string | null; created_at: Timestamp; updated_at: Timestamp }>;
      b2b_deals: Table<B2bDealRow>;
      b2b_deal_stage_history: Table<{ id: Uuid; deal_id: Uuid; stage_code: string; changed_at: Timestamp; source_system: "hubspot" | "manual_finance"; external_event_id: string | null; created_at: Timestamp }>;
      b2b_bookings: Table<B2bBookingRow>;
      b2b_invoices: Table<{ id: Uuid; deal_id: Uuid; booking_id: Uuid | null; source_system: "hubspot" | "manual_finance" | "accounting_system"; external_invoice_id: string | null; invoice_number: string | null; issued_on: string; due_on: string | null; original_amount: Decimal; original_currency: string; exchange_rate_to_usd: Decimal; invoiced_amount_usd: Decimal; created_at: Timestamp }>;
      b2b_receipts: Table<{ id: Uuid; invoice_id: Uuid; source_system: "manual_finance" | "accounting_system"; external_receipt_id: string | null; received_on: string; original_amount: Decimal; original_currency: string; exchange_rate_to_usd: Decimal; received_amount_usd: Decimal; created_at: Timestamp }>;
      b2b_recognised_sales: Table<RecognisedSaleRow>;
      financial_corrections: Table<{ id: Uuid; target_area: string; target_record_id: Uuid; correction_type: string; before_value: Json; after_value: Json; reason: string; effective_on: string; created_by: Uuid; created_at: Timestamp }>;
      expenses: Table<{ id: Uuid; expense_category: string; description: string; original_amount: Decimal; original_currency: string; exchange_rate_to_usd: Decimal; amount_usd: Decimal; incurred_on: string; source_reference: string | null; entered_by: Uuid; created_at: Timestamp }>;
      cash_position_snapshots: Table<{ id: Uuid; account_label: string; snapshot_on: string; original_amount: Decimal; original_currency: string; exchange_rate_to_usd: Decimal; amount_usd: Decimal; source_reference: string | null; entered_by: Uuid; created_at: Timestamp }>;
      financial_targets: Table<{ id: Uuid; metric_code: string; period_start: string; period_end: string; target_amount_usd: Decimal; notes: string | null; created_by: Uuid; updated_by: Uuid; created_at: Timestamp; updated_at: Timestamp }>;
      exchange_rates: Table<{ id: Uuid; rate_date: string; base_currency: string; quote_currency: "USD"; rate: Decimal; source_system: "manual_finance" | "provider"; source_reference: string | null; entered_by: Uuid | null; created_at: Timestamp }>;
      summit_targets: Table<{ id: Uuid; metric_code: string; period_start: string; period_end: string; target_value: Decimal; value_currency: string | null; created_by: Uuid; updated_by: Uuid; created_at: Timestamp; updated_at: Timestamp }>;
      summit_updates: Table<{ id: Uuid; metric_code: string; update_date: string; value: Decimal; original_currency: string | null; exchange_rate_to_usd: Decimal | null; value_usd: Decimal | null; reason_or_reference: string; entered_by: Uuid; created_at: Timestamp }>;
      data_coverage: Table<{ id: Uuid; domain_area: string; source_system: string; period_start: string; period_end: string; coverage_status: Database["public"]["Enums"]["backfill_status"]; source_record_count: number | null; notes: string | null; recorded_by: Uuid | null; created_at: Timestamp; updated_at: Timestamp }>;
      review_flags: Table<{ id: Uuid; source_area: string; source_record_id: Uuid; flag_type: Database["public"]["Enums"]["review_flag_type"]; status: Database["public"]["Enums"]["review_flag_status"]; priority: number; reason: string; assigned_to: Uuid | null; created_by: Uuid | null; resolved_by: Uuid | null; resolved_at: Timestamp | null; created_at: Timestamp; updated_at: Timestamp }>;
      review_flag_resolutions: Table<{ id: Uuid; flag_id: Uuid; resolution_status: "resolved" | "dismissed"; resolution_note: string; created_by: Uuid; created_at: Timestamp }>;
      review_notes: Table<{ id: Uuid; flag_id: Uuid; note: string; created_by: Uuid; created_at: Timestamp }>;
      audit_events: Table<{ id: Uuid; actor_profile_id: Uuid | null; actor_email: string | null; area: string; record_id: Uuid | null; action: "insert" | "update" | "delete"; before_value: Json | null; after_value: Json | null; reason: string | null; request_context: Json; occurred_at: Timestamp }>;
      integration_sync_runs: Table<{ id: Uuid; provider: string; status: Database["public"]["Enums"]["integration_status"]; started_at: Timestamp | null; completed_at: Timestamp | null; failed_at: Timestamp | null; retry_count: number; safe_error_summary: string | null; requested_range_start: Timestamp | null; requested_range_end: Timestamp | null; created_at: Timestamp }>;
      integration_events: Table<{ id: Uuid; provider: string; external_event_id: string; event_type: string; status: Database["public"]["Enums"]["integration_status"]; processing_attempts: number; received_at: Timestamp; processed_at: Timestamp | null; safe_metadata: Json; sync_run_id: Uuid | null; created_at: Timestamp }>;
      integration_errors: Table<{ id: Uuid; provider: string; integration_event_id: Uuid | null; sync_run_id: Uuid | null; safe_error_summary: string; occurred_at: Timestamp; resolved_at: Timestamp | null; resolved_by: Uuid | null; created_at: Timestamp }>;
      reconciliation_runs: Table<{ id: Uuid; provider: string; lookback_start: Timestamp; lookback_end: Timestamp; status: Database["public"]["Enums"]["integration_status"]; records_examined: number; records_inserted: number; duplicates_detected: number; safe_error_summary: string | null; started_at: Timestamp | null; completed_at: Timestamp | null; created_at: Timestamp }>;
      report_jobs: Table<{ id: Uuid; report_type: Database["public"]["Enums"]["report_type"]; period_start: string; period_end: string; status: Database["public"]["Enums"]["report_job_status"]; requested_by: Uuid | null; requested_at: Timestamp; started_at: Timestamp | null; completed_at: Timestamp | null; failed_at: Timestamp | null; retry_count: number; delivery_requested: boolean; safe_error_summary: string | null; created_at: Timestamp; updated_at: Timestamp }>;
      reports: Table<{ id: Uuid; job_id: Uuid; generated_at: Timestamp; summary_snapshot: Json; created_at: Timestamp }>;
      report_files: Table<{ id: Uuid; report_id: Uuid; file_kind: "pdf" | "csv_bundle"; storage_bucket: string; storage_path: string; created_at: Timestamp }>;
      report_delivery_attempts: Table<{ id: Uuid; report_id: Uuid; recipient_email: string; status: Database["public"]["Enums"]["integration_status"]; requested_at: Timestamp; sent_at: Timestamp | null; failed_at: Timestamp | null; safe_error_summary: string | null; created_at: Timestamp }>;
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: {
      access_role: "admin" | "viewer";
      review_flag_type: "refunded" | "failed" | "possible_duplicate" | "unmapped_product" | "needs_follow_up";
      review_flag_status: "open" | "resolved" | "dismissed";
      backfill_status: "not_started" | "partial" | "complete" | "unavailable";
      integration_status: "pending" | "processing" | "completed" | "failed" | "cancelled";
      report_type: "monthly" | "quarterly" | "annual" | "ad_hoc";
      report_job_status: "pending" | "processing" | "completed" | "failed" | "cancelled";
    };
    CompositeTypes: Record<string, never>;
  };
}
