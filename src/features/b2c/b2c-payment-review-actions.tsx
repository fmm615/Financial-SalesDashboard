"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PrimaryButton, StatusBadge } from "@/components/ui";
import { useCanManage } from "@/lib/auth/role-context";
import type { B2cLedgerRow } from "@/server/repositories/b2c-dashboard-repository";
import type { B2cDecoratedLedgerRow } from "@/server/repositories/b2c-ledger-repository";

/** The drawer's row shape: every ledger field plus the one accurate decision, minus Admin-only Stripe evidence (read separately). */
export type B2cReviewRow = Omit<B2cDecoratedLedgerRow, "stripeEvidence">;

const inputClass = "mt-1 block h-10 w-full min-w-0 rounded-input border border-border bg-surface px-3 text-sm text-text-primary outline-none focus:border-brand-accent";
const textareaClass = "mt-1 block min-h-24 w-full min-w-0 resize-y rounded-input border border-border bg-surface px-3 py-2 text-sm text-text-primary outline-none focus:border-brand-accent";
const fieldClass = "block min-w-0 text-sm font-medium text-text-secondary";
// Review copy can contain provider-supplied values and long audit explanations.
// Keep it inside the drawer at every viewport size instead of clipping it.
const copyClass = "min-w-0 max-w-full whitespace-normal break-words [overflow-wrap:anywhere]";

/** The one action a work item's `nextAction` selects as prominent; everything else in this fragment renders under "More actions". */
export type B2cPaymentActionPrimary = "correct" | "map" | "convert_fx" | "review_exception" | null;

function editableValue(value: string | null | undefined): string {
  const trimmed = String(value ?? "").trim();
  return trimmed === "-" || trimmed === "—" ? "" : trimmed;
}

function editableCategory(value: string | null | undefined): string {
  const normalised = editableValue(value).toLowerCase();
  return normalised === "unmapped" ? "" : normalised;
}

function hasMeaningfulAuditReason(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length >= 3 && !/^(?:-+|—+|n\/?a)$/i.test(trimmed);
}

type CorrectionDraft = {
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  categoryCode: string;
  membershipTier: string;
  amountUsd: string;
  occurredOn: string;
};

type FxConversionDraft = {
  exchangeRateToUsd: string;
  conversionSource: string;
  effectiveOn: string;
};

function draftFromRow(row: B2cLedgerRow): CorrectionDraft {
  return {
    customerName: editableValue(row.customerName),
    customerEmail: editableValue(row.customerEmail),
    customerPhone: editableValue(row.customerPhone),
    categoryCode: editableCategory(row.category),
    membershipTier: editableValue(row.membershipTier),
    // Numeric PostgreSQL values can be serialised as numbers by a Supabase
    // client even though the UI domain formats money as text. Form state must
    // always be text so the change comparison and input controls stay safe.
    amountUsd: row.amountValueUsd === null ? "" : String(row.amountValueUsd),
    occurredOn: String(row.dateValue),
  };
}

function isChanged(value: string | number | null | undefined, current: string | number | null | undefined, normalise?: (candidate: string) => string): boolean {
  const transform = normalise ?? ((candidate: string) => candidate.trim());
  return transform(String(value ?? "")) !== transform(String(current ?? ""));
}

/**
 * The drawer's "Local values" section for a Payment row: an always-available,
 * dialog-free verified-overlay editor. Reuses the existing `/correct` route
 * and validation; the drawer owns opening, closing, focus, and refresh.
 */
export function B2cPaymentLocalValuesFragment({ row, onSaved }: { row: B2cReviewRow; onSaved: () => void }) {
  const canManage = useCanManage();
  const router = useRouter();
  const [draft, setDraft] = useState<CorrectionDraft>(() => draftFromRow(row));
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Refunds are separate immutable source records. This workflow corrects the
  // linked payment's local reporting overlay, not a provider refund.
  if (!canManage || row.recordType !== "Payment") return null;

  const current = draftFromRow(row);
  const correction = {
    customerName: isChanged(draft.customerName, current.customerName, editableValue) ? editableValue(draft.customerName) || undefined : undefined,
    customerEmail: isChanged(draft.customerEmail, current.customerEmail, (value) => editableValue(value).toLowerCase()) ? editableValue(draft.customerEmail).toLowerCase() || undefined : undefined,
    customerPhone: isChanged(draft.customerPhone, current.customerPhone, editableValue) ? editableValue(draft.customerPhone) || undefined : undefined,
    categoryCode: isChanged(draft.categoryCode, current.categoryCode, editableCategory) ? editableCategory(draft.categoryCode) || undefined : undefined,
    membershipTier: isChanged(draft.membershipTier, current.membershipTier, editableValue) ? editableValue(draft.membershipTier) || undefined : undefined,
    amountUsd: isChanged(draft.amountUsd, current.amountUsd) ? draft.amountUsd.trim() : undefined,
    occurredOn: isChanged(draft.occurredOn, current.occurredOn) ? draft.occurredOn : undefined,
  };
  const hasLocalCorrectionInput = Object.values(correction).some(Boolean);

  async function saveLocalCorrection() {
    setSaving(true); setMessage(null);
    try {
      const response = await fetch(`/api/admin/b2c/payments/${row.id}/correct`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...correction, reason }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "The local B2C correction could not be saved.");
      setReason(""); router.refresh(); onSaved();
    } catch (caught) { setMessage(caught instanceof Error ? caught.message : "The local B2C correction could not be saved."); } finally { setSaving(false); }
  }

  return <div>
    <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
      <p className={`${copyClass} text-sm leading-6 text-text-muted`}>Update only the values Finance has verified. {row.source} is never changed.</p>
      <p className="text-xs text-text-muted">Source amount: {row.sourceAmountUsd} · Source date: {row.sourceDateValue}</p>
    </div>
    <div className="mt-4">
      <p className="text-xs font-semibold uppercase tracking-[0.08em] text-text-muted">Customer</p>
      <div className="mt-3 grid gap-x-5 gap-y-4 md:grid-cols-2">
        <label className={fieldClass}>Customer name<input className={inputClass} value={draft.customerName} onChange={(event) => setDraft((current) => ({ ...current, customerName: event.target.value }))} placeholder="Unavailable from Stripe" /></label>
        <label className={fieldClass}>Customer email<input className={inputClass} value={draft.customerEmail} onChange={(event) => setDraft((current) => ({ ...current, customerEmail: event.target.value }))} inputMode="email" placeholder="Unavailable from Stripe" /></label>
        <label className={fieldClass}>Customer mobile<input className={inputClass} value={draft.customerPhone} onChange={(event) => setDraft((current) => ({ ...current, customerPhone: event.target.value }))} inputMode="tel" placeholder="Unavailable from Stripe" /></label>
      </div>
    </div>
    <div className="mt-5 border-t border-border pt-5">
      <p className="text-xs font-semibold uppercase tracking-[0.08em] text-text-muted">PLAYBOOK reporting</p>
      <div className="mt-3 grid gap-x-5 gap-y-4 md:grid-cols-2">
        <label className={fieldClass}>PLAYBOOK reporting category<input className={inputClass} value={draft.categoryCode} onChange={(event) => setDraft((current) => ({ ...current, categoryCode: event.target.value }))} placeholder="Required for Finance, e.g. membership" /><span className="mt-1 block text-xs font-normal text-text-muted">Enter a verified category; do not use a dash.</span></label>
        <label className={fieldClass}>Plan / tier<input className={inputClass} value={draft.membershipTier} onChange={(event) => setDraft((current) => ({ ...current, membershipTier: event.target.value }))} placeholder="Unavailable from Stripe" /></label>
        <label className={fieldClass}>Local B2C amount (USD)<input className={inputClass} type="number" min="0.000001" step="0.000001" value={draft.amountUsd} onChange={(event) => setDraft((current) => ({ ...current, amountUsd: event.target.value }))} disabled={row.isForeignCurrency} /><span className="mt-1 block text-xs font-normal text-text-muted">{row.isForeignCurrency ? "Foreign-currency USD amounts are created only through the Finance conversion in Finance decision." : "Use only a Finance-verified USD amount."}</span></label>
        <label className={fieldClass}>Local business date<input className={inputClass} type="date" value={draft.occurredOn} onChange={(event) => setDraft((current) => ({ ...current, occurredOn: event.target.value }))} /></label>
      </div>
    </div>
    <label className={`${fieldClass} mt-5 block`}>Reason / evidence <span className="font-normal text-text-muted">(required)</span><textarea className={textareaClass} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Explain the evidence for this change. It is saved in the audit history." /><span className="mt-1 block text-xs font-normal text-text-muted">Leave a value blank when it is unavailable. A dash is not verified data.</span></label>
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <PrimaryButton onClick={() => void saveLocalCorrection()} disabled={saving || !hasLocalCorrectionInput || !hasMeaningfulAuditReason(reason)}>{saving ? "Saving…" : "Save audited local correction"}</PrimaryButton>
      <p className="text-xs leading-5 text-text-muted">{hasLocalCorrectionInput ? "The saved correction updates PLAYBOOK reporting only." : "Change at least one local value and enter a reason to save."}</p>
    </div>
    {message && <p role="alert" className="mt-3 text-sm text-danger">{message}</p>}
  </div>;
}

/**
 * The drawer's "Finance decision" section for a Payment row: FX conversion,
 * product mapping, the Finance inclusion exception, and open review flags.
 * `primary` (from the work item's `nextAction`) renders expanded first;
 * every other available action renders under one "More actions" disclosure.
 * The shared drawer owns opening, closing, focus, errors, and refresh.
 */
export function B2cPaymentFinanceDecisionFragment({ row, primary, onSaved }: { row: B2cReviewRow; primary: B2cPaymentActionPrimary; onSaved: () => void }) {
  const canManage = useCanManage();
  const router = useRouter();
  const [internalProductCode, setInternalProductCode] = useState("");
  const [internalProductName, setInternalProductName] = useState("");
  const [mappingCategoryCode, setMappingCategoryCode] = useState("");
  const [mappingMembershipTier, setMappingMembershipTier] = useState("");
  const [fxDraft, setFxDraft] = useState<FxConversionDraft>({ exchangeRateToUsd: "", conversionSource: "", effectiveOn: row.sourceDateValue });
  const [reason, setReason] = useState("");
  const [confirmedProviderTransaction, setConfirmedProviderTransaction] = useState(false);
  const [confirmedNoKnownDuplicate, setConfirmedNoKnownDuplicate] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (!canManage || row.recordType !== "Payment") return null;

  const hasUnmappedProduct = row.openReviewFlags.some((flag) => flag.type === "Unmapped product");
  const mappingAvailable = (row.sourceSystem === "stripe" || row.sourceSystem === "tap") && Boolean(row.productReference);

  async function mapProduct() {
    if (!row.productReference) return;
    setSaving(true); setMessage(null);
    try {
      const response = await fetch("/api/admin/b2c/products/map", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceSystem: row.sourceSystem, productReference: row.productReference, internalProductCode, internalProductName, categoryCode: mappingCategoryCode, membershipTier: mappingMembershipTier || undefined, reason }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "The local provider product mapping could not be saved.");
      router.refresh(); onSaved();
    } catch (caught) { setMessage(caught instanceof Error ? caught.message : "The local provider product mapping could not be saved."); } finally { setSaving(false); }
  }

  async function saveFinanceException() {
    setSaving(true); setMessage(null);
    try {
      const response = await fetch(`/api/admin/b2c/payments/${row.id}/finance-exception`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason, confirmedProviderTransaction, confirmedNoKnownDuplicate }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "The Finance exception could not be saved.");
      router.refresh(); onSaved();
    } catch (caught) { setMessage(caught instanceof Error ? caught.message : "The Finance exception could not be saved."); } finally { setSaving(false); }
  }

  async function saveFxConversion() {
    setSaving(true); setMessage(null);
    try {
      const response = await fetch(`/api/admin/b2c/payments/${row.id}/fx-conversion`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...fxDraft, reason }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "The Finance USD conversion could not be saved.");
      router.refresh(); onSaved();
    } catch (caught) { setMessage(caught instanceof Error ? caught.message : "The Finance USD conversion could not be saved."); } finally { setSaving(false); }
  }

  const requiresFxReview = row.foreignCurrencyReview === true;
  const canUseFinanceException = !requiresFxReview && row.paymentStatus === "Completed" && Boolean(row.providerReference) && row.category !== "Unmapped" && !row.hasFinanceException;
  const hasSourceReview = row.openReviewFlags.length > 0;
  const financeExceptionSourceGaps = Array.from(new Set(row.openReviewFlags.flatMap((flag) => {
    if (flag.type === "Missing customer email") return ["customer email"];
    if (flag.type === "Unmapped product") return ["approved product mapping"];
    return [];
  })));
  const showFinanceException = !requiresFxReview && (row.hasFinanceException || financeExceptionSourceGaps.length > 0);

  const fxBlock = row.isForeignCurrency && <details key="fx" className="group rounded-input border border-brand-accent/25 bg-brand-accent/5" open={primary === "convert_fx"}>
    <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-3 text-sm font-semibold text-text-primary marker:content-none"><span>Finance USD conversion {requiresFxReview ? <span className="ml-1 font-normal text-warning">(required before reporting)</span> : <span className="ml-1 font-normal text-success">(recorded)</span>}</span><span className="text-xs font-normal text-text-muted group-open:hidden">View</span><span className="hidden text-xs font-normal text-text-muted group-open:inline">Hide</span></summary>
    <div className="border-t border-brand-accent/15 px-4 py-4">
      <p className={`${copyClass} text-sm leading-6 text-text-secondary`}>The source payment is <strong>{row.sourceAmountUsd}</strong>. Enter the Finance-approved number of USD for one {row.sourceOriginalCurrency} and its evidence. PLAYBOOK calculates and stores the USD reporting amount; {row.source} is never changed.</p>
      {row.hasFxConversion && <p className="mt-3 rounded-input border border-success/20 bg-success/5 p-3 text-sm text-success">Latest local USD conversion: <strong>{row.amountUsd}</strong>{row.fxConversionEffectiveOn ? `, effective ${row.fxConversionEffectiveOn}` : ""}{row.fxConversionSource ? ` · ${row.fxConversionSource}` : ""}.</p>}
      <div className="mt-4 grid gap-x-5 gap-y-4 md:grid-cols-2">
        <label className={fieldClass}>USD per 1 {row.sourceOriginalCurrency}<input className={inputClass} type="number" min="0.0000000001" step="0.0000000001" value={fxDraft.exchangeRateToUsd} onChange={(event) => setFxDraft((current) => ({ ...current, exchangeRateToUsd: event.target.value }))} placeholder="e.g. 2.6595744681" /></label>
        <label className={fieldClass}>Finance conversion source<input className={inputClass} value={fxDraft.conversionSource} onChange={(event) => setFxDraft((current) => ({ ...current, conversionSource: event.target.value }))} placeholder="Approved Finance FX rate / accounting evidence" /></label>
        <label className={fieldClass}>Conversion effective date<input className={inputClass} type="date" value={fxDraft.effectiveOn} onChange={(event) => setFxDraft((current) => ({ ...current, effectiveOn: event.target.value }))} /></label>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3"><PrimaryButton onClick={() => void saveFxConversion()} disabled={saving || !fxDraft.exchangeRateToUsd.trim() || !fxDraft.conversionSource.trim() || !fxDraft.effectiveOn || !hasMeaningfulAuditReason(reason)}>{saving ? "Saving…" : row.hasFxConversion ? "Record revised USD conversion" : "Save Finance USD conversion"}</PrimaryButton><p className="text-xs leading-5 text-text-muted">Uses the same required reason below and creates a new audited Finance record.</p></div>
    </div>
  </details>;

  const reviewFlagsBlock = hasSourceReview && <details key="flags" className="group rounded-input border border-border bg-surface">
    <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-3 text-sm font-semibold text-text-primary marker:content-none"><span>Open review flags <span className="ml-1 font-normal text-text-muted">({row.openReviewFlags.length})</span></span><span className="text-xs font-normal text-text-muted group-open:hidden">View</span><span className="hidden text-xs font-normal text-text-muted group-open:inline">Hide</span></summary>
    <div className="border-t border-border px-4 py-4">
      <p className={`${copyClass} text-sm leading-6 text-text-muted`}>These source flags remain in history. A verified local correction clears only its matching missing-data flag; {row.source} is never changed.</p>
      <div className="mt-4 space-y-3">
        {row.openReviewFlags.map((flag) => <div key={flag.id} className="min-w-0 max-w-full rounded-input border border-border bg-surface-muted/35 p-4"><StatusBadge status={flag.type} /><p className={`${copyClass} mt-3 text-sm leading-6 text-text-secondary`}>{flag.reason}</p></div>)}
      </div>
      {hasUnmappedProduct && !mappingAvailable && <p className={`${copyClass} mt-4 rounded-input border border-warning/25 bg-warning/5 p-3 text-sm leading-6 text-warning`}>{row.source} did not provide a reusable product reference. A local correction affects this payment only.</p>}
    </div>
  </details>;

  const mappingBlock = hasUnmappedProduct && mappingAvailable && <details key="map" className="group rounded-input border border-warning/25 bg-warning/5" open={primary === "map"}>
    <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-3 text-sm font-semibold text-text-primary marker:content-none"><span>Create reusable product mapping</span><span className="text-xs font-normal text-warning group-open:hidden">View</span><span className="hidden text-xs font-normal text-warning group-open:inline">Hide</span></summary>
    <div className="border-t border-warning/20 px-4 py-4"><p className={`${copyClass} text-sm leading-6 text-text-secondary`}>This classifies every local payment with this exact source product reference. It does not edit {row.source}.</p><div className="mt-4 grid grid-cols-1 gap-x-5 gap-y-4 md:grid-cols-2"><label className={fieldClass}>Internal product code<input className={inputClass} value={internalProductCode} onChange={(event) => setInternalProductCode(event.target.value)} placeholder="membership_annual" /></label><label className={fieldClass}>Internal product name<input className={inputClass} value={internalProductName} onChange={(event) => setInternalProductName(event.target.value)} placeholder="Annual membership" /></label><label className={fieldClass}>PLAYBOOK reporting category<input className={inputClass} value={mappingCategoryCode} onChange={(event) => setMappingCategoryCode(event.target.value)} placeholder="membership" /></label><label className={fieldClass}>Membership tier <span className="font-normal text-text-muted">(optional)</span><input className={inputClass} value={mappingMembershipTier} onChange={(event) => setMappingMembershipTier(event.target.value)} placeholder="annual" /></label></div><div className="mt-4 flex flex-wrap items-center gap-3"><PrimaryButton onClick={() => void mapProduct()} disabled={saving || !hasMeaningfulAuditReason(reason)}>{saving ? "Saving…" : "Save local product mapping"}</PrimaryButton><p className="text-xs leading-5 text-text-muted">Uses the reason below and applies only in PLAYBOOK.</p></div></div>
  </details>;

  const exceptionBlock = showFinanceException && <details key="exception" className="group rounded-input border border-brand-accent/25 bg-brand-accent/5" open={primary === "review_exception"}>
    <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-3 text-sm font-semibold text-text-primary marker:content-none"><span>{row.hasFinanceException ? "Finance inclusion exception" : "Count in Finance despite missing source details"}</span><span className="text-xs font-normal text-text-muted group-open:hidden">View</span><span className="hidden text-xs font-normal text-text-muted group-open:inline">Hide</span></summary>
    <div className="border-t border-brand-accent/15 px-4 py-4">{row.hasFinanceException ? <p className={`${copyClass} text-sm leading-6 text-success`}>This payment is included in PLAYBOOK Finance through an audited exception. The original missing {row.source} source details remain visible in its history.</p> : <><p className={`${copyClass} text-sm leading-6 text-text-secondary`}>This payment is currently excluded because {row.source} did not provide: <strong className="font-semibold text-text-primary">{financeExceptionSourceGaps.join(" and ")}</strong>.</p><p className={`${copyClass} mt-2 text-sm leading-6 text-text-secondary`}>First, save a verified local value in Local values if you have it. Use this only when the source detail is genuinely unavailable but Finance has still verified the amount, business date, and PLAYBOOK category.</p>{!canUseFinanceException && <p className="mt-3 rounded-input border border-warning/25 bg-warning/5 p-3 text-sm leading-6 text-warning">Enter and save a real verified PLAYBOOK category in Local values, such as “membership”. Do not use “unmapped” or a dash.</p>}<label className="mt-4 flex items-start gap-3 text-sm leading-5 text-text-secondary"><input type="checkbox" checked={confirmedProviderTransaction} onChange={(event) => setConfirmedProviderTransaction(event.target.checked)} className="mt-0.5 size-4 shrink-0 rounded border-border text-brand-accent" />I confirm this is the exact provider payment ID shown in Summary.</label><label className="mt-3 flex items-start gap-3 text-sm leading-5 text-text-secondary"><input type="checkbox" checked={confirmedNoKnownDuplicate} onChange={(event) => setConfirmedNoKnownDuplicate(event.target.checked)} className="mt-0.5 size-4 shrink-0 rounded border-border text-brand-accent" />I reviewed the available evidence and found no known duplicate.</label><div className="mt-4 flex flex-wrap items-center gap-3"><PrimaryButton onClick={() => void saveFinanceException()} disabled={saving || !canUseFinanceException || !confirmedProviderTransaction || !confirmedNoKnownDuplicate || !hasMeaningfulAuditReason(reason)}>{saving ? "Saving…" : "Include in PLAYBOOK Finance"}</PrimaryButton><p className="text-xs leading-5 text-text-muted">Requires the reason below and both confirmations. {row.source} is never changed.</p></div></>}</div>
  </details>;

  const blocks = [fxBlock, mappingBlock, exceptionBlock].filter(Boolean);
  const primaryBlock = primary === "convert_fx" ? fxBlock : primary === "map" ? mappingBlock : primary === "review_exception" ? exceptionBlock : null;
  const secondaryBlocks = blocks.filter((block) => block !== primaryBlock);

  if (blocks.length === 0 && !reviewFlagsBlock) return <p className="text-sm leading-6 text-text-muted">No Finance decision action is currently available for this record.</p>;

  return <div className="space-y-3">
    {row.decision && <p className={`${copyClass} text-sm leading-6 text-text-secondary`}>{row.decision.explanation}</p>}
    {primaryBlock}
    {(secondaryBlocks.length > 0 || reviewFlagsBlock) && <details className="group rounded-input border border-border bg-surface-muted/35" open={!primaryBlock}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-3 text-sm font-semibold text-text-primary marker:content-none"><span>More actions</span><span className="text-xs font-normal text-text-muted group-open:hidden">Show</span><span className="hidden text-xs font-normal text-text-muted group-open:inline">Hide</span></summary>
      <div className="space-y-3 border-t border-border p-3">{secondaryBlocks}{reviewFlagsBlock}</div>
    </details>}
    <label className={`${fieldClass} block`}>Reason / evidence <span className="font-normal text-text-muted">(required for every save above)</span><textarea className={textareaClass} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Explain the evidence for this decision. It is saved in the audit history." /></label>
    {message && <p role="alert" className="mt-1 text-sm text-danger">{message}</p>}
  </div>;
}
