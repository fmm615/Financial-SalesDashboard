import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  firstValidationMessage,
  manualBankTransferSchema,
  manualB2bDealSchema,
  manualRecognisedSaleSchema,
  reportRequestSchema,
} from "@/lib/validation/financial-contracts";
import { calculateUsdAmount } from "@/lib/financial/usd-calculation";
import { recordManualRecognisedSale } from "@/server/services/record-manual-recognised-sale";
import type { B2bRecognisedSalesRepository } from "@/server/repositories/b2b-recognised-sales-repository";

const migration = (name: string) => readFileSync(path.join(process.cwd(), "supabase", "migrations", name), "utf8");

describe("Phase 2 validation contracts", () => {
  it("requires a monthly reporting period for manual recognised sales", () => {
    const parsed = manualRecognisedSaleSchema.parse({
      dealId: "11111111-1111-4111-8111-111111111111",
      bookingId: "22222222-2222-4222-8222-222222222222",
      recognisedAmount: "10000.000000",
      originalCurrency: "USD",
      exchangeRateToUsd: "1.0000000000",
      recognitionDate: "2026-08-31",
      reportingPeriod: "2026-08-01",
      reasonOrReference: "Finance recognition approval",
    });

    expect(calculateUsdAmount(parsed.recognisedAmount, parsed.exchangeRateToUsd)).toBe("10000");
    expect(() => manualRecognisedSaleSchema.parse({ ...parsed, reportingPeriod: "2026-08-02" })).toThrow();
  });

  it("turns generic recognised-sales validation failures into field-specific feedback", () => {
    const result = manualRecognisedSaleSchema.safeParse({
      dealId: "not-a-uuid",
      recognisedAmount: "10000",
      originalCurrency: "USD",
      exchangeRateToUsd: "1",
      recognitionDate: "2026-08-01",
      reportingPeriod: "2026-08-01",
      reasonOrReference: "Finance approval",
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(firstValidationMessage(result.error)).toMatch(/^Selected deal:/);
  });

  it("calculates USD recognised sales without floating point rounding", () => {
    expect(calculateUsdAmount("5000", "1")).toBe("5000");
    expect(calculateUsdAmount("5000", "2.65")).toBe("13250");
    expect(calculateUsdAmount("1", "0.0000005")).toBe("0.000001");
  });

  it("keeps money as decimal strings at the write boundary", () => {
    const result = manualBankTransferSchema.safeParse({
      customerEmail: " MEMBER@PLAYBOOK.TEST ",
      categoryCode: "membership",
      originalAmount: "100.125000",
      originalCurrency: "BHD",
      exchangeRateToUsd: "2.6595744681",
      amountUsd: "266.000000",
      grossAmountUsd: "266.000000",
      occurredAt: "2026-08-02T08:00:00.000Z",
      occurredOn: "2026-08-02",
      manualEntryReason: "Approved IBAN transfer",
    });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.customerEmail).toBe("member@playbook.test");
    expect(manualBankTransferSchema.safeParse({
      customerEmail: "member@playbook.test", categoryCode: "membership", originalAmount: 100,
    }).success).toBe(false);
  });

  it("requires complete local Finance deal values and a close date for a manual booking", () => {
    const manualDeal = {
      companyName: "Acme Holdings",
      name: "Annual programme",
      ownerName: null,
      stageCode: "closed_won",
      pipelineOriginalAmount: "1500.25",
      originalCurrency: "USD",
      exchangeRateToUsd: "1",
      closeDate: "2026-08-01",
      renewalDate: null,
      manualEntryReason: "Signed Finance-approved agreement",
    };
    expect(manualB2bDealSchema.safeParse(manualDeal).success).toBe(true);
    expect(manualB2bDealSchema.safeParse({ ...manualDeal, closeDate: null }).success).toBe(false);
    expect(manualB2bDealSchema.safeParse({ ...manualDeal, originalCurrency: "usd" }).success).toBe(false);
  });

  it("validates report date ordering before a job can be queued", () => {
    expect(reportRequestSchema.safeParse({
      reportType: "ad_hoc", periodStart: "2026-09-01", periodEnd: "2026-08-31",
    }).success).toBe(false);
  });

  it("does not derive recognised sales from a booking in the service boundary", async () => {
    const createManual = vi.fn().mockResolvedValue({ id: "sale-1" });
    const repository = { createManual } as unknown as B2bRecognisedSalesRepository;
    const input = {
      dealId: "11111111-1111-4111-8111-111111111111",
      recognisedAmount: "5000.000000",
      originalCurrency: "USD",
      exchangeRateToUsd: "1.0000000000",
      recognitionDate: "2026-08-15",
      reportingPeriod: "2026-08-01",
      reasonOrReference: "Approved manual recognition",
    };

    await expect(recordManualRecognisedSale(input, repository)).resolves.toEqual({ id: "sale-1" });
    expect(createManual).toHaveBeenCalledWith({ ...input, recognisedAmountUsd: "5000" });
  });
});

describe("Phase 2 database migration contracts", () => {
  it("creates auditable B2C Finance staging with protected source boundaries", () => {
    const stagingMigration = () => migration("20260812090000_b2c_finance_reconciliation_staging.sql");

    expect(stagingMigration).not.toThrow();

    const staging = stagingMigration();
    expect(staging).toContain("create table public.b2c_finance_imports");
    expect(staging).toContain("create table public.b2c_finance_staging_rows");
    expect(staging).toContain("create table public.b2c_provider_evidence");
    expect(staging).toContain("unique (source_file_sha256)");
    expect(staging).toContain("source_tab in ('B2C', 'B2C Cons')");
    expect(staging).toContain("transaction_kind in ('sale', 'processing_fee', 'fee_vat', 'refund', 'transfer', 'opening_balance', 'needs_review')");
    expect(staging).toContain("enable row level security");
    expect(staging).toContain("public.is_admin()");
  });

  it("creates protected, idempotent groups for exact B2C Finance duplicates", () => {
    const exactDuplicateGroups = () => migration("20260812103000_b2c_exact_duplicate_groups.sql");

    expect(exactDuplicateGroups).not.toThrow();

    const exactGroups = exactDuplicateGroups();
    expect(exactGroups).toContain("add column grouping_key text");
    expect(exactGroups).toContain("create unique index b2c_reconciliation_groups_grouping_key_unique");
    expect(exactGroups).toContain("create or replace function public.create_b2c_exact_duplicate_groups()");
    expect(exactGroups).toContain("security definer");
    expect(exactGroups).toContain("not public.is_admin()");
    expect(exactGroups).toContain("count(*) filter (where source_tab = 'B2C') = 1");
    expect(exactGroups).toContain("count(*) filter (where source_tab = 'B2C Cons') = 1");
    expect(exactGroups).not.toContain("insert into public.b2c_payments");
  });

  it("aligns cross-tab duplicate grouping with the shared Finance source fields", () => {
    const adjustment = () => migration("20260812104000_adjust_b2c_cross_tab_duplicate_grouping.sql");

    expect(adjustment).not.toThrow();

    const adjustedGroups = adjustment();
    expect(adjustedGroups).toContain("create or replace function public.create_b2c_exact_duplicate_groups()");
    expect(adjustedGroups).toContain("rows.normalized_customer_name as customer_name_key");
    expect(adjustedGroups).toContain("count(*) filter (where source_tab = 'B2C') = 1");
    expect(adjustedGroups).toContain("count(*) filter (where source_tab = 'B2C Cons') = 1");
    expect(adjustedGroups).not.toContain("category_key");
    expect(adjustedGroups).not.toContain("customer_email_key");
    expect(adjustedGroups).not.toContain("insert into public.b2c_payments");
  });

  it("posts approved iOS and bank-transfer Finance rows through an auditable ledger path", () => {
    const approvedFinancePosting = () => migration("20260817100000_post_approved_b2c_finance_payments.sql");

    expect(approvedFinancePosting).not.toThrow();

    const sql = approvedFinancePosting();
    expect(sql).toContain("'finance_tracker'");
    expect(sql).toContain("create table public.b2c_finance_ledger_posts");
    expect(sql).toContain("finance_row_id uuid not null unique");
    expect(sql).toContain("payment_id uuid not null unique");
    expect(sql).toContain("create or replace function public.post_approved_b2c_finance_payments()");
    expect(sql).toContain("Only an authenticated administrator can post approved B2C Finance payments");
    expect(sql).toContain("groups.reconciliation_state <> 'canonical' or groups.canonical_finance_row_id <> rows.id");
    expect(sql).not.toContain("https://");
    expect(sql).not.toContain("stripe.com");
    expect(sql).not.toContain("tap.company");
  });

  it("stores typed Stripe enrichment behind an Admin-only evidence boundary", () => {
    const sql = migration("20260812105000_stripe_read_only_payment_enrichment.sql");

    expect(sql).toContain("create table public.b2c_stripe_payment_details");
    expect(sql).toContain("payment_id uuid primary key");
    expect(sql).toContain("references public.b2c_payments(id)");
    expect(sql).toContain("checkout_customer_email citext");
    expect(sql).toContain("customer_profile_email citext");
    expect(sql).toContain("settlement_fee_amount numeric(20,6)");
    expect(sql).toContain("alter table public.b2c_stripe_payment_details enable row level security");
    expect(sql).toContain("create policy admin_read");
    expect(sql).toContain("create or replace function public.get_b2c_stripe_payment_contact_fallbacks()");
    expect(sql).toContain("public.is_approved_user()");
    expect(sql).toContain("linked payment is not a Stripe payment");
    expect(sql).not.toContain("grant insert, update on public.b2c_stripe_payment_details to authenticated");
  });

  it("enforces provider identity, Stripe=B2C, separate refunds, and refund overage protection", () => {
    const b2c = migration("20260802100200_b2c_foundation.sql");
    const b2b = migration("20260802100300_b2b_foundation.sql");

    expect(b2c).toContain("b2c_payments_provider_transaction_unique");
    expect(b2c).toContain("prevent_refund_overage");
    expect(b2c).toContain("references public.b2c_payments(id)");
    expect(b2b).not.toContain("'stripe'");
  });

  it("keeps booking and recognised-sales storage separate and makes recognition manual", () => {
    const b2b = migration("20260802100300_b2b_foundation.sql");
    expect(b2b).toContain("create table public.b2b_bookings");
    expect(b2b).toContain("create table public.b2b_recognised_sales");
    expect(b2b).toContain("or HubSpot trigger is permitted to manufacture recognised sales.");
    expect(b2b).toContain("validate_recognised_sale");
  });

  it("prevents recognised-sales entries from exceeding the linked deal total", () => {
    const overageGuard = migration("20260804100000_prevent_b2b_recognised_sales_overage.sql");

    expect(overageGuard).toContain("for update");
    expect(overageGuard).toContain("sum(recognised_amount_usd)");
    expect(overageGuard).toContain("recognised_total_usd + new.recognised_amount_usd > deal_amount_usd");
    expect(overageGuard).toContain("Recognised sales cannot exceed the linked deal USD amount");
  });

  it("derives recognised USD amounts from the retained amount and exchange rate", () => {
    const usdCalculation = migration("20260804110000_calculate_b2b_recognised_sales_usd.sql");

    expect(usdCalculation).toContain("new.recognised_amount_usd := round(new.recognised_amount * new.exchange_rate_to_usd, 6)");
    expect(usdCalculation).toContain("USD recognised sales require an exchange rate of 1");
  });

  it("enables RLS without a permissive public read policy", () => {
    const rls = migration("20260802100900_indexes_and_rls.sql");
    expect(rls).toContain("enable row level security");
    expect(rls).toContain("public.is_approved_user()");
    expect(rls).toContain("public.is_admin()");
    expect(rls).toContain("revoke all on all tables in schema public from anon");
    expect(rls).not.toContain("using (true)");
  });

  it("records database-triggered before/after audit history and report failure state", () => {
    const audit = migration("20260802100600_audit_log.sql");
    const reports = migration("20260802100800_reports.sql");
    expect(audit).toContain("before_value jsonb");
    expect(audit).toContain("after_value jsonb");
    expect(audit).toContain("auth.uid()");
    expect(reports).toContain("status <> 'failed'");
    expect(reports).toContain("safe_error_summary is not null");
  });

  it("keeps uncorrected B2B source records out of reportable views and preserves local date corrections", () => {
    const reportableDeals = migration("20260803120000_reportable_b2b_deals.sql");
    const preserveLocalDate = migration("20260803123000_preserve_local_hubspot_close_date_corrections.sql");

    expect(reportableDeals).toContain("create or replace view public.reportable_b2b_deals");
    expect(reportableDeals).toContain("d.financial_status = 'complete'");
    expect(reportableDeals).toContain("d.duplicate_review_status in ('clear', 'include')");
    expect(reportableDeals).toContain("d.hubspot_close_date is not null");
    expect(preserveLocalDate).toContain("old.source_metadata ? 'local_close_date_correction_at'");
    expect(preserveLocalDate).toContain("new.hubspot_close_date := old.hubspot_close_date");
  });

  it("keeps HubSpot source history while allowing only audited local overrides or exclusions", () => {
    const inlineWorkflow = migration("20260803130000_b2b_inline_admin_workflow.sql");
    expect(inlineWorkflow).toContain("local_record_status in ('active', 'excluded')");
    expect(inlineWorkflow).toContain("create or replace function public.apply_hubspot_deal_local_override");
    expect(inlineWorkflow).toContain("create or replace function public.exclude_hubspot_deal_locally");
    expect(inlineWorkflow).toContain("insert into public.financial_corrections");
    expect(inlineWorkflow).toContain("not public.is_admin()");
    expect(inlineWorkflow).toContain("d.local_record_status = 'active'");
    expect(inlineWorkflow).toContain("old.source_metadata ? 'local_override_at'");
    expect(inlineWorkflow).not.toContain("delete from public.b2b_deals");
  });

  it("creates manual Finance B2B deals locally with separate bookings and no recognised-sales creation", () => {
    const manualEntry = migration("20260803140000_manual_b2b_deal_entry.sql");
    expect(manualEntry).toContain("create or replace function public.create_manual_b2b_deal");
    expect(manualEntry).toContain("not public.is_admin()");
    expect(manualEntry).toContain("insert into public.b2b_bookings");
    expect(manualEntry).toContain("perform public.flag_manual_b2b_possible_duplicates");
    expect(manualEntry).not.toContain("insert into public.b2b_recognised_sales");
    expect(manualEntry).not.toContain("delete from public.b2b_deals");
  });

  it("keeps possible B2C duplicates outside the generic flag-resolution path", () => {
    const reviewQueueSafety = migration("20260810120000_review_queue_duplicate_safety.sql");

    expect(reviewQueueSafety).toContain("flag_type = 'possible_duplicate'");
    expect(reviewQueueSafety).toContain("Possible duplicates must be decided through the dedicated duplicate workflow");
    expect(reviewQueueSafety).toContain("create or replace function public.resolve_b2c_review_flag");
  });
});
