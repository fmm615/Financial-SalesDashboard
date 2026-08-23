"use client";

import { useEffect, useState } from "react";
import type {
  B2cPaymentDuplicateGroupReview,
  B2cPaymentDuplicateMemberReview,
  B2cPaymentDuplicateReviewResult,
} from "@/server/services/b2c-payment-duplicate-review";

type Props = {
  paymentId: string;
  onSaved: (resolvedPaymentIds: string[]) => void;
};

type SaveState = "keep_all" | "keep_one" | null;

function hasMeaningfulReason(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length >= 3 && trimmed.length <= 1000 && !/^(?:-+|—+|n\/?a)$/i.test(trimmed);
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

function isDuplicateSourceSystem(value: unknown): value is B2cPaymentDuplicateMemberReview["sourceSystem"] {
  return value === "stripe" || value === "tap" || value === "manual_bank_transfer" || value === "finance_tracker";
}

function isDuplicateMember(value: unknown): value is B2cPaymentDuplicateMemberReview {
  if (!value || typeof value !== "object") return false;
  const member = value as Record<string, unknown>;
  return typeof member.paymentId === "string"
    && isDuplicateSourceSystem(member.sourceSystem)
    && isNullableString(member.providerReference)
    && isNullableString(member.customerName)
    && isNullableString(member.sourceCustomerEmail)
    && typeof member.effectiveCustomerEmail === "string"
    && typeof member.sourceAmount === "string"
    && typeof member.sourceCurrency === "string"
    && typeof member.effectiveAmountUsd === "string"
    && isNullableString(member.sourceCategoryCode)
    && typeof member.effectiveCategoryCode === "string"
    && isNullableString(member.sourceOccurredOn)
    && typeof member.effectiveOccurredOn === "string";
}

function isReviewResult(value: unknown): value is B2cPaymentDuplicateReviewResult {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.kind === "none") return true;
  if (record.kind === "ungrouped_flag") return typeof record.flagId === "string";
  if (record.kind !== "group" || !record.group || typeof record.group !== "object") return false;
  const group = record.group as Record<string, unknown>;
  return typeof group.groupId === "string"
    && typeof group.detectionReason === "string"
    && group.detectionReason.trim().length > 0
    && Array.isArray(group.members)
    && group.members.every(isDuplicateMember);
}

function isResolvedDecision(value: unknown, groupId: string): value is { groupId: string; resolvedPaymentIds: string[] } {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.groupId === groupId
    && Array.isArray(record.resolvedPaymentIds)
    && record.resolvedPaymentIds.length > 0
    && record.resolvedPaymentIds.every((paymentId) => typeof paymentId === "string");
}

function ComparisonValue({ label, source, effective }: { label: string; source: string | null; effective: string }) {
  const changed = source !== effective;
  return <div>
    <dt className="text-text-muted">{label}</dt>
    <dd className="mt-1 break-words text-text-secondary">{source ?? "Unavailable"}</dd>
    {changed && <dd className="mt-1 text-text-primary"><span className="font-medium">Effective comparison value:</span> {effective}</dd>}
  </div>;
}

function GroupMembers({ group, selectedPaymentId, onSelect }: {
  group: B2cPaymentDuplicateGroupReview;
  selectedPaymentId: string | null;
  onSelect: (paymentId: string) => void;
}) {
  return <div className="mt-4 grid gap-4">
    {group.members.map((member) => <article key={member.paymentId} className="rounded-input border border-border bg-canvas p-4">
      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="radio"
          name={`payment-duplicate-${group.groupId}`}
          checked={selectedPaymentId === member.paymentId}
          onChange={() => onSelect(member.paymentId)}
          aria-label={`Keep ${member.providerReference ?? member.paymentId}`}
        />
        <span>
          <span className="block font-semibold text-text-primary">{member.providerReference ?? "No provider reference retained"}</span>
          <span className="mt-1 block text-sm text-text-secondary">{member.sourceSystem.replaceAll("_", " ")} · {member.customerName ?? "Customer unavailable"}</span>
        </span>
      </label>
      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
        <ComparisonValue label="Customer email" source={member.sourceCustomerEmail} effective={member.effectiveCustomerEmail} />
        <ComparisonValue label="Amount" source={member.sourceAmount ? `${member.sourceAmount} ${member.sourceCurrency}` : null} effective={`${member.effectiveAmountUsd} USD`} />
        <ComparisonValue label="Category" source={member.sourceCategoryCode} effective={member.effectiveCategoryCode} />
        <ComparisonValue label="Business date" source={member.sourceOccurredOn} effective={member.effectiveOccurredOn} />
      </dl>
    </article>)}
  </div>;
}

/** Admin-only decision controls for a database-owned B2C payment duplicate group. */
export function B2cPaymentDuplicateReview({ paymentId, onSaved }: Props) {
  const [review, setReview] = useState<B2cPaymentDuplicateReviewResult | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedPaymentId, setSelectedPaymentId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState<SaveState>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setReview(null); setLoadError(null); setSelectedPaymentId(null); setReason(""); setError(null);
    fetch(`/api/admin/b2c/payments/${paymentId}/duplicate-group`, { cache: "no-store" })
      .then(async (response) => {
        const payload: unknown = await response.json().catch(() => null);
        if (!response.ok || !isReviewResult(payload)) throw new Error("This payment duplicate review could not be loaded.");
        return payload;
      })
      .then((loaded) => { if (!cancelled) setReview(loaded); })
      .catch((caught) => { if (!cancelled) setLoadError(caught instanceof Error ? caught.message : "This payment duplicate review could not be loaded."); });
    return () => { cancelled = true; };
  }, [paymentId]);

  async function saveGroup(group: B2cPaymentDuplicateGroupReview, decision: Exclude<SaveState, null>) {
    if (!hasMeaningfulReason(reason) || (decision === "keep_one" && !selectedPaymentId)) return;
    setSaving(decision); setError(null);
    try {
      const response = await fetch(`/api/admin/b2c/payment-duplicate-groups/${group.groupId}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision,
          canonicalPaymentId: decision === "keep_one" ? selectedPaymentId : null,
          reason: reason.trim(),
        }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok || !isResolvedDecision(payload, group.groupId)) throw new Error("The payment duplicate decision could not be saved.");
      onSaved(payload.resolvedPaymentIds);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The payment duplicate decision could not be saved.");
    } finally {
      setSaving(null);
    }
  }

  async function dismissStale(flagId: string) {
    if (!hasMeaningfulReason(reason)) return;
    setSaving("keep_all"); setError(null);
    try {
      const response = await fetch(`/api/admin/b2c/review-flags/${flagId}/dismiss-stale-duplicate`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: reason.trim() }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok || !payload || typeof payload !== "object" || !("ok" in payload) || payload.ok !== true) {
        throw new Error("The stale duplicate review item could not be dismissed.");
      }
      onSaved([paymentId]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The stale duplicate review item could not be dismissed.");
    } finally {
      setSaving(null);
    }
  }

  if (loadError) return <p role="alert" className="text-sm text-danger">{loadError}</p>;
  if (!review) return <p className="text-sm text-text-muted">Loading payment duplicate review…</p>;

  const reasonInput = <label className="mt-4 block text-sm font-medium text-text-primary">Decision reason <span className="font-normal text-text-muted">(required)</span>
    <textarea aria-label="Payment duplicate decision reason" value={reason} onChange={(event) => setReason(event.target.value)} className="mt-1 block min-h-24 w-full rounded-input border border-border bg-surface p-3 text-sm text-text-primary" placeholder="Describe the evidence supporting this decision." />
  </label>;

  if (review.kind === "none") return <p className="text-sm text-text-muted">Candidate unavailable. This payment no longer has an open duplicate group or legacy duplicate flag.</p>;

  if (review.kind === "ungrouped_flag") return <section aria-labelledby="payment-duplicate-review-title">
    <h4 id="payment-duplicate-review-title" className="text-lg font-semibold text-text-primary">Payment duplicate review</h4>
    <p className="mt-2 text-sm leading-6 text-text-secondary">Candidate unavailable. The retained legacy flag has no current payment duplicate group. Dismiss it only after recording why the candidate is stale.</p>
    {reasonInput}
    <button type="button" disabled={!hasMeaningfulReason(reason) || saving !== null} onClick={() => void dismissStale(review.flagId)} className="mt-4 rounded-pill border border-warning px-4 py-2 text-sm font-semibold text-warning disabled:cursor-not-allowed disabled:opacity-60">{saving ? "Saving…" : "Dismiss stale duplicate flag"}</button>
    {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
  </section>;

  const canSaveReason = hasMeaningfulReason(reason) && saving === null;
  return <section aria-labelledby="payment-duplicate-review-title">
    <h4 id="payment-duplicate-review-title" className="text-lg font-semibold text-text-primary">Payment duplicate review</h4>
    <p className="mt-2 text-sm leading-6 text-text-secondary">Review the database-detected payment group before choosing to keep all records or one retained payment. Source and provider data remain unchanged.</p>
    <p className="mt-2 text-xs leading-5 text-text-muted">Detection: {review.group.detectionReason}</p>
    <GroupMembers group={review.group} selectedPaymentId={selectedPaymentId} onSelect={setSelectedPaymentId} />
    {reasonInput}
    <div className="mt-4 flex flex-wrap gap-3">
      <button type="button" disabled={!canSaveReason} onClick={() => void saveGroup(review.group, "keep_all")} className="rounded-pill bg-brand-primary px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60">{saving === "keep_all" ? "Saving…" : "Keep all payments"}</button>
      <button type="button" disabled={!canSaveReason || !selectedPaymentId} onClick={() => void saveGroup(review.group, "keep_one")} className="rounded-pill border border-border px-4 py-2 text-sm font-semibold text-text-primary disabled:cursor-not-allowed disabled:opacity-60">{saving === "keep_one" ? "Saving…" : "Keep selected payment"}</button>
    </div>
    {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
  </section>;
}
