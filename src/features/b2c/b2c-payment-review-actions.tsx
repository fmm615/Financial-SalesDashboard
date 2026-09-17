"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PrimaryButton } from "@/components/ui";
import { useCanManage } from "@/lib/auth/role-context";
import type { B2cDecoratedLedgerRow } from "@/server/repositories/b2c-ledger-repository";

/** The drawer's row shape: every ledger field plus the one accurate decision, minus full Admin-only Stripe evidence (read separately). */
export type B2cReviewRow = Omit<B2cDecoratedLedgerRow, "stripeEvidence">;

const inputClass = "mt-1 block h-10 w-full min-w-0 rounded-input border border-border bg-surface px-3 text-sm text-text-primary outline-none focus:border-brand-accent focus:ring-2 focus:ring-brand-accent/20";
const textareaClass = "mt-1 block min-h-24 w-full min-w-0 resize-y rounded-input border border-border bg-surface px-3 py-2 text-sm text-text-primary outline-none focus:border-brand-accent focus:ring-2 focus:ring-brand-accent/20";
const fieldClass = "block min-w-0 text-sm font-medium text-text-secondary";
const copyClass = "min-w-0 max-w-full whitespace-normal break-words [overflow-wrap:anywhere]";

function editableValue(value: string | number | null | undefined): string {
  const trimmed = String(value ?? "").trim();
  return trimmed === "-" || trimmed === "—" ? "" : trimmed;
}

function hasMeaningfulAuditReason(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length >= 3 && !/^(?:-+|—+|n\/?a)$/i.test(trimmed);
}

type LocalCorrectionField = "amountUsd" | "occurredOn" | "customerEmail";

function useLocalCorrection({
  row,
  field,
  initialValue,
  currentValue,
  normalize = editableValue,
  onSaved,
}: {
  row: B2cReviewRow;
  field: LocalCorrectionField;
  initialValue: string;
  currentValue: string;
  normalize?: (value: string) => string;
  onSaved: () => void;
}) {
  const router = useRouter();
  const [value, setValue] = useState(initialValue);
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const normalizedValue = normalize(value);
  const changed = Boolean(normalizedValue) && normalizedValue !== normalize(currentValue);

  async function save() {
    if (!changed || !hasMeaningfulAuditReason(reason)) return;
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/admin/b2c/payments/${row.id}/correct`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: normalizedValue, reason }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "The local B2C correction could not be saved.");
      setReason("");
      router.refresh();
      onSaved();
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "The local B2C correction could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return { value, setValue, reason, setReason, message, saving, changed, save };
}

function ReasonField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <label className={`${fieldClass} mt-4`}>
    Reason / evidence <span className="font-normal text-text-muted">(required)</span>
    <textarea
      className={textareaClass}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder="Explain the evidence for this change. It is saved in the audit history."
    />
  </label>;
}

export function B2cPaymentAmountCorrection({ row, onSaved }: { row: B2cReviewRow; onSaved: () => void }) {
  const canManage = useCanManage();
  const currentValue = row.amountValueUsd === null ? "" : String(row.amountValueUsd);
  const correction = useLocalCorrection({ row, field: "amountUsd", initialValue: currentValue, currentValue, onSaved });

  if (!canManage || row.recordType !== "Payment") return null;

  return <div>
    <p className={`${copyClass} text-sm leading-6 text-text-muted`}>Enter only a Finance-verified USD amount. The retained source amount is <strong className="font-semibold text-text-primary">{row.sourceAmountUsd}</strong>; {row.source} is never changed.</p>
    <label className={`${fieldClass} mt-4`}>Local B2C amount (USD)
      <input
        className={inputClass}
        type="number"
        min="0.000001"
        step="0.000001"
        value={correction.value}
        onChange={(event) => correction.setValue(event.target.value)}
        disabled={row.isForeignCurrency}
      />
    </label>
    <ReasonField value={correction.reason} onChange={correction.setReason} />
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <PrimaryButton onClick={() => void correction.save()} disabled={correction.saving || row.isForeignCurrency === true || !correction.changed || !hasMeaningfulAuditReason(correction.reason)}>{correction.saving ? "Saving…" : "Save amount"}</PrimaryButton>
      <p className="text-xs leading-5 text-text-muted">This creates an audited local correction in PLAYBOOK.</p>
    </div>
    {correction.message && <p role="alert" className="mt-3 text-sm text-danger">{correction.message}</p>}
  </div>;
}

export function B2cPaymentBusinessDateCorrection({ row, saveLabel, onSaved }: {
  row: B2cReviewRow;
  saveLabel: "Save date" | "Save corrected date";
  onSaved: () => void;
}) {
  const canManage = useCanManage();
  const currentValue = editableValue(row.dateValue);
  const correction = useLocalCorrection({ row, field: "occurredOn", initialValue: currentValue, currentValue, onSaved });

  if (!canManage || row.recordType !== "Payment") return null;

  return <div>
    <p className={`${copyClass} text-sm leading-6 text-text-muted`}>Enter the verified business date used by PLAYBOOK reporting. The retained source date is <strong className="font-semibold text-text-primary">{row.sourceDateValue || "unavailable"}</strong>; {row.source} is never changed.</p>
    <label className={`${fieldClass} mt-4`}>Local business date
      <input className={inputClass} type="date" value={correction.value} onChange={(event) => correction.setValue(event.target.value)} />
    </label>
    <ReasonField value={correction.reason} onChange={correction.setReason} />
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <PrimaryButton onClick={() => void correction.save()} disabled={correction.saving || !correction.changed || !hasMeaningfulAuditReason(correction.reason)}>{correction.saving ? "Saving…" : saveLabel}</PrimaryButton>
      <p className="text-xs leading-5 text-text-muted">This creates an audited local correction in PLAYBOOK.</p>
    </div>
    {correction.message && <p role="alert" className="mt-3 text-sm text-danger">{correction.message}</p>}
  </div>;
}

export function B2cPaymentEmailCorrection({ row, onSaved }: { row: B2cReviewRow; onSaved: () => void }) {
  const canManage = useCanManage();
  const suggestedValue = editableValue(row.customerEmail);
  const verifiedCurrentValue = row.customerEmailEvidenceLabel ? "" : suggestedValue;
  const correction = useLocalCorrection({
    row,
    field: "customerEmail",
    initialValue: suggestedValue,
    currentValue: verifiedCurrentValue,
    normalize: (value) => editableValue(value).toLowerCase(),
    onSaved,
  });

  if (!canManage || row.recordType !== "Payment") return null;

  return <div>
    <p className={`${copyClass} text-sm leading-6 text-text-muted`}>Save an email only after Finance verifies it for this payment. The source record in {row.source} is never changed.</p>
    <label className={`${fieldClass} mt-4`}>Customer email
      <input
        className={inputClass}
        type="email"
        inputMode="email"
        autoComplete="email"
        value={correction.value}
        onChange={(event) => correction.setValue(event.target.value)}
        placeholder={`Unavailable from ${row.source}`}
      />
    </label>
    {row.customerEmailEvidenceLabel && <span className="mt-1 block text-xs font-normal normal-case text-text-muted">From {row.customerEmailEvidenceLabel} — no action needed</span>}
    <ReasonField value={correction.reason} onChange={correction.setReason} />
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <PrimaryButton onClick={() => void correction.save()} disabled={correction.saving || !correction.changed || !hasMeaningfulAuditReason(correction.reason)}>{correction.saving ? "Saving…" : "Save email"}</PrimaryButton>
      <p className="text-xs leading-5 text-text-muted">This creates an audited local correction in PLAYBOOK.</p>
    </div>
    {correction.message && <p role="alert" className="mt-3 text-sm text-danger">{correction.message}</p>}
  </div>;
}

/** Optional metadata not tied to any blocking reason. Always available for a Payment row, independent of what it needs to become reportable. */
export function B2cPaymentOtherDetailsCorrection({ row, onSaved }: { row: B2cReviewRow; onSaved: () => void }) {
  const canManage = useCanManage();
  const router = useRouter();
  const verifiedName = row.customerNameEvidenceLabel ? "" : editableValue(row.customerName);
  const verifiedPhone = row.customerPhoneEvidenceLabel ? "" : editableValue(row.customerPhone);
  const verifiedTier = editableValue(row.membershipTier);
  const [customerName, setCustomerName] = useState(editableValue(row.customerName));
  const [customerPhone, setCustomerPhone] = useState(editableValue(row.customerPhone));
  const [membershipTier, setMembershipTier] = useState(verifiedTier);
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (!canManage || row.recordType !== "Payment") return null;

  const correction = {
    customerName: editableValue(customerName) !== verifiedName ? editableValue(customerName) || undefined : undefined,
    customerPhone: editableValue(customerPhone) !== verifiedPhone ? editableValue(customerPhone) || undefined : undefined,
    membershipTier: editableValue(membershipTier) !== verifiedTier ? editableValue(membershipTier) || undefined : undefined,
  };
  const hasInput = Object.values(correction).some(Boolean);

  async function save() {
    if (!hasInput || !hasMeaningfulAuditReason(reason)) return;
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/admin/b2c/payments/${row.id}/correct`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...correction, reason }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "The local B2C correction could not be saved.");
      setReason("");
      router.refresh();
      onSaved();
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "The local B2C correction could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return <div>
    <p className={`${copyClass} text-sm leading-6 text-text-muted`}>Optional metadata. Update only values Finance has verified; {row.source} is never changed.</p>
    <div className="mt-4 grid gap-x-5 gap-y-4 md:grid-cols-2">
      <div>
        <label className={fieldClass}>Customer name
          <input className={inputClass} value={customerName} onChange={(event) => setCustomerName(event.target.value)} placeholder={`Unavailable from ${row.source}`} />
        </label>
        {row.customerNameEvidenceLabel && <span className="mt-1 block text-xs font-normal normal-case text-text-muted">From {row.customerNameEvidenceLabel} — no action needed</span>}
      </div>
      <div>
        <label className={fieldClass}>Customer mobile
          <input className={inputClass} value={customerPhone} onChange={(event) => setCustomerPhone(event.target.value)} inputMode="tel" placeholder={`Unavailable from ${row.source}`} />
        </label>
        {row.customerPhoneEvidenceLabel && <span className="mt-1 block text-xs font-normal normal-case text-text-muted">From {row.customerPhoneEvidenceLabel} — no action needed</span>}
      </div>
      <label className={fieldClass}>Plan / tier
        <input className={inputClass} value={membershipTier} onChange={(event) => setMembershipTier(event.target.value)} placeholder={`Unavailable from ${row.source}`} />
      </label>
    </div>
    <ReasonField value={reason} onChange={setReason} />
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <PrimaryButton onClick={() => void save()} disabled={saving || !hasInput || !hasMeaningfulAuditReason(reason)}>{saving ? "Saving…" : "Save details"}</PrimaryButton>
      <p className="text-xs leading-5 text-text-muted">{hasInput ? "This creates an audited local correction in PLAYBOOK." : "Change at least one value and enter a reason to save."}</p>
    </div>
    {message && <p role="alert" className="mt-3 text-sm text-danger">{message}</p>}
  </div>;
}

export function B2cPaymentFinanceException({ row, onSaved }: { row: B2cReviewRow; onSaved: () => void }) {
  const canManage = useCanManage();
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [confirmedProviderTransaction, setConfirmedProviderTransaction] = useState(false);
  const [confirmedNoKnownDuplicate, setConfirmedNoKnownDuplicate] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (!canManage || row.recordType !== "Payment") return null;

  const canUseFinanceException = row.foreignCurrencyReview !== true
    && row.paymentStatus === "Completed"
    && Boolean(row.providerReference)
    && !row.hasFinanceException;

  async function saveFinanceException() {
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/admin/b2c/payments/${row.id}/finance-exception`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason, confirmedProviderTransaction, confirmedNoKnownDuplicate }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "The Finance exception could not be saved.");
      router.refresh();
      onSaved();
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "The Finance exception could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  if (row.hasFinanceException) {
    return <p className={`${copyClass} text-sm leading-6 text-success`}>This payment is included in PLAYBOOK Finance through an audited exception. The original missing {row.source} email remains visible in its history.</p>;
  }

  return <div>
    <p className={`${copyClass} text-sm leading-6 text-text-secondary`}>Use this only when the provider email is genuinely unavailable but Finance has verified the payment&apos;s amount, business date, exact provider ID, and duplicate status. It cannot bypass another blocker.</p>
    <label className="mt-4 flex items-start gap-3 text-sm leading-5 text-text-secondary">
      <input type="checkbox" checked={confirmedProviderTransaction} onChange={(event) => setConfirmedProviderTransaction(event.target.checked)} className="mt-0.5 size-4 shrink-0 rounded border-border text-brand-accent focus:ring-2 focus:ring-brand-accent/20" />
      I confirm this is the exact provider payment ID shown in Summary.
    </label>
    <label className="mt-3 flex items-start gap-3 text-sm leading-5 text-text-secondary">
      <input type="checkbox" checked={confirmedNoKnownDuplicate} onChange={(event) => setConfirmedNoKnownDuplicate(event.target.checked)} className="mt-0.5 size-4 shrink-0 rounded border-border text-brand-accent focus:ring-2 focus:ring-brand-accent/20" />
      I reviewed the available evidence and found no known duplicate.
    </label>
    <ReasonField value={reason} onChange={setReason} />
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <PrimaryButton onClick={() => void saveFinanceException()} disabled={saving || !canUseFinanceException || !confirmedProviderTransaction || !confirmedNoKnownDuplicate || !hasMeaningfulAuditReason(reason)}>{saving ? "Saving…" : "Include in PLAYBOOK Finance"}</PrimaryButton>
      <p className="text-xs leading-5 text-text-muted">This decision is append-only and audited. {row.source} is never changed.</p>
    </div>
    {message && <p role="alert" className="mt-3 text-sm text-danger">{message}</p>}
  </div>;
}

export function B2cPaymentFxConversion({ row, onSaved }: { row: B2cReviewRow; onSaved: () => void }) {
  const canManage = useCanManage();
  const router = useRouter();
  const [exchangeRateToUsd, setExchangeRateToUsd] = useState("");
  const [conversionSource, setConversionSource] = useState("");
  const [effectiveOn, setEffectiveOn] = useState(row.sourceDateValue);
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (!canManage || row.recordType !== "Payment") return null;

  async function saveFxConversion() {
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/admin/b2c/payments/${row.id}/fx-conversion`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ exchangeRateToUsd, conversionSource, effectiveOn, reason }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "The Finance USD conversion could not be saved.");
      router.refresh();
      onSaved();
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "The Finance USD conversion could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return <div>
    <p className={`${copyClass} text-sm leading-6 text-text-secondary`}>The source payment is <strong>{row.sourceAmountUsd}</strong>. Enter the Finance-approved number of USD for one {row.sourceOriginalCurrency} and its evidence. PLAYBOOK calculates the reporting amount; {row.source} is never changed.</p>
    {row.hasFxConversion && <p className="mt-3 rounded-input border border-success/20 bg-success/5 p-3 text-sm text-success">Latest local USD conversion: <strong>{row.amountUsd}</strong>{row.fxConversionEffectiveOn ? `, effective ${row.fxConversionEffectiveOn}` : ""}{row.fxConversionSource ? ` · ${row.fxConversionSource}` : ""}.</p>}
    <div className="mt-4 grid gap-x-5 gap-y-4 md:grid-cols-2">
      <label className={fieldClass}>USD per 1 {row.sourceOriginalCurrency}
        <input className={inputClass} type="number" min="0.0000000001" step="0.0000000001" value={exchangeRateToUsd} onChange={(event) => setExchangeRateToUsd(event.target.value)} placeholder="e.g. 2.6595744681" />
      </label>
      <label className={fieldClass}>Finance conversion source
        <input className={inputClass} value={conversionSource} onChange={(event) => setConversionSource(event.target.value)} placeholder="Approved Finance FX rate / accounting evidence" />
      </label>
      <label className={fieldClass}>Conversion effective date
        <input className={inputClass} type="date" value={effectiveOn} onChange={(event) => setEffectiveOn(event.target.value)} />
      </label>
    </div>
    <ReasonField value={reason} onChange={setReason} />
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <PrimaryButton onClick={() => void saveFxConversion()} disabled={saving || !exchangeRateToUsd.trim() || !conversionSource.trim() || !effectiveOn || !hasMeaningfulAuditReason(reason)}>{saving ? "Saving…" : "Save conversion"}</PrimaryButton>
      <p className="text-xs leading-5 text-text-muted">This creates a new append-only, audited Finance conversion.</p>
    </div>
    {message && <p role="alert" className="mt-3 text-sm text-danger">{message}</p>}
  </div>;
}
