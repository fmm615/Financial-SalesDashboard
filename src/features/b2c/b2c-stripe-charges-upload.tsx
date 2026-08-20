"use client";

import { useState } from "react";
import { PrimaryButton } from "@/components/ui";
import type { StripeChargesPreview } from "@/server/services/stripe-charges-upload";

type Stage = "select" | "previewing" | "previewed" | "importing";

/** Stripe Charges evidence upload as a state machine: select, `Preview`, then one final import action. */
export function B2cStripeChargesUpload({ onImported }: { onImported: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<StripeChargesPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>("select");

  function reset() {
    setFile(null); setPreview(null); setError(null); setStage("select");
  }

  async function requestPreview() {
    if (!file) return;
    setStage("previewing"); setError(null);
    try {
      const form = new FormData(); form.set("file", file);
      const response = await fetch("/api/admin/b2c/stripe-charges/preview", { method: "POST", body: form });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok || !payload || typeof payload !== "object" || !("preview" in payload)) {
        throw new Error(payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string" ? payload.error : "The Stripe Charges preview could not be prepared.");
      }
      setPreview(payload.preview as StripeChargesPreview);
      setStage("previewed");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The Stripe Charges preview could not be prepared.");
      setStage("select");
    }
  }

  async function confirmImport() {
    if (!file || !preview) return;
    setStage("importing"); setError(null);
    try {
      const form = new FormData(); form.set("file", file); form.set("expectedFileSha256", preview.sourceFileSha256);
      const response = await fetch("/api/admin/b2c/stripe-charges/finalize", { method: "POST", body: form });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string" ? payload.error : "The Stripe Charges file could not be staged.");
      reset();
      onImported();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The Stripe Charges file could not be staged.");
      setStage("previewed");
    }
  }

  return <div>
    <label htmlFor="stripe-charges-csv" className="text-sm font-medium text-text-primary">Stripe Charges CSV</label>
    <input
      id="stripe-charges-csv" type="file" accept=".csv,text/csv" disabled={stage === "previewing" || stage === "importing"}
      className="mt-2 block w-full text-sm"
      onChange={(event) => { setFile(event.target.files?.[0] ?? null); setPreview(null); setError(null); setStage("select"); }}
    />
    <div className="mt-3 flex flex-wrap items-center gap-3">
      {stage === "select" || stage === "previewing" ? (
        <button type="button" disabled={!file || stage === "previewing"} onClick={() => void requestPreview()} className="min-h-11 rounded-md bg-brand-primary px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">
          {stage === "previewing" ? "Previewing…" : "Preview"}
        </button>
      ) : (
        <>
          <PrimaryButton onClick={() => void confirmImport()} disabled={stage === "importing"}>{stage === "importing" ? "Importing…" : "Import reviewed evidence"}</PrimaryButton>
          <button type="button" onClick={reset} disabled={stage === "importing"} className="min-h-11 text-sm font-medium text-brand-accent disabled:cursor-not-allowed disabled:opacity-50">Change file</button>
        </>
      )}
    </div>
    {error && <p className="mt-3 text-sm text-danger" role="alert">{error}</p>}
    <div className="mt-4 min-h-[3.5rem]">
      {preview && <div className="rounded-md border border-border bg-canvas p-4 text-sm text-text-secondary" role="status">
        <p className="font-medium text-text-primary">{preview.sourceRows} source rows · {preview.evidenceEntries} evidence entries</p>
        <p className="mt-1">{preview.saleEntries} sales · {preview.refundEntries} refunds · {preview.needsReviewEntries} need review · {preview.rowsWithContact} with contact details</p>
      </div>}
    </div>
  </div>;
}
