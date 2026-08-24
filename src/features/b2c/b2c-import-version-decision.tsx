"use client";

import { useState } from "react";
import { PrimaryButton } from "@/components/ui";
import { useCanManage } from "@/lib/auth/role-context";
import type { B2cPendingCandidateRecord } from "@/server/services/b2c-work-items";

type Decision = "confirm_new" | "link_revision" | "link_existing_manual";

const CANDIDATE_EXPLANATION: Record<B2cPendingCandidateRecord["candidateKind"], string> = {
  new: "This replacement-workbook row has no prior Payment Tracker row or existing payment with the same identity. Confirm it as new only after verifying it is genuinely separate.",
  ambiguous: "Several rows share this payment identity. Choose the verified outcome and preserve the reason as audit evidence.",
  existing_payment: "This workbook row matches an existing manual bank transfer. Link it as evidence; never create a second payment.",
};

function hasMeaningfulReason(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length >= 3 && !/^(?:-+|—+|n\/?a)$/i.test(trimmed);
}

/** Resolves one immutable import-version candidate through the protected Admin API. */
export function B2cImportVersionDecision({ candidate, onSaved }: { candidate: B2cPendingCandidateRecord; onSaved: (candidateId: string) => void }) {
  const canManage = useCanManage();
  const [decision, setDecision] = useState<Decision>("confirm_new");
  const [targetLineageId, setTargetLineageId] = useState("");
  const [targetPaymentId, setTargetPaymentId] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (!canManage) return <p className="text-sm leading-6 text-text-muted">Viewer access is read-only. Only an Admin can take this action.</p>;

  const needsLineage = decision === "link_revision";
  const needsPayment = decision === "link_existing_manual";
  const canSubmit = hasMeaningfulReason(reason) && (!needsLineage || Boolean(targetLineageId)) && (!needsPayment || Boolean(targetPaymentId));

  async function submit() {
    if (!canSubmit) return;
    setSaving(true); setMessage(null);
    const payload: { candidateId: string; decision: Decision; reason: string; targetLineageId?: string; targetPaymentId?: string } = {
      candidateId: candidate.candidateId,
      decision,
      reason: reason.trim(),
    };
    if (needsLineage) payload.targetLineageId = targetLineageId;
    if (needsPayment) payload.targetPaymentId = targetPaymentId;
    try {
      const response = await fetch(`/api/admin/b2c/finance-imports/${candidate.importId}/lineage-decisions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(result?.error ?? "The B2C Finance import-version decision could not be saved.");
      onSaved(candidate.candidateId);
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "The B2C Finance import-version decision could not be saved. No source data was changed.");
    } finally {
      setSaving(false);
    }
  }

  return <div>
    <p className="text-sm leading-6 text-text-secondary">{CANDIDATE_EXPLANATION[candidate.candidateKind]}</p>
    <dl className="mt-4 grid gap-3 rounded-input border border-border bg-surface-muted/35 p-4 text-sm sm:grid-cols-2">
      <div><dt className="text-text-muted">Candidate</dt><dd className="mt-1 font-medium text-text-primary">{candidate.customerLabel}</dd></div>
      <div><dt className="text-text-muted">Workbook rows</dt><dd className="mt-1 font-medium text-text-primary">{candidate.financeRowIds.length}</dd></div>
      {candidate.occurredOn && <div><dt className="text-text-muted">Date</dt><dd className="mt-1 text-text-secondary">{candidate.occurredOn}</dd></div>}
      {candidate.amountUsd && <div><dt className="text-text-muted">Amount (USD)</dt><dd className="mt-1 font-medium tabular-nums text-text-primary">{candidate.amountUsd}</dd></div>}
    </dl>

    <fieldset className="mt-5 grid gap-3">
      <legend className="text-sm font-medium text-text-secondary">Decision</legend>
      <label className="flex cursor-pointer items-start gap-3 rounded-input border border-border p-3 text-sm text-text-secondary"><input aria-label="Confirm as a new payment" type="radio" name="import-version-decision" checked={decision === "confirm_new"} onChange={() => setDecision("confirm_new")} /><span><span className="font-medium text-text-primary">Confirm as a new payment</span><span className="mt-1 block">Creates a new Finance lineage for this verified payment.</span></span></label>
      <label className="flex cursor-pointer items-start gap-3 rounded-input border border-border p-3 text-sm text-text-secondary"><input aria-label="Link to an existing Finance lineage" type="radio" name="import-version-decision" checked={decision === "link_revision"} onChange={() => setDecision("link_revision")} /><span><span className="font-medium text-text-primary">Link to an existing Finance lineage</span><span className="mt-1 block">Records this workbook row as a revision of an existing lineage.</span></span></label>
      <label className="flex cursor-pointer items-start gap-3 rounded-input border border-border p-3 text-sm text-text-secondary"><input aria-label="Link to an existing manual bank transfer" type="radio" name="import-version-decision" checked={decision === "link_existing_manual"} onChange={() => setDecision("link_existing_manual")} /><span><span className="font-medium text-text-primary">Link to an existing manual bank transfer</span><span className="mt-1 block">Uses the manual payment as evidence and does not create another payment.</span></span></label>
    </fieldset>

    {needsLineage && <label className="mt-4 block text-sm font-medium text-text-secondary">Existing Finance lineage<select className="mt-1 block h-10 w-full rounded-input border border-border bg-surface px-3 text-sm text-text-primary" value={targetLineageId} onChange={(event) => setTargetLineageId(event.target.value)}><option value="">Select the verified lineage</option>{candidate.priorLineageIds.map((id) => <option key={id} value={id}>{id}</option>)}</select></label>}
    {needsPayment && <label className="mt-4 block text-sm font-medium text-text-secondary">Manual bank transfer<select className="mt-1 block h-10 w-full rounded-input border border-border bg-surface px-3 text-sm text-text-primary" value={targetPaymentId} onChange={(event) => setTargetPaymentId(event.target.value)}><option value="">Select the verified manual payment</option>{candidate.priorPaymentIds.map((id) => <option key={id} value={id}>{id}</option>)}</select></label>}

    <label className="mt-4 block text-sm font-medium text-text-secondary">Reason / evidence <span className="font-normal text-text-muted">(required)</span><textarea className="mt-1 block min-h-24 w-full resize-y rounded-input border border-border bg-surface px-3 py-2 text-sm text-text-primary outline-none focus:border-brand-accent" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Explain the source evidence for this decision. It is saved in the audit history." /></label>
    <div className="mt-4 flex flex-wrap items-center gap-3"><PrimaryButton onClick={() => void submit()} disabled={saving || !canSubmit}>{saving ? "Saving…" : "Record import-version decision"}</PrimaryButton><p className="text-xs leading-5 text-text-muted">The database locks this candidate and records the resulting lineage link atomically.</p></div>
    {message && <p role="alert" className="mt-3 text-sm text-danger">{message}</p>}
  </div>;
}
