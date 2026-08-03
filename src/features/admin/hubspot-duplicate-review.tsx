"use client";

import { useCallback, useEffect, useState } from "react";
import { ErrorState, LoadingSkeleton, PrimaryButton, SectionCard } from "@/components/ui";

type CandidateDeal = {
  id: string;
  source_system: "hubspot" | "manual_finance";
  external_deal_id: string | null;
  name: string;
  stage_code: string;
  pipeline_amount_usd: string | null;
  original_currency: string | null;
  hubspot_close_date: string | null;
};

type DuplicateGroup = { id: string; flaggedAt: string; deals: CandidateDeal[] };
type DuplicatePayload = { groups: DuplicateGroup[] };

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function DuplicateDecision({ group, onSaved }: { group: DuplicateGroup; onSaved: () => Promise<void> }) {
  const [decision, setDecision] = useState<"keep_both" | "keep_one">("keep_both");
  const [keepDealId, setKeepDealId] = useState(group.deals[0]?.id ?? "");
  const [resolutionNote, setResolutionNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/admin/hubspot/duplicates/${group.id}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, keepDealId: decision === "keep_one" ? keepDealId : null, resolutionNote }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Duplicate decision could not be saved.");
      await onSaved();
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "Duplicate decision could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return <article className="border-b border-line py-5 first:pt-0 last:border-b-0 last:pb-0">
    <div><p className="font-medium text-ink">Possible duplicate B2B deals</p><p className="mt-1 text-sm text-slate-600">Flagged {formatDate(group.flaggedAt)} · compare the records before deciding.</p></div>
    <div className="mt-4 grid gap-3 lg:grid-cols-2">
      {group.deals.map((deal) => <label key={deal.id} className={`rounded-md border p-4 ${decision === "keep_one" && keepDealId === deal.id ? "border-brand-lime bg-lime-50" : "border-line bg-white"}`}>
        <div className="flex items-start gap-3"><input type="radio" name={`keep-${group.id}`} checked={keepDealId === deal.id} onChange={() => setKeepDealId(deal.id)} disabled={decision !== "keep_one"} aria-label={`Keep ${deal.name}`} /><div className="min-w-0"><p className="font-medium text-ink">{deal.name}</p><p className="mt-1 break-all text-xs text-slate-600">Source: {deal.source_system === "hubspot" ? `HubSpot deal ${deal.external_deal_id ?? "ID unavailable"}` : "Manual Finance entry"}</p><p className="mt-1 text-sm text-slate-600">Stage: {deal.stage_code} · USD {deal.pipeline_amount_usd ?? "Unavailable"}</p><p className="mt-1 text-sm text-slate-600">Close date: {deal.hubspot_close_date ?? "Not set"} · Currency: {deal.original_currency ?? "Unavailable"}</p></div></div>
      </label>)}
    </div>
    <fieldset className="mt-4 flex flex-wrap gap-4"><legend className="sr-only">Duplicate decision</legend><label className="flex items-center gap-2 text-sm text-ink"><input type="radio" name={`decision-${group.id}`} checked={decision === "keep_both"} onChange={() => setDecision("keep_both")} /> Keep both deals</label><label className="flex items-center gap-2 text-sm text-ink"><input type="radio" name={`decision-${group.id}`} checked={decision === "keep_one"} onChange={() => setDecision("keep_one")} /> Keep only the selected deal</label></fieldset>
    <div className="mt-3 flex flex-col gap-2 sm:flex-row"><input value={resolutionNote} onChange={(event) => setResolutionNote(event.target.value)} className="min-w-0 flex-1 rounded-md border border-line bg-white px-3 py-2 text-sm" placeholder="Required decision note" /><PrimaryButton onClick={save} disabled={saving}>{saving ? "Saving decision…" : "Save duplicate decision"}</PrimaryButton></div>
    <p className="mt-2 text-xs text-slate-500">This decision only affects PLAYBOOK’s local financial view. It never changes HubSpot.</p>
    {message && <p role="alert" className="mt-2 text-sm text-red-700">{message}</p>}
  </article>;
}

/** Admin-only choice for exact matching B2B deals. No record is deleted. */
export function HubSpotDuplicateReview() {
  const [review, setReview] = useState<DuplicatePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/hubspot/duplicates", { cache: "no-store" });
      const body = await response.json() as DuplicatePayload & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not load B2B duplicate candidates.");
      setReview(body);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load B2B duplicate candidates.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  if (!review && loading) return <div className="mt-4"><LoadingSkeleton rows={3} /></div>;
  if (error && !review) return <div className="mt-4"><ErrorState title="Duplicate review unavailable" description={error} /></div>;

  return <div className="mt-4"><SectionCard title="Possible duplicate B2B deals" description="Exact candidates are paused from financial totals until an Admin chooses to keep both or keep one. The decision is audited; HubSpot source records are never changed.">
    {review?.groups.length ? <div>{review.groups.map((group) => <DuplicateDecision key={group.id} group={group} onSaved={load} />)}</div> : <p className="text-sm text-slate-600">No possible B2B duplicates are waiting for review.</p>}
    {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
  </SectionCard></div>;
}
