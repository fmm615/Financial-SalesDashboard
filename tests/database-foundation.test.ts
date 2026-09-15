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

  it("keeps money as decimal strings at the manual bank-transfer write boundary and rejects browser-supplied source facts", () => {
    const result = manualBankTransferSchema.safeParse({
      bankReference: "IBAN-2026-0912",
      customerEmail: " MEMBER@PLAYBOOK.TEST ",
      customerName: "Ada Member",
      amountUsd: "266.000000",
      receivedAt: "2026-08-02T08:00:00.000Z",
      reason: "Approved IBAN transfer",
    });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.customerEmail).toBe("member@playbook.test");
    expect(manualBankTransferSchema.safeParse({
      customerEmail: "member@playbook.test", amountUsd: 100,
    }).success).toBe(false);
    // USD-only in B2C v1: the browser may never supply currency, rate, or gross/net values.
    expect(manualBankTransferSchema.safeParse({
      bankReference: "IBAN-2026-0912", customerEmail: "member@playbook.test", customerName: "Ada Member",
      amountUsd: "266.000000", receivedAt: "2026-08-02T08:00:00.000Z",
      reason: "Approved IBAN transfer", originalCurrency: "BHD", exchangeRateToUsd: "2.6595744681",
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
  it("stores typed Stripe enrichment behind an Admin-only evidence boundary", () => {
    const sql = migration("20270101000200_b2c_foundation.sql");

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
    const b2c = migration("20270101000200_b2c_foundation.sql");
    const b2b = migration("20270101000100_b2b_foundation.sql");

    expect(b2c).toContain("b2c_payments_provider_transaction_unique");
    expect(b2c).toContain("prevent_refund_overage");
    expect(b2c).toContain("references public.b2c_payments(id)");
    expect(b2b).not.toContain("'stripe'");
  });

  it("keeps booking and recognised-sales storage separate and makes recognition manual", () => {
    const b2b = migration("20270101000100_b2b_foundation.sql");
    expect(b2b).toContain("create table public.b2b_bookings");
    expect(b2b).toContain("create table public.b2b_recognised_sales");
    expect(b2b).toContain("is permitted to manufacture one.");
    expect(b2b).toContain("validate_recognised_sale");
  });

  it("prevents recognised-sales entries from exceeding the linked deal total", () => {
    const overageGuard = migration("20270101000100_b2b_foundation.sql");

    expect(overageGuard).toContain("for update");
    expect(overageGuard).toContain("sum(recognised_amount_usd)");
    expect(overageGuard).toContain("recognised_total_usd + new.recognised_amount_usd > deal_amount_usd");
    expect(overageGuard).toContain("Recognised sales cannot exceed the linked deal USD amount");
  });

  it("derives recognised USD amounts from the retained amount and exchange rate", () => {
    const usdCalculation = migration("20270101000100_b2b_foundation.sql");

    expect(usdCalculation).toContain("new.recognised_amount_usd := round(new.recognised_amount * new.exchange_rate_to_usd, 6)");
    expect(usdCalculation).toContain("USD recognised sales require an exchange rate of 1");
  });

  it("enables RLS without a permissive public read policy", () => {
    // RLS/policy definitions live in each domain migration; the blanket
    // anon-revoke safety net is asserted last in the cross-domain sweep.
    const domain = migration("20270101000100_b2b_foundation.sql");
    const sweep = migration("20270101000400_cross_domain_sweep.sql");
    expect(domain).toContain("enable row level security");
    expect(domain).toContain("public.is_approved_user()");
    expect(domain).toContain("public.is_admin()");
    expect(sweep).toContain("revoke all on all tables in schema public from anon");
    expect(domain).not.toContain("using (true)");
    expect(sweep).not.toContain("using (true)");
  });

  it("records database-triggered before/after audit history and report failure state", () => {
    const sql = migration("20270101000300_finance_targets_reports.sql");
    expect(sql).toContain("before_value jsonb");
    expect(sql).toContain("after_value jsonb");
    expect(sql).toContain("auth.uid()");
    expect(sql).toContain("status <> 'failed'");
    expect(sql).toContain("safe_error_summary is not null");
  });

  it("keeps uncorrected B2B source records out of reportable views and preserves local date corrections", () => {
    const sql = migration("20270101000100_b2b_foundation.sql");

    expect(sql).toContain("create or replace view public.reportable_b2b_deals");
    expect(sql).toContain("d.financial_status = 'complete'");
    expect(sql).toContain("d.duplicate_review_status in ('clear', 'include')");
    expect(sql).toContain("d.hubspot_close_date is not null");
    expect(sql).toContain("old.source_metadata ? 'local_close_date_correction_at'");
    expect(sql).toContain("new.hubspot_close_date := old.hubspot_close_date");
  });

  it("keeps HubSpot source history while allowing only audited local overrides or exclusions", () => {
    const inlineWorkflow = migration("20270101000100_b2b_foundation.sql");
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
    const manualEntry = migration("20270101000100_b2b_foundation.sql");
    expect(manualEntry).toContain("create or replace function public.create_manual_b2b_deal");
    expect(manualEntry).toContain("not public.is_admin()");
    expect(manualEntry).toContain("insert into public.b2b_bookings");
    expect(manualEntry).toContain("perform public.flag_manual_b2b_possible_duplicates");
    expect(manualEntry).not.toContain("insert into public.b2b_recognised_sales");
    expect(manualEntry).not.toContain("delete from public.b2b_deals");
  });

  it("keeps possible B2C duplicates outside the generic flag-resolution path", () => {
    const reviewQueueSafety = migration("20270101000300_finance_targets_reports.sql");

    expect(reviewQueueSafety).toContain("flag_type = 'possible_duplicate'");
    expect(reviewQueueSafety).toContain("Possible duplicates must be decided through the dedicated duplicate workflow");
    expect(reviewQueueSafety).toContain("create or replace function public.resolve_b2c_review_flag");
  });

  it("creates an Admin-only, atomic B2C payment duplicate-group workflow", () => {
    const sql = migration("20270101000200_b2c_foundation.sql");
    expect(sql).toContain("create table public.b2c_payment_duplicate_groups");
    expect(sql).toContain("create table public.b2c_payment_duplicate_group_members");
    expect(sql).toContain("create or replace function public.open_b2c_payment_duplicate_group");
    expect(sql).toContain("create or replace function public.resolve_b2c_payment_duplicate_group");
    expect(sql).toContain("create or replace function public.dismiss_stale_b2c_possible_duplicate_flag");
    expect(sql).toContain("create or replace function public.get_b2c_payment_duplicate_reporting_states");
    expect(sql).toContain("extensions.digest(");
    expect(sql).toContain("p_decision not in ('keep_all', 'keep_one')");
    expect(sql).toContain("public.is_admin()");
    expect(sql).toContain("public.write_audit_event()");

    const constructor = sql.slice(
      sql.indexOf("create or replace function public.open_b2c_payment_duplicate_group"),
      sql.indexOf("create or replace function public.resolve_b2c_payment_duplicate_group"),
    );
    const advisoryLock = constructor.indexOf("pg_advisory_xact_lock");
    const firstRowLock = constructor.indexOf("for update");
    expect(constructor).toContain("pg_advisory_xact_lock(hashtext('b2c_payment_duplicate_workflow'))");
    expect(constructor).not.toContain("'b2c_payment_duplicate:' || target.fingerprint");
    expect(constructor).not.toContain("where payment.id = any(candidate_ids)");
    expect(constructor).not.toContain("local_override.payment_id = any(candidate_ids)");
    expect(advisoryLock).toBeGreaterThan(-1);
    expect(firstRowLock).toBeGreaterThan(-1);
    expect(advisoryLock).toBeLessThan(firstRowLock);

    // Writer order was rebuilt in a single clean-slate file (previously each
    // writer's mutex-before-lock fix landed in its own incremental
    // migration); the ordering below reflects the current file's actual
    // function order, not the old migration history.
    for (const [writer, nextWriter] of [
      ["create or replace function public.apply_stripe_product_mapping", "create or replace function public.apply_b2c_product_mapping"],
      ["create or replace function public.apply_b2c_product_mapping", "create or replace function public.apply_b2c_payment_local_correction"],
      ["create or replace function public.apply_b2c_payment_local_correction", "create or replace function public.include_b2c_payment_with_finance_exception"],
    ]) {
      const writerBody = sql.slice(sql.indexOf(writer), sql.indexOf(nextWriter));
      expect(writerBody.indexOf("pg_advisory_xact_lock(hashtext('b2c_payment_duplicate_workflow'))")).toBeGreaterThan(-1);
      expect(writerBody.indexOf("pg_advisory_xact_lock")).toBeLessThan(writerBody.indexOf("for update"));
    }
  });

  it("records a manual bank transfer only through one locked, re-validating RPC", () => {
    const sql = migration("20270101000200_b2c_foundation.sql");
    // Scope to the function body: the merged domain file also defines other
    // RPCs (e.g. apply_b2c_product_mapping) that legitimately use a
    // `p_source_system` parameter, which would otherwise collide with the
    // "not present" assertions below.
    const fn = sql.slice(
      sql.indexOf("create or replace function public.record_b2c_manual_bank_transfer("),
      sql.indexOf("create or replace function public.apply_stripe_product_mapping"),
    );

    expect(fn).toContain("create or replace function public.record_b2c_manual_bank_transfer");
    expect(fn).toContain("pg_advisory_xact_lock(hashtext('b2c_manual_bank_transfer:'");
    expect(fn).toContain("A manual bank transfer with this reference already exists");
    expect(fn).toContain("The reviewed bank transfer details changed since preview");
    expect(fn).toContain("at time zone 'Asia/Bahrain'");
    expect(fn).toContain("when unique_violation then");
    expect(fn).not.toContain("p_source_system");
    expect(fn).not.toContain("p_original_currency");
  });

  // 20270101000500 recreates three of the writers asserted above, so the two
  // tests before this one now describe superseded bodies. These assertions
  // re-establish the same invariants against the definitions that are actually
  // live, and pin the category removal itself.
  it("keeps the mutex-before-row-lock order in every writer the category removal recreates", () => {
    const sql = migration("20270101000500_remove_b2c_category.sql");
    for (const [writer, nextWriter] of [
      ["create or replace function public.apply_b2c_payment_local_correction", "create or replace function public.include_b2c_payment_with_finance_exception"],
      ["create or replace function public.open_b2c_payment_duplicate_group", "revoke all on function public.open_b2c_payment_duplicate_group"],
    ]) {
      const writerBody = sql.slice(sql.indexOf(writer), sql.indexOf(nextWriter));
      expect(writerBody).toContain("pg_advisory_xact_lock(hashtext('b2c_payment_duplicate_workflow'))");
      expect(writerBody.indexOf("pg_advisory_xact_lock")).toBeLessThan(writerBody.indexOf("for update"));
    }
  });

  it("removes the B2C category concept while preserving membership_tier", () => {
    const sql = migration("20270101000500_remove_b2c_category.sql");
    expect(sql).toContain("alter table public.b2c_payments drop column category_code;");
    expect(sql).toContain("alter table public.b2c_payments drop column product_mapping_id;");
    expect(sql).toContain("alter table public.b2c_payment_local_overrides drop column category_code;");
    expect(sql).toContain("drop table public.product_mappings;");
    expect(sql).toContain("drop function if exists public.apply_stripe_product_mapping");
    expect(sql).toContain("drop function if exists public.apply_b2c_product_mapping");

    // membership_tier is a separate concept that shared the same statements.
    // It must survive in both recreated RPC signatures and in the re-added
    // "at least one correction" constraint.
    expect(sql).toContain("p_membership_tier text");
    expect(sql).toContain("or membership_tier is not null");
    expect(sql).not.toContain("p_category_code");

    // The duplicate fingerprint keeps only email, USD amount, and business
    // date. createB2cDuplicateFingerprint must stay byte-identical to this.
    expect(sql).toContain("lower(trim(p_customer_email)) || '|USD|' || p_amount_usd_text || '|' ||");
    expect(sql).not.toContain("candidate.category_code = target.category_code");
  });

  it("keeps the recreated manual bank transfer RPC locked and re-validating", () => {
    const sql = migration("20270101000500_remove_b2c_category.sql");
    const fn = sql.slice(
      sql.indexOf("create or replace function public.record_b2c_manual_bank_transfer("),
      sql.indexOf("create or replace function public.apply_b2c_payment_local_correction"),
    );
    expect(fn).toContain("pg_advisory_xact_lock(hashtext('b2c_manual_bank_transfer:'");
    expect(fn).toContain("A manual bank transfer with this reference already exists");
    expect(fn).toContain("The reviewed bank transfer details changed since preview");
    expect(fn).toContain("at time zone 'Asia/Bahrain'");
    expect(fn).toContain("when unique_violation then");
    // Category was the only required field removed; every other guard stays.
    expect(fn).toContain("A verified customer email is required");
    expect(fn).toContain("A customer name is required");
    expect(fn).toContain("A bank reference between 1 and 200 characters is required");
    expect(fn).not.toContain("A category is required");
  });
});
