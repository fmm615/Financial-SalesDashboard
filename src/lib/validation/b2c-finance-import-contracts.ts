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
export type ReconciliationDecisionInput = z.infer<typeof reconciliationDecisionSchema>;
