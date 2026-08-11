"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { X } from "lucide-react";
import { FormEvent, useState } from "react";
import { ErrorState, StatusBadge } from "@/components/ui";
import { drawerTransition, fadeTransition } from "@/lib/motion";
import type { ReviewQueueDetail } from "@/server/services/review-queue";

export { FilterBar, SectionCard } from "@/components/ui";

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function statusLabel(value: "open" | "resolved" | "dismissed"): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

export function ReviewFlagBadge({ type }: { type: string }) { return <StatusBadge status={type} />; }

export function DetailDrawer({ detail, onClose, canAddNote, onAddNote }: { detail: ReviewQueueDetail; onClose: () => void; canAddNote: boolean; onAddNote?: (note: string) => Promise<void> }) {
  const [note, setNote] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const reducedMotion = useReducedMotion();
  const isB2cDuplicate = detail.item.sourceArea === "b2c_payment" && detail.item.flagType === "possible_duplicate";

  async function submitNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!onAddNote || !note.trim()) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onAddNote(note.trim());
      setNote("");
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Could not save review note.");
    } finally {
      setSaving(false);
    }
  }

  return <AnimatePresence><motion.div variants={reducedMotion ? undefined : fadeTransition} initial={reducedMotion ? false : "initial"} animate={reducedMotion ? undefined : "animate"} exit={reducedMotion ? undefined : "exit"} className="fixed inset-0 z-40 bg-brand-primary/30" role="presentation" onClick={onClose}><motion.aside variants={reducedMotion ? undefined : drawerTransition} initial={reducedMotion ? false : "initial"} animate={reducedMotion ? undefined : "animate"} exit={reducedMotion ? undefined : "exit"} role="dialog" aria-modal="true" aria-labelledby="review-detail-title" className="absolute inset-y-0 right-0 w-full max-w-xl overflow-y-auto bg-surface p-6 shadow-elevated" onClick={(event) => event.stopPropagation()}>
    <div className="flex items-start justify-between gap-4"><div><p className="text-xs font-semibold tracking-[0.08em] text-text-muted">{detail.item.sourceLabel}</p><h2 id="review-detail-title" className="mt-1 text-xl font-semibold tracking-[-0.03em] text-text-primary">{detail.item.flagLabel}</h2><div className="mt-3 flex flex-wrap gap-2"><ReviewFlagBadge type={detail.item.flagLabel} /><StatusBadge status={statusLabel(detail.item.status)} /><StatusBadge status={`Priority ${detail.item.priority}`} /></div></div><button type="button" aria-label="Close review detail" onClick={onClose} className="min-h-11 min-w-11 rounded-pill p-2 text-text-secondary hover:bg-surface-muted"><X aria-hidden="true" /></button></div>
    <dl className="mt-7 space-y-4 text-sm"><div><dt className="text-text-muted">Source area</dt><dd className="mt-1 font-medium text-text-primary">{detail.item.sourceArea}</dd></div><div><dt className="text-text-muted">Reason for flag</dt><dd className="mt-1 leading-6 text-text-secondary">{detail.item.reason}</dd></div><div><dt className="text-text-muted">Created</dt><dd className="mt-1 leading-6 text-text-secondary">{formatTimestamp(detail.item.createdAt)}</dd></div>{detail.item.resolvedAt && <div><dt className="text-text-muted">Resolved</dt><dd className="mt-1 leading-6 text-text-secondary">{formatTimestamp(detail.item.resolvedAt)}</dd></div>}<div><dt className="text-text-muted">Suggested next action</dt><dd className="mt-1 leading-6 text-text-secondary">{detail.item.nextAction.kind === "navigate" ? <a href={detail.item.nextAction.href} className="font-semibold text-brand-primary underline decoration-brand-accent underline-offset-4">{detail.item.nextAction.label}</a> : detail.item.nextAction.label}</dd>{isB2cDuplicate && <p className="mt-2 leading-6 text-text-muted">This item stays open until Finance&apos;s B2C duplicate decision workflow is defined.</p>}</div></dl>
    <section className="mt-7 border-t border-border pt-5"><h3 className="font-semibold text-text-primary">Resolution history</h3>{detail.resolutions.length === 0 ? <p className="mt-2 text-sm leading-6 text-text-muted">No resolution has been recorded.</p> : <ol className="mt-3 space-y-3">{detail.resolutions.map((resolution) => <li key={`${resolution.createdAt}-${resolution.createdBy}`} className="rounded-card border border-border bg-surface-muted/50 p-4"><div className="flex flex-wrap items-center gap-2"><StatusBadge status={statusLabel(resolution.resolutionStatus)} /><span className="text-xs text-text-muted">{formatTimestamp(resolution.createdAt)} · {resolution.createdBy}</span></div><p className="mt-2 text-sm leading-6 text-text-secondary">{resolution.resolutionNote}</p></li>)}</ol>}</section>
    <section className="mt-7 border-t border-border pt-5"><h3 className="font-semibold text-text-primary">Review notes</h3>{detail.notes.length === 0 ? <p className="mt-2 text-sm leading-6 text-text-muted">No notes yet.</p> : <ol className="mt-3 space-y-3">{detail.notes.map((item) => <li key={item.id} className="rounded-card border border-border bg-surface-muted/50 p-4"><p className="text-sm leading-6 text-text-secondary">{item.note}</p><p className="mt-2 text-xs text-text-muted">{formatTimestamp(item.createdAt)} · {item.createdBy}</p></li>)}</ol>}</section>
    <section className="mt-7 border-t border-border pt-5"><h3 className="font-semibold text-text-primary">Add review note</h3>{canAddNote && onAddNote ? <form className="mt-3" onSubmit={submitNote}><p className="text-sm leading-6 text-text-muted">The note is retained in the review history. It does not resolve this flag or change any financial value.</p><label className="mt-4 block text-sm font-medium text-text-secondary">Add review note<textarea aria-label="Add review note" required minLength={3} maxLength={1000} value={note} onChange={(event) => setNote(event.target.value)} className="mt-2 min-h-24 w-full rounded-card border border-border bg-surface p-3 font-normal text-text-primary" placeholder="Record a verified review note" /></label>{saveError && <div className="mt-3"><ErrorState title="Unable to save review note" description={saveError} /></div>}<button type="submit" disabled={saving || note.trim().length < 3} className="mt-4 min-h-11 rounded-md border border-brand-primary px-4 py-2 text-sm font-semibold text-brand-primary hover:bg-surface-accent disabled:cursor-not-allowed disabled:opacity-60">{saving ? "Saving note…" : "Add note"}</button></form> : <p className="mt-2 text-sm leading-6 text-text-muted">Viewer access is read-only. Only an Admin can add a note.</p>}</section>
  </motion.aside></motion.div></AnimatePresence>;
}
