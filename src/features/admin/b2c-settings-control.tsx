"use client";

import { useEffect, useState } from "react";
import { FormField } from "@/components/admin-ui";
import { PrimaryButton, SubtleLoading } from "@/components/ui";
import {
  B2C_DUPLICATE_DETECTION_WINDOW_MAX_HOURS,
  B2C_DUPLICATE_DETECTION_WINDOW_MIN_HOURS,
  b2cDuplicateDetectionWindowSchema,
} from "@/lib/validation/b2c-settings-contracts";

type SettingsState = { windowHours: number; reason: string | null; updatedAt: string };

const inputClass = "h-10 w-full rounded-md border border-border bg-surface px-3 text-sm text-text-primary placeholder:text-text-muted";

/**
 * Real, Admin-only control for the B2C duplicate-detection window (the
 * "possible duplicate" window both the manual-bank-transfer preview and the
 * ledger's possible-duplicate flagging use). Reads and writes through
 * /api/admin/b2c/settings, which is backed by the protected
 * update_b2c_duplicate_detection_window RPC -- Admin-only, bounds-checked,
 * and audited (supabase/migrations/20270101000700_b2c_duplicate_window_setting.sql).
 */
export function B2cSettingsControl() {
  const [current, setCurrent] = useState<SettingsState | null>(null);
  const [windowHoursInput, setWindowHoursInput] = useState("");
  const [reason, setReason] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setIsLoading(true);
      setError(null);
      try {
        const response = await fetch("/api/admin/b2c/settings");
        const body = await response.json() as { windowHours?: number; reason?: string | null; updatedAt?: string; error?: string };
        if (!response.ok || typeof body.windowHours !== "number") throw new Error(body.error ?? "Could not load the B2C duplicate-detection window.");
        if (cancelled) return;
        setCurrent({ windowHours: body.windowHours, reason: body.reason ?? null, updatedAt: body.updatedAt ?? "" });
        setWindowHoursInput(String(body.windowHours));
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load the B2C duplicate-detection window.");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, []);

  async function submit() {
    setError(null);
    setSavedMessage(null);
    const parsed = b2cDuplicateDetectionWindowSchema.safeParse({
      windowHours: Number(windowHoursInput),
      reason,
    });
    if (!parsed.success) {
      setError(`Enter a window between ${B2C_DUPLICATE_DETECTION_WINDOW_MIN_HOURS} and ${B2C_DUPLICATE_DETECTION_WINDOW_MAX_HOURS} hours and a reason of at least 3 characters.`);
      return;
    }
    setIsSaving(true);
    try {
      const response = await fetch("/api/admin/b2c/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      const body = await response.json() as { windowHours?: number; error?: string };
      if (!response.ok || typeof body.windowHours !== "number") throw new Error(body.error ?? "The B2C duplicate-detection window could not be changed.");
      setCurrent({ windowHours: body.windowHours, reason: parsed.data.reason, updatedAt: new Date().toISOString() });
      setReason("");
      setSavedMessage(`Saved. New possible-duplicate checks now use a ${body.windowHours}-hour window.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The B2C duplicate-detection window could not be changed.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="border border-line bg-stone p-6">
      <p className="font-medium text-ink">B2C duplicate-detection window</p>
      <p className="mt-2 max-w-2xl text-sm text-slate-600">
        Controls how close together (in hours) two succeeded B2C payments with the same effective customer email, USD amount, and business date must be to open a "possible duplicate" review case. Applies immediately to the manual-bank-transfer preview and to the ledger&apos;s possible-duplicate flagging. Default and historical value: 48 hours.
      </p>

      {isLoading ? (
        <div className="mt-5"><SubtleLoading /></div>
      ) : (
        <>
          {current && <p className="mt-4 text-sm text-slate-600">Current window: <span className="font-medium text-ink">{current.windowHours} hours</span>{current.reason ? ` — last changed because: "${current.reason}"` : ""}</p>}
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <FormField label={`Window (hours, ${B2C_DUPLICATE_DETECTION_WINDOW_MIN_HOURS}-${B2C_DUPLICATE_DETECTION_WINDOW_MAX_HOURS})`}>
              <input
                type="number"
                min={B2C_DUPLICATE_DETECTION_WINDOW_MIN_HOURS}
                max={B2C_DUPLICATE_DETECTION_WINDOW_MAX_HOURS}
                step={1}
                className={inputClass}
                value={windowHoursInput}
                onChange={(event) => setWindowHoursInput(event.target.value)}
              />
            </FormField>
            <FormField label="Reason for this change">
              <input className={inputClass} placeholder="Why is the window changing?" value={reason} onChange={(event) => setReason(event.target.value)} />
            </FormField>
          </div>
          <div className="mt-5"><PrimaryButton onClick={submit} disabled={isSaving}>{isSaving ? "Saving…" : "Save duplicate-detection window"}</PrimaryButton></div>
        </>
      )}
      {savedMessage && <p className="mt-4 text-sm text-emerald-700">{savedMessage}</p>}
      {error && <p role="alert" className="mt-4 text-sm text-red-700">{error}</p>}
    </div>
  );
}
