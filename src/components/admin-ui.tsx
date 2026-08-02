"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { ReactNode } from "react";
import { PrimaryButton } from "@/components/ui";
import { dialogTransition, fadeTransition } from "@/lib/motion";

export function FormField({ label, children }: { label: string; children: ReactNode }) { return <label className="block text-sm font-medium text-text-secondary"><span className="mb-2 block">{label}</span>{children}</label>; }
export function ConfirmationDialog({ title, description, onClose }: { title: string; description: string; onClose: () => void }) { const reducedMotion = useReducedMotion(); return <AnimatePresence><motion.div variants={reducedMotion ? undefined : fadeTransition} initial={reducedMotion ? false : "initial"} animate={reducedMotion ? undefined : "animate"} exit={reducedMotion ? undefined : "exit"} className="fixed inset-0 z-50 grid place-items-center bg-brand-primary/30 p-4"><motion.section variants={reducedMotion ? undefined : dialogTransition} initial={reducedMotion ? false : "initial"} animate={reducedMotion ? undefined : "animate"} exit={reducedMotion ? undefined : "exit"} role="dialog" aria-modal="true" aria-labelledby="dialog-title" className="w-full max-w-md rounded-panel bg-surface p-6 shadow-elevated"><h2 id="dialog-title" className="text-lg font-semibold tracking-[-0.02em] text-text-primary">{title}</h2><p className="mt-2 text-sm leading-6 text-text-muted">{description}</p><div className="mt-6 flex justify-end gap-3"><button type="button" className="rounded-pill px-3 py-2 text-sm font-medium text-text-secondary hover:bg-surface-muted" onClick={onClose}>Cancel</button><PrimaryButton onClick={onClose}>I understand</PrimaryButton></div></motion.section></motion.div></AnimatePresence>; }
