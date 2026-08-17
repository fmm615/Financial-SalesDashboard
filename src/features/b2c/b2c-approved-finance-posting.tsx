"use client";

import { useState } from "react";

type PostResult = { postedPayments: number; alreadyPostedPayments: number; skippedRows: number };

function isPostResult(value: unknown): value is PostResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return [candidate.postedPayments, candidate.alreadyPostedPayments, candidate.skippedRows]
    .every((count) => typeof count === "number" && Number.isInteger(count) && count >= 0);
}

/** Posts Finance-approved iOS and bank-transfer source rows; it never changes the source workbook or a provider. */
export function B2cApprovedFinancePosting({ onPosted }: { onPosted(): Promise<void> }) {
  const [posting, setPosting] = useState(false);
  const [result, setResult] = useState<PostResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const post = async () => {
    setPosting(true); setResult(null); setError(null);
    try {
      const response = await fetch("/api/admin/b2c/finance-ledger-posts", { method: "POST" });
      const payload: unknown = await response.json().catch(() => null);
      const safeResult = payload && typeof payload === "object" && "result" in payload ? (payload as { result: unknown }).result : null;
      if (!response.ok || !isPostResult(safeResult)) throw new Error();
      setResult(safeResult);
      await onPosted();
    } catch {
      setError("Could not add the approved Finance payments. No source data was changed.");
    } finally {
      setPosting(false);
    }
  };

  return <section className="mt-4 rounded-card border border-border bg-surface p-5 shadow-card" aria-labelledby="approved-finance-posting-title">
    <h2 id="approved-finance-posting-title" className="text-lg font-semibold tracking-[-0.02em] text-text-primary">Approved iOS and bank-transfer payments</h2>
    <p className="mt-1 max-w-3xl text-sm leading-6 text-text-secondary">Adds valid iOS and bank-transfer Finance rows to the B2C ledger. It does not alter the workbook or create Stripe, Tap, or Apple payments.</p>
    <button type="button" disabled={posting} onClick={() => void post()} className="mt-3 rounded-md bg-brand-primary px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">{posting ? "Adding…" : "Post approved Finance payments"}</button>
    {error && <p className="mt-3 text-sm text-danger" role="alert">{error}</p>}
    {result && <div className="mt-3 rounded-md border border-border bg-canvas p-3 text-sm text-text-secondary" role="status"><p className="font-medium text-text-primary">{result.postedPayments} Finance payment{result.postedPayments === 1 ? "" : "s"} added to the B2C ledger.</p><p className="mt-1">{result.alreadyPostedPayments} {result.alreadyPostedPayments === 1 ? "was" : "were"} already in the ledger. {result.skippedRows} {result.skippedRows === 1 ? "was" : "were"} kept out because {result.skippedRows === 1 ? "its" : "their"} source was not eligible to post.</p></div>}
  </section>;
}
