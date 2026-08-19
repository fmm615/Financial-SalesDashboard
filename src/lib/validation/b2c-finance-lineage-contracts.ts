import { z } from "zod";

const financeLineageDecisionFields = {
  decision: z.enum(["confirm_new", "link_revision", "link_existing_manual"]),
  candidateId: z.string().uuid(),
  targetLineageId: z.string().uuid().nullable().optional(),
  targetPaymentId: z.string().uuid().nullable().optional(),
  reason: z.string().trim().min(3).max(1000),
};

/**
 * Mirrors the database check constraint on `b2c_finance_import_version_decisions`:
 * each decision kind accepts exactly one kind of target, never both, never neither.
 */
export const financeLineageDecisionSchema = z.object(financeLineageDecisionFields).strict().superRefine((value, context) => {
  if (value.decision === "confirm_new" && (value.targetLineageId || value.targetPaymentId)) {
    context.addIssue({ code: "custom", path: ["decision"], message: "Confirming a new lineage cannot select a target lineage or payment." });
  }
  if (value.decision === "link_revision" && !value.targetLineageId) {
    context.addIssue({ code: "custom", path: ["targetLineageId"], message: "Linking a revision requires the existing lineage it belongs to." });
  }
  if (value.decision === "link_revision" && value.targetPaymentId) {
    context.addIssue({ code: "custom", path: ["targetPaymentId"], message: "Linking a revision cannot select a target payment." });
  }
  if (value.decision === "link_existing_manual" && !value.targetPaymentId) {
    context.addIssue({ code: "custom", path: ["targetPaymentId"], message: "Linking an existing manual payment requires the payment it represents." });
  }
  if (value.decision === "link_existing_manual" && value.targetLineageId) {
    context.addIssue({ code: "custom", path: ["targetLineageId"], message: "Linking an existing manual payment cannot select a target lineage." });
  }
});

export type FinanceLineageDecisionInput = z.infer<typeof financeLineageDecisionSchema>;
