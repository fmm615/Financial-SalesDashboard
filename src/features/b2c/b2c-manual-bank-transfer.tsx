"use client";

import { useState } from "react";
import { PrimaryButton } from "@/components/ui";
import type { ManualBankTransferRequest } from "@/server/services/record-manual-bank-transfer";
import type { ManualBankTransferDuplicateAssessment } from "@/server/services/record-manual-bank-transfer";

type Stage = "closed" | "form" | "previewing" | "reviewing" | "recording";

type Draft = {
  bankReference: string;
  customerName: string;
  customerEmail: string;
  categoryCode: string;
  membershipTier: string;
  amountUsd: string;
  receivedAtLocal: string;
  reason: string;
};

const EMPTY_DRAFT: Draft = { bankReference: "", customerName: "", customerEmail: "", categoryCode: "", membershipTier: "", amountUsd: "", receivedAtLocal: "", reason: "" };

const inputClass = "mt-1 block h-10 w-full min-w-0 rounded-input border border-border bg-surface px-3 text-sm text-text-primary outline-none focus:border-brand-accent";
const textareaClass = "mt-1 block min-h-20 w-full min-w-0 resize-y rounded-input border border-border bg-surface px-3 py-2 text-sm text-text-primary outline-none focus:border-brand-accent";
const fieldClass = "block min-w-0 text-sm font-medium text-text-secondary";

/** Appends the entering browser's own UTC offset to a `datetime-local` value, since the input itself carries no offset. */
function toIsoWithOffset(localValue: string): string | null {
  if (!localValue) return null;
  const local = new Date(localValue);
  if (Number.isNaN(local.getTime())) return null;
  const offsetMinutes = -local.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  const offset = `${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
  return `${localValue.length === 16 ? `${localValue}:00` : localValue}${offset}`;
}

function draftToRequest(draft: Draft): ManualBankTransferRequest | null {
  const receivedAt = toIsoWithOffset(draft.receivedAtLocal);
  if (!receivedAt) return null;
  return {
    bankReference: draft.bankReference.trim(),
    customerEmail: draft.customerEmail.trim(),
    customerName: draft.customerName.trim(),
    categoryCode: draft.categoryCode.trim(),
    membershipTier: draft.membershipTier.trim() || undefined,
    amountUsd: draft.amountUsd.trim(),
    receivedAt,
    reason: draft.reason.trim(),
  };
}

function isDraftComplete(draft: Draft): boolean {
  return Boolean(
    draft.bankReference.trim() && draft.customerName.trim() && draft.customerEmail.trim()
    && draft.categoryCode.trim() && draft.amountUsd.trim() && draft.receivedAtLocal && draft.reason.trim(),
  );
}

/**
 * The one `Add bank transfer` flow: Step 1 collects the seven required facts
 * (plus an optional membership tier), Step 2 shows the server's exact
 * reviewed values and duplicate assessment. The only final action is
 * `Record bank transfer`; `Back` preserves the draft. There is no `Add iOS
 * payment` action anywhere -- iOS is Payment Tracker-only.
 */
export function B2cManualBankTransfer({ onRecorded }: { onRecorded: () => void }) {
  const [stage, setStage] = useState<Stage>("closed");
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [assessment, setAssessment] = useState<ManualBankTransferDuplicateAssessment | null>(null);
  const [error, setError] = useState<string | null>(null);

  function setField<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function startForm() {
    setDraft(EMPTY_DRAFT);
    setAssessment(null);
    setError(null);
    setStage("form");
  }

  function backToForm() {
    setAssessment(null);
    setError(null);
    setStage("form");
  }

  function cancel() {
    setStage("closed");
    setDraft(EMPTY_DRAFT);
    setAssessment(null);
    setError(null);
  }

  async function requestPreview() {
    const request = draftToRequest(draft);
    if (!request) { setError("Enter a valid bank transfer date and time."); return; }
    setStage("previewing"); setError(null);
    try {
      const response = await fetch("/api/admin/b2c/payments/manual-bank-transfer/preview", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok || !payload || typeof payload !== "object" || !("assessment" in payload)) {
        throw new Error(payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string" ? payload.error : "The bank transfer details could not be reviewed.");
      }
      setAssessment(payload.assessment as ManualBankTransferDuplicateAssessment);
      setStage("reviewing");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The bank transfer details could not be reviewed.");
      setStage("form");
    }
  }

  async function confirmRecord() {
    const request = draftToRequest(draft);
    if (!request || !assessment) return;
    setStage("recording"); setError(null);
    try {
      const response = await fetch("/api/admin/b2c/payments/manual-bank-transfer", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...request, expectedInputSha256: assessment.inputSha256 }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string" ? payload.error : "The manual bank transfer could not be recorded.");
      cancel();
      onRecorded();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The manual bank transfer could not be recorded.");
      setStage("reviewing");
    }
  }

  if (stage === "closed") {
    return <PrimaryButton onClick={startForm}>Add bank transfer</PrimaryButton>;
  }

  if (stage === "reviewing" || stage === "recording") {
    if (!assessment) return null;
    const request = draftToRequest(draft);
    return <div className="space-y-4" role="group" aria-label="Review bank transfer">
      <div className="rounded-md border border-border bg-canvas p-4 text-sm text-text-secondary">
        <dl className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
          <div><dt className="text-xs uppercase tracking-wide text-text-muted">Bank reference</dt><dd className="font-medium text-text-primary">{draft.bankReference}</dd></div>
          <div><dt className="text-xs uppercase tracking-wide text-text-muted">Customer</dt><dd className="font-medium text-text-primary">{draft.customerName} · {draft.customerEmail}</dd></div>
          <div><dt className="text-xs uppercase tracking-wide text-text-muted">Amount (USD)</dt><dd className="font-medium text-text-primary">{draft.amountUsd}</dd></div>
          <div><dt className="text-xs uppercase tracking-wide text-text-muted">Category</dt><dd className="font-medium text-text-primary">{draft.categoryCode}{draft.membershipTier ? ` · ${draft.membershipTier}` : ""}</dd></div>
          <div><dt className="text-xs uppercase tracking-wide text-text-muted">Bank transfer date/time</dt><dd className="font-medium text-text-primary">{request?.receivedAt ?? "—"}</dd></div>
          <div><dt className="text-xs uppercase tracking-wide text-text-muted">Reason</dt><dd className="font-medium text-text-primary">{draft.reason}</dd></div>
        </dl>
      </div>

      {assessment.matchState === "clear" && <p role="status" className="rounded-md border border-success/30 bg-success/5 p-4 text-sm font-medium text-success">No existing match. This will be recorded as one new reportable bank transfer.</p>}
      {assessment.matchState === "exact_existing" && <div role="alert" className="rounded-md border border-danger/30 bg-danger/5 p-4 text-sm text-danger">
        <p className="font-medium">Existing Payment Tracker/payment found.</p>
        <p className="mt-1">This transfer already exists. Recording it again is not possible.</p>
        {assessment.exactMatchHref && <a href={assessment.exactMatchHref} className="mt-2 inline-block font-medium text-brand-accent underline">Review the existing record</a>}
      </div>}
      {assessment.matchState === "possible_duplicate" && <div role="alert" className="rounded-md border border-warning/30 bg-warning/5 p-4 text-sm text-warning">
        <p className="font-medium">Possible duplicate.</p>
        <p className="mt-1">Another completed B2C payment matches this customer, amount, category, and business date within 48 hours. Recording it will keep it excluded from totals until an Admin reviews it.</p>
        <ul className="mt-2 space-y-1">
          {assessment.possibleMatches.map((match) => <li key={match.recordId}>{match.sourceLabel} · {match.occurredOn} · {match.amountUsd}</li>)}
        </ul>
      </div>}

      {error && <p className="text-sm text-danger" role="alert">{error}</p>}

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={backToForm} disabled={stage === "recording"} className="min-h-11 rounded-pill border border-border px-4 text-sm font-medium text-text-secondary disabled:cursor-not-allowed disabled:opacity-50">Back</button>
        {assessment.matchState !== "exact_existing" && <PrimaryButton onClick={() => void confirmRecord()} disabled={stage === "recording"}>{stage === "recording" ? "Recording…" : "Record bank transfer"}</PrimaryButton>}
        <button type="button" onClick={cancel} disabled={stage === "recording"} className="min-h-11 text-sm font-medium text-brand-accent disabled:cursor-not-allowed disabled:opacity-50">Cancel</button>
      </div>
    </div>;
  }

  const complete = isDraftComplete(draft);
  return <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void requestPreview(); }}>
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <label className={fieldClass}>Bank reference<input required value={draft.bankReference} onChange={(event) => setField("bankReference", event.target.value)} className={inputClass} /></label>
      <label className={fieldClass}>Customer name<input required value={draft.customerName} onChange={(event) => setField("customerName", event.target.value)} className={inputClass} /></label>
      <label className={fieldClass}>Customer email<input required type="email" value={draft.customerEmail} onChange={(event) => setField("customerEmail", event.target.value)} className={inputClass} /></label>
      <label className={fieldClass}>Bank transfer date/time<input required type="datetime-local" value={draft.receivedAtLocal} onChange={(event) => setField("receivedAtLocal", event.target.value)} className={inputClass} /></label>
      <label className={fieldClass}>Amount (USD)<input required inputMode="decimal" value={draft.amountUsd} onChange={(event) => setField("amountUsd", event.target.value)} className={inputClass} /></label>
      <label className={fieldClass}>Category<input required value={draft.categoryCode} onChange={(event) => setField("categoryCode", event.target.value)} className={inputClass} /></label>
      <label className={fieldClass}>Membership tier (optional)<input value={draft.membershipTier} onChange={(event) => setField("membershipTier", event.target.value)} className={inputClass} /></label>
    </div>
    <label className={fieldClass}>Reason<textarea required value={draft.reason} onChange={(event) => setField("reason", event.target.value)} className={textareaClass} /></label>

    {error && <p className="text-sm text-danger" role="alert">{error}</p>}

    <div className="flex flex-wrap items-center gap-3">
      <button type="submit" disabled={!complete || stage === "previewing"} className="min-h-11 rounded-md bg-brand-primary px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">
        {stage === "previewing" ? "Reviewing…" : "Preview"}
      </button>
      <button type="button" onClick={cancel} disabled={stage === "previewing"} className="min-h-11 text-sm font-medium text-brand-accent disabled:cursor-not-allowed disabled:opacity-50">Cancel</button>
    </div>
  </form>;
}
