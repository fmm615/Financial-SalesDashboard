import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  manualBankTransferSchema,
  manualRecognisedSaleSchema,
  reportRequestSchema,
} from "@/lib/validation/financial-contracts";
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
      recognisedAmountUsd: "10000.000000",
      recognitionDate: "2026-08-31",
      reportingPeriod: "2026-08-01",
      reasonOrReference: "Finance recognition approval",
    });

    expect(parsed.recognisedAmountUsd).toBe("10000.000000");
    expect(() => manualRecognisedSaleSchema.parse({ ...parsed, reportingPeriod: "2026-08-02" })).toThrow();
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
      recognisedAmountUsd: "5000.000000",
      recognitionDate: "2026-08-15",
      reportingPeriod: "2026-08-01",
      reasonOrReference: "Approved manual recognition",
    };

    await expect(recordManualRecognisedSale(input, repository)).resolves.toEqual({ id: "sale-1" });
    expect(createManual).toHaveBeenCalledWith(input);
  });
});

describe("Phase 2 database migration contracts", () => {
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
});
