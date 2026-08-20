"use client";

import { useState } from "react";
import { PrimaryButton } from "@/components/ui";
import type { PaymentTrackerPreview } from "@/server/services/payment-tracker-upload";

type Stage = "select" | "previewing" | "previewed" | "importing";

/**
 * One context-aware Payment Tracker action: `Import workbook` when no completed
 * import exists yet, `Replace workbook` once one does. A state machine -- never
 * two simultaneously enabled buttons -- carries the Admin from file selection
 * through `Preview` to the one final `Import reviewed…`/`Replace with reviewed…` action.
 */
export function B2cPaymentTrackerUpload({ hasExistingImport, supersedesImportId, onImported }: { hasExistingImport: boolean; supersedesImportId: string | null; onImported: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PaymentTrackerPreview | null>(null);
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
      if (supersedesImportId) form.set("supersedesImportId", supersedesImportId);
      const response = await fetch("/api/admin/b2c/payment-tracker/preview", { method: "POST", body: form });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok || !payload || typeof payload !== "object" || !("preview" in payload)) {
        throw new Error(payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string" ? payload.error : "The workbook preview could not be prepared.");
      }
      setPreview(payload.preview as PaymentTrackerPreview);
      setStage("previewed");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The workbook preview could not be prepared.");
      setStage("select");
    }
  }

  async function confirmImport() {
    if (!file || !preview) return;
    setStage("importing"); setError(null);
    try {
      const form = new FormData(); form.set("file", file); form.set("expectedFileSha256", preview.sourceFileSha256);
      if (supersedesImportId) form.set("supersedesImportId", supersedesImportId);
      const response = await fetch("/api/admin/b2c/payment-tracker/finalize", { method: "POST", body: form });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string" ? payload.error : "The workbook could not be staged.");
      reset();
      onImported();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The workbook could not be staged.");
      setStage("previewed");
    }
  }

  const importLabel = hasExistingImport ? "Replace workbook" : "Import workbook";
  const confirmLabel = hasExistingImport ? "Replace with reviewed workbook" : "Import reviewed workbook";

  return <div>
    <label htmlFor="payment-tracker-workbook" className="text-sm font-medium text-text-primary">{importLabel}</label>
    <input
      id="payment-tracker-workbook" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      disabled={stage === "previewing" || stage === "importing"} className="mt-2 block w-full text-sm"
      onChange={(event) => { setFile(event.target.files?.[0] ?? null); setPreview(null); setError(null); setStage("select"); }}
    />
    <div className="mt-3 flex flex-wrap items-center gap-3">
      {stage === "select" || stage === "previewing" ? (
        <button type="button" disabled={!file || stage === "previewing"} onClick={() => void requestPreview()} className="min-h-11 rounded-md bg-brand-primary px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">
          {stage === "previewing" ? "Previewing…" : "Preview"}
        </button>
      ) : (
        <>
          <PrimaryButton onClick={() => void confirmImport()} disabled={stage === "importing"}>{stage === "importing" ? "Importing…" : confirmLabel}</PrimaryButton>
          <button type="button" onClick={reset} disabled={stage === "importing"} className="min-h-11 text-sm font-medium text-brand-accent disabled:cursor-not-allowed disabled:opacity-50">Change file</button>
        </>
      )}
    </div>
    {error && <p className="mt-3 text-sm text-danger" role="alert">{error}</p>}
    {/* Reserved preview space so a loading state never shifts surrounding layout. */}
    <div className="mt-4 min-h-[3.5rem]">
      {preview && <div className="rounded-md border border-border bg-canvas p-4 text-sm text-text-secondary" role="status">
        <p className="font-medium text-text-primary">{preview.summary.totalRows} extracted rows</p>
        <p className="mt-1">Tabs: {preview.acceptedTabs.join(" and ")} · {preview.summary.validRows} valid · {preview.summary.needsReviewRows} need review · {preview.summary.zeroValueRows} zero-value · {preview.summary.invalidRows} invalid</p>
        <p className="mt-1">Duplicate candidates: {preview.duplicateCandidates.exact} exact, {preview.duplicateCandidates.possible} possible, {preview.duplicateCandidates.conflicts} conflicts.</p>
      </div>}
    </div>
  </div>;
}
