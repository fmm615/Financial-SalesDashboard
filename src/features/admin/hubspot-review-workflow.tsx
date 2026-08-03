"use client";

import { useCallback, useEffect, useState } from "react";
import { ErrorState, LoadingSkeleton, PrimaryButton, SectionCard } from "@/components/ui";
import { hubSpotDealNameForDisplay } from "@/lib/integrations/hubspot/source-reference";

type IncompleteDeal = {
  id: string;
  name: string;
  stageCode: string;
  originalCurrency: string | null;
  closeDate: string | null;
  correctionType: "financial" | "close_date";
  reason: string;
  flaggedAt: string;
};

type IntegrationError = { id: string; safe_error_summary: string; source_reference: string | null; occurred_at: string };
type ReviewPayload = { incompleteDeals: IncompleteDeal[]; integrationErrors: IntegrationError[] };

const inputClass = "mt-1 w-full rounded-md border border-line bg-white px-3 py-2 text-sm text-ink";

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function CorrectionForm({ deal, onSaved }: { deal: IncompleteDeal; onSaved: () => Promise<void> }) {
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState(deal.originalCurrency ?? "USD");
  const [exchangeRateToUsd, setExchangeRateToUsd] = useState(currency === "USD" ? "1" : "");
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit() {
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/admin/hubspot/deals/${deal.id}/correct`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount, currency, exchangeRateToUsd, reason }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Correction could not be saved.");
      await onSaved();
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "Correction could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return <div className="mt-4 grid gap-3 rounded-md border border-line bg-white p-4 sm:grid-cols-2">
    <label className="text-sm font-medium text-ink">Correct amount<input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" className={inputClass} placeholder="0.00" /></label>
    <label className="text-sm font-medium text-ink">Original currency<input value={currency} onChange={(event) => { const value = event.target.value.toUpperCase(); setCurrency(value); if (value === "USD") setExchangeRateToUsd("1"); }} className={inputClass} maxLength={3} placeholder="USD" /></label>
    <label className="text-sm font-medium text-ink">Exchange rate to USD<input value={exchangeRateToUsd} onChange={(event) => setExchangeRateToUsd(event.target.value)} inputMode="decimal" className={inputClass} placeholder="1" /></label>
    <label className="text-sm font-medium text-ink">Reason / source<input value={reason} onChange={(event) => setReason(event.target.value)} className={inputClass} placeholder="Finance-approved correction reason" /></label>
    <div className="sm:col-span-2 flex flex-wrap items-center gap-3"><PrimaryButton onClick={submit} disabled={saving}>{saving ? "Saving correction…" : "Save audited correction"}</PrimaryButton>{message && <p role="alert" className="text-sm text-red-700">{message}</p>}</div>
  </div>;
}

function CloseDateCorrectionForm({ deal, onSaved }: { deal: IncompleteDeal; onSaved: () => Promise<void> }) {
  const [closeDate, setCloseDate] = useState("");
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit() {
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/admin/hubspot/deals/${deal.id}/close-date`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ closeDate, reason }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Close-date correction could not be saved.");
      await onSaved();
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "Close-date correction could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return <div className="mt-4 grid gap-3 rounded-md border border-line bg-white p-4 sm:grid-cols-2">
    <label className="text-sm font-medium text-ink">Correct close date<input value={closeDate} onChange={(event) => setCloseDate(event.target.value)} type="date" className={inputClass} /></label>
    <label className="text-sm font-medium text-ink">Reason / source<input value={reason} onChange={(event) => setReason(event.target.value)} className={inputClass} placeholder="Finance-approved local close-date source" /></label>
    <div className="sm:col-span-2 flex flex-wrap items-center gap-3"><PrimaryButton onClick={submit} disabled={saving}>{saving ? "Saving correction…" : "Save audited close date"}</PrimaryButton>{message && <p role="alert" className="text-sm text-red-700">{message}</p>}</div>
  </div>;
}

function ResolutionForm({ issue, onResolved }: { issue: IntegrationError; onResolved: () => Promise<void> }) {
  const [resolutionNote, setResolutionNote] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function resolve() {
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/admin/hubspot/errors/${issue.id}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolutionNote }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Issue could not be resolved.");
      await onResolved();
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "Issue could not be resolved.");
    } finally {
      setSaving(false);
    }
  }

  return <article className="border-b border-line py-4 last:border-b-0">
    <p className="font-medium text-ink">{issue.safe_error_summary}</p>
    <p className="mt-1 text-sm text-slate-700">Affected deal: {hubSpotDealNameForDisplay(issue.source_reference)}</p>
    <p className="mt-1 text-xs text-slate-500">Flagged {formatDate(issue.occurred_at)}</p>
    <div className="mt-3 flex flex-col gap-2 sm:flex-row"><input value={resolutionNote} onChange={(event) => setResolutionNote(event.target.value)} className="min-w-0 flex-1 rounded-md border border-line bg-white px-3 py-2 text-sm" placeholder="Required resolution note" /><PrimaryButton onClick={resolve} disabled={saving}>{saving ? "Resolving…" : "Mark resolved"}</PrimaryButton></div>
    {message && <p role="alert" className="mt-2 text-sm text-red-700">{message}</p>}
  </article>;
}

/** Admin-only correction and resolution workflow for retained HubSpot issues. */
export function HubSpotReviewWorkflow() {
  const [review, setReview] = useState<ReviewPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/hubspot/review", { cache: "no-store" });
      const body = await response.json() as ReviewPayload & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not load HubSpot review items.");
      setReview(body);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load HubSpot review items.");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (!review && refreshing) return <LoadingSkeleton rows={4} />;
  if (error && !review) return <ErrorState title="HubSpot review unavailable" description={error} />;

  return <div className="mt-6 space-y-4">
    <SectionCard title="HubSpot deals requiring correction" description="Missing financial values and missing booking dates are retained for traceability. An Admin can record a local, audited correction; saving never changes HubSpot.">
      {review?.incompleteDeals.length ? <div className="divide-y divide-line">{review.incompleteDeals.map((deal) => <article key={deal.id} className="py-4 first:pt-0 last:pb-0"><div className="flex flex-wrap items-start justify-between gap-2"><div><p className="font-medium text-ink">{deal.name}</p><p className="mt-1 text-sm text-slate-600">Stage: {deal.stageCode}{deal.closeDate ? ` · Close date: ${deal.closeDate}` : deal.correctionType === "close_date" ? " · Close date missing" : ""}</p></div><p className="text-xs text-slate-500">Flagged {formatDate(deal.flaggedAt)}</p></div><p className="mt-2 text-sm text-amber-800">{deal.reason}</p>{deal.correctionType === "financial" ? <CorrectionForm deal={deal} onSaved={load} /> : <CloseDateCorrectionForm deal={deal} onSaved={load} />}</article>)}</div> : <p className="text-sm text-slate-600">No HubSpot deals are waiting for correction.</p>}
    </SectionCard>
    <SectionCard title="HubSpot integration issues" description="Every unresolved provider validation or persistence failure is a review item. Resolve it with a note after correcting the source configuration or HubSpot source data, then run the 48-hour sync again.">
      {review?.integrationErrors.length ? <div>{review.integrationErrors.map((issue) => <ResolutionForm key={issue.id} issue={issue} onResolved={load} />)}</div> : <p className="text-sm text-slate-600">No unresolved HubSpot integration issues.</p>}
      {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
    </SectionCard>
  </div>;
}
