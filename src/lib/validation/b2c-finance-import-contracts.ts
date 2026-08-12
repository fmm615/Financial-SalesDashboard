import { z } from "zod";

const rawText = (maximum: number) => z.string().max(maximum).nullable().optional();

/** Raw worksheet values are preserved; parsing and quality assessment happen separately. */
export const financeWorkbookRowSchema = z.object({
  sourceTab: z.enum(["B2C", "B2C Cons"]),
  sourceRowNumber: z.number().int().min(2),
  // An empty source date is retained as a Finance review issue; it is not dropped.
  reportedDateRaw: z.string().max(100),
  declaredMonth: rawText(40),
  declaredYear: rawText(10),
  amountUsdRaw: rawText(100),
  customerNameRaw: rawText(300),
  customerEmailRaw: rawText(320),
  customerPhoneRaw: rawText(100),
  categoryRaw: rawText(200),
  membershipTypeRaw: rawText(200),
  paymentMethodRaw: rawText(100),
  paymentStatusRaw: rawText(100),
  noteRaw: rawText(2000),
}).strict();

const stagedFinanceRowSchema = financeWorkbookRowSchema.extend({
  rawPayload: z.record(z.string(), z.unknown()),
}).strict();

/** Raw spreadsheet bytes are deliberately not accepted at this API boundary. */
export const financeImportRequestSchema = z.object({
  sourceFileName: z.string().trim().min(1).max(255),
  sourceFileSha256: z.string().regex(/^[0-9a-f]{64}$/),
  sourceStorageBucket: z.string().trim().min(1).max(100),
  sourceStoragePath: z.string().trim().min(1).max(1000),
  rows: z.array(stagedFinanceRowSchema).min(1).max(20_000),
}).strict();

/** This is a statement row, not a Tap API charge. Amounts stay in their original currency. */
export const tapEvidenceRowSchema = z.object({
  description: z.string().max(1000).nullable(),
  chargeId: z.string().max(255).nullable(),
  refundId: z.string().max(255).nullable(),
  currency: z.string().trim().regex(/^[A-Za-z]{3}$/),
  debit: z.string().max(100).nullable(),
  credit: z.string().max(100).nullable(),
}).strict();

export const tapStatementEvidenceRowSchema = z.object({
  sourceRowNumber: z.number().int().min(2),
  postingId: z.string().trim().min(1).max(255),
  paymentId: z.string().trim().max(255).nullable(),
  refundId: z.string().trim().max(255).nullable(),
  kind: z.enum(["sale", "processing_fee", "fee_vat", "refund", "transfer", "opening_balance", "needs_review"]),
  description: z.string().max(1000).nullable(),
  occurredAt: z.string().datetime().nullable(),
  occurredAtRaw: z.string().max(100).nullable(),
  currency: z.string().trim().regex(/^[A-Z]{3}$/),
  credit: z.string().regex(/^\d+(?:\.\d{1,6})?$/).nullable(),
  debit: z.string().regex(/^\d+(?:\.\d{1,6})?$/).nullable(),
  // Tap CSV cells are text; constraining them here makes the database JSON boundary explicit.
  rawPayload: z.record(z.string(), z.string()),
}).strict();

/** A minimized Stripe Charges CSV entry, kept outside the B2C payment ledger. */
export const stripeChargesEvidenceRowSchema = z.object({
  sourceRowNumber: z.number().int().min(2),
  sourceEntryKey: z.enum(["primary", "refund"]),
  chargeId: z.string().trim().max(255).nullable(),
  kind: z.enum(["sale", "refund", "needs_review"]),
  description: z.string().max(1000).nullable(),
  occurredAt: z.string().datetime().nullable(),
  occurredAtRaw: z.string().max(100).nullable(),
  currency: z.string().trim().regex(/^[A-Z]{3}$/),
  credit: z.string().regex(/^\d+(?:\.\d{1,6})?$/).nullable(),
  debit: z.string().regex(/^\d+(?:\.\d{1,6})?$/).nullable(),
  customerName: z.string().trim().min(1).max(200).nullable(),
  customerEmail: z.string().trim().toLowerCase().email().max(320).nullable(),
  customerPhone: z.string().trim().regex(/^[0-9+().\-\s]{5,40}$/).nullable(),
  // Only a selected non-sensitive source subset is persisted; the original CSV remains private evidence.
  rawPayload: z.record(z.string(), z.string()),
}).strict().superRefine((row, context) => {
  if (row.sourceEntryKey === "refund" && row.kind !== "refund") context.addIssue({ code: "custom", path: ["kind"], message: "Refund source entries must be refund evidence." });
  if (row.sourceEntryKey === "primary" && row.kind === "refund") context.addIssue({ code: "custom", path: ["kind"], message: "Primary source entries cannot be refund evidence." });
  if ((row.kind === "sale" || row.kind === "refund") && !row.chargeId) context.addIssue({ code: "custom", path: ["chargeId"], message: "Sale and refund evidence require a Stripe charge ID." });
  if (row.kind === "sale" && !row.credit) context.addIssue({ code: "custom", path: ["credit"], message: "Sale evidence requires an original amount." });
  if (row.kind === "refund" && !row.debit) context.addIssue({ code: "custom", path: ["debit"], message: "Refund evidence requires a refunded amount." });
});

const reconciliationDecisionFields = {
  decisionState: z.enum(["canonical", "excluded"]),
  canonicalFinanceRowId: z.string().uuid().nullable().optional(),
  decisionReason: z.string().trim().min(3).max(1000),
};

function addDecisionRequirements<T extends { decisionState: "canonical" | "excluded"; canonicalFinanceRowId?: string | null }>(schema: z.ZodType<T>) {
  return schema.superRefine((value, context) => {
  if (value.decisionState === "canonical" && !value.canonicalFinanceRowId) {
    context.addIssue({ code: "custom", path: ["canonicalFinanceRowId"], message: "A canonical decision requires a Finance row." });
  }
  if (value.decisionState === "excluded" && value.canonicalFinanceRowId) {
    context.addIssue({ code: "custom", path: ["canonicalFinanceRowId"], message: "An excluded group cannot select a Finance row." });
  }
  });
}

export const reconciliationDecisionRequestSchema = addDecisionRequirements(z.object(reconciliationDecisionFields).strict());
export const reconciliationDecisionSchema = addDecisionRequirements(z.object({
  reconciliationGroupId: z.string().uuid(),
  ...reconciliationDecisionFields,
}).strict());

export type FinanceWorkbookRowInput = z.infer<typeof financeWorkbookRowSchema>;
export type FinanceImportRequestInput = z.infer<typeof financeImportRequestSchema>;
export type TapEvidenceRowInput = z.infer<typeof tapEvidenceRowSchema>;
export type TapStatementEvidenceRowInput = z.infer<typeof tapStatementEvidenceRowSchema>;
export type StripeChargesEvidenceRowInput = z.infer<typeof stripeChargesEvidenceRowSchema>;
export type ReconciliationDecisionInput = z.infer<typeof reconciliationDecisionSchema>;
